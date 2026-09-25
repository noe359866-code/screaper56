import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

export class NyaaCrawler extends BaseCrawler {
  public readonly name = 'nyaa';
  public readonly baseUrl: string;

  private readonly defaultMirrors = [
    'https://nyaa.si',
    'https://nyaa.ink',
    'https://nyaa.land',
    'https://nyaa.net'
  ];

  constructor() {
    super();
    this.baseUrl = process.env.NYAA_BASE_URL || 'https://nyaa.si';
  }

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
   * Busca el primer espejo de Nyaa que responda con una tabla HTML válida
   */
  private async getWorkingMirror(): Promise<string> {
    const mirrorsToTry = [
      this.baseUrl,
      ...this.defaultMirrors.filter(m => m !== this.baseUrl)
    ];

    for (const mirror of mirrorsToTry) {
      try {
        console.log(`[${this.name}] Checking connectivity to ${mirror}...`);
        const resp = await this.httpClient.get<string>(`${mirror}/?f=0&c=1_2&p=1`, {
          timeout: 6000,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });

        // Validamos que sea HTML real de Nyaa buscando la tabla de torrents
        if (resp.status === 200 && resp.data.includes('torrent-list')) {
          console.log(`[${this.name}] Connected to active mirror: ${mirror}`);
          return mirror;
        }
      } catch (err: any) {
        console.warn(`[${this.name}] Mirror ${mirror} unreachable or blocked. Trying next...`);
      }
    }

    throw new Error(`[${this.name}] All Nyaa mirrors are down or blocked.`);
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting Nyaa anime crawl (maxPages=${maxPages})...`);
    
    let workingMirror: string;
    try {
      workingMirror = await this.getWorkingMirror();
    } catch (error: any) {
      console.error(error.message);
      return []; // Aborta inmediatamente si Nyaa está totalmente caído
    }

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

    // Consultas a categorías de anime subtitulado en inglés y español
    const queryEndpoints: string[] = [
      '/?f=0&c=1_2', // Anime - English-translated (SubsPlease, Erai-raws, etc.)
      '/?f=0&c=1_3', // Anime - Non-English-translated (Fansubs en español, etc.)
      '/?f=0&c=0_0&q=spanish',
      '/?f=0&c=0_0&q=latino',
      '/?f=0&c=0_0&q=castellano',
      '/?f=0&c=0_0&q=multisub'
    ];

    for (const endpoint of queryEndpoints) {
      for (let page = 1; page <= maxPages; page++) {
        // Aseguramos que la paginación funcione limpiamente
        const separator = endpoint.includes('?') ? '&' : '?';
        const targetUrl = `${workingMirror}${endpoint}${separator}p=${page}`;

        try {
          console.log(`[${this.name}] Fetching anime catalog: ${targetUrl}`);
          const resp = await this.httpClient.get<string>(targetUrl);
          const html = resp.data;
          
          if (!html || typeof html !== 'string') continue;

          const $ = cheerio.load(html);
          const rows = $('table.torrent-list tbody tr');
          
          if (rows.length === 0) {
            console.log(`[${this.name}] No rows found on ${targetUrl}, stopping pagination for this endpoint.`);
            break; // Si no hay filas, terminamos la paginación para esta categoría
          }

          rows.each((_, tr) => {
            const tds = $(tr).find('td');
            if (tds.length < 7) return;

            // Nyaa usa class="comments" para el link de los comentarios, excluyendo eso nos da el título real
            const titleAnchor = tds.eq(1).find('a:not(.comments)').last();
            const title = titleAnchor.text().trim();
            const viewHref = titleAnchor.attr('href') || '';
            const magnetHref = tds.eq(2).find('a[href^="magnet:"]').attr('href');
            
            if (!title || !magnetHref) return;

            const parsedMag = parseMagnetUri(magnetHref);
            if (!parsedMag?.infoHash) return;

            const infoHash = parsedMag.infoHash.toLowerCase();
            if (uniqueHashes.has(infoHash)) return; // Evita duplicados inter-categorías
            uniqueHashes.add(infoHash);

            const sizeText = tds.eq(3).text().trim();
            const sizeBytes = parseSizeToBytes(sizeText);
            const seeders = parseInt(tds.eq(5).text().trim(), 10) || 0;
            const leechers = parseInt(tds.eq(6).text().trim(), 10) || 0;

            const parsedMeta = parseTorrentTitle(title, 'anime');
            // Como Nyaa a veces mezcla idiomas en 1_3, enviamos el endpoint a detectLanguages como contexto
            const contextCategory = endpoint.includes('1_2') ? 'english' : (endpoint.includes('1_3') ? 'non-english' : 'spanish');
            const langs = detectLanguages(title, ['nyaa', contextCategory]);

            // Descarga directa del .torrent (si existe)
            const torrentHref = tds.eq(2).find('a[href^="/download/"]').attr('href');
            const torrentFileUrl = torrentHref ? this.resolveUrl(torrentHref, workingMirror) : null;
            const sourceUrl = viewHref ? this.resolveUrl(viewHref, workingMirror) : targetUrl;

            results.push({
              imdb_id: null,
              tmdb_id: null,
              kitsu_id: null, // Si en el futuro quieres añadir Kitsun/Anilist ID, aquí irían
              anilist_id: null,
              mal_id: null,
              type: 'anime',
              season: parsedMeta.season,
              episode: parsedMeta.episode,
              absolute_episode: parsedMeta.absoluteEpisode,
              file_index: null,
              info_hash: infoHash,
              magnet_url: magnetHref,
              torrent_file_url: torrentFileUrl,
              source_url: sourceUrl,
              title,
              release_group: parsedMeta.releaseGroup,
              quality: parsedMeta.quality,
              codec: parsedMeta.codec,
              hdr_format: parsedMeta.hdrFormat,
              audio: langs.audio,
              subtitles: langs.subtitles,
              channels: parsedMeta.channels,
              size_bytes: sizeBytes,
              seeders,
              leechers,
              source_tracker: parsedMag.trackers[0] || 'http://nyaa.tracker.wf:7777/announce'
            });
          });
        } catch (err: any) {
          console.warn(`[${this.name}] Failed fetching ${targetUrl}: ${err.message}`);
          break; // Rompe la paginación si Nyaa banea la IP o da timeout
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total unique records discovered: ${results.length}`);
    return results;
  }
}

export default NyaaCrawler;
