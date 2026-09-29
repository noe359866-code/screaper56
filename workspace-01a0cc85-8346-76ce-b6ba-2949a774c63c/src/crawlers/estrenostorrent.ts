import * as cheerio from 'cheerio';
import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri, buildMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  describeError,
  isBlockedTitle,
  mapWithConcurrency,
  nextPaginationLink,
  qualityOf,
  sameSite
} from './support.js';

export interface EstrenosTorrentItem {
  detailUrl: string;
  title: string;
  type: ContentType;
}

export interface EstrenosTorrentDownload {
  url: string;
  label: string;
  sizeBytes: number | null;
}

export interface EstrenosTorrentDetail {
  title: string;
  type: ContentType;
  downloads: EstrenosTorrentDownload[];
}

function sameSiteUrl(a: string, b: string): boolean {
  return sameSite(a, b);
}

function isDetailPath(path: string): boolean {
  if (/^\/(?:online\/[^/]+(?:\/[^/]+)?|serie-online\/\d+|movie\/(?:movie|online)\/\d+|serie\/(?:serie|online)\/\d+)\/?$/i.test(path)) {
    return true;
  }
  const segments = path.split('/').filter(Boolean);
  return segments.length === 3 && /^(?:peliculas|series)$/i.test(segments[0]) &&
    /^(?:4k-)?(?:2160p|1080p|720p|480p|bluray|brrip|dvdrip|hdtv)$/i.test(segments[1]) &&
    /^[a-z0-9][a-z0-9-]*$/i.test(segments[2]);
}

function routeContainsPath(routePath: string, candidatePath: string): boolean {
  const normalized = routePath.replace(/\/+$/, '') || '/';
  if (normalized === '/') return /^\/(?:page|pagina)\/\d+\/?$/i.test(candidatePath) || candidatePath === '/';
  return candidatePath === normalized || candidatePath.startsWith(`${normalized}/`);
}

/** Spanish film/series catalogues with public, signed .torrent links. */
export class EstrenosTorrentCrawler extends BaseCrawler {
  public readonly name = 'estrenostorrent';
  public baseUrl = process.env.ESTRENOSTORRENT_BASE_URL || 'https://estrenostorrent.org';

  public static readonly DEFAULT_MIRRORS: readonly string[] = ['https://estrenostorrent.org'];

  private readonly concurrency = Math.max(
    1,
    Number.parseInt(process.env.ESTRENOSTORRENT_CONCURRENCY || '3', 10) || 3
  );

  /** Detail pages are processed in ordered batches of this size ("pages"),
   *  so a long single-response catalogue is walked page by page instead of
   *  being truncated to `maxPages * 30` candidates. */
  private readonly detailPageSize = 30;

  /** Optional hard cap (ESTRENOSTORRENT_MAX_DETAILS); unset/invalid = no cap:
   *  every discovered detail page is processed, bounded by the run deadline. */
  private resolveDetailLimit(): number {
    const raw = process.env.ESTRENOSTORRENT_MAX_DETAILS;
    if (raw === undefined || raw.trim() === '') return Number.POSITIVE_INFINITY;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
  }

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'ESTRENOSTORRENT',
      defaults: EstrenosTorrentCrawler.DEFAULT_MIRRORS,
      probes: [{
        path: '/peliculas/',
        label: 'catálogo de películas',
        timeoutMs: 8000,
        validate: htmlMarkerValidator([/href=["'][^"']*\/(?:online|serie-online)\//i, /\/assets\/u\//i])
      }]
    });
  }

