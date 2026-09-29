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

/** Restricts source, detail and metainfo links to the active mirror site. */
function sameMirrorSite(a: string, b: string): boolean {
  return sameSite(a, b);
}

function routeContainsPath(routePath: string, candidatePath: string): boolean {
  const normalizedRoute = `/${routePath}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  return candidatePath === normalizedRoute ||
    (normalizedRoute === '/' ? candidatePath.startsWith('/') : candidatePath.startsWith(`${normalizedRoute}/`));
}

export interface MagnetDlRow {
  detailUrl: string;
  title: string;
  type: ContentType;
  sizeStr: string;
  seeders: number | null;
  leechers: number | null;
  /** Present when the listing already publishes the magnet. */
  magnet: string | null;
  /** Metainfo link published by the `/single/:id` page (when there is one). */
  torrentFileUrl?: string | null;
}

/**
 * MagnetDL: `/download/movies/`, `/download/tv/` and `/<letter>/<slug>/`
 * searches. Newer templates link the magnet icon to `/single/:id`, so the
 * magnet is read from that page when the row does not carry it.
 */
export class MagnetDlCrawler extends BaseCrawler {
  public readonly name = 'magnetdl';
  public baseUrl = process.env.MAGNETDL_BASE_URL || 'https://magnetdl.co';

  /** Known domains; extend with MAGNETDL_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://magnetdl.co',
    'https://www.magnetdl.com',
    'https://magnetdl.app',
    'https://magnetdl.org'
  ];

  private readonly concurrency = Math.max(
    1,
    Number.parseInt(process.env.MAGNETDL_CONCURRENCY || '3', 10) || 3
  );

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'MAGNETDL',
      defaults: MagnetDlCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/download/movies/',
          label: 'catálogo de películas',
          timeoutMs: 8000,
          validate: htmlMarkerValidator([/href=["'][^"']*(?:\/single\/\d+|magnet:\?)/i])
        }
      ]
    });
  }

  /** `/s/spanish/` style search route (first letter + slug). */
  public static searchPath(term: string): string | null {
    const slug = term.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return null;
    return `/${slug[0]}/${slug}/`;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting MagnetDL crawl (maxPages=${maxPages})...`);

    const mirror = (await this.getWorkingMirror()).replace(/\/+$/, '');
    this.baseUrl = mirror;

    const searches = (process.env.MAGNETDL_SEARCH ?? 'spanish,castellano,latino')
      .split(/[,\n]+/).map(term => MagnetDlCrawler.searchPath(term.trim())).filter((p): p is string => Boolean(p));
    const routes: Array<{ path: string; type: ContentType | null }> = [
      ...searches.map(path => ({ path, type: null })),
      { path: '/download/movies/', type: 'movie' },
      { path: '/download/tv/', type: 'series' }
    ];

    const rows = new Map<string, MagnetDlRow>();
    let successfulListings = 0;
    for (const route of routes) {
      let url: string | null = `${mirror}${route.path}`;
      const visited = new Set<string>();
      for (let page = 1; url && page <= maxPages; page++) {
        if (this.deadline.expired || visited.has(url)) break;
        visited.add(url);
        try {
          const html = await this.fetchHtml(url, { headers: { Referer: `${mirror}/` } }, { rejectBlocked: true });
          this.metrics.add('listings');
          const found = this.parseListing(html, url, route.type);
          successfulListings++;
          for (const row of found) {
            if (!rows.has(row.detailUrl)) rows.set(row.detailUrl, row);
          }
          // A repeated/overlapping page can still publish a later page with new
          // items. Let the pager and visited-URL guard, not global deduplication,
          // decide when pagination ends.
          if (!found.length) break;
          url = this.nextPage(html, url, route.path, page);
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Listing failed ${url}: ${describeError(error)}`);
          break;
        }
      }
    }

    if (successfulListings === 0) {
      throw new Error('[magnetdl] No usable catalogue responses. Check mirror availability, blocking and page layout.');
    }

    const maxDetails = Math.max(40, maxPages * 60);
    const candidates = [...rows.values()].slice(0, maxDetails);
    this.log.info(`Discovered ${rows.size} releases; resolving ${candidates.length}...`);

    const records = await mapWithConcurrency(candidates, this.concurrency, async row => {
      if (this.deadline.expired) return null;
      try {
        let magnet = row.magnet;
        let title = row.title;
        if (!magnet) {
          const html = await this.fetchHtml(
            row.detailUrl,
            { headers: { Referer: `${mirror}/` } },
            { rejectBlocked: true }
          );
          this.metrics.add('details');
          const detail = this.parseDetail(html, row.title, row.detailUrl);
          magnet = detail.magnet;
          title = detail.title || title;
          if (detail.torrentFileUrl) row.torrentFileUrl = detail.torrentFileUrl;
        }
        const record = magnet ? this.buildRecord(row, magnet, title) : null;
        if (record) this.metrics.add('records');
        else this.metrics.add('skipped');
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

  /**
   * Published pagination only: `rel=next`, "next"/"»"/"More results", or the
   * page number that follows the current one inside the same route.
   */
  public nextPage(html: string, current: string, routePath: string, page: number): string | null {
    const link = nextPaginationLink(html, current, {
      nextText: /^(?:next|siguiente|siguientes?|pr[oó]xima?|»|›|>|→|more torrent results)(?:\s*(?:»|›|>|→))?$/i
    });
    if (!link) return null;
    try {
      const next = new URL(link);
      const currentUrl = new URL(current);
      if (!sameMirrorSite(next.href, currentUrl.href) || !routeContainsPath(routePath, next.pathname)) return null;
    } catch {
      return null;
    }
    return link;
  }

  public parseListing(html: string, pageUrl: string, forcedType: ContentType | null): MagnetDlRow[] {
    const $ = cheerio.load(html);
    const rows: MagnetDlRow[] = [];

    $('tr').each((_, tr) => {
      const tds = $(tr).children('td');
      if (tds.length < 6) return;

      // Title anchor = the /single/ link with text (the icon link has none).
      const anchor = $(tr).find('a[href*="/single/"], a[href*="/file/"]')
        .filter((__, a) => cleanText($(a).text()).length > 0).first();
      if (!anchor.length) return;

      const resolvedDetail = absoluteHttpUrl(anchor.attr('href'), pageUrl);
      const detailUrl = resolvedDetail && sameMirrorSite(resolvedDetail, pageUrl) ? resolvedDetail : null;
      const title = cleanText(anchor.attr('title') || anchor.text());
      if (!detailUrl || !title || isBlockedTitle(title)) return;

      // Columns: magnet | name | age | type | [files] | size | seeds | leech.
      const cells = tds.toArray().map(td => cleanText($(td).text()));

      // The category cell is located BY CONTENT: mirrors that drop the type
      // column shifted `tds.eq(3)` onto the size, and "1.4 GB" failed the
      // video-word test so every row of those mirrors was silently dropped.
      const CATEGORY_CELL =
        /^(?:movies?|tv|series|anime|video|documentar\w*|music|audio|games?|apps?|applications?|software|xxx|adult|pictures?|books?|other)\b/i;
      const category = cells.slice(2).find(text => text.length <= 30 && CATEGORY_CELL.test(text)) ?? '';
      if (category && !/movie|tv|anime|video|documentar/i.test(category)) return;

      let magnet: string | null = null;
      $(tr).find('a[href]').each((__, element) => {
        if (magnet) return;
        const candidate = $(element).attr('href') ?? '';
        if (/^magnet:\?/i.test(candidate) && parseMagnetUri(candidate)) magnet = candidate;
      });
      const type: ContentType = forcedType ??
        (/tv/.test(category) || /\bS\d{1,2}(?:E\d{1,3})?\b/i.test(title) ? 'series' : 'movie');

      const sizeIndex = cells.findIndex((text, i) => i > 1 && parseSizeToBytes(text) !== null && /[KMGT]i?B/i.test(text));
      rows.push({
        detailUrl,
        title,
        type,
        sizeStr: sizeIndex >= 0 ? cells[sizeIndex] : '',
        seeders: sizeIndex >= 0 ? parseCount(cells[sizeIndex + 1]) : null,
        leechers: sizeIndex >= 0 ? parseCount(cells[sizeIndex + 2]) : null,
        magnet: magnet && parseMagnetUri(magnet) ? magnet : null
      });
    });

    return rows;
  }

  /**
   * `/single/:id` page -> magnet (or a magnet rebuilt from the printed hash),
   * its real title and, when the page publishes it, the metainfo link.
   */
  public parseDetail(html: string, fallbackTitle: string, pageUrl = this.baseUrl): {
    magnet: string | null;
    title: string;
    torrentFileUrl: string | null;
  } {
    const $ = cheerio.load(html);
    const heading = cleanText($('h1').first().text());
    const title = /(?:\.\.\.|…)\s*$/.test(fallbackTitle) && heading ? heading : fallbackTitle || heading;

    // Download buttons may be ads. Keep only a real .torrent URL on this
    // mirror site, with no scheme downgrade, port change or URL credentials.
    let torrentFileUrl: string | null = null;
    for (const element of $('a[href]').toArray()) {
      const raw = $(element).attr('href') ?? '';
      const resolved = absoluteHttpUrl(raw, pageUrl);
      if (!resolved || !/\.torrent\/?(?:[?#].*)?$/i.test(resolved) || !sameMirrorSite(resolved, pageUrl)) continue;
      torrentFileUrl = resolved;
      break;
    }

    // Do not let an invalid first magnet hide a valid one later in the page.
    let magnet: string | null = null;
    for (const element of $('a[href]').toArray()) {
      const candidate = $(element).attr('href') ?? '';
      if (/^magnet:\?/i.test(candidate) && parseMagnetUri(candidate)) {
        magnet = candidate;
        break;
      }
    }
    if (!magnet) {
      for (const match of html.matchAll(/magnet:\?[^"'<>\s]+/gi)) {
        const candidate = match[0].replace(/&amp;/gi, '&').replace(/&#0*38;/gi, '&');
        if (parseMagnetUri(candidate)) {
          magnet = candidate;
          break;
        }
      }
    }
    if (magnet) return { magnet, title, torrentFileUrl };

    let hashMagnet: string | null = null;
    for (const hash of html.matchAll(/(?:info\s*hash|hash)[^0-9a-f]{0,40}\b([0-9a-f]{40})\b/gi)) {
      if (/^0{40}$/i.test(hash[1])) continue;
      hashMagnet = buildMagnetUri(hash[1].toLowerCase(), title, [], { includeDefaultTrackers: false });
      break;
    }
    return { magnet: hashMagnet, title, torrentFileUrl };
  }

  private buildRecord(row: MagnetDlRow, magnet: string, title: string): TorrentRecord | null {
    const parsed = parseMagnetUri(magnet);
    if (!parsed?.infoHash) return null;
    const cleanTitle = cleanText(title || parsed.displayName || '');
    if (!cleanTitle || isBlockedTitle(cleanTitle)) return null;

    const meta = parseTorrentTitle(cleanTitle, row.type);
    const langs = detectLanguages(cleanTitle, []);

    return buildTorrentRecord({
      title: cleanTitle,
      type: meta.type,
      infoHash: parsed.infoHash,
      magnetUrl: magnet,
      torrentFileUrl: row.torrentFileUrl ?? null,
      sourceUrl: row.detailUrl,
      trackers: parsed.trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes: parseSizeToBytes(row.sizeStr),
      seeders: row.seeders,
      leechers: row.leechers,
      sourceTracker: parsed.trackers[0] ?? null
    });
  }
}

export default MagnetDlCrawler;
