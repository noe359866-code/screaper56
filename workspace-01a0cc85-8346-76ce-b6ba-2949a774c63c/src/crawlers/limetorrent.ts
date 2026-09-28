import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { looksLikeBlockedPage } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  describeError,
  isBlockedTitle,
  mapWithConcurrency,
  nextPaginationLink,
  parseCount,
  qualityOf,
  sameHost
} from './support.js';

interface LimeCandidate {
  title: string;
  detailUrl: string;
  sizeBytes?: number | null;
  seeders?: number | null;
  leeches?: number | null;
  type: ContentType;
}

const LIME_TABLE_MARKER = /<table\b[^>]*class=["'][^"']*\btable2\b/i;

function isLimeListingHtml(data: unknown): data is string {
  return typeof data === 'string' && !looksLikeBlockedPage(data) && LIME_TABLE_MARKER.test(data);
}
const NON_VIDEO_CATEGORY = /\b(audio|music|games?|software|applications?|apps?|pictures?|literature|books?|e-?books?|adult|porn|xxx)\b/i;

/** Resolve a site URL while preventing cross-site, scheme-downgrade and port escapes. */
function sameSiteHttpUrl(value: string, resolveAgainst: string, siteBase: string): string | null {
  const candidate = absoluteHttpUrl(value, resolveAgainst);
  if (!candidate) return null;
  try {
    const left = new URL(candidate);
    const right = new URL(siteBase);
    if (left.username || left.password) return null;
    return left.protocol === right.protocol && left.port === right.port && sameHost(candidate, siteBase)
      ? candidate
      : null;
  } catch {
    return null;
  }
}

/** Ensure a pager stays on the current catalogue route (including page/N forms). */
function sameListingRoute(next: string, current: string, siteBase: string): boolean {
  const trustedNext = sameSiteHttpUrl(next, siteBase, siteBase);
  if (!trustedNext) return false;
  try {
    const nextUrl = new URL(trustedNext);
    const currentUrl = new URL(current);
    const routePath = (pathname: string) => pathname
      .replace(/\/page\/\d+\/?$/i, '/')
      .replace(/\/\d+\/?$/, '/')
      .replace(/\/+$/, '') || '/';
    return routePath(nextUrl.pathname) === routePath(currentUrl.pathname);
  } catch {
    return false;
  }
}

function inferLimeType(title: string, category: string): ContentType {
  if (/documentar/i.test(category)) return 'documentary';
  if (/\banime\b/i.test(category)) return 'anime';
  if (/\b(tv|television|series|shows?)\b/i.test(category)) return 'series';
  if (/\b(movie|movies|film|films)\b/i.test(category)) return 'movie';
  return parseTorrentTitle(title).type;
}

/**
 * LimeTorrents: `table2` listings plus search. The age column is detected
 * dynamically so size/seeders/leechers never shift by one cell.
 */
export class LimeTorrentsCrawler extends BaseCrawler {
  public readonly name = 'limetorrents';
  public baseUrl: string;

  /** Known LimeTorrents domains; extend with LIMETORRENTS_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://limetorrent.store',
    'https://www.limetorrents.fun',
    'https://limetorrents.lol',
    'https://limetorrents.asia',
    'https://limetorrents.pro',
    'https://limetorrent.net',
    'https://limetorrents.cc',
    'https://www.limetorrents.to'
  ];

  private readonly detailConcurrency = Math.max(
    1,
    Number.parseInt(process.env.LIMETORRENTS_CONCURRENCY || '3', 10) || 3
  );

  constructor() {
    super();
    this.baseUrl = process.env.LIMETORRENTS_BASE_URL || LimeTorrentsCrawler.DEFAULT_MIRRORS[0];
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting crawl across catalogs and searches (maxPages=${maxPages})...`);

    const mirror = await this.resolveMirror({
      envPrefix: 'LIMETORRENTS',
      defaults: LimeTorrentsCrawler.DEFAULT_MIRRORS,
      probes: [
        { path: '/latest100', label: 'latest100', timeoutMs: 6000, validate: data => isLimeListingHtml(data) },
        { path: '/top100', label: 'top100', timeoutMs: 6000, validate: data => isLimeListingHtml(data) }
      ]
    });

    // Actualizamos la propiedad baseUrl para sincronizarla con el mirror activo
    this.baseUrl = mirror;

    const candidateMap = new Map<string, LimeCandidate>();
    let successfulListings = 0;

    // 1. Spanish-oriented searches first: candidates are capped below, and
    //    running them last meant the Spanish results were the ones cut off.
    //    (discovery only, never language evidence)
    const spanishQueries = (process.env.LIMETORRENTS_SEARCH || 'spanish,castellano,latino')
      .split(/[,\s]+/)
      .map(q => q.trim())
      .filter(Boolean);

    for (const query of spanishQueries) {
      if (this.deadline.expired) break;
      const html = await this.searchHtml(mirror, query);
      if (!html) continue;
      successfulListings++;
      this.metrics.add('listings');
      this.collectRows(html, `${mirror}/search`, mirror, null, candidateMap);
    }

    // 2. Catalogues
    const categories: Array<{ path: string; type: ContentType | null; paginated: boolean }> = [
      // `/latest100` and `/top100` are mixed-category feeds: forcing 'movie'
      // mislabelled every TV show and anime release they contained.
      { path: '/latest100', type: null, paginated: false },
      { path: '/top100', type: null, paginated: false },
      { path: '/browse-torrents/Movies/', type: 'movie', paginated: true },
      { path: '/browse-torrents/TV-shows/', type: 'series', paginated: true },
      { path: '/browse-torrents/Anime/', type: 'anime', paginated: true }
    ];

    for (const cat of categories) {
      // Only the offsets the listing itself publishes. A guessed
      // `/browse-torrents/Movies/2/` is served by most mirrors as page 1
      // again, so the old numbering re-crawled the same rows `maxPages` times.
      let listUrl: string | null = `${mirror}${cat.path}`;
      const visited = new Set<string>();

      for (let page = 1; listUrl && page <= maxPages; page++) {
        if (this.deadline.expired) break;
        if (visited.has(listUrl)) break;
        visited.add(listUrl);

        try {
          this.log.debug(`Fetching catalog listing: ${listUrl}`);
          const html = await this.fetchHtml(listUrl, {}, { rejectBlocked: true });
          if (!isLimeListingHtml(html)) throw new Error('Expected table2 in LimeTorrents catalogue response');
          successfulListings++;
          this.metrics.add('listings');
          this.collectRows(html, listUrl, mirror, cat.type, candidateMap);
          const publishedNext: string | null = cat.paginated ? nextPaginationLink(html, listUrl) : null;
          listUrl = publishedNext && sameListingRoute(publishedNext, listUrl, mirror) ? publishedNext : null;
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Failed fetching listing ${listUrl}: ${describeError(error)}`);
          break;
        }
      }
    }

    if (successfulListings === 0) {
      throw new Error('[limetorrents] No usable catalogue responses. Check mirror availability, blocking and page layout.');
    }

    this.log.info(`Discovered ${candidateMap.size} candidates. Extracting release details...`);

    const maxCandidates = Math.max(30, maxPages * 25);
    const candidates = [...candidateMap.values()].slice(0, maxCandidates);

    const records = await mapWithConcurrency(candidates, this.detailConcurrency, async item => {
      if (this.deadline.expired) return null;
      try {
        const record = await this.parseLimeDetail(item, mirror);
        if (record) this.metrics.add('records');
        return record;
      } catch (error) {
        this.metrics.add('detailErrors');
        this.log.warn(`Error parsing ${item.detailUrl}: ${describeError(error)}`);
        return null;
      }
    });

    const deduplicated = this.deduplicateRecords(records.filter((r): r is TorrentRecord => Boolean(r)));
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** POST search with a GET fallback: mirrors disagree on which one they expose. */
  private async searchHtml(mirror: string, query: string): Promise<string | null> {
    this.log.debug(`Querying search for "${query}"...`);
    try {
      const response = await this.httpClient.request<string>({
        method: 'POST',
        url: `${mirror}/search`,
        data: new URLSearchParams({ q: query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (isLimeListingHtml(response.data)) {
        return response.data;
      }
    } catch (error) {
      this.log.debug(`POST search failed for "${query}": ${describeError(error)}`);
    }

    try {
      const html = await this.fetchHtml(
        `${mirror}/search/all/${encodeURIComponent(query)}/seeds/1/`,
        {},
        { rejectBlocked: true }
      );
      if (isLimeListingHtml(html)) return html;
      this.metrics.add('listingErrors');
      this.log.warn(`Search response for "${query}" did not contain table2.`);
      return null;
    } catch (error) {
      this.metrics.add('listingErrors');
      this.log.warn(`Search error for "${query}": ${describeError(error)}`);
      return null;
    }
  }

  /** Parses a `table2` grid; the age column is located by content, not by index. */
  private collectRows(
    html: string,
    sourceUrl: string,
    mirror: string,
    forcedType: ContentType | null,
    sink: Map<string, LimeCandidate>
  ): number {
    let parsed = 0;
    const $ = cheerio.load(html);

    $('table.table2 tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;

      // Prefer the site's title wrapper, then fall back to other same-site
      // `.html` anchors. This skips off-site ad links and tolerates headerless tables.
      const preferred = $(tr).find('div.tt-name a[href]').toArray();
      const candidates = [...preferred, ...$(tr).find('a[href]').toArray()];
      let title = '';
      let fullUrl: string | null = null;
      const seenAnchors = new Set<unknown>();
      for (const element of candidates) {
        if (seenAnchors.has(element)) continue;
        seenAnchors.add(element);
        const candidateUrl = sameSiteHttpUrl($(element).attr('href') || '', sourceUrl, mirror);
        if (!candidateUrl) continue;
        try {
          if (!/\.html?$/i.test(new URL(candidateUrl).pathname)) continue;
        } catch {
          continue;
        }
        title = cleanText($(element).attr('title') || $(element).text());
        fullUrl = candidateUrl;
        break;
      }

      if (!fullUrl || !title || isBlockedTitle(title) || sink.has(fullUrl)) return;

      const tdsArray = tds.toArray();
      const sizeIndex = tdsArray.findIndex((td, position) => {
        if (position === 0) return false;
        const text = cleanText($(td).text());
        return /[KMGT]i?B/i.test(text) && parseSizeToBytes(text) !== null;
      });

      let sizeBytes: number | null = null;
      let seeders: number | null = null;
      let leeches: number | null = null;

      // Solución a desbordamiento / wrap-around cuando sizeIndex === -1
      if (sizeIndex !== -1) {
        sizeBytes = parseSizeToBytes(cleanText(tds.eq(sizeIndex).text()));
        if (sizeIndex + 1 < tds.length) {
          seeders = parseCount(cleanText(tds.eq(sizeIndex + 1).text()));
        }
        if (sizeIndex + 2 < tds.length) {
          leeches = parseCount(cleanText(tds.eq(sizeIndex + 2).text()));
        }
      }

      const categoryLabel = cleanText(
        tds.eq(0).find('img').first().attr('title') ||
        tds.eq(0).find('img').first().attr('alt') ||
        tds.eq(0).attr('data-category') ||
        $(tr).attr('data-category') || ''
      );
      if (NON_VIDEO_CATEGORY.test(categoryLabel)) return;

      sink.set(fullUrl, {
        title,
        detailUrl: fullUrl,
        sizeBytes,
        seeders,
        leeches,
        type: forcedType ?? inferLimeType(title, categoryLabel)
      });
      parsed++;
    });

    return parsed;
  }

  private async parseLimeDetail(item: LimeCandidate, mirror: string): Promise<TorrentRecord | null> {
    const html = await this.fetchHtml(
      item.detailUrl,
      { headers: { Referer: `${mirror}/` } },
      { rejectBlocked: true }
    );
    this.metrics.add('details');
    const $ = cheerio.load(html);

    const effectiveTitle = cleanText($('h1').first().text()) || item.title;
    if (!effectiveTitle || isBlockedTitle(effectiveTitle)) return null;

    let infoHash: string | null = null;
    let magnetUri: string | null = null;
    let sizeBytes = item.sizeBytes ?? null;
    let seeders = item.seeders ?? null;
    let leechers = item.leeches ?? null;
    const trackers: string[] = [];

    // 1. Extracción de URI Magnet
    for (const element of $('a[href]').toArray()) {
      const href = $(element).attr('href') || '';
      if (!/^magnet:/i.test(href)) continue;
      const parsed = parseMagnetUri(href);
      if (!parsed?.infoHash) continue;
      magnetUri = href;
      infoHash = parsed.infoHash;
      trackers.push(...parsed.trackers);
      break;
    }

    // 2. Búsqueda de Hash, Size, Seeders/Leechers en las tablas de detalles
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      const key = cleanText(tds.eq(0).text()).toLowerCase();
      const value = cleanText(tds.eq(1).text());

      if (key.includes('hash') && !infoHash) {
        const hashMatch = value.match(/([0-9a-fA-F]{40})/);
        if (hashMatch) infoHash = hashMatch[1].toLowerCase();
      }
      if (key.includes('size') && !sizeBytes) {
        sizeBytes = parseSizeToBytes(value);
      }
      if (key.includes('seeder') && seeders === null) {
        seeders = parseCount(value);
      }
      if (key.includes('leecher') && leechers === null) {
        leechers = parseCount(value);
      }
    });

    // 3. Trackers explicitly listed on the page. The old `:1337`/`:6969`
    // substring test also matched unrelated links, so only real announce URLs
    // are accepted now.
    $('a[href^="udp://"], a[href^="http://"], a[href^="https://"]').each((_, a) => {
      const href = $(a).attr('href');
      if (href && (/^udp:\/\//i.test(href) || /\/announce\/?$/i.test(href))) {
        if (!trackers.includes(href)) trackers.push(href);
      }
    });

    // Fallback focalizado para seeders/leechers en lugar de escanear todo $.root().text()
    if (seeders === null || leechers === null) {
      $('.table2, .torrentinfo').find('tr, div, span').each((_, el) => {
        const txt = $(el).text();
        if (seeders === null) {
          const m = txt.match(/Seeders?\s*:\s*([\d,.]+)/i);
          if (m) seeders = parseCount(m[1]);
        }
        if (leechers === null) {
          const m = txt.match(/Leechers?\s*:\s*([\d,.]+)/i);
          if (m) leechers = parseCount(m[1]);
        }
      });
    }

    // IMDb is only linked from some templates; it is stored when present
    // because it is what lets the same release dedupe against other sources.
    const imdbId = html.match(/imdb\.com\/title\/(tt\d{7,10})/i)?.[1]?.toLowerCase() ?? null;

    // Metainfo link published next to the magnet, when the template has one.
    // The href is resolved before comparing hosts: it is usually relative.
    let torrentFileUrl: string | null = null;
    for (const element of $('a[href]').toArray()) {
      const href = $(element).attr('href') || '';
      let isTorrent = false;
      try {
        isTorrent = /\.torrent$/i.test(new URL(href, item.detailUrl).pathname);
      } catch {
        continue;
      }
      if (!isTorrent) continue;
      const candidate = sameSiteHttpUrl(href, item.detailUrl, mirror);
      if (candidate) {
        torrentFileUrl = candidate;
        break;
      }
    }

    if (!infoHash) return null;

    // Si no existía el enlace magnet directo en el HTML pero sí obtuvimos el infoHash, se construye sintéticamente
    if (!magnetUri) {
      const trParams = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
      magnetUri = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(effectiveTitle)}${trParams}`;
    }

    const meta = parseTorrentTitle(effectiveTitle, item.type);
    const langs = detectLanguages(effectiveTitle, ['limetorrents']);

    return buildTorrentRecord({
      title: effectiveTitle,
      type: meta.type,
      infoHash,
      magnetUrl: magnetUri,
      torrentFileUrl,
      imdbId,
      sourceUrl: item.detailUrl,
      trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes,
      seeders,
      leechers,
      sourceTracker: trackers[0] ?? null
    });
  }
}

export default LimeTorrentsCrawler;
