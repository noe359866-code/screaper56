import * as cheerio from 'cheerio';
import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
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
  sameSite
} from './support.js';

export interface RarbgRow {
  detailUrl: string;
  title: string;
  category: string;
  sizeStr: string;
  seeders: number | null;
  leechers: number | null;
}

/** Categories that are never indexed (the schema only stores video). */
const EXCLUDED_CATEGORY = /\b(xxx|porn|adult|games?|music|apps?|software|e-?books?)\b/i;

function sameMirrorSite(a: string, b: string): boolean {
  return sameSite(a, b);
}

/**
 * RARBG proxy clones (rarbgproxy.to and friends): `lista2` tables with a
 * detail page per release that holds the magnet, language and peers.
 */
export class RarbgCrawler extends BaseCrawler {
  public readonly name = 'rarbg';
  public baseUrl = process.env.RARBG_BASE_URL || 'https://www.rarbgproxy.to';

  /** Known clones; extend with RARBG_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www.rarbgproxy.to',
    'https://rarbgproxy.to',
    'https://rargb.to',
    'https://www2.rarbggo.to',
    'https://rarbg.tw'
  ];

  private readonly concurrency = Math.max(
    1,
    Number.parseInt(process.env.RARBG_CONCURRENCY || '3', 10) || 3
  );

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'RARBG',
      defaults: RarbgCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/movies/',
          label: 'catálogo de películas',
          timeoutMs: 8000,
          validate: htmlMarkerValidator([/href=["'][^"']*_torrent\/[^"']+\.html/i])
        }
      ]
    });
  }

  /** Listing URLs: Spanish searches first, then video catalogues. */
  public listingUrl(mirror: string, route: string, page: number): string {
    if (route.startsWith('search:')) {
      const term = encodeURIComponent(route.slice('search:'.length));
      return page > 1 ? `${mirror}/search/${page}/?search=${term}` : `${mirror}/search/?search=${term}`;
    }
    return page > 1 ? `${mirror}${route}${page}/` : `${mirror}${route}`;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting RARBG crawl (maxPages=${maxPages})...`);

    const mirror = (await this.getWorkingMirror()).replace(/\/+$/, '');
    this.baseUrl = mirror;

    const searches = (process.env.RARBG_SEARCH || 'spanish,castellano,latino')
      .split(/[,\n]+/).map(term => term.trim()).filter(Boolean);
    const routes = [
      ...searches.map(term => `search:${term}`),
      '/movies/',
      '/tv/',
      '/anime/',
      '/documentaries/'
    ];

    // Routes are crawled with a small bounded parallelism: they are independent
    // listings, and reading them one by one made a full run wait for the slowest
    // route before even starting the next one.
    let successfulListings = 0;
    const perRoute = await mapWithConcurrency(routes, 2, async route => {
      const found = new Map<string, RarbgRow>();
      let url: string | null = this.listingUrl(mirror, route, 1);
      const visited = new Set<string>();

      for (let page = 1; url && page <= maxPages; page++) {
        if (this.deadline.expired) break;
        if (visited.has(url)) break;
        visited.add(url);

        try {
          const html = await this.fetchHtml(url, { headers: { Referer: `${mirror}/` } }, { rejectBlocked: true });
          this.metrics.add('listings');
          successfulListings++;
          const parsed = this.parseListing(html, url);
          for (const row of parsed) {
            if (!found.has(row.detailUrl)) found.set(row.detailUrl, row);
          }
          // Deduplication must not stop a page that repeats earlier rows but
          // still publishes a later page with new releases. The URL set and
          // maxPages budget bound loops, while only published same-site links
          // are followed.
          const next = nextPaginationLink(html, url);
          url = next && sameMirrorSite(next, mirror) ? next : null;
          if (!url) break;
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Listing failed ${url}: ${describeError(error)}`);
          break;
        }
      }

      return [...found.values()];
    });

    if (successfulListings === 0) {
      throw new Error('[rarbg] No usable catalogue responses. Check mirror availability, blocking and page layout.');
    }

    const rows = new Map<string, RarbgRow>();
    for (const routeRows of perRoute) {
      for (const row of routeRows) {
        if (!rows.has(row.detailUrl)) rows.set(row.detailUrl, row);
      }
    }

    const maxDetails = Math.max(40, maxPages * 60);
    const candidates = [...rows.values()].slice(0, maxDetails);
    this.log.info(`Discovered ${rows.size} releases; reading ${candidates.length} detail pages...`);

    const records = await mapWithConcurrency(candidates, this.concurrency, async row => {
      if (this.deadline.expired) return null;
      try {
        const html = await this.fetchHtml(
          row.detailUrl,
          { headers: { Referer: `${mirror}/` } },
          { rejectBlocked: true }
        );
        this.metrics.add('details');
        const record = this.parseDetail(html, row);
        if (record) this.metrics.add('records');
        return record;
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('detailErrors');
        this.log.warn(`Detail failed ${row.detailUrl}: ${describeError(error)}`);
        return null;
      }
    });

    const deduplicated = this.deduplicateRecords(records.filter((r): r is TorrentRecord => Boolean(r)));
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** Listing table -> rows (XXX and non-video categories are dropped). */
  public parseListing(html: string, pageUrl: string): RarbgRow[] {
    const $ = cheerio.load(html);
    const rows: RarbgRow[] = [];

    $('tr').each((_, tr) => {
      const tds = $(tr).children('td');
      // Some clones omit the date or uploader column; the release route and
      // size/peer cells are enough to parse a row with six cells.
      if (tds.length < 6) return;

      const candidates = $(tr).find('a[href*="_torrent/"]').toArray();
      let anchor = $(tr).find('a[href*="_torrent/"]').first();
      let detailUrl: string | null = null;
      for (const element of candidates) {
        const candidate = absoluteHttpUrl($(element).attr('href'), pageUrl);
        if (!candidate || !sameMirrorSite(candidate, pageUrl)) continue;
        try {
          if (!/\.html?$/i.test(new URL(candidate).pathname)) continue;
        } catch {
          continue;
        }
        anchor = $(element);
        detailUrl = candidate;
        break;
      }
      if (!detailUrl) return;

      const title = cleanText(anchor.text()) ||
        cleanText((anchor.attr('title') || '').replace(/\s+torrent$/i, ''));
      if (!title || isBlockedTitle(title)) return;

      const category = cleanText(tds.eq(2).text());
      if (EXCLUDED_CATEGORY.test(category)) return;

      // Columns: cat | title | category | added | size | S | L | uploader.
      // The size column is located by content (mirrors add or drop the
      // uploader/date cells), and the fixed indices are only the fallback.
      const cells = tds.toArray().map(td => cleanText($(td).text()));
      let sizeIndex = cells.findIndex((text, position) => position > 2 && parseSizeToBytes(text) !== null);
      if (sizeIndex === -1 && cells.length > 6) sizeIndex = 4;

      rows.push({
        detailUrl,
        title,
        category,
        sizeStr: sizeIndex >= 0 ? cells[sizeIndex] : '',
        seeders: sizeIndex >= 0 ? parseCount(cells[sizeIndex + 1] ?? '') : null,
        leechers: sizeIndex >= 0 ? parseCount(cells[sizeIndex + 2] ?? '') : null
      });
    });

    return rows;
  }

  /** Detail page -> record. The magnet (or published hash) is mandatory. */
  public parseDetail(html: string, row: RarbgRow): TorrentRecord | null {
    const $ = cheerio.load(html);

    const fields = new Map<string, string>();
    $('tr').each((_, tr) => {
      const cells = $(tr).children('td');
      if (cells.length < 2) return;
      const key = cleanText(cells.eq(0).text()).replace(/:$/, '').toLowerCase();
      if (key && key.length < 30 && !fields.has(key)) fields.set(key, cleanText(cells.eq(1).text()));
    });

    const heading = cleanText($('h1').first().text());
    const releaseName = fields.get('release name') || '';
    const truncated = /(?:\.\.\.|…)$/.test(row.title);
    const title = cleanText((truncated ? releaseName || heading : '') || row.title || releaseName || heading);
    if (!title || isBlockedTitle(title)) return null;

    let magnetHref: string | null = null;
    let parsed = null;
    for (const element of $('a[href]').toArray()) {
      const href = $(element).attr('href') || '';
      if (!/^magnet:/i.test(href)) continue;
      const candidate = parseMagnetUri(href);
      if (!candidate?.infoHash) continue;
      magnetHref = href;
      parsed = candidate;
      break;
    }
    if (!parsed?.infoHash) {
      const hash = (fields.get('info hash') || fields.get('hash') || '').match(/\b([0-9a-f]{40})\b/i);
      if (!hash) return null;
      magnetHref = buildMagnetUri(hash[1].toLowerCase(), title, [], { includeDefaultTrackers: false });
      parsed = parseMagnetUri(magnetHref);
      if (!parsed?.infoHash) return null;
    }

    const category = (fields.get('category') || row.category || '').toLowerCase();
    if (EXCLUDED_CATEGORY.test(category)) return null;

    let defaultType: ContentType = 'movie';
    if (/\btv\b|series|shows?/.test(category)) defaultType = 'series';
    else if (/anime/.test(category)) defaultType = 'anime';
    else if (/documentar/.test(category)) defaultType = 'documentary';

    // "Language: Spanish" is a structured field published by the uploader.
    const language = fields.get('language') || '';
    const meta = parseTorrentTitle(title, defaultType);
    const langs = detectLanguages(title, language ? [language] : []);

    const peers = fields.get('peers') || '';
    const seeders = row.seeders ?? parseCount(peers.match(/seeders\s*:\s*([\d,.]+)/i)?.[1] ?? null);
    const leechers = row.leechers ?? parseCount(peers.match(/leechers\s*:\s*([\d,.]+)/i)?.[1] ?? null);
    const imdb = html.match(/imdb\.com\/title\/(tt\d{7,10})/i);

    // Some clones publish metainfo next to the magnet. Ignore off-site buttons,
    // and keep searching if the first `.torrent` anchor is an advert.
    let torrentFileUrl: string | null = null;
    for (const element of $('a[href]').toArray()) {
      const href = $(element).attr('href') || '';
      let isTorrent = false;
      try {
        isTorrent = /\.torrent$/i.test(new URL(href, row.detailUrl).pathname);
      } catch {
        continue;
      }
      if (!isTorrent) continue;
      const candidate = absoluteHttpUrl(href, row.detailUrl);
      if (candidate && sameMirrorSite(candidate, row.detailUrl)) {
        torrentFileUrl = candidate;
        break;
      }
    }

    return buildTorrentRecord({
      title,
      type: meta.type,
      infoHash: parsed.infoHash,
      magnetUrl: magnetHref,
      torrentFileUrl,
      sourceUrl: row.detailUrl,
      trackers: parsed.trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes: parseSizeToBytes(row.sizeStr) ?? parseSizeToBytes(fields.get('size') || ''),
      seeders,
      leechers,
      imdbId: imdb ? imdb[1] : null,
      sourceTracker: parsed.trackers[0] ?? null
    });
  }
}

export default RarbgCrawler;
