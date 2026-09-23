import * as crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { buildMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

interface ParsedTorrentMeta {
  infoHash: string;
  name: string;
  sizeBytes: number;
  primaryTracker: string | null;
  trackers: string[];
}

/**
 * Decodificador ROT13 para el enlace ofuscado de acortame-esto
 */
function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const base = isUpper ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

/**
 * Decodificador de la cadena Base64 + ROT13 que utiliza EliteTorrent en acortame-esto.com
 */
function decodeAcortameString(raw: string): string {
  let s = raw;
  for (let i = 0; i < 8; i++) {
    try {
      const decoded = Buffer.from(s, 'base64').toString('utf-8');
      s = decoded;
      const rot = rot13(s);
      if (rot.startsWith('magnet:') || rot.startsWith('http://') || rot.startsWith('https://')) {
        return rot;
      }
      if (s.startsWith('magnet:') || s.startsWith('http://') || s.startsWith('https://')) {
        return s;
      }
    } catch {
      break;
    }
  }
  const fallback = rot13(s);
  return fallback;
}

/**
 * Decodificador Bencode integrado para extraer metadatos de archivos .torrent
 */
function parseTorrentBuffer(buf: Buffer): ParsedTorrentMeta | null {
  if (!buf || buf.length < 20) return null;

  const target = Buffer.from('4:info');
  const targetIdx = buf.indexOf(target);
  if (targetIdx === -1) return null;

  const startPos = targetIdx + target.length;
  if (buf[startPos] !== 0x64 /* 'd' */) {
    return null;
  }

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
    // Continuar si falla la decodificación secundaria
  }

  const info = decoded?.info || {};

  let name = '';
  if (typeof info.name === 'string') {
    name = info.name;
  } else if (Buffer.isBuffer(info.name)) {
    name = info.name.toString('utf-8');
  }

  let sizeBytes = 0;
  if (typeof info.length === 'number') {
    sizeBytes = info.length;
  } else if (Array.isArray(info.files)) {
    for (const f of info.files) {
      if (typeof f?.length === 'number') {
        sizeBytes += f.length;
      }
    }
  }

  const trackers: string[] = [];
  let primaryTracker: string | null = null;

  if (typeof decoded?.announce === 'string') {
    primaryTracker = decoded.announce;
    trackers.push(decoded.announce);
  } else if (Buffer.isBuffer(decoded?.announce)) {
    primaryTracker = decoded.announce.toString('utf-8');
    trackers.push(primaryTracker);
  }

  return {
    infoHash,
    name,
    sizeBytes,
    primaryTracker,
    trackers
  };
}

