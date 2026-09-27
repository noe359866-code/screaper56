import { DOWNLOAD_NODES, literalDownloadCandidates, spanishReleaseHints } from './spanish-catalog.js';
import { parseMagnetUri } from '../utils/magnet.js';
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
  qualityOf,
  sameOrigin
} from './support.js';

type MirrorMode = 'legacy_eu' | 'modern_me';

interface ListingTarget {
  url: string;
  type: ContentType;
}

/**
 * MejorTorrent: legacy `.eu` templates and WordPress-based mirrors.
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

  private readonly concurrency = Math.max(
    1,
    Number.parseInt(process.env.MEJORTORRENT_CONCURRENCY || '8', 10) || 8
  );

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
      return /wp-json|wp-content|api\.w\.org/i.test(html) ? 'modern_me' : 'legacy_eu';
    } catch {
      return 'legacy_eu';
    }
  }

  // ==========================================================================
  // MODE: LEGACY EU (.eu, .wtf, .app)
  // ==========================================================================
  private async crawlLegacyEuMode(mirror: string, maxPages: number): Promise<TorrentRecord[]> {
    const categories: Array<{ path: string; type: ContentType }> = [
      { path: '/inicio', type: 'movie' },
      { path: '/peliculas-hd', type: 'movie' },
      { path: '/peliculas-4k', type: 'movie' },
      { path: '/series-hd', type: 'series' },
      { path: '/documentales', type: 'documentary' }
    ];

    const listingTargets: ListingTarget[] = [];
    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        if (page > 1 && cat.path === '/inicio') break;
        const url = page > 1 ? `${mirror}${cat.path}/page/${page}` : `${mirror}${cat.path}`;
        listingTargets.push({ url, type: cat.type });
      }
    }

    const detailUrls = new Set<string>();

    // Extraer páginas de listado en paralelo con control de concurrencia
    await mapWithConcurrency(listingTargets, this.concurrency, async ({ url }) => {
      if (this.deadline.expired) return;
      try {
        const html = await this.fetchHtml(url);
        this.metrics.add('listings');
        const $ = cheerio.load(html);
        $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();

        $('a[href*="/pelicula/"], a[href*="/serie/"], a[href*="/documental/"]').each((_, el) => {
          const href = $(el).attr('href');
          if (href && !/genre|year|quality/i.test(href)) {
            detailUrls.add(this.resolveUrl(href, url));
          }
        });
      } catch (error) {
        this.metrics.add('listingErrors');
        this.log.debug(`Listing failed ${url}: ${describe(error)}`);
      }
    });

    const targets = [...detailUrls].slice(0, maxPages * 35);
    const nested = await mapWithConcurrency(targets, this.concurrency, async url => {
      if (this.deadline.expired) return [];
      try {
        const html = await this.fetchHtml(url);
        this.metrics.add('details');
        const $ = cheerio.load(html);
        $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();

        const title = cleanText($('h1').first().text()) || cleanText($('title').text().split(/[|\-–]/)[0]);
        const defaultType: ContentType = url.includes('/serie/')
          ? 'series'
          : url.includes('/documental/') ? 'documentary' : 'movie';

        const anchors = $(DOWNLOAD_NODES).toArray();
        const records: TorrentRecord[] = [];

        for (const el of anchors) {
          const anchor = $(el);
          for (const href of literalDownloadCandidates(anchor)) {
            if (!parseMagnetUri(href) && !/\.torrent(?:[?#]|$)/i.test(href) && !(sameOrigin(this.resolveUrl(href, url), url) && /^\/torrents\//i.test(new URL(this.resolveUrl(href, url)).pathname))) continue;

            const torrentUrl = this.resolveUrl(href, url);
            let itemTitle = title;
            if (defaultType === 'series') {
              const epText = cleanText(anchor.closest('tr').find('td').eq(1).text());
              if (epText) itemTitle = `${title} ${epText}`;
            }

            const record = await this.downloadAndBuildRecord(torrentUrl, url, itemTitle, defaultType, spanishReleaseHints($));
            if (record) {
              records.push(record);
              this.metrics.add('records');
            }
          }
        }
        return records;
      } catch (error) {
        this.metrics.add('detailErrors');
        this.log.warn(`Error parsing EU detail ${url}: ${describe(error)}`);
        return [];
      }
    });

    return nested.flat();
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
        this.log.debug(`WP API page ${page} finished or failed: ${describe(error)}`);
        break;
      }
    }

    if (!detailUrls.size) {
      this.log.warn('WordPress API yielded no posts; trying HTML catalogues.');
      return this.crawlLegacyEuMode(mirror, maxPages);
    }

    const targets = [...detailUrls].slice(0, maxPages * 40);
    const nested = await mapWithConcurrency(targets, this.concurrency, async url => {
      if (this.deadline.expired) return [];
      try {
        const html = await this.fetchHtml(url);
        this.metrics.add('details');
        const $ = cheerio.load(html);
        $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();

        const torrentUrls = new Set<string>();
        $(DOWNLOAD_NODES).each((_, el) => {
          for (const href of literalDownloadCandidates($(el))) {
            if (parseMagnetUri(href) || /\.torrent(?:[?#]|$)/i.test(href)) {
              torrentUrls.add(this.resolveUrl(href, url));
            }
          }
        });

        if (!torrentUrls.size) {
          const matches = html.match(/https?:\/\/[^\s"'<>]+\.torrent(\?[^\s"'<>]*)?/gi) ?? [];
          for (const match of matches) torrentUrls.add(match);
        }

        const pageTitle = cleanText($('h1').first().text()) ||
          cleanText(decodeURIComponent(url.split('/').filter(Boolean).pop() || '').replace(/-/g, ' '));
        const defaultType: ContentType = /(temporada|episodios|\bs\d{1,2}\b)/i.test(html.toLowerCase())
          ? 'series'
          : 'movie';

        const records: TorrentRecord[] = [];
        for (const torrentUrl of torrentUrls) {
          const record = await this.downloadAndBuildRecord(torrentUrl, url, pageTitle, defaultType, spanishReleaseHints($));
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
    defaultType: ContentType,
    hints: string[] = []
  ): Promise<TorrentRecord | null> {
    try {
      const magnet = parseMagnetUri(torrentUrl);
      const parsedTorrent = magnet ? null : await this.fetchTorrentMetainfoViaGet(torrentUrl, sourceUrl);
      this.metrics.add('downloads');

      const effectiveTitle = cleanText(
        parsedTorrent?.name || magnet?.displayName || fallbackTitle
      );
      if (!effectiveTitle || isBlockedTitle(effectiveTitle)) return null;

      const meta = parseTorrentTitle([effectiveTitle, fallbackTitle, ...hints].join(' '), defaultType);
      // Domain rule: MejorTorrent publishes Spanish releases.
      const langs = detectLanguages(effectiveTitle, ['mejortorrent', fallbackTitle, ...hints]);
      if (!langs.audio.length) langs.audio.push('Castellano');

      return buildTorrentRecord({
        title: effectiveTitle,
        type: meta.type,
        infoHash: magnet?.infoHash || parsedTorrent!.infoHash,
        magnetUrl: magnet ? torrentUrl : null,
        torrentFileUrl: magnet ? null : torrentUrl,
        sourceUrl,
        trackers: magnet?.trackers || parsedTorrent?.trackers || [],
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parsedTorrent?.sizeBytes ?? null,
        seeders: null,
        leechers: null,
        sourceTracker: parsedTorrent?.primaryTracker || magnet?.trackers[0] || null
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
