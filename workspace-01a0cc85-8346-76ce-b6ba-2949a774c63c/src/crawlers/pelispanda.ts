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

interface PelispandaDownload {
  quality?: string;
  size?: string;
  subs?: number;
  download_type?: string;
  download_link?: string;
  language?: string;
}

interface PelispandaDetail {
  id: number;
  slug: string;
  title: string;
  year?: string | number;
  tmdb_id?: number;
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

export class PelispandaCrawler extends BaseCrawler {
  public readonly name = 'pelispanda';
  public readonly baseUrl = 'https://pelispanda.org';

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting crawl across movies, series, and animes (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(3);

    const categories: Array<{ path: string; type: 'movie' | 'series' | 'anime' }> = [
      { path: 'movies', type: 'movie' },
      { path: 'series', type: 'series' },
      { path: 'animes', type: 'anime' }
    ];

    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        try {
          const listUrl = `${this.baseUrl}/wp-json/wpreact/v1/${cat.path}?page=${page}`;
          const response = await this.httpClient.get<any>(listUrl);
          const data = response.data;

          const items: PelispandaItemSummary[] = data?.[cat.path] || (Array.isArray(data) ? data : []);
          if (!items || items.length === 0) {
            break; // No more items in this category
          }

          console.log(`[${this.name}] Found ${items.length} items on ${cat.path} page ${page}`);

          const detailTasks = items.map(item => limit(async () => {
            try {
              return await this.crawlDetail(cat.type, item.slug);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[${this.name}] Failed to fetch detail for "${item.slug}": ${msg}`);
              return [];
            }
          }));

          const itemRecordsNested = await Promise.all(detailTasks);
          for (const records of itemRecordsNested) {
            results.push(...records);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error reading ${cat.path} page ${page}: ${msg}`);
          break;
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Discovered ${results.length} torrent records.`);
    return results;
  }

  private async crawlDetail(categoryType: 'movie' | 'series' | 'anime', slug: string): Promise<TorrentRecord[]> {
    const routeType = categoryType === 'movie' ? 'movie' : categoryType === 'series' ? 'serie' : 'anime';
    const detailUrl = `${this.baseUrl}/wp-json/wpreact/v1/${routeType}/${slug}`;
    const response = await this.httpClient.get<PelispandaDetail>(detailUrl);
    const detail = response.data;
    if (!detail) return [];

    const records: TorrentRecord[] = [];
    const tmdbId = detail.tmdb_id ? Number(detail.tmdb_id) : null;
    const imdbId = detail.imdb && String(detail.imdb).startsWith('tt') ? String(detail.imdb) : null;

    // 1. Process Movie / Direct Downloads
    if (detail.downloads && Array.isArray(detail.downloads)) {
      for (const dl of detail.downloads) {
        if (!dl.download_link || !dl.download_link.startsWith('magnet:?')) continue;

        const parsedMagnet = parseMagnetUri(dl.download_link);
        if (!parsedMagnet || !parsedMagnet.infoHash) continue;

        const releaseTitle = parsedMagnet.displayName || `${detail.title} ${dl.quality || ''}`.trim();
        const parsedMeta = parseTorrentTitle(releaseTitle, categoryType);
        const langHints = [dl.language || '', dl.subs ? 'sub_es' : '', 'pelispanda'];
        const langs = detectLanguages(releaseTitle, langHints);

        // Ensure Spanish is set if marked as Latino/Spanish
        if (dl.language && /latino/i.test(dl.language) && !langs.audio.includes('Spanish (Latino)')) {
          langs.audio.push('Spanish (Latino)');
        } else if (dl.language && /castellano|español/i.test(dl.language) && !langs.audio.includes('Spanish')) {
          langs.audio.push('Spanish');
        }

        if (dl.subs && !langs.subtitles.includes('Sub_ES')) {
          langs.subtitles.push('Sub_ES');
        }

        const sizeBytes = dl.size ? parseSizeToBytes(dl.size) : null;

        records.push({
          imdb_id: imdbId,
          tmdb_id: tmdbId,
          kitsu_id: null,
          anilist_id: null,
          mal_id: null,
          type: categoryType,
          season: parsedMeta.season,
          episode: parsedMeta.episode,
          absolute_episode: parsedMeta.absoluteEpisode,
          file_index: null,
          info_hash: parsedMagnet.infoHash,
          magnet_url: dl.download_link,
          torrent_file_url: null,
          source_url: detailUrl,
          title: releaseTitle,
          release_group: parsedMeta.releaseGroup,
          quality: dl.quality || parsedMeta.quality,
          codec: parsedMeta.codec,
          hdr_format: parsedMeta.hdrFormat,
          audio: langs.audio,
          subtitles: langs.subtitles,
          channels: parsedMeta.channels,
          size_bytes: sizeBytes,
          seeders: 10, // Default active seed floor for indexer
          leechers: 2,
          source_tracker: parsedMagnet.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
        });
      }
    }

    // 2. Process Episodic Series / Animes if seasons exist
    if (detail.seasons && Array.isArray(detail.seasons)) {
      for (const season of detail.seasons) {
        if (!season.episodes || !Array.isArray(season.episodes)) continue;

        for (const ep of season.episodes) {
          if (!ep.downloads || !Array.isArray(ep.downloads)) continue;

          for (const dl of ep.downloads) {
            if (!dl.download_link || !dl.download_link.startsWith('magnet:?')) continue;

            const parsedMagnet = parseMagnetUri(dl.download_link);
            if (!parsedMagnet || !parsedMagnet.infoHash) continue;

            const epTitle = parsedMagnet.displayName || `${detail.title} S${String(season.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`;
            const parsedMeta = parseTorrentTitle(epTitle, categoryType);
            const langs = detectLanguages(epTitle, [dl.language || '', dl.subs ? 'sub_es' : '', 'pelispanda']);

            records.push({
              imdb_id: imdbId,
              tmdb_id: tmdbId,
              kitsu_id: null,
              anilist_id: null,
              mal_id: null,
              type: categoryType,
              season: season.season_number,
              episode: ep.episode_number,
              absolute_episode: parsedMeta.absoluteEpisode,
              file_index: null,
              info_hash: parsedMagnet.infoHash,
              magnet_url: dl.download_link,
              torrent_file_url: null,
              source_url: detailUrl,
              title: epTitle,
              release_group: parsedMeta.releaseGroup,
              quality: dl.quality || parsedMeta.quality,
              codec: parsedMeta.codec,
              hdr_format: parsedMeta.hdrFormat,
              audio: langs.audio,
              subtitles: langs.subtitles,
              channels: parsedMeta.channels,
              size_bytes: dl.size ? parseSizeToBytes(dl.size) : null,
              seeders: 8,
              leechers: 1,
              source_tracker: parsedMagnet.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
            });
          }
        }
      }
    }

    return records;
  }
}
