import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  isBlockedTitle,
  mapWithConcurrency,
  qualityOf
} from './support.js';

type MirrorMode = 'legacy_eu' | 'modern_me';

/**
 * MejorTorrent: legacy `.eu` templates and the WordPress based mirrors.
 * The infohash always comes from the downloaded metainfo (shared bencode parser),
 * never from a guessed ID, and unknown swarm counters remain `null`.
 */
export class MejorTorrentCrawler extends BaseCrawler {
  public readonly name = 'mejortorrent';
  public baseUrl: string;

  /** Known MejorTorrent domains; extend with MEJORTORRENT_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www45.mejortorrent.eu',
    'https://mejortorrent.me',
    'https://mejortorrent.wtf',
    'https://mejortorrent.app',
    'https://www.mejortorrent.icu',
    'https://mejortorrent1.com',
    'https://mejortorrents.net',
    'https://mejortorrent.nz',
    'https://www50.mejortorrent.eu'
  ];

  private readonly concurrency = Math.max(1, Number.parseInt(process.env.MEJORTORRENT_CONCURRENCY || '8', 10) || 8);

  constructor() {
    super();
    this.baseUrl = process.env.MEJORTORRENT_BASE_URL || MejorTorrentCrawler.DEFAULT_MIRRORS[0];
  }

  private resolveUrl(target: string, base: string): string {
    return absoluteHttpUrl(target, base) ?? target;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting crawl across movies and series (maxPages=${maxPages})...`);

    const validate = htmlMarkerValidator([/wp-json/i, /href=["'][^"']*\/(?:pelicula|serie)\//i]);
    const mirror = await this.resolveMirror({
      envPrefix: 'MEJORTORRENT',
      defaults: MejorTorrentCrawler.DEFAULT_MIRRORS,
      probes: [
        { path: '/', label: 'portada', timeoutMs: 6000, validate },
        { path: '/peliculas-hd', label: 'catálogo HD', timeoutMs: 6000, validate }
      ]
    });

    const mode = await this.detectTemplate(mirror);
    this.log.info(`Connected to ${mirror} (mode=${mode}).`);

    const records = mode === 'legacy_eu'
      ? await this.crawlLegacyEuMode(mirror, maxPages)
      : await this.crawlModernMeMode(mirror, maxPages);

    const deduplicated = this.deduplicateRecords(records);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** WordPress mirrors expose `wp-json`; the legacy `.eu` template does not. */
  private async detectTemplate(mirror: string): Promise<MirrorMode> {
    try {
      const html = await this.fetchHtml(mirror, { timeout: 6000 });
      return html.includes('wp-json/wp/v2') ? 'modern_me' : 'legacy_eu';
    } catch {
      return 'legacy_eu';
    }
  }