  public parseListing(html: string, pageUrl: string, forcedType: ContentType | null = null): EstrenosTorrentItem[] {
    const $ = cheerio.load(html);
    const found = new Map<string, EstrenosTorrentItem>();
    $('a[href]').each((_, element) => {
      const anchor = $(element);
      const raw = anchor.attr('href') || '';
      const detailUrl = absoluteHttpUrl(raw, pageUrl);
      if (!detailUrl || !sameSiteUrl(detailUrl, pageUrl)) return;
      let parsed: URL;
      try {
        parsed = new URL(detailUrl);
      } catch {
        return;
      }
      if (!isDetailPath(parsed.pathname)) return;
      const imageTitle = anchor.find('img').first().attr('alt') || '';
      const title = cleanText(anchor.attr('title') || anchor.find('strong').first().text() || imageTitle || anchor.text());
      if (!title || /^(?:descargar|ver ficha|ver m[aá]s|m[aá]s info)$/i.test(title) || isBlockedTitle(title)) return;
      const type: ContentType = forcedType ??
        (/serie|season|temporada|\bS\d{1,2}E\d{1,3}\b/i.test(`${parsed.pathname} ${title}`) ? 'series' : 'movie');
      if (!found.has(detailUrl)) found.set(detailUrl, { detailUrl, title, type });
    });
    return [...found.values()];
  }

  public parseDetail(html: string, sourceUrl: string, fallbackType: ContentType = 'movie'): EstrenosTorrentDetail {
    const $ = cheerio.load(html);
    const bodyText = cleanText($('body').text());
    const title = cleanText($('h1').first().text() || $('meta[property="og:title"]').attr('content') || '');
    const path = (() => {
      try { return new URL(sourceUrl).pathname; } catch { return ''; }
    })();
    const typeLabel = bodyText.match(/Tipo\s*:?\s*(Pel[ií]cula|Serie)/i)?.[1] || '';
    const type: ContentType = /^serie$/i.test(typeLabel) || /serie-online|\/(?:serie|series)\//i.test(path)
      ? 'series'
      : /\bdocumental(?:es)?\b/i.test(bodyText.slice(0, 500)) ? 'documentary'
        : fallbackType;

    const downloads: EstrenosTorrentDownload[] = [];
    const seen = new Set<string>();
    $('a[href]').each((_, element) => {
      const anchor = $(element);
      const href = anchor.attr('href') || '';
      if (/^magnet:/i.test(href)) {
        if (parseMagnetUri(href) && !seen.has(href)) {
          seen.add(href);
          downloads.push({ url: href, label: cleanText(anchor.text() || title), sizeBytes: parseSizeToBytes(anchor.text()) });
        }
        return;
      }
      const url = absoluteHttpUrl(href, sourceUrl);
      if (!url || !sameSiteUrl(url, sourceUrl)) return;
      let pathname: string;
      try { pathname = new URL(url).pathname; } catch { return; }
      if (!/\.torrent$/i.test(pathname) || seen.has(url)) return;
      seen.add(url);
      const label = cleanText(anchor.text() || anchor.attr('title') || '');
      const sizeText = label.match(/\d+(?:[.,]\d+)?\s*(?:TB|GB|GiB|MB|MiB|KB|KiB)/i)?.[0] || '';
      downloads.push({ url, label, sizeBytes: parseSizeToBytes(sizeText) });
    });

    return { title, type, downloads };
  }

  public nextPage(html: string, current: string, routePath: string): string | null {
    const candidate = nextPaginationLink(html, current, {
      nextText: /^(?:next|siguiente|siguientes?|pr[oó]xima?|»|›|>|→|m[aá]s)(?:\s*(?:»|›|>|→))?$/i
    });
    if (!candidate || !sameSiteUrl(candidate, current)) return null;
    try {
      return routeContainsPath(routePath, new URL(candidate).pathname) ? candidate : null;
    } catch {
      return null;
    }
  }

