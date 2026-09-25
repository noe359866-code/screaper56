import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

interface EztvApiTorrent {
  id: number;
  hash: string;
  filename: string;
  episode_url?: string;
  torrent_url?: string;
  magnet_url?: string;
  title: string;
  imdb_id?: string;
  season?: string | number;
  episode?: string | number;
  seeds?: number;
  peers?: number;
  size_bytes?: string | number;
}

export class EztvCrawler extends BaseCrawler {
  public readonly name = 'eztv';
  public readonly baseUrl = 'https://eztv1.xyz';
  
  // Añadimos dominios extra conocidos de EZTV
  private readonly fallbackMirrors = [
    'https://eztv.re', 
    'https://eztv.wf', 
    'https://eztv.tf',
    'https://eztv.yt'
  ];

  private readonly defaultTrackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.coppersurfer.tk:6969/announce'
  ];

  /**
   * Construye un magnet con trackers si la API no lo provee completo
   */
  private buildMagnet(infoHash: string, name: string): string {
    let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
    for (const tr of this.defaultTrackers) {
      magnet += `&tr=${encodeURIComponent(tr)}`;
    }
    return magnet;
  }

  /**
   * Resuelve URLs relativas de forma segura
   */
  private resolveUrl(target: string, base: string): string {
    try {
      return new URL(target, base).href;
    } catch {
      return target.startsWith('http') ? target : `${base}${target.startsWith('/') ? '' : '/'}${target}`;
    }
  }

  /**
   * Busca un dominio base activo probando el endpoint de la API
   */
  private async getWorkingDomain(): Promise<string | null> {
    const domains = [this.baseUrl, ...this.fallbackMirrors];
    
    for (const domain of domains) {
      try {
        console.log(`[${this.name}] Testing domain: ${domain}...`);
        const resp = await this.httpClient.get<any>(`${domain}/api/get-torrents?limit=1`, {
          timeout: 5000 // Timeout corto para no perder tiempo en espejos caídos
        });
        
        if (resp.status === 200 && resp.data) {
          console.log(`[${this.name}] Active domain found: ${domain}`);
          return domain;
        }
      } catch (err) {
        console.warn(`[${this.name}] Domain ${domain} unreachable.`);
      }
    }
    return null;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting EZTV crawl (maxPages=${maxPages})...`);
    
    const activeDomain = await this.getWorkingDomain();
    if (!activeDomain) {
      console.error(`[${this.name}] CRITICAL: No working EZTV mirrors found. Aborting crawl.`);
      return [];
    }

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>(); // Para deduplicación
    let apiSuccess = false;

    // ========================================================================
    // FASE 1: Intento de extracción por API
    // ========================================================================
    try {
      for (let page = 1; page <= maxPages; page++) {
        const apiUrl = `${activeDomain}/api/get-torrents?limit=80&page=${page}`;
        console.log(`[${this.name}] Querying EZTV API: ${apiUrl}`);

        const resp = await this.httpClient.get<any>(apiUrl);
        const torrents: EztvApiTorrent[] = resp.data?.torrents || [];

        if (!torrents || torrents.length === 0) {
          console.log(`[${this.name}] API returned no more results at page ${page}.`);
          break;
        }

        for (const t of torrents) {
          const rec = this.mapApiTorrentToRecord(t, activeDomain);
          if (rec && !uniqueHashes.has(rec.info_hash)) {
            uniqueHashes.add(rec.info_hash);
            results.push(rec);
          }
        }
        apiSuccess = true; // Si llegamos aquí, la API funcionó para al menos una página
      }

      if (results.length > 0) {
        console.log(`[${this.name}] EZTV API yielded ${results.length} unique records.`);
        return results;
      }
    } catch (apiErr: any) {
      console.warn(`[${this.name}] EZTV API failed (${apiErr.message}). Falling back to HTML scraper...`);
    }

    // ========================================================================
    // FASE 2: Fallback Scraper HTML (Solo si la API falló por completo)
    // ========================================================================
    if (!apiSuccess || results.length === 0) {
      try {
        for (let page = 0; page < maxPages; page++) {
          const pageUrl = page === 0 ? `${activeDomain}/home` : `${activeDomain}/page_${page}`;
          console.log(`[${this.name}] Scraping HTML: ${pageUrl}`);

          const resp = await this.httpClient.get<string>(pageUrl);
          const $ = cheerio.load(resp.data);
          let addedInPage = 0;

          $('tr.forum_header_border').each((_, el) => {
            const titleAnchor = $(el).find('a.epinfo');
            const magnetLink = $(el).find('a.magnet').attr('href');
            
            if (!titleAnchor.length || !magnetLink) return;

            const parsedMagnet = parseMagnetUri(magnetLink);
            if (!parsedMagnet || !parsedMagnet.infoHash) return;

            const infoHash = parsedMagnet.infoHash.toLowerCase();
            
            // Deduplicación en el scraper
            if (uniqueHashes.has(infoHash)) return; 

            const title = titleAnchor.text().trim();
            const detailPath = titleAnchor.attr('href') || '';
            const torrentLink = $(el).find('a.download_1').attr('href') || null;

            const sizeText = $(el).find('td:nth-child(4)').text().trim();
            const seedsText = $(el).find('td:nth-child(6) font').text().trim();
            const seeders = parseInt(seedsText.replace(/,/g, ''), 10) || 0;

            const parsedMeta = parseTorrentTitle(title, 'series');
            const langs = detectLanguages(title, ['eztv', 'tv']);

            uniqueHashes.add(infoHash);
            addedInPage++;

            results.push({
              imdb_id: null,
              tmdb_id: null,
              kitsu_id: null,
              anilist_id: null,
              mal_id: null,
              type: 'series', // EZTV es exclusivo de series
              season: parsedMeta.season,
              episode: parsedMeta.episode,
              absolute_episode: parsedMeta.absoluteEpisode,
              file_index: null,
              info_hash: infoHash,
              magnet_url: magnetLink,
              torrent_file_url: torrentLink,
              source_url: this.resolveUrl(detailPath, activeDomain),
              title,
              release_group: parsedMeta.releaseGroup,
              quality: parsedMeta.quality,
              codec: parsedMeta.codec,
              hdr_format: parsedMeta.hdrFormat,
              audio: langs.audio,
              subtitles: langs.subtitles,
              channels: parsedMeta.channels,
              size_bytes: parseSizeToBytes(sizeText),
              seeders,
              leechers: 0, // EZTV HTML no suele mostrar leechers
              source_tracker: parsedMagnet.trackers[0] || this.defaultTrackers[0]
            });
          });

          if (addedInPage === 0) break; // Termina si la página está vacía
        }
      } catch (htmlErr: any) {
        console.error(`[${this.name}] HTML fallback error: ${htmlErr.message}`);
      }
    }

    console.log(`[${this.name}] Crawl completed. Total unique records retrieved: ${results.length}`);
    return results;
  }

  private mapApiTorrentToRecord(t: EztvApiTorrent, activeDomain: string): TorrentRecord | null {
    if (!t.hash) return null;

    const infoHash = t.hash.toLowerCase();
    const fullTitle = t.filename || t.title;
    const parsedMeta = parseTorrentTitle(fullTitle, 'series');
    const langs = detectLanguages(fullTitle, ['eztv', 'tv']);

    // Estandarización robusta de IMDB ID
    let imdbId: string | null = null;
    if (t.imdb_id && t.imdb_id !== '0') {
      const raw = String(t.imdb_id).replace(/^tt/, '').trim();
      imdbId = `tt${raw.padStart(7, '0')}`;
    }

    const season = t.season ? parseInt(String(t.season), 10) : parsedMeta.season;
    const episode = t.episode ? parseInt(String(t.episode), 10) : parsedMeta.episode;
    const sizeBytes = t.size_bytes ? parseInt(String(t.size_bytes), 10) : null;

    // Aseguramos que el magnet tenga trackers si viene de la API
    const magnetUrl = t.magnet_url && t.magnet_url.includes('tr=') 
      ? t.magnet_url 
      : this.buildMagnet(infoHash, fullTitle);

    return {
      imdb_id: imdbId,
      tmdb_id: null,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: 'series',
      season: isNaN(Number(season)) ? null : Number(season),
      episode: isNaN(Number(episode)) ? null : Number(episode),
      absolute_episode: parsedMeta.absoluteEpisode,
      file_index: null,
      info_hash: infoHash,
      magnet_url: magnetUrl,
      torrent_file_url: t.torrent_url || null,
      source_url: t.episode_url || `${activeDomain}/ep/${t.id}`,
      title: fullTitle,
      release_group: parsedMeta.releaseGroup,
      quality: parsedMeta.quality,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: sizeBytes,
      seeders: t.seeds || 0,
      leechers: t.peers || 0,
      source_tracker: this.defaultTrackers[0]
    };
  }
}
