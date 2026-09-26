import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  dedupeStrings,
  isBlockedTitle,
  mapWithConcurrency,
  qualityOf
} from './support.js';

interface EliteRoute {
  path: string;
  hasPagination: boolean;
  type: ContentType;
}

/**
 * EliteTorrent: detail pages, Base64/ROT13 shortener, hex/Base32 magnets and
 * relative `.torrent` URLs with a query string. Swarm counters are not published
 * by the site, so they stay `null` instead of being faked as zero.
 */
export class EliteTorrentCrawler extends BaseCrawler {
  public readonly name = 'elitetorrent';
  public baseUrl: string;

  /** Known EliteTorrent domains; extend with ELITETORRENT_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www.elitetorrent.com',
    'https://elitetorrent.li',
    'https://elitetorrent.app',
    'https://elitetorrent.wtf',
    'https://www.elitetorrent.ec',
    'https://elitetorrent.biz',
    'https://elitetorrent.ms',
    'https://elitetorrents.pro',
    'https://www.elitetorrent.nu'
  ];

  private readonly detailConcurrency = Math.max(1, Number.parseInt(process.env.ELITETORRENT_CONCURRENCY || '5', 10) || 5);

  constructor() {
    super();
    this.baseUrl = process.env.ELITETORRENT_BASE_URL || EliteTorrentCrawler.DEFAULT_MIRRORS[0];
  }

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'ELITETORRENT',
      defaults: EliteTorrentCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/',
          label: 'portada',
          timeoutMs: 7000,
          validate: htmlMarkerValidator([/href=["'][^"']*\/(peliculas|series)\/[^"']+/i])
        },
        {
          path: '/series/',
          label: 'catálogo de series',
          timeoutMs: 7000,
          validate: htmlMarkerValidator([/href=["'][^"']*\/(peliculas|series)\/[^"']+/i])
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting EliteTorrent crawl (maxPages=${maxPages})...`);

    const mirror = await this.getWorkingMirror();
    this.baseUrl = mirror;

    let mirrorOrigin = mirror;
    try {
      mirrorOrigin = new URL(mirror).origin;
    } catch {
      // Retain full mirror string on URL parse fallback
    }

    const results: TorrentRecord[] = [];
    const visitedUrls = new Set<string>();

    const sectionRoutes: EliteRoute[] = [
      { path: '/', hasPagination: false, type: 'movie' },
      { path: '/series/', hasPagination: true, type: 'series' },
      { path: '/idioma/castellano-17-1/', hasPagination: true, type: 'movie' },
      { path: '/idioma/espanol-latino-11-1/', hasPagination: true, type: 'movie' },
      { path: '/calidad/1080p-10-1/', hasPagination: true, type: 'movie' },
      { path: '/calidad/4k-uhd-23-1/', hasPagination: true, type: 'movie' }
    ];

    for (const route of sectionRoutes) {
      const pagesToCrawl = route.hasPagination ? maxPages : 1;

      for (let page = 1; page <= pagesToCrawl; page++) {
        if (this.deadline.expired) break;

        const listUrl = page > 1
          ? `${mirror}${route.path.replace(/\/$/, '')}/page/${page}/`
          : `${mirror}${route.path}`;

        try {
          this.log.debug(`Fetching listing: ${listUrl}`);
          const html = await this.fetchHtml(listUrl);
          this.metrics.add('listings');

          const pageDetailUrls: string[] = [];
          const $ = cheerio.load(html);

          $('a[href*="/peliculas/"], a[href*="/series/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            if (/\/feed\/|\/page\//.test(href)) return;
            if (/\/peliculas-1\/$\vert{}\/series\/$/.test(href)) return;

            const fullUrl = absoluteHttpUrl(href, listUrl);
            if (!fullUrl) return;

            try {
              if (new URL(fullUrl).origin !== mirrorOrigin) return;
            } catch {
              return;
            }

            if (visitedUrls.has(fullUrl)) return;
            visitedUrls.add(fullUrl);
            pageDetailUrls.push(fullUrl);
          });

          if (!pageDetailUrls.length) {
            this.log.debug(`No new records on page ${page} for ${route.path}. Stopping route.`);
            break;
          }

          const records = await mapWithConcurrency(pageDetailUrls, this.detailConcurrency, async url => {
            if (this.deadline.expired) return null;
            try {
              const record = await this.parseEliteTorrentDetail(url, mirror);
              if (record) this.metrics.add('records');
              return record;
            } catch (error) {
              this.metrics.add('detailErrors');
              this.log.warn(`Error parsing detail [${url}]: ${formatError(error)}`);
              return null;
            }
          });

          for (const record of records) {
            if (record) results.push(record);
          }
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Failed fetching ${listUrl}: ${formatError(error)}. Skipping to next route.`);
          break;
        }
      }
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  public async parseEliteTorrentDetail(url: string, mirror: string): Promise<TorrentRecord | null> {
    const response = await this.httpClient.get<string>(url);
    if (!response.data || typeof response.data !== 'string') return null;
    this.metrics.add('details');

    const $ = cheerio.load(response.data);
    const rawH1 = cleanText($('h1').first().text());
    if (!rawH1) return null;

    const cleanTitle = rawH1
      .replace(/^Descargar\s+/i, '')
      .replace(/\s+por torrent.*$/i, '')
      .replace(/^["\u201C\u201D\x27]+|["\u201C\u201D\x27]+$/g, '')
      .trim();

    if (!cleanTitle || isBlockedTitle(cleanTitle)) return null;

    let sizeStr = '';
    let idiomaStr = '';
    let calidadStr = '';
    let formatoStr = '';

    $('p.descrip span, .ficha span, li').each((_, el) => {
      const txt = cleanText($(el).text());
      if (/^Tamaño:/i.test(txt)) sizeStr = txt.replace(/^Tamaño:/i, '').trim();
      else if (/^Idioma:/i.test(txt)) idiomaStr = txt.replace(/^Idioma:/i, '').trim();
      else if (/^Calidad:/i.test(txt)) calidadStr = txt.replace(/^Calidad:/i, '').trim();
      else if (/^Formato:/i.test(txt)) formatoStr = txt.replace(/^Formato:/i, '').trim();
    });

    let magnetLink: string | null = null;
    let torrentDownloadUrl: string | null = null;

    $('a').each((_, el) => {
      // Early break if both magnet and torrent download URLs are found
      if (magnetLink && torrentDownloadUrl) return false;

      const href = $(el).attr('href') || '';
      if (!href) return;

      if (/acortame-esto\.com\/s\.php\?i=/i.test(href)) {
        const param = safeQueryParam(href, url, 'i');
        if (param) {
          const decoded = decodeAcortameString(param);
          if (decoded.startsWith('magnet:') && !magnetLink) {
            magnetLink = decoded;
          } else if (decoded.includes('.torrent') && !torrentDownloadUrl) {
            torrentDownloadUrl = absoluteHttpUrl(decoded, url);
          }
        }
      } else if (href.startsWith('magnet:') && !magnetLink) {
        magnetLink = href;
      } else if (/\.torrent(?:[?#]|$)/i.test(href) && !torrentDownloadUrl) {
        torrentDownloadUrl = absoluteHttpUrl(href, url);
      }
    });

    const parsedMagnet = magnetLink ? parseMagnetUri(magnetLink) : null;
    let infoHash: string | null = parsedMagnet?.infoHash ?? null;
    let trackers: string[] = parsedMagnet?.trackers ?? [];
    let sizeBytes = parseSizeToBytes(sizeStr);

    if ((!infoHash || !sizeBytes) && torrentDownloadUrl) {
      try {
        const parsed = await this.fetchTorrentMetainfoViaGet(torrentDownloadUrl, url);
        if (!infoHash) infoHash = parsed.infoHash;
        if (!sizeBytes && parsed.sizeBytes > 0) sizeBytes = parsed.sizeBytes;
        if (!trackers.length) trackers = parsed.trackers;
      } catch (error) {
        this.metrics.add('downloadErrors');
        this.log.debug(`Metainfo download failed for ${torrentDownloadUrl}: ${formatError(error)}`);
      }
    }

    if (!infoHash) return null;

    // Fallback: build a valid magnet URI if infoHash exists but no original magnet was found
    if (!magnetLink && infoHash) {
      magnetLink = buildMagnetUri(infoHash, cleanTitle);
    }

    const isSeries = url.includes('/series/') || /S\d{1,2}|Temporada|\b\d{1,2}[xX×]\d{1,3}\b/i.test(cleanTitle);
    const defaultType: ContentType = isSeries ? 'series' : 'movie';

    const normalizedTitleForParsing = cleanTitle.replace(
      /(\d{1,2})[xX×](\d{1,3})/g,
      (_, season: string, episode: string) => `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`
    );

    const context = dedupeStrings([normalizedTitleForParsing, calidadStr, formatoStr]).join(' ');
    const meta = parseTorrentTitle(context, defaultType);
    const hints = dedupeStrings(['elitetorrent', idiomaStr, calidadStr, formatoStr]);
    const langs = detectLanguages(cleanTitle, hints);

    // The site publishes an explicit language field; use it when the title is silent.
    if (!langs.audio.length && !langs.subtitles.includes('Sub_ES')) {
      if (/latino/i.test(idiomaStr)) {
        langs.audio.push('Spanish (Latino)');
      } else if (/vose/i.test(idiomaStr)) {
        langs.audio.push('English');
        langs.subtitles.push('Sub_ES');
      } else {
        langs.audio.push('Spanish');
      }
    }

    return buildTorrentRecord({
      title: cleanTitle,
      type: meta.type,
      infoHash,
      magnetUrl: magnetLink,
      torrentFileUrl: torrentDownloadUrl,
      sourceUrl: url,
      trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: calidadStr || qualityOf(meta),
      sizeBytes,
      // EliteTorrent listings do not expose seeders/leechers: keep them unknown.
      seeders: null,
      leechers: null,
      sourceTracker: trackers[0] ?? null
    });
  }
}

function safeQueryParam(href: string, base: string, key: string): string | null {
  try {
    return new URL(href, base).searchParams.get(key);
  } catch {
    return null;
  }
}

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 65 && code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

/** Decodes the site's own Base64/ROT13 shortener parameter (no remote calls). */
export function decodeAcortameString(raw: string): string {
  if (!raw) return '';
  const s = raw.trim();

  if (/^(magnet:|http:\/\/|https:\/\/)/i.test(s)) return s;

  const initialRot = rot13(s);
  if (/^(magnet:|http:\/\/|https:\/\/)/i.test(initialRot)) return initialRot;

  let current = s;
  for (let i = 0; i < 8; i++) {
    try {
      current = Buffer.from(current, 'base64').toString('utf-8');
      if (/^(magnet:|http:\/\/|https:\/\/)/i.test(current)) return current;

      const rotDecoded = rot13(current);
      if (/^(magnet:|http:\/\/|https:\/\/)/i.test(rotDecoded)) return rotDecoded;
    } catch {
      break;
    }
  }

  return initialRot;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default EliteTorrentCrawler;