  private async processDetail(item: EstrenosTorrentItem, mirror: string): Promise<TorrentRecord[]> {
    if (this.deadline.expired) return [];
    try {
      const html = await this.fetchHtml(item.detailUrl, { headers: { Referer: `${mirror}/` } }, { rejectBlocked: true });
      this.metrics.add('details');
      const detail = this.parseDetail(html, item.detailUrl, item.type);
      if (!detail.title || isBlockedTitle(detail.title)) return [];
      const records: TorrentRecord[] = [];
      for (const download of detail.downloads.slice(0, 8)) {
        try {
          const magnet = parseMagnetUri(download.url);
          const metainfo = magnet ? null : await this.fetchTorrentMetainfoViaGet(download.url, item.detailUrl);
          const infoHash = magnet?.infoHash || metainfo?.infoHash;
          if (!infoHash) continue;
          const title = cleanText(metainfo?.name || magnet?.displayName || download.label || detail.title);
          if (!title || isBlockedTitle(title)) continue;
          const context = `${title} ${detail.title} ${download.label}`;
          const meta = parseTorrentTitle(context, detail.type);
          const languages = detectLanguages(context, ['estrenostorrent']);
          const trackers = magnet?.trackers || metainfo?.trackers || [];
          const magnetUrl = magnet
            ? download.url
            : buildMagnetUri(infoHash, title, trackers, { includeDefaultTrackers: false });
          const record = buildTorrentRecord({
            title,
            type: meta.type,
            infoHash,
            magnetUrl,
            torrentFileUrl: magnet ? null : download.url,
            sourceUrl: item.detailUrl,
            trackers,
            audio: languages.audio,
            subtitles: languages.subtitles,
            meta,
            quality: qualityOf(meta),
            sizeBytes: metainfo?.sizeBytes ?? download.sizeBytes,
            seeders: null,
            leechers: null,
            sourceTracker: metainfo?.primaryTracker ?? magnet?.trackers[0] ?? null
          });
          if (record) records.push(record);
          this.metrics.add('downloads');
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('downloadErrors');
          this.log.debug(`Metainfo failed ${download.url}: ${describeError(error)}`);
        }
      }
      return records;
    } catch (error) {
      rethrowIfBlockedOrRateLimited(error);
      this.metrics.add('detailErrors');
      this.log.warn(`Detail failed ${item.detailUrl}: ${describeError(error)}`);
      return [];
    }
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting EstrenosTorrent crawl (maxPages=${maxPages})...`);

    const mirror = (await this.getWorkingMirror()).replace(/\/+$/, '');
    this.baseUrl = mirror;
    const routes: Array<{ path: string; type: ContentType | null }> = [
      { path: '/', type: null },
      { path: '/peliculas/', type: 'movie' },
      { path: '/series/', type: 'series' }
    ];
    const items = new Map<string, EstrenosTorrentItem>();
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
          for (const item of found) {
            if (!items.has(item.detailUrl)) items.set(item.detailUrl, item);
          }
          url = this.nextPage(html, url, route.path);
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Listing failed ${url}: ${describeError(error)}`);
          url = null;
        }
      }
    }

    if (!successfulListings) {
      throw new Error('[estrenostorrent] No usable catalogue responses. Check the configured domain and page layout.');
    }
    const candidates = [...items.values()];
    if (!candidates.length) {
      throw new Error('[estrenostorrent] No detail pages found in the home, movies or series catalogues.');
    }

    // The movie and series catalogues are served as one long response without a
    // pager, so every discovered detail page is processed, in batches ("pages")
    // of `detailPageSize`, until the catalogue, the optional
    // ESTRENOSTORRENT_MAX_DETAILS cap or the run deadline is exhausted.
    const limit = this.resolveDetailLimit();
    const pending = Math.min(candidates.length, limit);
    this.log.info(`Processing ${pending} detail pages in batches of ${this.detailPageSize} (discovered: ${candidates.length})...`);
    const results: TorrentRecord[] = [];
    let processed = 0;
    for (let offset = 0; offset < candidates.length && processed < limit && !this.deadline.expired; offset += this.detailPageSize) {
      const batch = candidates.slice(offset, offset + Math.min(this.detailPageSize, limit - processed));
      const batchRecords = (await mapWithConcurrency(batch, this.concurrency, item => this.processDetail(item, mirror))).flat();
      processed += batch.length;
      results.push(...batchRecords);
      this.log.info(
        `[estrenostorrent] detail page ${Math.floor(offset / this.detailPageSize) + 1}: ` +
        `${batch.length} fichas, +${batchRecords.length} records (${processed}/${pending}).`
      );
    }

    const unique = this.deduplicateRecords(results);
    this.logRunSummary(unique);
    if (!unique.length) {
      throw new Error(`[estrenostorrent] No verified torrent infohashes from ${candidates.length} detail pages.`);
    }
    return unique;
  }
}

export default EstrenosTorrentCrawler;
