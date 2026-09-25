import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { parseMagnetUri, buildMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

export class TorrentGalaxyCrawler extends BaseCrawler {
  public readonly name = 'torrentgalaxy';
  
  // Lista de espejos de alta disponibilidad
  private readonly mirrors = [
    'https://torrentgalaxy.to', // Dominio principal actual
    'https://torrentgalaxy.one',
    'https://en.torrentgalaxy-official.is',
    'https://torrentgalaxy.buzz',
    'https://torrentgalaxy.su'
  ];

  /**
   * Determina cuál espejo está vivo ANTES de empezar el escaneo masivo
   */
  private async getWorkingMirror(): Promise<string | null> {
    for (const mirror of this.mirrors) {
      try {
        console.log(`[${this.name}] Testing mirror: ${mirror}...`);
        const resp = await this.httpClient.get<string>(mirror, { timeout: 7000 });
        
        // Verificamos que devuelva HTML válido de TGX
        if (resp.status === 200 && resp.data && resp.data.includes('tgx')) {
          console.log(`[${this.name}] Active mirror found: ${mirror}`);
          return mirror;
        }
      } catch (err: any) {
        console.warn(`[${this.name}] Mirror ${mirror} unreachable: ${err.message}`);
      }
    }
    return null;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting TorrentGalaxy crawl (maxPages=${maxPages})...`);
    
    const activeMirror = await this.getWorkingMirror();
    if (!activeMirror) {
      console.error(`[${this.name}] CRITICAL: No working mirrors found. Aborting crawl.`);
      return [];
    }

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>(); // Para evitar duplicados entre categorías

    // Endpoints estratégicos. Agregamos sort=id&order=desc para asegurar que traemos los más recientes
    const endpoints = [
      '/movies',
      '/torrents.php?search=spanish&sort=id&order=desc',
      '/torrents.php?search=latino&sort=id&order=desc',
      '/torrents.php?cat=41&sort=id&order=desc', // 4K Movies
      '/torrents.php?cat=42&sort=id&order=desc'  // HD Movies
    ];

    for (const endpoint of endpoints) {
      console.log(`[${this.name}] Crawling endpoint: ${endpoint}`);
      
      for (let page = 0; page < maxPages; page++) {
        // En TGX, el parámetro page es 0-indexed
        const pageSeparator = endpoint.includes('?') ? '&' : '?';
        const targetPath = `${endpoint}${pageSeparator}page=${page}`;
        const fullUrl = `${activeMirror}${targetPath}`;

        try {
          console.log(`[${this.name}] Fetching page ${page}: ${fullUrl}`);
          const resp = await this.httpClient.get<string>(fullUrl);
          
          if (!resp.data || typeof resp.data !== 'string') continue;

          const records = this.parseTorrentGalaxyHtml(resp.data, fullUrl, activeMirror);
          
          let addedInPage = 0;
          for (const record of records) {
            if (!uniqueHashes.has(record.info_hash)) {
              uniqueHashes.add(record.info_hash);
              results.push(record);
              addedInPage++;
            }
          }

          console.log(`[${this.name}] Extracted ${addedInPage} new records from page ${page}.`);

          // Si la página no devolvió torrents, significa que llegamos al final de la paginación para esa categoría
          if (records.length === 0) {
            console.log(`[${this.name}] No more records found. Moving to next endpoint.`);
            break; 
          }
          
        } catch (err: any) {
          console.warn(`[${this.name}] Failed fetching ${fullUrl}: ${err.message}. Skipping page.`);
          break; // Si da error 404/500, saltamos a la siguiente categoría
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total unique records retrieved: ${results.length}`);
    return results;
  }

  private parseTorrentGalaxyHtml(html: string, sourceUrl: string, activeMirror: string): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    // Selector más estricto: TGX usa '.tgxtablerow' para las filas de datos.
    // Evitamos 'table tbody tr' genérico porque puede capturar tablas de maquetación del header.
    $('.tgxtablerow').each((_, el) => {
      
      // 1. TÍTULO Y URL
      const titleLink = $(el).find('a.txlight, a[href^="/torrent/"]');
      if (titleLink.length === 0) return; // Fila inválida

      const title = titleLink.attr('title') || titleLink.text().trim();
      const href = titleLink.attr('href') || '';
      const detailUrl = href.startsWith('http') ? href : `${activeMirror}${href}`;

      if (!title) return;

      // 2. MAGNET LINK / INFO HASH
      let magnetHref = $(el).find('a[href^="magnet:?xt="]').first().attr('href');
      let infoHash: string | null = null;

      if (magnetHref) {
        const parsed = parseMagnetUri(magnetHref);
        infoHash = parsed?.infoHash || null;
      } else {
        // Fallback: Si no hay icono de magnet, buscar en el enlace del archivo .torrent
        const itorrentLink = $(el).find('a[href*="/torrent/"][href$=".torrent"]').attr('href') || '';
        const hashMatch = itorrentLink.match(/torrent\/([0-9a-fA-F]{40})/i);
        if (hashMatch) {
          infoHash = hashMatch[1].toLowerCase();
          magnetHref = buildMagnetUri(infoHash, title);
        }
      }

      if (!infoHash || !magnetHref) return; // Sin hash no nos sirve

      // 3. SEEDERS / LEECHERS (Manejando colores estándar de TGX)
      const seedersText = $(el).find('font[color="green"], span.seeders').first().text().trim();
      const leechersText = $(el).find('font[color="#ff0000"], span.leechers').first().text().trim();
      const seeders = parseInt(seedersText.replace(/,/g, ''), 10) || 0; // NUNCA falsear datos (0 por defecto)
      const leechers = parseInt(leechersText.replace(/,/g, ''), 10) || 0;

      // 4. TAMAÑO
      // En TGX, el tamaño suele estar en un div con clase 'badge' o simplemente texto en la celda
      const sizeText = $(el).find('span.badge').first().text().trim() \vert{}\vert{}$(el).find('div.tgxtablecell').eq(3).text().trim();
      const sizeBytes = parseSizeToBytes(sizeText);

      // 5. IMDB ID
      let imdbId: string | null = null;
      const imdbAnchor = $(el).find('a[href*="imdb.com/title/tt"]');
      if (imdbAnchor.length) {
        const match = (imdbAnchor.attr('href') || '').match(/tt\d{7,8}/);
        if (match) imdbId = match[0];
      }

      // 6. METADATOS Y LIMPIEZA
      const isSeries = detailUrl.includes('cat=41') || /S\d{1,2}/i.test(title);
      const defaultType: ContentType = isSeries ? 'series' : 'movie';
      const parsedMeta = parseTorrentTitle(title, defaultType);
      
      // Idiomas: Si es de los endpoints de español, lo pasamos como pista
      const isSpanishEndpoint = sourceUrl.includes('search=spanish') || sourceUrl.includes('search=latino');
      const hints = ['tgx', 'torrentgalaxy'];
      if (isSpanishEndpoint) hints.push('spanish', 'latino');
      
      const langs = detectLanguages(title, hints);

      // Si viene del endpoint latino pero el regex no lo detectó en el título
      if (isSpanishEndpoint && langs.audio.length === 0) {
        langs.audio.push(sourceUrl.includes('latino') ? 'Spanish (Latino)' : 'Spanish');
      }

      records.push({
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
        info_hash: infoHash,
        magnet_url: magnetHref,
        torrent_file_url: null, // TGX redirige a iTorrents, mejor confiar en el magnet
        source_url: detailUrl,
        title: title || parsedMeta.cleanTitle,
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
        source_tracker: 'udp://tracker.opentrackr.org:1337/announce'
      });
    });

    return records;
  }
}
