import * as crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { buildMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';

interface ParsedTorrentFile {
  infoHash: string;
  name: string;
  sizeBytes: number;
  primaryTracker: string | null;
  trackers: string[];
}

// ============================================================================
// BENCODE PARSER (Optimizado)
// ============================================================================
function parseTorrentBuffer(buf: Buffer): ParsedTorrentFile | null {
  if (!buf || buf.length < 20) return null;

  const target = Buffer.from('4:info');
  const targetIdx = buf.indexOf(target);
  if (targetIdx === -1) return null;

  const startPos = targetIdx + target.length;
  if (buf[startPos] !== 0x64 /* 'd' */) return null;

  let endPos: number;
  try {
    endPos = skipBencodeValue(buf, startPos);
  } catch {
    return null;
  }

  const infoSlice = buf.subarray(startPos, endPos);
  const infoHash = crypto.createHash('sha1').update(infoSlice).digest('hex').toLowerCase();

  let decoded: Record<string, any> | null = null;
  try {
    decoded = decodeBencode(buf) as Record<string, any>;
  } catch {
    // Tolerancia a fallos: nos basta con el infoHash si el resto falla
  }

  const info = decoded?.info || {};

  const name = typeof info.name === 'string' 
    ? info.name 
    : (Buffer.isBuffer(info.name) ? info.name.toString('utf-8') : '');

  let sizeBytes = 0;
  if (typeof info.length === 'number') {
    sizeBytes = info.length;
  } else if (Array.isArray(info.files)) {
    for (const f of info.files) {
      if (typeof f?.length === 'number') sizeBytes += f.length;
    }
  }

  const trackers = new Set<string>();
  let primaryTracker: string | null = null;

  const announceRaw = decoded?.announce;
  if (announceRaw) {
    primaryTracker = Buffer.isBuffer(announceRaw) ? announceRaw.toString('utf-8') : String(announceRaw);
    trackers.add(primaryTracker);
  }

  if (Array.isArray(decoded?.['announce-list'])) {
    for (const tier of decoded['announce-list']) {
      if (Array.isArray(tier)) {
        for (const tr of tier) {
          const trStr = Buffer.isBuffer(tr) ? tr.toString('utf-8') : (typeof tr === 'string' ? tr : null);
          if (trStr) trackers.add(trStr);
        }
      }
    }
  }

  return { infoHash, name, sizeBytes, primaryTracker, trackers: Array.from(trackers) };
}

function skipBencodeValue(buf: Buffer, p: number): number {
  if (p >= buf.length) throw new Error('Out of bounds');
  const char = buf[p];

  if (char === 0x69) { // 'i'
    const end = buf.indexOf(0x65, p); // 'e'
    if (end === -1) throw new Error('Unterminated int');
    return end + 1;
  }
  if (char === 0x6c || char === 0x64) { // 'l' or 'd'
    let cur = p + 1;
    while (cur < buf.length && buf[cur] !== 0x65) {
      cur = skipBencodeValue(buf, cur);
      if (char === 0x64) cur = skipBencodeValue(buf, cur); // dict value
    }
    return cur + 1;
  }
  
  // String
  const colon = buf.indexOf(0x3a, p); // ':'
  if (colon === -1) throw new Error('Invalid string');
  const len = parseInt(buf.subarray(p, colon).toString('ascii'), 10);
  if (isNaN(len)) throw new Error('Invalid string length');
  return colon + 1 + len;
}

function decodeBencode(buf: Buffer): any {
  let pos = 0;
  function parse(): any {
    if (pos >= buf.length) return null;
    const byte = buf[pos];

    if (byte === 0x69) {
      pos++;
      const end = buf.indexOf(0x65, pos);
      if (end === -1) return null;
      const str = buf.subarray(pos, end).toString('ascii');
      pos = end + 1;
      return parseInt(str, 10);
    }
    if (byte === 0x6c) {
      pos++;
      const list: any[] = [];
      while (pos < buf.length && buf[pos] !== 0x65) list.push(parse());
      pos++;
      return list;
    }
    if (byte === 0x64) {
      pos++;
      const dict: Record<string, any> = {};
      while (pos < buf.length && buf[pos] !== 0x65) {
        const key = parse();
        const val = parse();
        if (typeof key === 'string') dict[key] = val;
      }
      pos++;
      return dict;
    }
    
    const colon = buf.indexOf(0x3a, pos);
    if (colon === -1) return null;
    const len = parseInt(buf.subarray(pos, colon).toString('ascii'), 10);
    pos = colon + 1;
    const valBuf = buf.subarray(pos, pos + len);
    pos += len;
    return valBuf.toString('utf-8');
  }
  return parse();
}

// ============================================================================
// CRAWLER
// ============================================================================
export class MejorTorrentCrawler extends BaseCrawler {
  public readonly name = 'mejortorrent';
  public readonly baseUrl: string;
  private readonly CONCURRENCY = 8;

  private readonly defaultMirrors = [
    'https://www45.mejortorrent.eu',
    'https://mejortorrent.me',
    'https://mejortorrent.wtf',
    'https://mejortorrent.app'
  ];

  constructor() {
    super();
    this.baseUrl = process.env.MEJORTORRENT_BASE_URL || 'https://www45.mejortorrent.eu';
  }

  /**
   * Resuelve URLs relativas de forma segura
   */
  private resolveUrl(target: string, base: string): string {
    try {
      return new URL(target, base).href;
    } catch {
      return target; // Fallback
    }
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting crawl across movies and series (maxPages=${maxPages})...`);
    
    const mirrorsToTry = [this.baseUrl, ...this.defaultMirrors.filter(m => m !== this.baseUrl)];
    let workingMirror: string | null = null;
    let mirrorMode: 'legacy_eu' | 'modern_me' = 'legacy_eu';

    // 1. Detectar el primer mirror vivo y sin bloqueo de Cloudflare
    for (const mirror of mirrorsToTry) {
      try {
        console.log(`[${this.name}] Testing connectivity to ${mirror}...`);
        const resp = await this.httpClient.get<string>(mirror, {
          timeout: 5000,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
          }
        });

        const html = resp.data || '';
        if (resp.status === 200 && !/Just a moment|Un momento|cf-mitigated/i.test(html)) {
          workingMirror = mirror;
          // Heurística de detección de template
          mirrorMode = html.includes('wp-json/wp/v2') ? 'modern_me' : 'legacy_eu';
          console.log(`[${this.name}] Connected to active endpoint: ${mirror} (mode=${mirrorMode})`);
          break;
        }
      } catch (err: unknown) {
        console.warn(`[${this.name}] Mirror ${mirror} unreachable. Trying next...`);
      }
    }

    if (!workingMirror) {
      console.warn(`[${this.name}] All mirrors failed or blocked. Defaulting to https://mejortorrent.me...`);
      workingMirror = 'https://mejortorrent.me';
      mirrorMode = 'modern_me';
    }

    const limit = pLimit(this.CONCURRENCY);
    const records = mirrorMode === 'legacy_eu' 
      ? await this.crawlLegacyEuMode(workingMirror, maxPages, limit)
      : await this.crawlModernMeMode(workingMirror, maxPages, limit);

    console.log(`[${this.name}] Crawl completed. Total records discovered: ${records.length}`);
    return records;
  }

  // ==========================================================================
  // MODE: LEGACY EU (.eu, .wtf, .app)
  // ==========================================================================
  private async crawlLegacyEuMode(mirror: string, maxPages: number, limit: ReturnType<typeof pLimit>): Promise<TorrentRecord[]> {
    const results: TorrentRecord[] = [];
    const detailUrls = new Set<string>();

    const categories = [
      { path: '/inicio', type: 'movie' },
      { path: '/peliculas-hd', type: 'movie' },
      { path: '/series-hd', type: 'series' }
    ];

    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        let listUrl = `${mirror}${cat.path}`;
        if (page > 1) {
          if (cat.path === '/inicio') break;
          listUrl = `${mirror}${cat.path}/page/${page}`;
        }

        try {
          const resp = await this.httpClient.get<string>(listUrl);
          if (!resp.data || typeof resp.data !== 'string') continue;

          const $= cheerio.load(resp.data);$('a[href*="/pelicula/"], a[href*="/serie/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && !/genre|year|quality/i.test(href)) {
              detailUrls.add(this.resolveUrl(href, mirror));
            }
          });
        } catch {
          break; // Si falla la pagina, salta a la siguiente categoría
        }
      }
    }

    const tasks = Array.from(detailUrls).slice(0, maxPages * 35).map(url =>
      limit(async () => {
        try {
          const resp = await this.httpClient.get<string>(url);
          const $ = cheerio.load(resp.data);
          
          let title = $('h1').first().text().trim() || $('title').text().replace(/\Vert{}.*$/, '').trim();
          const defaultType: ContentType = url.includes('/serie/') ? 'series' : 'movie';
          const torrentAnchors = $('a[href*="/torrents/"][href$=".torrent"], a:contains("Descargar")');

          for (let i = 0; i < torrentAnchors.length; i++) {
            const a = torrentAnchors.eq(i);
            const href = a.attr('href');
            if (!href?.endsWith('.torrent')) continue;

            const torrentUrl = this.resolveUrl(href, mirror);
            let itemTitle = title;
            
            // Si es serie, trata de extraer el episodio de la tabla
            if (defaultType === 'series') {
              const epText = a.closest('tr').find('td').eq(1).text().trim();
              if (epText) itemTitle = `${title} ${epText}`;
            }

            const record = await this.downloadAndBuildRecord(torrentUrl, url, itemTitle, defaultType);
            if (record) results.push(record);
          }
        } catch (err: any) {
          console.warn(`[${this.name}] Error parsing EU detail ${url}: ${err.message}`);
        }
      })
    );

    await Promise.all(tasks);
    return results;
  }

  // ==========================================================================
  // MODE: MODERN ME (API REST de WordPress + Scraping)
  // ==========================================================================
  private async crawlModernMeMode(mirror: string, maxPages: number, limit: ReturnType<typeof pLimit>): Promise<TorrentRecord[]> {
    const results: TorrentRecord[] = [];
    const detailUrls = new Set<string>();

    // 1. Obtener links vía WordPress API (Más rápido y preciso)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const apiUrl = `${mirror}/wp-json/wp/v2/posts?page=${page}&per_page=30`;
        const resp = await this.httpClient.get<Array<{ link: string }>>(apiUrl);
        if (Array.isArray(resp.data)) {
          resp.data.forEach(post => post.link && detailUrls.add(this.resolveUrl(post.link, mirror)));
        }
      } catch {
        break;
      }
    }

    const tasks = Array.from(detailUrls).slice(0, maxPages * 40).map(url =>
      limit(async () => {
        try {
          const resp = await this.httpClient.get<string>(url);
          const $ = cheerio.load(resp.data);
          
          const torrentUrls = new Set<string>();
          $('a[href$=".torrent"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href) torrentUrls.add(this.resolveUrl(href, mirror));
          });

          // Fallback regex if no standard anchors found
          if (torrentUrls.size === 0) {
            const matches = resp.data.match(/https?:\/\/[^\s"'<>]+\.torrent/gi);
            matches?.forEach(m => torrentUrls.add(m));
          }

          const pageText = resp.data.toLowerCase();
          const defaultType: ContentType = /(temporada|episodios|s\d{1,2})/i.test(pageText) ? 'series' : 'movie';
          const pageTitle = $('h1').first().text().trim() || url.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') || '';

          for (const torrentUrl of torrentUrls) {
            if (torrentUrl.toLowerCase().includes('thimbleweed')) continue; // Exclusión quemada
            
            const record = await this.downloadAndBuildRecord(torrentUrl, url, pageTitle, defaultType);
            if (record) results.push(record);
          }
        } catch (err: any) {
          console.warn(`[${this.name}] Error parsing ME detail ${url}: ${err.message}`);
        }
      })
    );

    await Promise.all(tasks);
    return results;
  }

  // ==========================================================================
  // UNIFIED TORRENT PROCESSOR (DRY)
  // ==========================================================================
  private async downloadAndBuildRecord(
    torrentUrl: string,
    sourceUrl: string,
    fallbackTitle: string,
    defaultType: ContentType
  ): Promise<TorrentRecord | null> {
    try {
      const resp = await this.httpClient.get<ArrayBuffer>(torrentUrl, { responseType: 'arraybuffer' });
      const buf = Buffer.from(resp.data);
      
      const parsedTorrent = parseTorrentBuffer(buf);
      if (!parsedTorrent || !parsedTorrent.infoHash) return null;
      if (parsedTorrent.name.toLowerCase().includes('thimbleweed')) return null;

      const effectiveTitle = (parsedTorrent.name && parsedTorrent.name.length > 3) 
        ? parsedTorrent.name 
        : fallbackTitle;

      const parsedMeta = parseTorrentTitle(effectiveTitle, defaultType);
      
      // Regla de dominio: MejorTorrent es español por defecto
      const langs = detectLanguages(effectiveTitle, ['mejortorrent', 'castellano']);
      if (langs.audio.length === 0) langs.audio.push('Castellano');

      const magnetUrl = buildMagnetUri(parsedTorrent.infoHash, effectiveTitle, parsedTorrent.trackers);
      const isSeries = parsedMeta.type === 'series';

      return {
        imdb_id: null,
        tmdb_id: null,
        kitsu_id: null,
        anilist_id: null,
        mal_id: null,
        type: parsedMeta.type,
        season: parsedMeta.season,
        episode: parsedMeta.episode,
        absolute_episode: parsedMeta.absoluteEpisode,
        file_index: null,
        info_hash: parsedTorrent.infoHash,
        magnet_url: magnetUrl,
        torrent_file_url: torrentUrl,
        source_url: sourceUrl,
        title: effectiveTitle,
        release_group: parsedMeta.releaseGroup,
        quality: parsedMeta.quality,
        codec: parsedMeta.codec,
        hdr_format: parsedMeta.hdrFormat,
        audio: langs.audio,
        subtitles: langs.subtitles,
        channels: parsedMeta.channels,
        size_bytes: parsedTorrent.sizeBytes || null,
        seeders: isSeries ? 15 : 10,
        leechers: isSeries ? 3 : 2,
        source_tracker: parsedTorrent.primaryTracker || 'udp://tracker.opentrackr.org:1337/announce'
      };
    } catch (err: any) {
      console.warn(`[${this.name}] Failed to process torrent ${torrentUrl}: ${err.message}`);
      return null;
    }
  }
}

export default MejorTorrentCrawler;
