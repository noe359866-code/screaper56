import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

interface ApibayItem {
  id: string;
  name: string;
  info_hash: string;
  leechers: string | number;
  seeders: string | number;
  size: string | number;
  category: string | number;
  imdb?: string;
}

export class ThePirateBayCrawler extends BaseCrawler {
  public readonly name = 'thepiratebay';
  public readonly baseUrl = 'https://thepiratebay.org';

  private readonly apibayBase = 'https://apibay.org';
  private readonly webMirrors = [
    'https://thepiratebay10.org',
    'https://tpb.party',
    'https://pirate-bays.net',
    'https://thehiddenbay.com'
  ];

  // Tracker por defecto para crear magnets de la API
  private readonly defaultTrackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce'
  ];

  /**
   * Resuelve URLs relativas de forma segura
   */
  private resolveUrl(target: string, base: string): string {
    try {
      return new URL(target, base).href;
    } catch {
      return target;
    }
  }

  /**
   * Genera un Magnet URI estándar
   */
  private buildMagnet(infoHash: string, name: string): string {
    let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
    for (const tr of this.defaultTrackers) {
      magnet += `&tr=${encodeURIComponent(tr)}`;
    }
    return magnet;
  }

  /**
   * Busca el primer espejo web activo (evitando saturarlos a todos a la vez)
   */
  private async getWorkingWebMirror(): Promise<string | null> {
    for (const mirror of this.webMirrors) {
      try {
        console.log(`[${this.name}] Checking web mirror connectivity: ${mirror}...`);
        const resp = await this.httpClient.get<string>(`${mirror}/search/test/1/99/200`, {
          timeout: 7000,
          headers: {
            'Accept': 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        // Verificamos que no sea un captcha de Cloudflare y que exista la tabla de resultados
        if (resp.status === 200 && resp.data.includes('searchResult')) {
          console.log(`[${this.name}] Connected to active web mirror: ${mirror}`);
          return mirror;
        }
      } catch (err) {
        console.warn(`[${this.name}] Web mirror ${mirror} unreachable or blocked.`);
      }
    }
    return null;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting The Pirate Bay crawl (maxPages=${maxPages})...`);
    
    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>(); // Para deduplicar resultados cruzados

    // ========================================================================
    // FASE 1: Ingesta rápida vía API Oficial (Top 100)
    // ========================================================================
    const apiEndpoints = [
      '/precompiled/data_top100_200.json', // Video General
      '/precompiled/data_top100_201.json', // Películas
      '/precompiled/data_top100_207.json', // Películas HD
      '/precompiled/data_top100_205.json', // Series TV
      '/precompiled/data_top100_208.json'  // Series TV HD
    ];

    for (const ep of apiEndpoints) {
      try {
        const apiUrl = `${this.apibayBase}${ep}`;
        console.log(`[${this.name}] Querying Apibay: ${apiUrl}`);
        
        const resp = await this.httpClient.get<ApibayItem[]>(apiUrl);
        const items = resp.data || [];

        if (Array.isArray(items)) {
          for (const item of items) {
            const rec = this.mapApibayItem(item);
            if (rec && !uniqueHashes.has(rec.info_hash)) {
              uniqueHashes.add(rec.info_hash);
              results.push(rec);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[${this.name}] Apibay ${ep} failed: ${err.message}`);
      }
    }

    // ========================================================================
    // FASE 2: Búsquedas Web Scraping (Contenido en español)
    // ========================================================================
    const workingMirror = await this.getWorkingWebMirror();
    
    if (!workingMirror) {
      console.warn(`[${this.name}] No working web mirrors found. Skipping Phase 2.`);
    } else {
      const searchTerms = ['spanish', 'castellano', 'latino'];

      for (const term of searchTerms) {
        for (let page = 1; page <= maxPages; page++) {
          const searchUrl = `${workingMirror}/search/${term}/${page}/99/200`;
          
          try {
            console.log(`[${this.name}] Scraping search term '${term}': ${searchUrl}`);
            const resp = await this.httpClient.get<string>(searchUrl);
            const $ = cheerio.load(resp.data);
            let addedInPage = 0;

            $('#searchResult tr:not(.header)').each((_, el) => {
              const titleEl = $(el).find('.detName a, a.detLink');
              const magnetEl = $(el).find('a[href^="magnet:?xt="]');
              
              if (!titleEl.length || !magnetEl.length) return;

              const title = titleEl.text().trim();
              const magnetUrl = magnetEl.attr('href') || '';
              const detailHref = titleEl.attr('href') || '';
              
              const parsedMagnet = parseMagnetUri(magnetUrl);
              if (!parsedMagnet || !parsedMagnet.infoHash) return;

              const infoHash = parsedMagnet.infoHash.toLowerCase();
              if (uniqueHashes.has(infoHash)) return; // Deduplicación

              const tds = $(el).find('td');
              const seeders = parseInt(tds.eq(tds.length - 2).text().trim(), 10) || 0;
              const leechers = parseInt(tds.eq(tds.length - 1).text().trim(), 10) || 0;

              const descText = $(el).find('font.detDesc').text();
              const sizeMatch = descText.match(/Size\s+([^,]+)/i);
              const sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;

              const meta = parseTorrentTitle(title, 'movie');
              const metaAny = meta as any;
              const langs = detectLanguages(title, ['thepiratebay', term]); // Pasamos 'term' como contexto de idioma

              uniqueHashes.add(infoHash);
              addedInPage++;
              
              results.push({
                imdb_id: null,
                tmdb_id: null,
                kitsu_id: null,
                anilist_id: null,
                mal_id: null,
                type: meta.type,
                season: meta.season,
                episode: meta.episode,
                absolute_episode: meta.absoluteEpisode,
                file_index: null,
                info_hash: infoHash,
                magnet_url: magnetUrl,
                torrent_file_url: null, // TPB casi no maneja .torrent crudos ya
                source_url: this.resolveUrl(detailHref, workingMirror),
                title,
                release_group: meta.releaseGroup,
                quality: metaAny.quality || metaAny.resolution || null,
                codec: meta.codec,
                hdr_format: meta.hdrFormat,
                audio: langs.audio,
                subtitles: langs.subtitles,
                channels: meta.channels,
                size_bytes: sizeBytes,
                seeders,
                leechers,
                source_tracker: parsedMagnet.trackers[0] || this.defaultTrackers[0]
              });
            });

            // Si la página no arrojó resultados válidos, cortamos el loop de paginación para este término
            if (addedInPage === 0) {
              console.log(`[${this.name}] No more results for '${term}' at page ${page}.`);
              break; 
            }

          } catch (err: any) {
            console.warn(`[${this.name}] Failed scraping ${searchUrl}: ${err.message}`);
            break; // Si hay timeout o error 500, pasamos al siguiente término
          }
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total unique records discovered: ${results.length}`);
    return results;
  }

  private mapApibayItem(item: ApibayItem): TorrentRecord | null {
    if (!item.info_hash || !/^[0-9a-fA-F]{40}$/.test(item.info_hash) || item.name === 'No results returned') {
      return null;
    }

    const infoHash = item.info_hash.toLowerCase();
    const catNum = Number(item.category);
    let defaultType: ContentType = 'movie';
    if (catNum === 205 || catNum === 208) {
      defaultType = 'series';
    }

    const meta = parseTorrentTitle(item.name, defaultType);
    const metaAny = meta as any;
    const langs = detectLanguages(item.name, ['thepiratebay']);

    let validImdbId: string | null = null;
    if (item.imdb && /^tt[0-9]{7,8}$/.test(item.imdb.trim())) {
      validImdbId = item.imdb.trim();
    }

    return {
      imdb_id: validImdbId,
      tmdb_id: null,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: meta.type,
      season: meta.season,
      episode: meta.episode,
      absolute_episode: meta.absoluteEpisode,
      file_index: null,
      info_hash: infoHash,
      magnet_url: this.buildMagnet(infoHash, item.name),
      torrent_file_url: null,
      source_url: `https://thepiratebay.org/description.php?id=${item.id}`, // Reconstruimos URL base de TPB
      title: item.name,
      release_group: meta.releaseGroup,
      quality: metaAny.quality || metaAny.resolution || null,
      codec: meta.codec,
      hdr_format: meta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: meta.channels,
      size_bytes: Number(item.size) || 0,
      seeders: Number(item.seeders) || 0,
      leechers: Number(item.leechers) || 0,
      source_tracker: this.defaultTrackers[0]
    };
  }
}

// Alias para compatibilidad hacia atrás
export class DivxTotalCrawler extends ThePirateBayCrawler {}
