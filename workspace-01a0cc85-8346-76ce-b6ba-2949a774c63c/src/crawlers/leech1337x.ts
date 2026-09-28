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

interface ScrapedRow {
  detailUrl: string;
  title: string;
  seeders: number | null;
  leechers: number | null;
  sizeStr: string;
}

const EXCLUDED_CATEGORY = /\b(games?|music|apps?|applications?|software|e-?books?|porn|xxx|adult)\b/i;

/** Same mirror front-end, allowing www/apex but not a scheme or port change. */
function sameSiteUrl(a: string, b: string): boolean {
  return sameSite(a, b);
}

/** Pagination must stay on the listing route, not just on the mirror host. */
function sameListingRoute(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const routePath = (pathname: string) => pathname.replace(/\/\d+\/?$/, '/').replace(/\/+$/, '') || '/';
    return sameSiteUrl(a, b) && routePath(left.pathname) === routePath(right.pathname);
  } catch {
    return false;
  }
}

export class Leech1337xCrawler extends BaseCrawler {
  public readonly name = 'leech1337x';
  public baseUrl = process.env.LEECH1337X_BASE_URL || 'https://1337x.la';

  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://1337x.la',
    'https://www.1337x.tw',
    'https://1337x.to',
    'https://1337x.st',
    'https://x1337x.ws',
    'https://x1337x.eu',
    'https://x1337x.se',
    'https://1337x.is',
    'https://1337x.gd',
    'https://1377x.to'
  ];

  private readonly concurrency = Math.max(1, Number.parseInt(process.env.LEECH1337X_CONCURRENCY || '2', 10) || 2);

  private resolveUrl(target: string, base: string): string {
    return absoluteHttpUrl(target, base) ?? target;
  }

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'LEECH1337X',
      defaults: Leech1337xCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/',
          label: 'portada',
          timeoutMs: 7000,
          validate: htmlMarkerValidator([/table-list/, /href=["'][^"']*\/torrent\//])
        },
        {
          path: '/popular-movies',
          label: 'populares',
          timeoutMs: 7000,
          validate: htmlMarkerValidator([/table-list/, /href=["'][^"']*\/torrent\//])
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting 1337x crawl (maxPages=${maxPages})...`);

    const mirror = await this.getWorkingMirror();
    const results: TorrentRecord[] = [];
    const visitedDetails = new Set<string>();
    let successfulListings = 0;
    let listingLayouts = 0;

    const searchEndpoints = [
      '/sort-search/spanish/seeders/desc',
      '/sort-search/latino/seeders/desc',
      '/sort-search/castellano/seeders/desc',
      '/sort-search/dual%20audio/seeders/desc',
      '/popular-movies',
      '/popular-tv'
    ];

    for (const endpoint of searchEndpoints) {
      const isSearch = endpoint.includes('sort-search');

      // Search pagination is numbered, so the guess stays as a fallback, but
      // the pager the page publishes (when it has one) always wins: mirrors
      // differ in whether page 2 is `/2/` or `/seeders/desc/2/`.
      let url: string | null = isSearch ? `${mirror}${endpoint}/1/` : `${mirror}${endpoint}`;
      const visited = new Set<string>();

      for (let page = 1; url && page <= maxPages; page++) {
        if (this.deadline.expired) break;
        if (visited.has(url)) break;
        visited.add(url);

        let listingHtml = '';
        let listingHadRows = false;
        try {
          this.log.debug(`Scraping listing: ${url}`);
          const html = await this.fetchHtml(url, {}, { rejectBlocked: true });
          this.metrics.add('listings');
          successfulListings++;
          const $ = cheerio.load(html);
          listingHtml = html;

          if ($('table.table-list').length > 0) listingLayouts++;
          const tableRows = $('table.table-list tbody tr');
          if (tableRows.length === 0) this.log.debug(`No rows found on ${url}.`);
          listingHadRows = tableRows.length > 0;

          const rows: ScrapedRow[] = [];
          tableRows.each((_, el) => {
            const $row =$(el);
            const nameEl = $row.find('td.name a[href]').filter((_, anchor) => {
              try {
                return /^\/torrent\/\d+(?:\/|$)/.test(new URL($(anchor).attr('href') || '', mirror).pathname);
              } catch { return false; }
            }).first();
            if (!nameEl.length) return;

            const detailUrl = this.resolveUrl(nameEl.attr('href') || '', mirror);
            if (!sameSiteUrl(detailUrl, mirror)) return;
            if (visitedDetails.has(detailUrl)) return;

            const title = cleanText(nameEl.text());
            if (!title || isBlockedTitle(title)) return;

            visitedDetails.add(detailUrl);

            const sizeTdText = $row.find('td.size, td.coll-4').text();
            const sizeMatch = sizeTdText.match(/\d+(?:[.,]\d+)?\s*(?:[KMGT]i?B|bytes)/i);

            rows.push({
              detailUrl,
              title,
              seeders: parseCount($row.find('td.seeds').text()),
              leechers: parseCount($row.find('td.leeches').text()),
              sizeStr: sizeMatch ? sizeMatch[0] : cleanText(sizeTdText)
            });
          });

          this.log.debug(`Processing ${rows.length} torrent rows from ${url}...`);
          const records = await mapWithConcurrency(rows, this.concurrency, async row => {
            if (this.deadline.expired) return null;
            try {
              const record = await this.crawlDetail(row, mirror);
              if (record) this.metrics.add('records');
              return record;
            } catch (error) {
              rethrowIfBlockedOrRateLimited(error);
              this.metrics.add('detailErrors');
              this.log.warn(`Failed to scrape detail for "${row.title}": ${describeError(error)}`);
              return null;
            }
          });

          for (const record of records) {
            if (record) results.push(record);
          }
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Failed loading listing ${url}: ${describeError(error)}`);
          break;
        }

        const publishedNext = nextPaginationLink(listingHtml, url);
        url = publishedNext && sameListingRoute(publishedNext, url)
          ? publishedNext
          : (isSearch && listingHadRows ? `${mirror}${endpoint}/${page + 1}/` : null);
      }
    }

    if (successfulListings === 0) {
      throw new Error('[leech1337x] No usable catalogue responses. Check mirror availability, blocking and network access.');
    }
    if (listingLayouts === 0) {
      throw new Error('[leech1337x] Catalogue pages did not contain the expected table-list layout.');
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  private async crawlDetail(row: ScrapedRow, mirror?: string): Promise<TorrentRecord | null> {
    // Mirrors 403 detail pages that arrive without a same-site Referer.
    const html = await this.fetchHtml(row.detailUrl, {
      headers: mirror ? { Referer: `${mirror}/` } : {}
    }, { rejectBlocked: true });
    this.metrics.add('details');
    const $ = cheerio.load(html);

    let magnetHref: string | null = null;
    let parsedMagnet: ReturnType<typeof parseMagnetUri> = null;
    for (const element of $('a[href]').toArray()) {
      const href = $(element).attr('href') || '';
      if (!/^magnet:/i.test(href)) continue;
      const candidate = parseMagnetUri(href);
      if (!candidate?.infoHash) continue;
      magnetHref = href;
      parsedMagnet = candidate;
      break;
    }

    const detailsMap = new Map<string, string>();
    $('.torrent-category-detail li, .torrent-detail-page li').each((_, el) => {
      const $li =$(el);
      const strong = $li.find('strong').first();
      if (!strong.length) return;

      const key = cleanText(strong.text()).replace(':', '').toLowerCase();
      if (!key) return;

      const val = cleanText($li.children('span').text() || $li.contents().not(strong).text());
      detailsMap.set(key, val);
    });

    const pageCategory = (detailsMap.get('category') || '').toLowerCase();
    if (EXCLUDED_CATEGORY.test(pageCategory)) return null;
    const pageLanguage = detailsMap.get('language') || '';

    let defaultType: ContentType = 'movie';
    if (/tv|television|episodes/.test(pageCategory)) defaultType = 'series';
    else if (pageCategory.includes('anime')) defaultType = 'anime';
    else if (pageCategory.includes('documentar')) defaultType = 'documentary';

    // Listing titles are truncated with "..." on long names; the detail heading
    // or the magnet display name carries the full release name.
    const heading = cleanText($('div.box-info-heading h1').first().text());
    const truncated = /(?:\.\.\.|…)$/.test(row.title);
    const title = (truncated ? heading || parsedMagnet?.displayName : null) || row.title || parsedMagnet?.displayName || heading;
    if (!title || isBlockedTitle(title)) return null;

    // Several front-ends hide the magnet behind a third-party download button
    // but still print the hash in the detail list; that is a real infohash, not
    // a guess, so it is worth recovering before giving up on the page.
    if (!parsedMagnet?.infoHash) {
      const publishedHash = (detailsMap.get('infohash') || detailsMap.get('info hash') || '')
        .match(/\b([0-9a-f]{40})\b/i)
        || html.match(/info\s*hash[^0-9a-fA-F]{0,40}([0-9a-f]{40})/i);

      if (!publishedHash) return null;

      const recovered = publishedHash[1].toLowerCase();
      magnetHref = buildMagnetUri(recovered, title, [], { includeDefaultTrackers: false });
      parsedMagnet = parseMagnetUri(magnetHref);
      if (!parsedMagnet?.infoHash) return null;
      this.metrics.add('hashRecovered');
    }

    const meta = parseTorrentTitle(title, defaultType);
    const langs = detectLanguages(title, [pageLanguage, pageCategory]);

    const imdbMatch = html.match(/imdb\.com\/title\/(tt\d{7,10})/i);

    // Metainfo link published next to the magnet, when the mirror offers one.
    // Third-party download buttons are dropped: they are not this source's
    // file. The href is resolved first, because it is usually relative.
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
      if (candidate && sameSiteUrl(candidate, row.detailUrl)) {
        torrentFileUrl = candidate;
        break;
      }
    }

    const finalSizeStr = row.sizeStr || detailsMap.get('total size') || detailsMap.get('size') || '';
    const seeders = row.seeders ?? parseCount(detailsMap.get('seeders'));
    const leechers = row.leechers ?? parseCount(detailsMap.get('leechers'));

    return buildTorrentRecord({
      title,
      type: meta.type,
      infoHash: parsedMagnet.infoHash,
      magnetUrl: magnetHref,
      torrentFileUrl,
      sourceUrl: row.detailUrl,
      trackers: parsedMagnet.trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes: parseSizeToBytes(finalSizeStr),
      seeders,
      leechers,
      imdbId: imdbMatch ? imdbMatch[1] : null,
      sourceTracker: parsedMagnet.trackers[0] ?? null
    });
  }
}

export default Leech1337xCrawler;
