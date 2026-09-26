import * as crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { buildMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

export class EliteTorrentCrawler extends BaseCrawler {
  public readonly name = 'elitetorrent';
  public readonly baseUrl: string;

  private readonly defaultMirrors = [
    'https://www.elitetorrent.com',
    'https://elitetorrent.li',
    'https://elitetorrent.app'
  ];

  constructor() {
    super();
    this.baseUrl = process.env.ELITETORRENT_BASE_URL || 'https://www.elitetorrent.com';
  }

  private async getWorkingMirror(): Promise<string | null> {
    const mirrorsToTry = [this.baseUrl, ...this.defaultMirrors.filter(m => m !== this.baseUrl)];

    for (const mirror of mirrorsToTry) {
      try {
        console.log(`[${this.name}] Checking mirror: ${mirror}...`);
        const resp = await this.httpClient.get<string>(mirror, {
          timeout: 6000,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
          }
        });

        if (resp.status === 200 && resp.data && resp.data.length > 1000) {
          console.log(`[${this.name}] Connected to active mirror: ${mirror}`);
          return mirror;
        }
      } catch (err: any) {
        console.warn(`[${this.name}] Mirror ${mirror} failed: ${err.message}`);
      }
    }
    return null;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting EliteTorrent crawl (maxPages=${maxPages})...`);
    
    const workingMirror = await this.getWorkingMirror();
    if (!workingMirror) {
      console.error(`[${this.name}] CRITICAL: No working mirrors found. Aborting.`);
      return [];
    }

    const results: TorrentRecord[] = [];
    const visitedUrls = new Set<string>();
    const limit = pLimit(5);

    const sectionRoutes: Array<{ path: string; hasPagination: boolean; type: ContentType }> = [
      { path: '/', hasPagination: false, type: 'movie' },
      { path: '/series/', hasPagination: true, type: 'series' },
      { path: '/idioma/castellano-17-1/', hasPagination: true, type: 'movie' },
      { path: '/idioma/espanol-latino-11-1/', hasPagination: true, type: 'movie' },
      { path: '/calidad/1080p-10-1/', hasPagination: true, type: 'movie' }
    ];

    for (const route of sectionRoutes) {
      const pagesToCrawl = route.hasPagination ? maxPages : 1;

      for (let page = 1; page <= pagesToCrawl; page++) {
        let listUrl = `${workingMirror}${route.path}`;
        if (page > 1) {
          listUrl = `${workingMirror}${route.path.replace(/\/$/, '')}/page/${page}/`;
        }

        try {
          console.log(`[${this.name}] Fetching listing: ${listUrl}`);
          const resp = await this.httpClient.get<string>(listUrl);
          
          if (!resp.data) continue;
          const $ = cheerio.load(resp.data);
          const pageDetailUrls: string[] = [];

          $('a[href*="/peliculas/"], a[href*="/series/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (
              href &&
              (href.includes('/peliculas/') || href.includes('/series/')) &&
              !href.endsWith('/peliculas-1/') &&
              !href.endsWith('/series/') &&
              !href.includes('/feed/') &&
              !href.includes('/page/')
            ) {
              const fullUrl = href.startsWith('http') ? href : `${workingMirror}${href.startsWith('/') ? '' : '/'}${href}`;
              
              if (!visitedUrls.has(fullUrl)) {
                visitedUrls.add(fullUrl);
                pageDetailUrls.push(fullUrl);
              }
            }
          });

          if (pageDetailUrls.length === 0) {
            console.log(`[${this.name}] No new records found on page ${page} for ${route.path}. Stopping route.`);
            break;
          }

          console.log(`[${this.name}] Found ${pageDetailUrls.length} new items on page ${page}. Parsing details...`);

          const pageTasks = pageDetailUrls.map(url =>
            limit(async () => {
              try {
                const record = await this.parseEliteTorrentDetail(url, workingMirror);
                if (record) results.push(record);
              } catch (err: any) {
                console.warn(`[${this.name}] Error parsing detail [${url}]: ${err.message}`);
              }
            })
          );

          await Promise.all(pageTasks);

        } catch (err: any) {
          console.warn(`[${this.name}] Failed fetching ${listUrl}: ${err.message}. Skipping to next route.`);
          break;
        }
      }
    }

    console.log(`[${this.name}] Crawl finished. Successfully extracted ${results.length} torrent records.`);
    return results;
  }

  private async parseEliteTorrentDetail(url: string, mirror: string): Promise<TorrentRecord | null> {
    const resp = await this.httpClient.get<string>(url);
    if (!resp.data) return null;

    const $ = cheerio.load(resp.data);
    const rawH1 = $('h1').first().text().trim();
    if (!rawH1) return null;

    let cleanTitle = rawH1
      .replace(/^Descargar\s+/i, '')
      .replace(/\s+por torrent.*$/i, '')
      .replace(/^["\u201C\u201D\x27]+|["\u201C\u201D\x27]+$/g, '')
      .trim();

    if (!cleanTitle) return null;

    let sizeStr = '';
    let idiomaStr = '';
    let calidadStr = '';
    let formatoStr = '';

    $('p.descrip span').each((_, el) => {
      const txt = $(el).text();
      if (txt.includes('Tamaño:')) sizeStr = txt.replace('Tamaño:', '').trim();
      if (txt.includes('Idioma:')) idiomaStr = txt.replace('Idioma:', '').trim();
      if (txt.includes('Calidad:')) calidadStr = txt.replace('Calidad:', '').trim();
      if (txt.includes('Formato:')) formatoStr = txt.replace('Formato:', '').trim();
    });

    let magnetLink: string | null = null;
    let torrentDownloadUrl: string | null = null;

    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('acortame-esto.com/s.php?i=')) {
        const param = href.split('?i=')[1];
        if (param) {
          const decoded = decodeAcortameString(param);
          if (decoded.startsWith('magnet:') && !magnetLink) magnetLink = decoded;
          else if (decoded.includes('.torrent') && !torrentDownloadUrl) torrentDownloadUrl = decoded;
        }
      } else if (href.startsWith('magnet:') && !magnetLink) {
        magnetLink = href;
      } else if (href.endsWith('.torrent') && !torrentDownloadUrl) {
        torrentDownloadUrl = href.startsWith('http') ? href : `${mirror}${href.startsWith('/') ? '' : '/'}${href}`;
      }
    });

    let infoHash: string | null = null;
    if (magnetLink) {
      const match = (magnetLink as string).match(/urn:btih:([0-9a-fA-F]{40})/i);
      if (match) infoHash = match[1].toLowerCase();
    }

    let sizeBytes = parseSizeToBytes(sizeStr);

    if ((!infoHash || !sizeBytes) && torrentDownloadUrl) {
      try {
        const tResp = await this.httpClient.get<Buffer>(torrentDownloadUrl, { responseType: 'arraybuffer' });
        const parsed = parseTorrentBuffer(Buffer.from(tResp.data));
        if (parsed) {
          if (!infoHash) infoHash = parsed.infoHash;
          if (!sizeBytes && parsed.sizeBytes > 0) sizeBytes = parsed.sizeBytes;
        }
      } catch {
        // Ignorar error
      }
    }

    if (!infoHash) return null;

    const isSeries = url.includes('/series/') || /S\d{1,2}|Temporada|\b\d{1,2}[xX×]\d{1,3}\b/i.test(cleanTitle);
    const defaultType: ContentType = isSeries ? 'series' : 'movie';

    const normalizedTitleForParsing = cleanTitle.replace(/(\d{1,2})[xX×](\d{1,3})/g, (_, s, e) => {
      return `S${s.padStart(2, '0')}E${e.padStart(2, '0')}`;
    });

    const parsedMeta = parseTorrentTitle(normalizedTitleForParsing, defaultType);
    const hints = ['elitetorrent', idiomaStr, calidadStr, formatoStr];
    const langs = detectLanguages(cleanTitle, hints);

    if (langs.audio.length === 0 && !langs.subtitles.includes('Sub_ES')) {
      if (/latino/i.test(idiomaStr)) langs.audio.push('Spanish (Latino)');
      else if (/vose/i.test(idiomaStr)) {
        langs.audio.push('English');
        langs.subtitles.push('Sub_ES');
      } else langs.audio.push('Spanish');
    }

    const defaultTrackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.demonii.si:1337/announce',
      'udp://tracker.openbittorrent.com:80/announce'
    ];

    const metaAny = parsedMeta as any;

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
      info_hash: infoHash,
      magnet_url: magnetLink || buildMagnetUri(infoHash, cleanTitle, defaultTrackers),
      torrent_file_url: torrentDownloadUrl,
      source_url: url,
      title: cleanTitle,
      release_group: parsedMeta.releaseGroup,
      quality: calidadStr || metaAny.quality || metaAny.resolution || null,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: sizeBytes,
      seeders: 0,
      leechers: 0,
      source_tracker: 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}

interface ParsedTorrentMeta {
  infoHash: string;
  name: string;
  sizeBytes: number;
  primaryTracker: string | null;
  trackers: string[];
}

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 65 && code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

function decodeAcortameString(raw: string): string {
  let s = raw;
  for (let i = 0; i < 8; i++) {
    try {
      s = Buffer.from(s, 'base64').toString('utf-8');
      const rot = rot13(s);
      if (/^(magnet:|http:\/\/|https:\/\/)/.test(rot)) return rot;
      if (/^(magnet:|http:\/\/|https:\/\/)/.test(s)) return s;
    } catch {
      break;
    }
  }
  return rot13(s);
}

function parseTorrentBuffer(buf: Buffer): ParsedTorrentMeta | null {
  if (!buf || buf.length < 20) return null;
  const target = Buffer.from('4:info');
  const targetIdx = buf.indexOf(target);
  if (targetIdx === -1) return null;

  const startPos = targetIdx + target.length;
  if (buf[startPos] !== 0x64) return null;

  try {
    const endPos = skipBencodeValue(buf, startPos);
    const infoSlice = buf.subarray(startPos, endPos);
    const infoHash = crypto.createHash('sha1').update(infoSlice).digest('hex').toLowerCase();
    
    const decoded = decodeBencode(buf) as Record<string, any>;
    const info = decoded?.info || {};

    let sizeBytes = typeof info.length === 'number' ? info.length : 0;
    if (Array.isArray(info.files)) {
      sizeBytes = info.files.reduce((acc: number, f: any) => acc + (typeof f?.length === 'number' ? f.length : 0), 0);
    }

    const primaryTracker = typeof decoded?.announce === 'string' ? decoded.announce : (Buffer.isBuffer(decoded?.announce) ? decoded.announce.toString('utf-8') : null);

    return {
      infoHash,
      name: typeof info.name === 'string' ? info.name : (Buffer.isBuffer(info.name) ? info.name.toString('utf-8') : ''),
      sizeBytes,
      primaryTracker,
      trackers: primaryTracker ? [primaryTracker] : []
    };
  } catch {
    return null;
  }
}

function skipBencodeValue(buf: Buffer, p: number): number {
  if (p >= buf.length) throw new Error('Out of bounds');
  const char = buf[p];
  if (char === 0x69) return buf.indexOf(0x65, p) + 1;
  if (char === 0x6c || char === 0x64) {
    let cur = p + 1;
    while (cur < buf.length && buf[cur] !== 0x65) cur = skipBencodeValue(buf, cur);
    return cur + 1;
  }
  const colon = buf.indexOf(0x3a, p);
  const len = parseInt(buf.subarray(p, colon).toString('ascii'), 10);
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
      const str = buf.subarray(pos, end).toString('ascii');
      pos = end + 1;
      return parseInt(str, 10);
    }
    if (byte === 0x6c) {
      pos++;
      const list = [];
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
    const len = parseInt(buf.subarray(pos, colon).toString('ascii'), 10);
    pos = colon + 1;
    const valBuf = buf.subarray(pos, pos + len);
    pos += len;
    return valBuf.toString('utf-8');
  }
  return parse();
}

export default EliteTorrentCrawler;
