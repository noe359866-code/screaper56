import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

interface ScrapedRow {
  detailUrl: string;
  title: string;
  seeders: number;
  leechers: number;
  sizeStr: string;
}

export class Leech1337xCrawler extends BaseCrawler {
  public readonly name = 'leech1337x';
  public readonly baseUrl = 'https://1337x.la'; 
  private readonly fallbackMirrors = [
    'https://www.1337x.tw', 
    'https://1337x.to', 
    'https://1337x.st',
    'https://x1337x.ws'
  ];
  private readonly CONCURRENCY = 2; // 1337x banea rápido, 2 es un buen límite seguro

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
   * Busca el primer mirror activo que no esté bloqueado por Cloudflare
   */
  private async getWorkingMirror(): Promise<string> {
    const mirrorsToTry = [this.baseUrl, ...this.fallbackMirrors];

    for (const mirror of mirrorsToTry) {
      try {
        console.log(`[${this.name}] Testing connectivity to${mirror}...`);
        const resp = await this.httpClient.get<string>(mirror, {
          timeout: 7000,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });

        const html = resp.data || '';
        // 1337x usa mucha protección anti-DDoS, verificamos que cargue el DOM real
        if (resp.status === 200 && !/Just a moment|Attention Required!|cf-mitigated|Cloudflare/i.test(html) && html.includes('table')) {
          console.log(`[${this.name}] Connected to active endpoint:${mirror}`);
          return mirror;
        }
      } catch (err) {
        console.warn(`[${this.name}] Mirror${mirror} unreachable or blocked. Trying next...`);
      }
    }

    throw new Error(`[${this.name}] All 1337x mirrors are down or blocked by Cloudflare.`);
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting 1337x crawl (maxPages=${maxPages})...`);
    
    let workingMirror: string;
    try {
      workingMirror = await this.getWorkingMirror();
    } catch (error: any) {
      console.error(error.message);
      return []; // Cortamos la ejecución si no hay espejos vivos
    }

    const results: TorrentRecord[] = [];
    const limit = pLimit(this.CONCURRENCY);

    const searchEndpoints = [
      '/sort-search/spanish/seeders/desc',
      '/sort-search/latino/seeders/desc',
      '/sort-search/castellano/seeders/desc',
      '/popular-movies',
      '/popular-tv'
    ];

    for (const endpoint of searchEndpoints) {
      for (let page = 1; page <= maxPages; page++) {
        const isSearch = endpoint.includes('sort-search');
        
        // Las listas populares normalmente no tienen paginación directa en la misma ruta
        const url = isSearch 
          ? `${workingMirror}${endpoint}/${page}/` 
          : (page === 1 ? `${workingMirror}${endpoint}` : null);
        
        if (!url) break;

        try {
          console.log(`[${this.name}] Scraping listing:${url}`);
          const response = await this.httpClient.get<string>(url);
          const $ = cheerio.load(response.data);

          const rows: ScrapedRow[] = [];
          $('table.table-list tbody tr').each((_, el) => {
            const nameEl = $(el).find('td.name a[href^="/torrent/"]');
            if (!nameEl.length) return;

            const href = nameEl.attr('href') || '';
            const title = nameEl.text().trim();
            const seeders = parseInt($(el).find('td.seeds').text().trim(), 10) || 0;
            const leechers = parseInt($(el).find('td.leeches').text().trim(), 10) || 0;
            
            // Truco clásico de jQuery/Cheerio para obtener el texto sin el de los hijos (íconos, spans)
            const sizeStr = $(el).find('td.size').clone().children().remove().end().text().trim();

            rows.push({
              detailUrl: this.resolveUrl(href, workingMirror),
              title,
              seeders,
              leechers,
              sizeStr
            });
          });

          if (rows.length === 0) {
            console.log(`[${this.name}] No rows found on${url}. Moving to next endpoint.`);
            break;
          }

          console.log(`[${this.name}] Processing ${rows.length} torrent rows from${url}...`);

          const detailTasks = rows.map(row => limit(async () => {
            try {
              return await this.crawlDetail(row);
            } catch (err: any) {
              console.warn(`[${this.name}] Failed to scrape detail for "${row.title}": ${err.message}`);
              return null;
            }
          }));

          const records = await Promise.all(detailTasks);
          for (const rec of records) {
            if (rec) results.push(rec);
          }
        } catch (err: any) {
          console.warn(`[${this.name}] Failed loading listing ${url}:${err.message}`);
          break; // Si falla la página, rompemos el bucle de paginación para este endpoint
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total records retrieved: ${results.length}`);
    return results;
  }

  private async crawlDetail(row: ScrapedRow): Promise<TorrentRecord | null> {
    const response = await this.httpClient.get<string>(row.detailUrl);
    const $ = cheerio.load(response.data);

    // Extraer el enlace Magnet
    const magnetHref = $('a[href^="magnet:?xt="]').first().attr('href');
    if (!magnetHref) return null;

    const parsedMagnet = parseMagnetUri(magnetHref);
    if (!parsedMagnet || !parsedMagnet.infoHash) return null;

    // Extraer meta-información desde la tabla de detalles
    const pageCategory = $('.torrent-category-detail strong:contains("Category")').next().text().trim().toLowerCase();
    const pageLanguage = $('.torrent-category-detail strong:contains("Language")').next().text().trim();

    let defaultType: ContentType = 'movie';
    if (pageCategory.includes('tv') || pageCategory.includes('television') || pageCategory.includes('episodes')) {
      defaultType = 'series';
    } else if (pageCategory.includes('anime')) {
      defaultType = 'anime';
    }

    const title = row.title || parsedMagnet.displayName || $('div.box-info-heading h1').text().trim();
    const parsedMeta = parseTorrentTitle(title, defaultType);
    
    // Pasamos el language de la página como pista extra
    const langs = detectLanguages(title, [pageLanguage, pageCategory]);

    // Buscar ID de IMDB con Regex robusto (a veces los enlaces tienen parámetros query)
    let imdbId: string | null = null;
    const htmlString = response.data;
    const imdbMatch = htmlString.match(/imdb\.com\/title\/(tt\d{7,8})/i);
    if (imdbMatch && imdbMatch[1]) {
      imdbId = imdbMatch[1];
    }

    return {
      imdb_id: imdbId,
      tmdb_id: null,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: parsedMeta.type,
      season: parsedMeta.season,
      episode: parsedMeta.episode,
      absolute_episode: parsedMeta.absoluteEpisode,
      file_index: null,
      info_hash: parsedMagnet.infoHash,
      magnet_url: magnetHref,
      torrent_file_url: null, // 1337x depende fuertemente de magnets, no de archivos .torrent raw
      source_url: row.detailUrl,
      title,
      release_group: parsedMeta.releaseGroup,
      quality: parsedMeta.quality,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: parseSizeToBytes(row.sizeStr),
      seeders: row.seeders,
      leechers: row.leechers,
      source_tracker: parsedMagnet.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}
