import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';
import pLimit from 'p-limit';

interface PelispandaItemSummary {
  id: number;
  slug: string;
  title: string;
  type?: string;
}

// Interfaz para tipar la respuesta de la lista en lugar de usar "any"
interface PelispandaListResponse {
  [key: string]: PelispandaItemSummary[] | undefined;
}

interface PelispandaDownload {
  quality?: string;
  size?: string;
  subs?: number | boolean;
  download_type?: string;
  download_link?: string;
  language?: string;
}

interface PelispandaDetail {
  id: number;
  slug: string;
  title: string;
  year?: string | number;
  tmdb_id?: number | string;
  imdb?: string | number;
  type?: string;
  downloads?: PelispandaDownload[];
  seasons?: Array<{
    season_number: number;
    episodes: Array<{
      episode_number: number;
      downloads?: PelispandaDownload[];
    }>;
  }>;
}

type CategoryType = 'movie' | 'series' | 'anime';

export class PelispandaCrawler extends BaseCrawler {
  public readonly name = 'pelispanda';
  public readonly baseUrl = 'https://pelispanda.org';
  
  // Limita la concurrencia globalmente dentro de una ejecución de crawl
  private readonly CONCURRENCY_LIMIT = 3;

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting crawl across movies, series, and animes (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(this.CONCURRENCY_LIMIT);

    const categories: Array<{ path: string; type: CategoryType }> = [
      { path: 'movies', type: 'movie' },
      { path: 'series', type: 'series' },
      { path: 'animes', type: 'anime' }
    ];

    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        try {
          const listUrl = `${this.baseUrl}/wp-json/wpreact/v1/${cat.path}?page=${page}`;
          const response = await this.httpClient.get<PelispandaListResponse | PelispandaItemSummary[]>(listUrl);
          const data = response.data;

          // Manejo seguro del payload dependiendo si devuelve un array directo o un objeto con la llave de la categoría
          const items: PelispandaItemSummary[] = Array.isArray(data) 
            ? data 
            : (data?.[cat.path] || []);

          if (!items || items.length === 0) {
            console.log(`[${this.name}] No more items found on ${cat.path} page ${page}. Moving to next category.`);
            break; 
          }

          console.log(`[${this.name}] Found ${items.length} items on ${cat.path} page ${page}`);

          const detailTasks = items.map(item => limit(async () => {
            if (!item.slug) return [];
            
            try {
              return await this.crawlDetail(cat.type, item.slug);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[${this.name}] Failed to fetch detail for "${item.slug}": ${msg}`);
              return [];
            }
          }));

          const itemRecordsNested = await Promise.all(detailTasks);
          results.push(...itemRecordsNested.flat());

        } catch (err: any) {
          const statusCode = err?.response?.status;
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error reading ${cat.path} page ${page}: ${msg}`);
          
          // Si es un 404, significa que ya no hay más páginas, rompemos el bucle
          if (statusCode === 404) break;
          // Si es un 500+ o un timeout, continuamos a la siguiente página para no perder todo el proceso
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Discovered ${results.length} torrent records.`);
    return results;
  }

  private async crawlDetail(categoryType: CategoryType, slug: string): Promise<TorrentRecord[]> {
    const routeType = categoryType === 'movie' ? 'movie' : categoryType === 'series' ? 'serie' : 'anime';
    const detailUrl = `${this.baseUrl}/wp-json/wpreact/v1/${routeType}/${slug}`;
    
    const response = await this.httpClient.get<PelispandaDetail>(detailUrl);
    const detail = response.data;
    if (!detail) return [];

    const records: TorrentRecord[] = [];
    
    // Evitar que un string vacío ("") se convierta en 0 numérico (que es falso pero un ID inválido)
    const tmdbId = detail.tmdb_id ? Number(detail.tmdb_id) || null : null;
    const imdbId = detail.imdb && String(detail.imdb).startsWith('tt') ? String(detail.imdb) : null;

    // 1. Process Movie / Direct Downloads
    if (Array.isArray(detail.downloads)) {
      for (const dl of detail.downloads) {
        const fallbackTitle = `${detail.title} ${dl.quality || ''}`.trim();
        const record = this.buildTorrentRecord(dl, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId);
        if (record) records.push(record);
      }
    }

    // 2. Process Episodic Series / Animes if seasons exist
    if (Array.isArray(detail.seasons)) {
      for (const season of detail.seasons) {
        if (!Array.isArray(season.episodes)) continue;

        for (const ep of season.episodes) {
          if (!Array.isArray(ep.downloads)) continue;

          for (const dl of ep.downloads) {
            const seasonStr = String(season.season_number).padStart(2, '0');
            const epStr = String(ep.episode_number).padStart(2, '0');
            const fallbackTitle = `${detail.title} S${seasonStr}E${epStr} ${dl.quality || ''}`.trim();

            const record = this.buildTorrentRecord(dl, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId, season.season_number, ep.episode_number);
            if (record) records.push(record);
          }
        }
      }
    }

    return records;
  }

  /**
   * Centraliza la lógica de conversión de un "Download" genérico a un TorrentRecord,
   * aplicando las validaciones de Magnet, Idioma y Parseo.
   */
  private buildTorrentRecord(
    dl: PelispandaDownload,
    sourceUrl: string,
    categoryType: CategoryType,
    fallbackTitle: string,
    tmdbId: number | null,
    imdbId: string | null,
    season?: number,
    episode?: number
  ): TorrentRecord | null {
    if (!dl.download_link || !dl.download_link.startsWith('magnet:?')) return null;

    const parsedMagnet = parseMagnetUri(dl.download_link);
    if (!parsedMagnet || !parsedMagnet.infoHash) return null;

    const releaseTitle = parsedMagnet.displayName || fallbackTitle;
    const parsedMeta = parseTorrentTitle(releaseTitle, categoryType);
    const metaAny = parsedMeta as any;
    
    const langHints = [dl.language || '', dl.subs ? 'sub_es' : '', 'pelispanda'];
    const langs = detectLanguages(releaseTitle, langHints);

    // Ajuste seguro de idiomas (español / latino)
    if (dl.language) {
      if (/latino/i.test(dl.language) && !langs.audio.includes('Spanish (Latino)')) {
        langs.audio.push('Spanish (Latino)');
      } else if (/castellano|español/i.test(dl.language) && !langs.audio.includes('Spanish')) {
        langs.audio.push('Spanish');
      }
    }

    if (dl.subs && !langs.subtitles.includes('Sub_ES')) {
      langs.subtitles.push('Sub_ES');
    }

    const sizeBytes = dl.size ? parseSizeToBytes(dl.size) : null;

    return {
      imdb_id: imdbId,
      tmdb_id: tmdbId,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: categoryType,
      season: season ?? parsedMeta.season,
      episode: episode ?? parsedMeta.episode,
      absolute_episode: parsedMeta.absoluteEpisode,
      file_index: null,
      info_hash: parsedMagnet.infoHash,
      magnet_url: dl.download_link,
      torrent_file_url: null,
      source_url: sourceUrl,
      title: releaseTitle,
      release_group: parsedMeta.releaseGroup,
      quality: dl.quality || metaAny.quality || metaAny.resolution || null,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: sizeBytes,
      seeders: null,
      leechers: null,
      source_tracker: parsedMagnet.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}

export default PelispandaCrawler;
