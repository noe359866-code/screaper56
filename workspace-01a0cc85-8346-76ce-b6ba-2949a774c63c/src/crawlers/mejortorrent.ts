import { DOWNLOAD_NODES, literalDownloadCandidates, spanishReleaseHints } from './spanish-catalog.js';
import { parseMagnetUri } from '../utils/magnet.js';
import * as cheerio from 'cheerio';
import { BaseCrawler, BlockedPageError, rethrowIfBlockedOrRateLimited } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { detectLanguages, SPANISH_AUDIO_CANONICAL } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
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

type MirrorMode = 'legacy_eu' | 'modern_me';

/**
 * Same site, allowing `www.` variation without accepting a scheme/port change.
 * The `.eu` template rotates its `wwwNN.` front-ends by redirecting
 * (`www45.mejortorrent.eu` -> `www46.mejortorrent.eu`) and the redirected
 * pages render ABSOLUTE links on the final host, so an exact-host comparison
 * discarded every listing link and silently produced zero records.
 */
function sameSiteHost(a: string, b: string): boolean {
  if (sameSite(a, b)) return true;
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.username || left.password || right.username || right.password) return false;
    if (left.protocol !== right.protocol || left.port !== right.port) return false;
    const normalize = (host: string) => host.replace(/^www\d*\./i, '').toLowerCase();
    const leftHost = normalize(left.hostname);
    return leftHost.length > 0 && leftHost === normalize(right.hostname);
  } catch {
    return false;
  }
}

/**
 * MejorTorrent: legacy `.eu` templates and WordPress-based mirrors.
 * The infohash always comes from the downloaded metainfo (shared bencode parser),
 * never from a guessed ID, and unknown swarm counters remain `null`.
 */
export class MejorTorrentCrawler extends BaseCrawler {
  public readonly name = 'mejortorrent';
  public baseUrl: string;

  /**
   * Known MejorTorrent domains; extend with MEJORTORRENT_MIRRORS.
   *
   * Live check 2026-09-29: `www45` keeps 301-rotating to the active `wwwNN`
   * front (www46 today) and `mejortorrent.me` still serves the WordPress
   * template with a working `/wp-json/wp/v2/posts` API. NXDOMAIN and parked
   * domains were pruned from the pool so a cold resolution never waits on
   * them: www.mejortorrent.icu, mejortorrent1.com (parked), mejortorrents.net,
   * mejortorrent.nz and www50.mejortorrent.eu (the rotation left it behind).
   */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www45.mejortorrent.eu',
    'https://www46.mejortorrent.eu',
    'https://mejortorrent.me',
    'https://mejortorrent.wtf',
    'https://mejortorrent.app'
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

    // Legacy portadas speak through `/pelicula|serie/` hrefs; the WordPress
    // portada (.me) only publishes `wp-content` posters and slug links, so it
    // needs its own marker to pass the probe without a wp-json link tag.
    const validate = htmlMarkerValidator([
      /wp-json/i,
      /wp-content/i,
      /href=["'][^"']*\/(?:pelicula|serie)\//i
    ]);
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

    // An unreachable/blocked catalogue must not look like a successful empty
    // run: every other adapter reports this, and the failure diagnosis relies
    // on it to tell "network/layout" apart from "no releases".
    if (this.metrics.get('listings') === 0) {
      throw new Error(
        `[mejortorrent] No usable catalogue responses on ${mirror} (mode=${mode}). ` +
        'Check mirror availability, blocking and the template (WordPress vs legacy).'
      );
    }
    return deduplicated;
  }