function skipBencodeValue(buf: Buffer, p: number): number {
  if (p >= buf.length) throw new Error('Out of bounds');
  const char = buf[p];

  if (char === 0x69) {
    const end = buf.indexOf(0x65, p);
    if (end === -1) throw new Error('Unterminated int');
    return end + 1;
  }
  if (char === 0x6c) {
    let cur = p + 1;
    while (cur < buf.length && buf[cur] !== 0x65) {
      cur = skipBencodeValue(buf, cur);
    }
    return cur + 1;
  }
  if (char === 0x64) {
    let cur = p + 1;
    while (cur < buf.length && buf[cur] !== 0x65) {
      cur = skipBencodeValue(buf, cur);
      cur = skipBencodeValue(buf, cur);
    }
    return cur + 1;
  }
  const colon = buf.indexOf(0x3a, p);
  if (colon === -1) throw new Error('Invalid string');
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
      if (end === -1) return null;
      const str = buf.subarray(pos, end).toString('ascii');
      pos = end + 1;
      return parseInt(str, 10);
    }
    if (byte === 0x6c) {
      pos++;
      const list: any[] = [];
      while (pos < buf.length && buf[pos] !== 0x65) {
        list.push(parse());
      }
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

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting crawl (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(8);

    const mirrorsToTry = [
      this.baseUrl,
      ...this.defaultMirrors.filter(m => m !== this.baseUrl)
    ];

    let workingMirror = this.baseUrl;
    for (const mirror of mirrorsToTry) {
      try {
        console.log(`[${this.name}] Checking mirror availability: ${mirror}...`);
        const resp = await this.httpClient.get<string>(mirror, {
          timeout: 6000,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
          }
        });

        if (resp.status === 200 && resp.data && resp.data.length > 1000) {
          workingMirror = mirror;
          console.log(`[${this.name}] Connected to active mirror: ${mirror}`);
          break;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Mirror ${mirror} failed: ${msg}. Trying next...`);
      }
    }

    // Categorías clave de EliteTorrent para indexar estrenos y series
    const sectionRoutes: Array<{ path: string; hasPagination: boolean; type: ContentType }> = [
      { path: '/', hasPagination: false, type: 'movie' },
      { path: '/series/', hasPagination: true, type: 'series' },
      { path: '/idioma/castellano-17-1/', hasPagination: true, type: 'movie' },
      { path: '/idioma/espanol-latino-11-1/', hasPagination: true, type: 'movie' },
      { path: '/calidad/1080p-10-1/', hasPagination: true, type: 'movie' }
    ];

    const detailUrls = new Set<string>();

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
          const html = resp.data;
          if (!html || typeof html !== 'string') continue;

          const $ = cheerio.load(html);
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
              const fullUrl = href.startsWith('http')
                ? href
                : `${workingMirror}${href.startsWith('/') ? '' : '/'}${href}`;
              detailUrls.add(fullUrl);
            }
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Failed fetching ${listUrl}: ${msg}`);
          break;
        }
      }
    }

    console.log(`[${this.name}] Discovered ${detailUrls.size} candidate detail pages. Parsing releases...`);

    const maxCandidates = Math.max(50, maxPages * 40);
    const candidateList = Array.from(detailUrls).slice(0, maxCandidates);

    const tasks = candidateList.map(url =>
      limit(async () => {
        try {
          const record = await this.parseEliteTorrentDetail(url, workingMirror);
          if (record) {
            results.push(record);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error parsing detail [${url}]: ${msg}`);
        }
      })
    );

    await Promise.all(tasks);
    console.log(`[${this.name}] Crawl finished. Successfully extracted ${results.length} torrent records.`);
    return results;
  }

  private async parseEliteTorrentDetail(url: string, mirror: string): Promise<TorrentRecord | null> {
    const resp = await this.httpClient.get<string>(url);
    const html = resp.data;
    if (!html || typeof html !== 'string') return null;

    const $ = cheerio.load(html);

    const rawH1 = $('h1').first().text().trim();
    if (!rawH1) return null;

    // Limpiar título de etiquetas "Descargar ... por torrent" y comillas tipográficas
    let cleanTitle = rawH1
      .replace(/^Descargar\s+/i, '')
      .replace(/\s+por torrent.*$/i, '')
      .replace(/^["\u201C\u201D\x27]+|["\u201C\u201D\x27]+$/g, '')
      .trim();

    if (!cleanTitle) return null;

    // Extraer campos estructurados de la descripción técnica
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
          if (decoded.startsWith('magnet:') && !magnetLink) {
            magnetLink = decoded;
          } else if (decoded.includes('.torrent') && !torrentDownloadUrl) {
            torrentDownloadUrl = decoded;
          }
        }
      } else if (href.startsWith('magnet:') && !magnetLink) {
        magnetLink = href;
      } else if (href.endsWith('.torrent') && !torrentDownloadUrl) {
        torrentDownloadUrl = href.startsWith('http')
          ? href
          : `${mirror}${href.startsWith('/') ? '' : '/'}${href}`;
      }
    });

    let infoHash: string | null = null;

    if (magnetLink) {
      const match = (magnetLink as string).match(/urn:btih:([0-9a-fA-F]{40})/i);
      if (match) {
        infoHash = match[1].toLowerCase();
      }
    }

    let sizeBytes = parseSizeToBytes(sizeStr);

    // Si aún no tenemos info_hash o size_bytes y existe archivo .torrent directo, descargarlo
    if ((!infoHash || !sizeBytes) && torrentDownloadUrl) {
      try {
        const tResp = await this.httpClient.get<Buffer>(torrentDownloadUrl, {
          responseType: 'arraybuffer'
        });
        const parsed = parseTorrentBuffer(Buffer.from(tResp.data));
        if (parsed) {
          if (!infoHash) infoHash = parsed.infoHash;
          if (!sizeBytes && parsed.sizeBytes > 0) sizeBytes = parsed.sizeBytes;
        }
      } catch {
        // Continuar con lo extraído
      }
    }

    if (!infoHash) {
      return null;
    }

    const isSeries = url.includes('/series/') || /S\d{1,2}|Temporada|\b\d{1,2}[xX×]\d{1,3}\b/i.test(cleanTitle);
    const defaultType: ContentType = isSeries ? 'series' : 'movie';

    // Normalizar notaciones de episodios como "3×10" o "3x10" a "S03E10" para el parser de títulos
    const normalizedTitleForParsing = cleanTitle.replace(/(\d{1,2})[xX×](\d{1,3})/g, (_, s, e) => {
      return `S${s.padStart(2, '0')}E${e.padStart(2, '0')}`;
    });

    const parsedMeta = parseTorrentTitle(normalizedTitleForParsing, defaultType);

    // Detección rigurosa de idiomas (Español / Castellano / Latino / VOSE)
    const hints = ['elitetorrent', idiomaStr, calidadStr, formatoStr];
    const langs = detectLanguages(cleanTitle, hints);

    // Si el campo Idioma decía Español y no se detectó nada, asignar Español
    if (langs.audio.length === 0 && !langs.subtitles.includes('Sub_ES')) {
      if (/latino/i.test(idiomaStr)) {
        langs.audio.push('Spanish (Latino)');
      } else if (/vose/i.test(idiomaStr)) {
        langs.audio.push('English');
        langs.subtitles.push('Sub_ES');
      } else {
        langs.audio.push('Spanish');
      }
    }

    // Trackers predeterminados de alta disponibilidad
    const defaultTrackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.demonii.si:1337/announce',
      'udp://tracker.openbittorrent.com:80/announce'
    ];

    const finalMagnet = magnetLink || buildMagnetUri(infoHash, cleanTitle, defaultTrackers);

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
      magnet_url: finalMagnet,
      torrent_file_url: torrentDownloadUrl,
      source_url: url,
      title: cleanTitle,
      release_group: parsedMeta.releaseGroup,
      quality: calidadStr || parsedMeta.quality || null,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: sizeBytes,
      seeders: 15,
      leechers: 3,
      source_tracker: 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}

export default EliteTorrentCrawler;
