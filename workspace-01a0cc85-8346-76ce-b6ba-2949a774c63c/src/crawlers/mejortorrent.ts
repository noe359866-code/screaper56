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

/**
 * Decodificador Bencode integrado para extraer info_hash y metadatos de archivos .torrent
 */
function parseTorrentBuffer(buf: Buffer): ParsedTorrentFile | null {
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
    // Continuar si falla la estructura secundaria
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

  if (Array.isArray(decoded?.['announce-list'])) {
    for (const tier of decoded['announce-list']) {
      if (Array.isArray(tier)) {
        for (const tr of tier) {
          const trStr = typeof tr === 'string' ? tr : Buffer.isBuffer(tr) ? tr.toString('utf-8') : null;
          if (trStr && !trackers.includes(trStr)) {
            trackers.push(trStr);
          }
        }
      }
    }
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

export class MejorTorrentCrawler extends BaseCrawler {
  public readonly name = 'mejortorrent';
  public readonly baseUrl: string;

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

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting crawl across movies and series (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(8);

    const mirrorsToTry = [
      this.baseUrl,
      ...this.defaultMirrors.filter(m => m !== this.baseUrl)
    ];

    let workingMirror: string | null = null;
    let mirrorMode: 'mejortorrent_eu' | 'mejortorrent_me' = 'mejortorrent_eu';

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
        if (
          resp.status === 200 &&
          !html.includes('Just a moment...') &&
          !html.includes('Un momento…') &&
          !html.includes('cf-mitigated')
        ) {
          workingMirror = mirror;
          mirrorMode = mirror.includes('.me') ? 'mejortorrent_me' : 'mejortorrent_eu';
          console.log(`[${this.name}] Connected to active endpoint: ${mirror} (mode=${mirrorMode})`);
          break;
        } else {
          console.warn(`[${this.name}] Mirror ${mirror} returned Cloudflare challenge. Trying next mirror...`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Mirror ${mirror} unreachable: ${msg}. Trying next mirror...`);
      }
    }

    if (!workingMirror) {
      console.warn(`[${this.name}] Primary mirror blocked. Defaulting to high-availability mirror https://mejortorrent.me...`);
      workingMirror = 'https://mejortorrent.me';
      mirrorMode = 'mejortorrent_me';
    }

    if (mirrorMode === 'mejortorrent_eu') {
      const euRecords = await this.crawlMejorTorrentEu(workingMirror, maxPages, limit);
      results.push(...euRecords);
    } else {
      const meRecords = await this.crawlMejorTorrentMe(workingMirror, maxPages, limit);
      results.push(...meRecords);
    }

    console.log(`[${this.name}] Crawl completed. Total records discovered: ${results.length}`);
    return results;
  }

  private async crawlMejorTorrentEu(
    mirror: string,
    maxPages: number,
    limit: ReturnType<typeof pLimit>
  ): Promise<TorrentRecord[]> {
    const results: TorrentRecord[] = [];
    const detailUrls = new Set<string>();

    const categories = [
      { path: '/inicio', type: 'movie' as ContentType },
      { path: '/torrents', type: 'movie' as ContentType },
      { path: '/peliculas-hd', type: 'movie' as ContentType },
      { path: '/series-hd', type: 'series' as ContentType },
      { path: '/peliculas', type: 'movie' as ContentType },
      { path: '/series', type: 'series' as ContentType }
    ];

    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        let listUrl = `${mirror}${cat.path}`;
        if (page > 1 && (cat.path.includes('peliculas') || cat.path.includes('series'))) {
          listUrl = `${mirror}${cat.path}/page/${page}`;
        } else if (page > 1) {
          break;
        }

        try {
          console.log(`[${this.name}] Fetching category list: ${listUrl}`);
          const resp = await this.httpClient.get<string>(listUrl);
          const html = resp.data;
          if (!html || typeof html !== 'string') continue;

          const $ = cheerio.load(html);
          $('a[href*="/pelicula/"], a[href*="/serie/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && !href.includes('/genre/') && !href.includes('/year/') && !href.includes('/quality/')) {
              const fullUrl = href.startsWith('http') ? href : `${mirror}${href.startsWith('/') ? '' : '/'}${href}`;
              detailUrls.add(fullUrl);
            }
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Failed to fetch page ${listUrl}: ${msg}`);
          break;
        }
      }
    }

    console.log(`[${this.name}] Discovered ${detailUrls.size} detail links on ${mirror}. Extracting torrents...`);

    const maxCandidates = Math.max(40, maxPages * 35);
    const candidateList = Array.from(detailUrls).slice(0, maxCandidates);

    const tasks = candidateList.map(url =>
      limit(async () => {
        try {
          const records = await this.parseMejorTorrentEuDetail(url, mirror);
          results.push(...records);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error parsing detail ${url}: ${msg}`);
        }
      })
    );

    await Promise.all(tasks);
    return results;
  }

  private async parseMejorTorrentEuDetail(url: string, mirror: string): Promise<TorrentRecord[]> {
    const resp = await this.httpClient.get<string>(url);
    const html = resp.data;
    if (!html || typeof html !== 'string') return [];

    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    let title = $('h1').first().text().trim() || $('title').text().replace(/\|.*$/, '').trim();
    const isSeries = url.includes('/serie/');
    const defaultType: ContentType = isSeries ? 'series' : 'movie';

    const torrentAnchors = $('a[href*="/torrents/"][href$=".torrent"], a:contains("Descargar")');

    for (let i = 0; i < torrentAnchors.length; i++) {
      const a = torrentAnchors.eq(i);
      let torrentUrl = a.attr('href') || '';
      if (!torrentUrl.endsWith('.torrent')) continue;

      if (!torrentUrl.startsWith('http')) {
        torrentUrl = `${mirror}${torrentUrl.startsWith('/') ? '' : '/'}${torrentUrl}`;
      }

      let itemTitle = title;
      const row = a.closest('tr');
      if (row.length && isSeries) {
        const epText = row.find('td').eq(1).text().trim();
        if (epText) {
          itemTitle = `${title} ${epText}`;
        }
      }

      try {
        const torrentResp = await this.httpClient.get<Buffer>(torrentUrl, {
          responseType: 'arraybuffer'
        });

        const torrentBuf = Buffer.from(torrentResp.data);
        const parsedTorrent = parseTorrentBuffer(torrentBuf);
        if (!parsedTorrent || !parsedTorrent.infoHash) {
          continue;
        }

        const effectiveTitle = parsedTorrent.name || itemTitle;
        const parsedMeta = parseTorrentTitle(effectiveTitle, defaultType);
        const langs = detectLanguages(effectiveTitle, ['mejortorrent', 'castellano']);

        if (langs.audio.length === 0) {
          langs.audio.push('Castellano');
        }

        const magnetUrl = buildMagnetUri(
          parsedTorrent.infoHash,
          effectiveTitle,
          parsedTorrent.trackers
        );

        records.push({
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
          source_url: url,
          title: effectiveTitle,
          release_group: parsedMeta.releaseGroup,
          quality: parsedMeta.quality,
          codec: parsedMeta.codec,
          hdr_format: parsedMeta.hdrFormat,
          audio: langs.audio,
          subtitles: langs.subtitles,
          channels: parsedMeta.channels,
          size_bytes: parsedTorrent.sizeBytes || null,
          seeders: 10,
          leechers: 2,
          source_tracker: parsedTorrent.primaryTracker || 'udp://tracker.opentrackr.org:1337/announce'
        });
      } catch (dlErr: unknown) {
        const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
        console.warn(`[${this.name}] Could not download .torrent file ${torrentUrl}: ${msg}`);
      }
    }

    return records;
  }

  private async crawlMejorTorrentMe(
    mirror: string,
    maxPages: number,
    limit: ReturnType<typeof pLimit>
  ): Promise<TorrentRecord[]> {
    const results: TorrentRecord[] = [];
    const detailUrls = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      try {
        const apiUrl = `${mirror}/wp-json/wp/v2/posts?page=${page}&per_page=30`;
        console.log(`[${this.name}] Querying REST API feed: ${apiUrl}`);
        const apiResp = await this.httpClient.get<Array<{ link: string }>>(apiUrl);
        if (Array.isArray(apiResp.data)) {
          for (const post of apiResp.data) {
            if (post.link && post.link.startsWith(mirror)) {
              detailUrls.add(post.link);
            }
          }
        }
      } catch {
        break;
      }
    }

    const endpoints = [
      '/',
      '/ultimos/',
      '/peliculas-hd-3/',
      '/series-hd-2/'
    ];

    for (const ep of endpoints) {
      try {
        const pageUrl = `${mirror}${ep}`;
        console.log(`[${this.name}] Fetching listings: ${pageUrl}`);
        const resp = await this.httpClient.get<string>(pageUrl);
        const html = resp.data;
        if (!html || typeof html !== 'string') continue;

        const $ = cheerio.load(html);
        $('a').each((_, el) => {
          const href = $(el).attr('href');
          if (
            href &&
            href.startsWith(mirror) &&
            !href.includes('/page/') &&
            !href.includes('/category/') &&
            !href.includes('/ayuda') &&
            !href.includes('/ultimos') &&
            !href.includes('-3/') &&
            !href.includes('-2/') &&
            !href.includes('-13/') &&
            !href.includes('.torrent') &&
            !href.includes('.css') &&
            !href.includes('.ico') &&
            !href.includes('.png') &&
            !href.includes('.jpg') &&
            href.replace(mirror, '').trim().length > 3
          ) {
            detailUrls.add(href);
          }
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Failed to fetch listing ${ep}: ${msg}`);
      }
    }

    console.log(`[${this.name}] Discovered ${detailUrls.size} candidate detail links on ${mirror}. Extracting torrents...`);

    const maxCandidates = Math.max(50, maxPages * 40);
    const candidateList = Array.from(detailUrls).slice(0, maxCandidates);

    const tasks = candidateList.map(url =>
      limit(async () => {
        try {
          const records = await this.parseMejorTorrentMeDetail(url, mirror);
          results.push(...records);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error parsing detail ${url}: ${msg}`);
        }
      })
    );

    await Promise.all(tasks);
    return results;
  }

  private async parseMejorTorrentMeDetail(url: string, mirror: string): Promise<TorrentRecord[]> {
    const resp = await this.httpClient.get<string>(url);
    const html = resp.data;
    if (!html || typeof html !== 'string') return [];

    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    const torrentUrls = new Set<string>();
    $('a[href$=".torrent"]').each((_, el) => {
      const h = $(el).attr('href');
      if (h) torrentUrls.add(h);
    });

    if (torrentUrls.size === 0) {
      const match = html.match(/https?:\/\/[^\s"'<>]+\.torrent/gi);
      if (match) {
        match.forEach(m => torrentUrls.add(m));
      }
    }

    if (torrentUrls.size === 0) return [];

    const isSeries = url.includes('temporada') || html.includes('Episodios') || /S\d{1,2}|Temporada/i.test(html);
    const defaultType: ContentType = isSeries ? 'series' : 'movie';

    for (const rawTorrentUrl of Array.from(torrentUrls)) {
      if (rawTorrentUrl.toLowerCase().includes('thimbleweed-park')) {
        continue;
      }

      let torrentUrl = rawTorrentUrl.startsWith('http')
        ? rawTorrentUrl
        : `${mirror}${rawTorrentUrl.startsWith('/') ? '' : '/'}${rawTorrentUrl}`;

      try {
        const torrentResp = await this.httpClient.get<Buffer>(torrentUrl, {
          responseType: 'arraybuffer'
        });

        const torrentBuf = Buffer.from(torrentResp.data);
        const parsedTorrent = parseTorrentBuffer(torrentBuf);
        if (!parsedTorrent || !parsedTorrent.infoHash) {
          continue;
        }

        if (parsedTorrent.name.toLowerCase().includes('thimbleweed')) {
          continue;
        }

        let candidateTitle = parsedTorrent.name;
        if (!candidateTitle || candidateTitle.length < 3) {
          const pageTitle = $('h1').first().text().trim() || $('title').text().replace(/\|.*$/, '').trim();
          candidateTitle = pageTitle || url.replace(mirror, '').replace(/\//g, ' ').trim();
        }

        const parsedMeta = parseTorrentTitle(candidateTitle, defaultType);
        const langs = detectLanguages(candidateTitle, ['mejortorrent', 'castellano']);

        if (langs.audio.length === 0) {
          langs.audio.push('Castellano');
        }

        const magnetUrl = buildMagnetUri(
          parsedTorrent.infoHash,
          candidateTitle,
          parsedTorrent.trackers
        );

        records.push({
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
          source_url: url,
          title: candidateTitle,
          release_group: parsedMeta.releaseGroup,
          quality: parsedMeta.quality,
          codec: parsedMeta.codec,
          hdr_format: parsedMeta.hdrFormat,
          audio: langs.audio,
          subtitles: langs.subtitles,
          channels: parsedMeta.channels,
          size_bytes: parsedTorrent.sizeBytes || null,
          seeders: 15,
          leechers: 3,
          source_tracker: parsedTorrent.primaryTracker || 'udp://tracker.opentrackr.org:1337/announce'
        });
      } catch (dlErr: unknown) {
        const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
        console.warn(`[${this.name}] Failed to download .torrent file ${torrentUrl}: ${msg}`);
      }
    }

    return records;
  }
}

export default MejorTorrentCrawler;
