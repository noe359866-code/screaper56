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
  sameHost
} from './support.js';

export interface T0rrentaItem {
  detailUrl: string;
  title: string;
}

export interface T0rrentaDownload {
  url: string;
  title: string;
  sizeBytes: number | null;
}

interface T0rrentaDetail {
  title: string;
  type: ContentType;
  tmdbId: number | null;
  downloads: T0rrentaDownload[];
}

function sameSiteUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return !left.username && !left.password && !right.username && !right.password &&
      left.protocol === right.protocol && left.port === right.port && sameHost(a, b);
  } catch {
    return false;
  }
}

function fileKey(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
      .replace(/\.torrent$/i, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  } catch {
    return url.toLowerCase();
  }
}

/** Public metadata pages and signed metainfo links published by t0rrenta.org. */
export class T0rrentaCrawler extends BaseCrawler {
  public readonly name = 't0rrenta';
  public baseUrl = process.env.T0RRENTA_BASE_URL || 'https://t0rrenta.org';

  public static readonly DEFAULT_MIRRORS: readonly string[] = ['https://t0rrenta.org'];

  private readonly concurrency = Math.max(
    1,
    Number.parseInt(process.env.T0RRENTA_CONCURRENCY || '2', 10) || 2
  );

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'T0RRENTA',
      defaults: T0rrentaCrawler.DEFAULT_MIRRORS,
      probes: [{
        path: '/',
        label: 'portada t0rrenta',
        timeoutMs: 8000,
        validate: htmlMarkerValidator([/t0rrenta-logo/i])
      }]
    });
  }

  /** Extract `/p/:id` pages from both the site's cards and its published sitemap. */
  public parseListing(html: string, pageUrl: string): T0rrentaItem[] {
    const $ = cheerio.load(html, { xmlMode: /sitemap\.xml(?:$|\?)/i.test(pageUrl) });
    const found = new Map<string, T0rrentaItem>();

    const add = (rawUrl: string | undefined, rawTitle: string): void => {
      const detailUrl = absoluteHttpUrl(rawUrl, pageUrl);
      if (!detailUrl || !sameSiteUrl(detailUrl, pageUrl)) return;
      let parsed: URL;
      try {
        parsed = new URL(detailUrl);
      } catch {
        return;
      }
      if (!/^\/p\/\d+\/?$/.test(parsed.pathname)) return;
      const title = cleanText(rawTitle);
      if (!title || isBlockedTitle(title)) return;
      if (!found.has(detailUrl)) found.set(detailUrl, { detailUrl, title });
    };

    $('a[href]').each((_, element) => {
      const anchor = $(element);
      const href = anchor.attr('href') || '';
      if (!/\/p\/\d+\/?(?:[?#]|$)/.test(href)) return;
      const title = anchor.attr('title') || anchor.text() || anchor.find('img').first().attr('alt') || '';
      add(href, title);
    });
    $('loc').each((_, element) => add($(element).text(), 'Torrent release'));

    return [...found.values()];
  }

  public parseDetail(html: string, sourceUrl: string): T0rrentaDetail {
    const $ = cheerio.load(html);
    const title = cleanText($('h1').first().text() || $('meta[property="og:title"]').attr('content') || '');
    const pageText = cleanText($('body').text());
    const tmdbLink = $('a[href*="themoviedb.org/"]').first().attr('href') || '';
    const tmdbMatch = tmdbLink.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    const tmdbId = tmdbMatch ? Number.parseInt(tmdbMatch[2], 10) : null;
    const genreText = cleanText($('h1').first().parent().text() || pageText.slice(0, 500));
    const type: ContentType = tmdbMatch?.[1].toLowerCase() === 'tv'
      ? 'series'
      : /\bdocumental(?:es)?\b/i.test(genreText) ? 'documentary' : 'movie';

    const downloads: T0rrentaDownload[] = [];
    const seen = new Set<string>();
    $('a[href]').each((_, element) => {
      const anchor = $(element);
      const href = anchor.attr('href') || '';
      if (/^magnet:/i.test(href)) {
        if (parseMagnetUri(href)) downloads.push({
          url: href,
          title: cleanText(anchor.text() || title),
          sizeBytes: parseSizeToBytes(anchor.text())
        });
        return;
      }
      const url = absoluteHttpUrl(href, sourceUrl);
      if (!url || !sameSiteUrl(url, sourceUrl)) return;
      let path: string;
      try {
        path = new URL(url).pathname;
      } catch {
        return;
      }
      if (!/^\/download\/\d+\/[^/]+\.torrent$/i.test(path)) return;
      const key = fileKey(url);
      if (seen.has(key)) return;
      seen.add(key);
      const label = cleanText(anchor.text() || anchor.attr('title') || '');
      const sizeText = label.match(/\d+(?:[.,]\d+)?\s*(?:TB|GB|GiB|MB|MiB|KB|KiB)/i)?.[0] || '';
      let filename = '';
      try {
        filename = decodeURIComponent(path.split('/').pop() || '').replace(/\.torrent$/i, '');
      } catch {
        filename = path.split('/').pop() || '';
      }
      downloads.push({
        url,
        title: cleanText(filename.replace(/[-_]+/g, ' ')) || title,
        sizeBytes: parseSizeToBytes(sizeText)
      });
    });

    return { title, type, tmdbId, downloads };
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting t0rrenta crawl (maxPages=${maxPages})...`);

    const mirror = (await this.getWorkingMirror()).replace(/\/+$/, '');
    this.baseUrl = mirror;
    const items = new Map<string, T0rrentaItem>();
    let successfulListings = 0;

    let pageUrl: string | null = `${mirror}/`;
    const visited = new Set<string>();
    for (let page = 1; pageUrl && page <= maxPages; page++) {
      if (this.deadline.expired || visited.has(pageUrl)) break;
      visited.add(pageUrl);
      try {
        const html = await this.fetchHtml(pageUrl, { headers: { Referer: `${mirror}/` } }, { rejectBlocked: true });
        this.metrics.add('listings');
        const found = this.parseListing(html, pageUrl);
        successfulListings++;
        for (const item of found) items.set(item.detailUrl, item);
        const next = nextPaginationLink(html, pageUrl);
        pageUrl = next && sameSiteUrl(next, mirror) ? next : null;
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('listingErrors');
        this.log.warn(`Listing failed ${pageUrl}: ${describeError(error)}`);
        pageUrl = null;
      }
    }

    // The site publishes item permalinks in sitemap.xml as well as its home cards.
    // It is a single bounded index request; detail count is capped below.
    try {
      const sitemapUrl = `${mirror}/sitemap.xml`;
      const html = await this.fetchHtml(sitemapUrl, { headers: { Referer: `${mirror}/` } }, { rejectBlocked: true });
      this.metrics.add('listings');
      const sitemapItems = this.parseListing(html, sitemapUrl);
      successfulListings++;
      for (const item of sitemapItems) {
        if (!items.has(item.detailUrl)) items.set(item.detailUrl, item);
      }
    } catch (error) {
      rethrowIfBlockedOrRateLimited(error);
      this.metrics.add('listingErrors');
      this.log.debug(`Optional sitemap unavailable: ${describeError(error)}`);
    }

    if (!successfulListings) {
      throw new Error('[t0rrenta] No usable catalogue responses. Check the configured domain and page layout.');
    }
    const candidates = [...items.values()].slice(0, Math.max(20, maxPages * 20));
    if (!candidates.length) {
      throw new Error('[t0rrenta] No /p/:id detail pages found in the home listing or sitemap.');
    }

    const results = (await mapWithConcurrency(candidates, this.concurrency, async item => {
      if (this.deadline.expired) return [] as TorrentRecord[];
      try {
        const html = await this.fetchHtml(item.detailUrl, { headers: { Referer: `${mirror}/` } }, { rejectBlocked: true });
        this.metrics.add('details');
        const detail = this.parseDetail(html, item.detailUrl);
        if (!detail.title || isBlockedTitle(detail.title)) return [] as TorrentRecord[];
        const records: TorrentRecord[] = [];
        for (const download of detail.downloads.slice(0, 4)) {
          try {
            const magnet = parseMagnetUri(download.url);
            const metainfo = magnet ? null : await this.fetchTorrentMetainfoViaGet(download.url, item.detailUrl);
            const infoHash = magnet?.infoHash || metainfo?.infoHash;
            if (!infoHash) continue;
            const releaseTitle = cleanText(metainfo?.name || magnet?.displayName || download.title || detail.title);
            if (!releaseTitle || isBlockedTitle(releaseTitle)) continue;
            const context = `${releaseTitle} ${detail.title} ${download.title}`;
            const meta = parseTorrentTitle(context, detail.type);
            const languages = detectLanguages(context, ['t0rrenta']);
            const trackers = magnet?.trackers || metainfo?.trackers || [];
            const magnetUrl = magnet
              ? download.url
              : buildMagnetUri(infoHash, releaseTitle, trackers, { includeDefaultTrackers: false });
            const record = buildTorrentRecord({
              title: releaseTitle,
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
              tmdbId: detail.tmdbId,
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
        return [] as TorrentRecord[];
      }
    })).flat();

    const unique = this.deduplicateRecords(results);
    this.logRunSummary(unique);
    if (!unique.length) {
      throw new Error(`[t0rrenta] No verified torrent infohashes from ${candidates.length} detail pages.`);
    }
    return unique;
  }
}

export default T0rrentaCrawler;
