import * as cheerio from 'cheerio';
import { BaseCrawler, MirrorSetup } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { parseTorrentBuffer } from '../utils/bencode2.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  dedupeStrings,
  isBlockedTitle,
  mapWithConcurrency,
  qualityOf
} from './support.js';

export interface DownloadLink {
  url: string;
  title: string;
  hints?: string[];
  buffer?: Buffer;
}

export interface CatalogDetail {
  title: string;
  type: ContentType;
  downloads: DownloadLink[];
}

/**
 * Shared transport for plain HTML catalogues.
 *
 * Only the generic plumbing lives here (mirror selection, pagination guards,
 * per-detail concurrency, metainfo validation and record building). Routes,
 * selectors and link decoding stay in each site adapter.
 */
export abstract class HtmlCatalogCrawler extends BaseCrawler {
  public abstract baseUrl: string;
  protected abstract readonly sections: string[];
  public abstract parseListing(html: string, url: string): string[];
  public abstract parseDetail(html: string, url: string): CatalogDetail | Promise<CatalogDetail>;

  /** Optional mirror pool; resolution is soft so the adapter can still report a precise error. */
  protected get mirrorSetup(): MirrorSetup | null {
    return null;
  }

  /** Parallel detail pages per adapter (`CATALOG_DETAIL_CONCURRENCY`). */
  protected get detailConcurrency(): number {
    return Math.max(1, Number.parseInt(process.env.CATALOG_DETAIL_CONCURRENCY || '2', 10) || 2);
  }

  protected async discoverDownloads(html: string, url: string): Promise<CatalogDetail> {
    return this.parseDetail(html, url);
  }

  public nextPage(html: string, current: string): string | null {
    try {
      const $ = cheerio.load(html);
      const currentUrl = new URL(current);
      currentUrl.hash = '';
      const normalizedCurrent = currentUrl.href;

      const selectors = 'a[rel="next"], .pagination a, .navigation a, .pages a, .pagi a, .paginacion a';
      for (const el of $(selectors).toArray()) {
        const a = $(el);
        const isRelNext = a.attr('rel') === 'next';
        const text = cleanText(a.text());

        if (!isRelNext && !/siguiente|next|[»›→]/i.test(text)) continue;

        const rawHref = a.attr('href');
        if (!rawHref) continue;

        const next = httpUrl(rawHref, current);
        if (!next) continue;

        try {
          const nextUrl = new URL(next);
          nextUrl.hash = '';

          if (nextUrl.origin === currentUrl.origin && nextUrl.href !== normalizedCurrent) {
            return nextUrl.href;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();

    const setup = this.mirrorSetup;
    const base = setup
      ? await this.resolveMirror({ ...setup, fallback: setup.fallback ?? this.baseUrl })
      : this.baseUrl;
    this.baseUrl = base;

    const results: TorrentRecord[] = [];
    const seenDetails = new Set<string>();
    const seenListings = new Set<string>();
    let listingsRead = 0;

    for (const section of this.sections) {
      let listUrl: string | null = new URL(section, `${base}/`).href;

      for (let page = 0; listUrl && page < maxPages; page++) {
        if (seenListings.has(listUrl) || this.deadline.expired) break;
        seenListings.add(listUrl);

        try {
          const html = await this.fetchHtml(listUrl);
          listingsRead++;
          this.metrics.add('listings');

          // Resolver URLs relativas a absolutas e ignorar duplicados/inválidos
          const details = this.parseListing(html, listUrl)
            .map(rawUrl => httpUrl(rawUrl, listUrl!))
            .filter((url): url is string => {
              if (!url || seenDetails.has(url)) return false;
              seenDetails.add(url);
              return true;
            });

          const batches = await mapWithConcurrency(details, this.detailConcurrency, async url => {
            if (this.deadline.expired) return [];
            return this.crawlDetail(url);
          });

          // Inserción segura para evitar Stack Overflow con arrays masivos
          for (const batch of batches) {
            for (const record of batch) {
              results.push(record);
            }
          }

          // Seguir enlaces reales de paginación
          listUrl = this.nextPage(html, listUrl);
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Catalog failed ${listUrl}: ${describe(error)}`);
          break;
        }
      }
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);

    if (!listingsRead || !seenDetails.size || !deduplicated.length) {
      throw new Error(
        `[${this.name}] No usable releases: catalogs=${listingsRead}, details=${seenDetails.size}, ` +
        `records=${deduplicated.length} on ${base}. Check connectivity, layout and public downloads.`
      );
    }
    return deduplicated;
  }

  private async crawlDetail(url: string): Promise<TorrentRecord[]> {
    try {
      const html = await this.fetchHtml(url, { headers: { Referer: this.baseUrl } });
      this.metrics.add('details');

      const detail = await this.discoverDownloads(html, url);
      const records: TorrentRecord[] = [];
      const seenDownloads = new Set<string>();

      for (const download of detail.downloads) {
        if (seenDownloads.has(download.url)) continue;
        seenDownloads.add(download.url);
        try {
          const record = await this.buildDownload(download, detail, url);
          if (record) {
            records.push(record);
            this.metrics.add('records');
          }
        } catch (error) {
          this.metrics.add('downloadErrors');
          this.log.warn(`Invalid/unavailable download ${download.url}: ${describe(error)}`);
        }
      }

      if (!records.length) {
        this.metrics.add('skipped');
        this.log.warn(`No valid torrent in ${url} (layout, login or download unavailable).`);
      }
      return records;
    } catch (error) {
      this.metrics.add('detailErrors');
      this.log.warn(`Detail failed ${url}: ${describe(error)}`);
      return [];
    }
  }

  private async buildDownload(
    download: DownloadLink,
    detail: CatalogDetail,
    sourceUrl: string
  ): Promise<TorrentRecord | null> {
    const magnet = parseMagnetUri(download.url);
    let torrent = null;
    let resolvedTorrentUrl: string | null = null;

    if (!magnet) {
      if (download.buffer) {
        // Ya descargado por el adaptador
        torrent = parseTorrentBuffer(download.buffer);
        if (!torrent) throw new Error('Downloaded payload is not valid v1/hybrid torrent metainfo');
      } else {
        const resolved = httpUrl(download.url, sourceUrl);
        if (!resolved) return null;
        resolvedTorrentUrl = resolved;
        torrent = await this.fetchTorrentMetainfo(resolved, sourceUrl);
      }
      this.metrics.add('downloads');
    }

    const hash = magnet?.infoHash || torrent?.infoHash;
    if (!hash) return null;

    const title = cleanText(magnet?.displayName || download.title || torrent?.name || detail.title);
    if (isBlockedTitle(title)) return null;

    const context = dedupeStrings([title, torrent?.name ?? null, ...(download.hints || [])]).join(' ');
    const meta = parseTorrentTitle(context, detail.type);
    const languages = detectLanguages(context, [], false);
    const trackers = magnet?.trackers || torrent?.trackers || [];

    return buildTorrentRecord({
      title,
      type: meta.type,
      infoHash: hash,
      magnetUrl: magnet ? download.url : null,
      torrentFileUrl: magnet ? null : (resolvedTorrentUrl || httpUrl(download.url, sourceUrl)),
      sourceUrl,
      trackers,
      audio: languages.audio,
      subtitles: languages.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes: torrent?.sizeBytes ?? null,
      seeders: null,
      leechers: null,
      sourceTracker: trackers[0] || null
    });
  }
}

/** Resolves a link and rejects anything that is not plain http(s). */
export function httpUrl(value: string | undefined, base: string): string | null {
  return absoluteHttpUrl(value, base);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