  /** WordPress mirrors expose `wp-json`; the legacy `.eu` template does not. */
  private async detectTemplate(mirror: string): Promise<MirrorMode> {
    try {
      const html = await this.fetchHtml(mirror, { timeout: 6000 });
      return /wp-json|wp-content|api\.w\.org/i.test(html) ? 'modern_me' : 'legacy_eu';
    } catch (error) {
      rethrowIfBlockedOrRateLimited(error);
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
      { path: '/series-hd', type: 'series' },
      // Full per-type indexes (live 2026-09: linked from every ficha as
      // "Volver al índice"). They extend the window beyond the recent uploads;
      // the maxPages*35 quota still bounds how many fichas are processed.
      { path: '/peliculas', type: 'movie' },
      { path: '/series', type: 'series' },
      { path: '/peliculas-4k', type: 'movie' },
      { path: '/documentales', type: 'documentary' }
    ];

    const detailUrls = new Set<string>();

    for (const cat of categories) {
      // Walk only published pages. Fingerprints are per category: a page made
      // entirely of releases already seen in another category must not stop
      // this route before its own next page is visited.
      let url: string | null = `${mirror}${cat.path}`;
      const visited = new Set<string>();
      let previousSignature = '';

      for (let page = 1; url && page <= maxPages; page++) {
        if (this.deadline.expired) break;
        if (visited.has(url)) break;
        visited.add(url);

        try {
          const html = await this.fetchHtml(url, { headers: { Referer: `${mirror}/` } });
          this.metrics.add('listings');
          const $ = cheerio.load(html);
          $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();

          const pageDetails = new Set<string>();
          $('a[href*="/pelicula/"], a[href*="/serie/"], a[href*="/documental/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || /genre|year|quality/i.test(href)) return;
            const resolved = this.resolveUrl(href, url!);
            // Listing markup occasionally contains promoted links to another
            // site using a matching path; never crawl those as site details.
            if (sameSiteHost(resolved, mirror)) pageDetails.add(resolved);
          });

          const signature = [...pageDetails].sort().join('|');
          if (!signature || signature === previousSignature) break;
          previousSignature = signature;
          for (const detailUrl of pageDetails) detailUrls.add(detailUrl);

          const nextUrl = nextPaginationLink(html, url);
          url = nextUrl && sameSiteHost(nextUrl, mirror) ? nextUrl : null;
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.debug(`Listing failed ${url}: ${describeError(error)}`);
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
        $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();

        const title = cleanText($('h1').first().text()) || cleanText($('title').text().split(/[|\-–]/)[0]);
        const defaultType: ContentType = url.includes('/serie/')
          ? 'series'
          : url.includes('/documental/') ? 'documentary' : 'movie';

        const anchors = $(DOWNLOAD_NODES).toArray();
        const records: TorrentRecord[] = [];
        // Hoisted out of the per-link loop.
        const releaseHints = spanishReleaseHints($);
        // The same file is usually linked by the button AND the icon: download once.
        const seenDownloads = new Set<string>();

        for (const el of anchors) {
          const anchor = $(el);
          for (const href of literalDownloadCandidates(anchor)) {
            const torrentUrl = parseMagnetUri(href) ? href : this.resolveUrl(href, url);
            if (!isMejortorrentDownload(href, torrentUrl, url)) continue;
            if (seenDownloads.has(torrentUrl)) continue;
            seenDownloads.add(torrentUrl);

            let itemTitle = title;
            if (defaultType === 'series') {
              const epText = cleanText(anchor.closest('tr').find('td').eq(1).text());
              if (epText) itemTitle = `${title} ${epText}`;
            }

            const record = await this.downloadAndBuildRecord(torrentUrl, url, itemTitle, defaultType, releaseHints);
            if (record) {
              records.push(record);
              this.metrics.add('records');
            }
          }
        }
        return records;
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('detailErrors');
        this.log.warn(`Error parsing EU detail ${url}: ${describeError(error)}`);
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
    let previousSignature = '';

    for (let page = 1; page <= maxPages; page++) {
      if (this.deadline.expired) break;
      try {
        const posts = await this.fetchJson<Array<{ link?: string }>>(
          `${mirror}/wp-json/wp/v2/posts?page=${page}&per_page=30`
        );
        if (!Array.isArray(posts) || !posts.length) break;
        this.metrics.add('listings');
        const pageLinks = posts
          .map(post => post?.link ? this.resolveUrl(post.link, mirror) : '')
          .filter((link): link is string => Boolean(link) && sameSiteHost(link, mirror));
        const signature = [...new Set(pageLinks)].sort().join('|');
        if (!signature || signature === previousSignature) break;
        previousSignature = signature;
        for (const link of pageLinks) detailUrls.add(link);
      } catch (error) {
        // A WP API that answers with an HTML page (SPA shell or WAF) only
        // proves the mirror is not WordPress: fall back to the HTML catalogues
        // instead of aborting the run. A genuinely blocked mirror re-raises
        // from the legacy fetches below (they use rejectBlocked).
        if (error instanceof BlockedPageError) {
          this.log.debug(`WP API answered with HTML: ${describeError(error)}`);
          break;
        }
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('listingErrors');
        this.log.debug(`WP API page ${page} finished or failed: ${describeError(error)}`);
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
            if (parseMagnetUri(href)) {
              torrentUrls.add(href);
            } else if (/\.torrent(?:[?#]|$)/i.test(href)) {
              const resolved = this.resolveUrl(href, url);
              if (isMejortorrentDownload(href, resolved, url)) torrentUrls.add(resolved);
            }
          }
        });

        if (!torrentUrls.size) {
          // Last resort: raw-HTML scan. Restricted to the mirror's own origin so
          // an advertising network's `.torrent` beacon can never be indexed.
          const matches = html.match(/https?:\/\/[^\s"'<>]+\.torrent(\?[^\s"'<>]*)?/gi) ?? [];
          for (const match of matches) {
            if (sameSiteHost(match, url)) torrentUrls.add(match);
          }
        }

        const encodedSlug = url.split('/').filter(Boolean).pop() || '';
        let decodedSlug = encodedSlug;
        try {
          decodedSlug = decodeURIComponent(encodedSlug);
        } catch {
          // Keep the literal slug if the mirror published malformed %-escapes.
        }
        const pageTitle = cleanText($('h1').first().text()) ||
          cleanText(decodedSlug.replace(/-/g, ' '));
        // Only the release itself decides: every page's menu says "Series" /
        // "Temporadas", so scanning the whole HTML labelled all movies as series.
        const defaultType: ContentType = /\/series?\//i.test(url) ||
          /temporada|episodios?|cap[ií]tulos?|\bs\d{1,2}(?:e\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b/i.test(pageTitle)
          ? 'series'
          : 'movie';

        const records: TorrentRecord[] = [];
        const releaseHints = spanishReleaseHints($);
        for (const torrentUrl of torrentUrls) {
          const record = await this.downloadAndBuildRecord(torrentUrl, url, pageTitle, defaultType, releaseHints);
          if (record) {
            records.push(record);
            this.metrics.add('records');
          }
        }
        return records;
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('detailErrors');
        this.log.warn(`Error parsing ME detail ${url}: ${describeError(error)}`);
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
      // Domain rule: MejorTorrent publishes Spanish releases. The canonical tag
      // is used so 'Castellano' and 'Spanish' cannot split the same language.
      const langs = detectLanguages(effectiveTitle, ['mejortorrent', fallbackTitle, ...hints]);
      if (!langs.audio.length) langs.audio.push(SPANISH_AUDIO_CANONICAL);

      const infoHash = magnet?.infoHash || parsedTorrent?.infoHash;
      if (!infoHash) return null;

      return buildTorrentRecord({
        title: effectiveTitle,
        type: meta.type,
        infoHash,
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
      rethrowIfBlockedOrRateLimited(error);
      this.metrics.add('downloadErrors');
      this.log.warn(`Failed to process torrent ${torrentUrl}: ${describeError(error)}`);
      return null;
    }
  }
}

/**
 * Accepts magnets, same-site `.torrent` files and the site's own `/torrents/`
 * handler. Everything else (shorteners, ad networks, category links) is
 * rejected before a single byte is downloaded.
 */
export function isMejortorrentDownload(href: string, resolved: string, pageUrl: string): boolean {
  if (parseMagnetUri(href)) return true;
  if (!sameSiteHost(resolved, pageUrl)) return false;
  if (/\.torrent(?:[?#]|$)/i.test(href)) return true;
  try {
    return /^\/torrents\//i.test(new URL(resolved).pathname);
  } catch {
    return false;
  }
}

export default MejorTorrentCrawler;