  // ==========================================================================
  // MODE: LEGACY EU (.eu, .wtf, .app)
  // ==========================================================================
  private async crawlLegacyEuMode(mirror: string, maxPages: number): Promise<TorrentRecord[]> {
    const results: TorrentRecord[] = [];
    const detailUrls = new Set<string>();

    const categories: Array<{ path: string; type: ContentType }> = [
      { path: '/inicio', type: 'movie' },
      { path: '/peliculas-hd', type: 'movie' },
      { path: '/peliculas-4k', type: 'movie' },
      { path: '/series-hd', type: 'series' },
      { path: '/documentales', type: 'documentary' }
    ];

    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        if (page > 1 && cat.path === '/inicio') break;

        const listUrl = page > 1 ? `${mirror}${cat.path}/page/${page}` : `${mirror}${cat.path}`;
        try {
          const html = await this.fetchHtml(listUrl);
          this.metrics.add('listings');
          const $ = cheerio.load(html);
          $('a[href*="/pelicula/"], a[href*="/serie/"], a[href*="/documental/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && !/genre|year|quality/i.test(href)) detailUrls.add(this.resolveUrl(href, mirror));
          });
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.debug(`Listing failed ${listUrl}: ${describe(error)}`);
          break;
        }
      }
    }

    const targets = [...detailUrls].slice(0, maxPages * 35);
    const nested = await mapWithConcurrency(targets, this.concurrency, async url => {
      if (this.deadline.expired) return [];
      try {
        const html = await this.fetchHtml(url);
        this.metrics.add('details');
        const $ = cheerio.load(html);

        const title = cleanText($('h1').first().text()) || cleanText($('title').text().split(/[|\-–]/)[0]);
        const defaultType: ContentType = url.includes('/serie/')
          ? 'series'
          : url.includes('/documental/') ? 'documentary' : 'movie';

        const anchors = $('a[href$=".torrent"], a[href*="/torrents/"]').toArray();
        const records: TorrentRecord[] = [];

        for (const el of anchors) {
          const anchor = $(el);
          const href = anchor.attr('href');
          if (!href?.toLowerCase().endsWith('.torrent')) continue;

          const torrentUrl = this.resolveUrl(href, url);
          let itemTitle = title;
          if (defaultType === 'series') {
            const epText = cleanText(anchor.closest('tr').find('td').eq(1).text());
            if (epText) itemTitle = `${title} ${epText}`;
          }

          const record = await this.downloadAndBuildRecord(torrentUrl, url, itemTitle, defaultType);
          if (record) {
            records.push(record);
            this.metrics.add('records');
          }
        }
        return records;
      } catch (error) {
        this.metrics.add('detailErrors');
        this.log.warn(`Error parsing EU detail ${url}: ${describe(error)}`);
        return [];
      }
    });

    results.push(...nested.flat());
    return results;
  }

  // ==========================================================================
  // MODE: MODERN ME (WordPress REST API + scraping)
  // ==========================================================================
  private async crawlModernMeMode(mirror: string, maxPages: number): Promise<TorrentRecord[]> {
    const detailUrls = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      if (this.deadline.expired) break;
      try {
        const posts = await this.fetchJson<Array<{ link?: string }>>(
          `${mirror}/wp-json/wp/v2/posts?page=${page}&per_page=30`
        );
        if (!Array.isArray(posts) || !posts.length) break;
        this.metrics.add('listings');
        for (const post of posts) {
          if (post?.link) detailUrls.add(this.resolveUrl(post.link, mirror));
        }
      } catch (error) {
        this.metrics.add('listingErrors');
        this.log.debug(`WP API page ${page} failed: ${describe(error)}`);
        break;
      }
    }

    const targets = [...detailUrls].slice(0, maxPages * 40);
    const nested = await mapWithConcurrency(targets, this.concurrency, async url => {
      if (this.deadline.expired) return [];
      try {
        const html = await this.fetchHtml(url);
        this.metrics.add('details');
        const $ = cheerio.load(html);

        const torrentUrls = new Set<string>();
        $('a[href$=".torrent"]').each((_, el) => {
          const href = $(el).attr('href');
          if (href) torrentUrls.add(this.resolveUrl(href, url));
        });
        if (!torrentUrls.size) {
          for (const match of html.match(/https?:\/\/[^\s"'<>]+\.torrent/gi) ?? []) torrentUrls.add(match);
        }

        const pageTitle = cleanText($('h1').first().text()) ||
          cleanText(decodeURIComponent(url.split('/').filter(Boolean).pop() || '').replace(/-/g, ' '));
        const defaultType: ContentType = /(temporada|episodios|\bs\d{1,2}\b)/i.test(html.toLowerCase())
          ? 'series'
          : 'movie';

        const records: TorrentRecord[] = [];
        for (const torrentUrl of torrentUrls) {
          const record = await this.downloadAndBuildRecord(torrentUrl, url, pageTitle, defaultType);
          if (record) {
            records.push(record);
            this.metrics.add('records');
          }
        }
        return records;
      } catch (error) {
        this.metrics.add('detailErrors');
        this.log.warn(`Error parsing ME detail ${url}: ${describe(error)}`);
        return [];
      }
    });

    return nested.flat();
  }

  // ==========================================================================
  // UNIFIED TORRENT PROCESSOR (DRY)
  // ==========================================================================
  public async downloadAndBuildRecord(
    torrentUrl: string,
    sourceUrl: string,
    fallbackTitle: string,
    defaultType: ContentType
  ): Promise<TorrentRecord | null> {
    try {
      const parsedTorrent = await this.fetchTorrentMetainfoViaGet(torrentUrl, sourceUrl);
      this.metrics.add('downloads');

      const effectiveTitle = cleanText(
        parsedTorrent.name && parsedTorrent.name.length > 3 ? parsedTorrent.name : fallbackTitle
      );
      if (!effectiveTitle || isBlockedTitle(effectiveTitle)) return null;

      const meta = parseTorrentTitle(effectiveTitle, defaultType);
      // Domain rule: MejorTorrent publishes Spanish releases.
      const langs = detectLanguages(effectiveTitle, ['mejortorrent', 'castellano']);
      if (!langs.audio.length) langs.audio.push('Castellano');

      return buildTorrentRecord({
        title: effectiveTitle,
        type: meta.type,
        infoHash: parsedTorrent.infoHash,
        torrentFileUrl: torrentUrl,
        sourceUrl,
        trackers: parsedTorrent.trackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parsedTorrent.sizeBytes || null,
        seeders: null,
        leechers: null,
        sourceTracker: parsedTorrent.primaryTracker || null
      });
    } catch (error) {
      this.metrics.add('downloadErrors');
      this.log.warn(`Failed to process torrent ${torrentUrl}: ${describe(error)}`);
      return null;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default MejorTorrentCrawler;
