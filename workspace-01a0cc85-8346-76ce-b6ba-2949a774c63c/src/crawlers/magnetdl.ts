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
  describeError,
  isBlockedTitle,
  mapWithConcurrency,
  parseCount,
  qualityOf,
  sameOrigin
} from './support.js';

export interface MagnetDlRow {
  detailUrl: string;
  title: string;
  type: ContentType;
  sizeStr: string;
  seeders: number | null;
  leechers: number | null;
  /** Present when the listing already publishes the magnet. */
  magnet: string | null;
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

    const searches = (process.env.MAGNETDL_SEARCH || 'spanish,castellano,latino')
      .split(/[,\n]+/).map(term => MagnetDlCrawler.searchPath(term.trim())).filter((p): p is string => Boolean(p));
    const routes: Array<{ path: string; type: ContentType | null }> = [
      ...searches.map(path => ({ path, type: null })),
      { path: '/download/movies/', type: 'movie' },
      { path: '/download/tv/', type: 'series' }
    ];

    const rows = new Map<string, MagnetDlRow>();
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
          let added = 0;
          for (const row of found) {
            if (rows.has(row.detailUrl)) continue;
            rows.set(row.detailUrl, row);
            added++;
          }
          if (!found.length || added === 0) break;
          url = this.nextPage(html, url, route.path, page);
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Listing failed ${url}: ${describeError(error)}`);
          break;
        }
      }
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
          const html = await this.fetchHtml(row.detailUrl, { headers: { Referer: `${mirror}/` } });
          this.metrics.add('details');
          const detail = this.parseDetail(html, row.title);
          magnet = detail.magnet;
          title = detail.title || title;
        }
        const record = magnet ? this.buildRecord(row, magnet, title) : null;
        if (record) this.metrics.add('records');
        else this.metrics.add('skipped');
        return record;
      } catch (error) {
        this.metrics.add('detailErrors');
        this.log.warn(`Detail failed ${row.detailUrl}: ${describeError(error)}`);
        return null;
      }
    });

    const deduplicated = this.deduplicateRecords(records.filter((r): r is TorrentRecord => Boolean(r)));
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** Published pagination only: "next"/"»"/"More results" or number `page + 1`. */
  public nextPage(html: string, current: string, routePath: string, page: number): string | null {
    const $ = cheerio.load(html);
    for (const el of $('a[href]').toArray()) {
      const anchor = $(el);
      const text = cleanText(anchor.text());
      const link = absoluteHttpUrl(anchor.attr('href'), current);
      if (!link || !sameOrigin(link, current) || link === current) continue;
      if (!new URL(link).pathname.startsWith(routePath)) continue;
      if (/^(next|siguiente|»|›|>|more torrent results)/i.test(text) || text === String(page + 1)) return link;
    }
    return null;
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

      const detailUrl = absoluteHttpUrl(anchor.attr('href'), pageUrl);
      const title = cleanText(anchor.attr('title') || anchor.text());
      if (!detailUrl || !title || isBlockedTitle(title)) return;

      const category = cleanText(tds.eq(3).text()).toLowerCase();
      if (category && !/movie|tv|anime|video|documentar/.test(category)) return;

      const magnet = $(tr).find('a[href^="magnet:?"]').first().attr('href') ?? null;
      const type: ContentType = forcedType ??
        (/tv/.test(category) || /\bS\d{1,2}(?:E\d{1,3})?\b/i.test(title) ? 'series' : 'movie');

      // Columns: magnet | name | age | type | [files] | size | seeds | leech.
      const cells = tds.toArray().map(td => cleanText($(td).text()));
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

  /** `/single/:id` page -> magnet (or a magnet rebuilt from the printed hash). */
  public parseDetail(html: string, fallbackTitle: string): { magnet: string | null; title: string } {
    const $ = cheerio.load(html);
    const heading = cleanText($('h1').first().text());
    const title = /(?:\.\.\.|…)$/.test(fallbackTitle) && heading ? heading : fallbackTitle || heading;

    const href = $('a[href^="magnet:?"]').first().attr('href') ??
      html.match(/magnet:\?xt=urn:btih:[^"'<>\s]+/i)?.[0]?.replace(/&amp;/g, '&') ?? null;
    if (href && parseMagnetUri(href)) return { magnet: href, title };

    const hash = html.match(/(?:info\s*hash|hash)[^0-9a-f]{0,40}\b([0-9a-f]{40})\b/i);
    return { magnet: hash ? buildMagnetUri(hash[1].toLowerCase(), title) : null, title };
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
