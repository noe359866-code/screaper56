import { DOWNLOAD_NODES, literalDownloadCandidates, spanishReleaseHints } from './spanish-catalog.js';
import * as cheerio from 'cheerio';
import { MAX_TORRENT_BYTES, MirrorSetup } from './base.js';
import { CatalogDetail, HtmlCatalogCrawler, httpUrl } from './html-catalog.js';
import { htmlMarkerValidator } from './mirrors.js';
import { cleanText, describeError, nextPaginationLink } from './support.js';
import { parseMagnetUri } from '../utils/magnet.js';

/** Same-site download endpoints used by the Wolf/WolfMax4K templates. */
const WOLF_DOWNLOAD_ENDPOINTS = /^\/(?:descargar|descarga|download|downloads|get|torrent|torrents?|link|links?|enlace|bajar)(?:\/|\.php|\.asp|\?|$)/i;
const WOLF_DOWNLOAD_QUERY = /(?:^|[?&])(?:do|action|op)=(?:download|descarga|descargar|torrent)(?:[&#]|$)/i;

/** Path segments that always belong to a listing, a filter or the pager. */
const WOLF_LISTING_SEGMENTS =
  /^(?:page|pagina|paged|feed|rss|categoria|categorias|cat|genero|generos|calidad|calidades|idioma|idiomas|audio|orden|order|etiquetas?|tags?|actor|actores|director|buscar|search|busqueda|index|inicio|home|estrenos?|novedades|accion|animacion|anime|aventura|belic[ao]|biografia|ciencia-ficcion|comedia|crimen|documental|drama|familia|fantasia|guerra|historia|horror|intriga|misterio|musical|policiac[ao]|romance|suspenso|suspense|terror|thriller|western|deporte|adultos?|xxx|hentai)$/i;

/** Attributes a download button may carry the magnet in, before any click. */
const MAGNET_ATTRIBUTES = ['href', 'data-magnet', 'data-url', 'data-href', 'data-torrent', 'data-download', 'data-file'] as const;

/** Hosts compared without their `www.` prefix and across direct subdomains. */
export function isSameDomain(urlA: string, urlB: string): boolean {
  try {
    const left = new URL(urlA);
    const right = new URL(urlB);
    if (left.username || left.password || right.username || right.password) return false;
    if (left.protocol !== right.protocol || left.port !== right.port) return false;
    const hostA = left.hostname.replace(/^www\./i, '').toLowerCase();
    const hostB = right.hostname.replace(/^www\./i, '').toLowerCase();
    if (!hostA || !hostB) return false;
    return hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`);
  } catch {
    return false;
  }
}

/**
 * True when `href` is a single release (`/pelicula/:id/:slug`, `/serie/...`).
 * `/pelicula/page/2/`, `/serie/categoria/accion/` and friends matched the old
 * two-segment regex and were queued as details.
 */
export function isWolfDetailPath(href: string, base: string): boolean {
  if (!href || typeof href !== 'string') return false;

  const target = httpUrl(href, base);
  if (!target) return false;
  if (!isSameDomain(target, base)) return false;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (!/^\/(?:pelicula|peliculas|serie|series)\/[^/]+\/[^/]+\/?$/i.test(url.pathname)) return false;

  const segments = url.pathname.split('/').filter(Boolean).slice(1);
  if (segments.some(segment => WOLF_LISTING_SEGMENTS.test(segment))) return false;
  // A file nested under a detail-shaped path is still a file, not a release page.
  if (/\.(?:torrent|zip|rar|7z|mp4|mkv|avi|jpe?g|png|webp|gif|pdf|php|xml)$/i.test(segments[segments.length - 1] || '')) return false;
  // `/pelicula/page/2/` and `/serie/calidad/1080p/` are listings, not releases.
  if (/\/(?:page|pagina|paged)\/\d+/i.test(url.pathname)) return false;

  return true;
}

/**
 * WolfMax4K catalog: /pelicula/:id/:slug and /serie/:id/:slug.
 * Download URLs are discovered from the page, never manufactured from an ID.
 */
export class WolftorrentCrawler extends HtmlCatalogCrawler {
  public readonly name = 'wolftorrent';
  public baseUrl = process.env.WOLFTORRENT_BASE_URL || 'https://wolftorrent.com/';
  protected readonly sections = ['/peliculas', '/series'];

  /** Browser fallbacks used in this run; capped so a template change cannot
   *  turn into hundreds of headless navigations. */
  private browserSolves = 0;

  private get browserFallbackEnabled(): boolean {
    const raw = (process.env.WOLFTORRENT_BROWSER ?? 'true').trim().toLowerCase();
    return !(raw === 'false' || raw === '0' || raw === 'no');
  }

  private get browserSolveCap(): number {
    const parsed = Number.parseInt(process.env.WOLFTORRENT_BROWSER_MAX ?? '25', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 25;
  }

  /** Known Wolf/WolfMax4K domains; add your own with WOLFTORRENT_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://wolftorrent.com',
    'https://wolfmax4k.com',
    'https://www.wolfmax4k.com',
    'https://wolftorrent.net',
    'https://wolfmax4k.org'
  ];

  protected override get mirrorSetup(): MirrorSetup {
    return {
      envPrefix: 'WOLFTORRENT',
      defaults: WolftorrentCrawler.DEFAULT_MIRRORS,
      fallback: null, // No catalog request against a mirror that failed validation.
      probes: [
        {
          path: '/peliculas',
          label: 'catálogo de películas',
          timeoutMs: 8000,
          validate: htmlMarkerValidator([/href=["'][^"']*\/(?:pelicula|serie)\/[^"']+\/[^"']+/i])
        }
      ]
    };
  }

  public parseListing(html: string, url: string): string[] {
    const $ = cheerio.load(html);
    const links = new Set<string>();

    $('a[href]').each((_, el) => {
      const link = httpUrl($(el).attr('href'), url);
      if (!link) return;

      // Domain check ignores `www.` (the site links the apex from the www host)
      // and the path check rejects pagination/category/filter routes that
      // otherwise look exactly like a release slug.
      if (isWolfDetailPath(link, url)) links.add(link);
    });

    return [...links];
  }

  /** Follow a published pager across `www`/apex only, never across origin families. */
  public override nextPage(html: string, current: string): string | null {
    const next = nextPaginationLink(html, current);
    return next && isSameDomain(next, current) ? next : null;
  }

  public parseDetail(html: string, url: string): CatalogDetail {
    const $ = cheerio.load(html);
    $('.comments, #comentarios, .related, .relacionados, .related-torrents, .recommendations, .recomendados, .sidebar, footer, nav').remove();
    // cleanText (not .trim()) so a multi-line <h1> never becomes "Sample\n  1080p".
    const title = cleanText($('h1').first().text()) || cleanText($('title').first().text());
    const downloads: CatalogDetail['downloads'] = [];
    const seenUrls = new Set<string>();
    // Hoisted: the ficha is document-wide, not per-download.
    const releaseHints = spanishReleaseHints($);

    $(DOWNLOAD_NODES).each((_, el) => {
      const node = $(el);
      const values = literalDownloadCandidates(node);

      for (const value of values) {
        const target = wolfDownloadUrl(value, url);
        if (!target || seenUrls.has(target)) continue;

        seenUrls.add(target);
        const rowText = cleanText(node.closest('tr, .episode, .episodio').text());
        downloads.push({
          url: target,
          title: cleanText(`${title} ${rowText}`),
          hints: releaseHints
        });
      }
    });

    let contentType: 'movie' | 'series' = 'movie';
    try {
      if (/^\/series?/i.test(new URL(url).pathname)) {
        contentType = 'series';
      }
    } catch {
      // Fallback por defecto
    }

    return { title, type: contentType, downloads };
  }

  protected override async discoverDownloads(html: string, url: string): Promise<CatalogDetail> {
    const detail = this.parseDetail(html, url);
    if (detail.downloads.length || !this.browserFallbackEnabled) return detail;

    if (this.browserSolves >= this.browserSolveCap) {
      this.metrics.add('browserSkipped');
      this.log.debug(
        `${url}: browser fallback cap reached (${this.browserSolveCap}); skipping. ` +
        'Raise WOLFTORRENT_BROWSER_MAX if the site really needs it.'
      );
      return detail;
    }

    // Some Wolf templates only expose a JS button. A normal browser click lets
    // the site's own code resolve the URL; no CAPTCHA/login automation.
    // The page comes from the ONE shared stealth browser (see BaseCrawler),
    // not from a Chromium launched per detail page.
    this.browserSolves++;

    return this.withBrowserPage(async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const renderedUrl = typeof page.url === 'function' ? page.url() : url;
      if (!isSameDomain(renderedUrl, url)) {
        this.metrics.add('browserErrors');
        this.log.warn(`Browser detail redirected off-site (${renderedUrl}); ignoring it.`);
        return detail;
      }

      // Everything from here on is the RENDERED page: returning the statically
      // parsed `detail` threw away the titles and hints JavaScript had updated.
      const renderedHtml = await page.content();
      const rendered = this.parseDetail(renderedHtml, url);
      if (rendered.downloads.length) return rendered;
      const renderedHints = spanishReleaseHints(cheerio.load(renderedHtml));

      const buttons = page.getByRole('button', { name: /^descargar(?: torrent)?$/i })
        .or(page.getByRole('link', { name: /^descargar(?: torrent)?$/i }));

      const count = Math.min(await buttons.count(), 12);
      for (let index = 0; index < count; index++) {
        const button = buttons.nth(index);
        try {
          // A magnet is not a browser download: clicking only opens a client or
          // a modal, so `waitForEvent('download')` used to time out and count a
          // false failure. The literal href is read first.
          const buttonValues = await Promise.all(
            MAGNET_ATTRIBUTES.map(attr => button.getAttribute(attr).catch(() => null))
          );
          const magnetHref = buttonValues.find(value =>
            value && /^magnet:\?/i.test(value.trim()) && parseMagnetUri(value.trim())?.infoHash
          ) ?? null;

          if (magnetHref) {
            rendered.downloads.push({
              url: magnetHref.trim(),
              title: rendered.title,
              hints: renderedHints
            });
            continue;
          }

          // Do not click an explicit external/unsafe target (e.g. an ad
          // shortener) just because it is labelled "Descargar".
          const unsafeExplicitTarget = buttonValues.some(value => {
            if (!value) return false;
            const trimmed = value.trim();
            const explicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//');
            return explicitScheme && !wolfDownloadUrl(trimmed, url);
          });
          if (unsafeExplicitTarget) {
            this.metrics.add('downloadErrors');
            continue;
          }

          // Attach both event outcomes before clicking: if the click fails,
          // waitForEvent can still reject on timeout after this catch has run.
          const downloadEvent = page.waitForEvent('download', { timeout: 4000 }).then(
            download => ({ download }),
            error => ({ error })
          );
          await button.click({ timeout: 3000 });
          const outcome = await downloadEvent;
          if ('error' in outcome) throw outcome.error;
          const download = outcome.download;

          const rawUrl = download.url();
          const isBlobUrl = /^blob:/i.test(rawUrl);
          const trustedDownloadUrl = isBlobUrl ? null : wolfDownloadUrl(rawUrl, url);
          if (!isBlobUrl && !trustedDownloadUrl) {
            this.metrics.add('downloadErrors');
            this.log.warn(`Ignoring off-site or untrusted browser download ${rawUrl} from ${url}.`);
            await download.delete().catch(() => {});
            continue;
          }

          const buffer = await readDownloadCapped(download);
          if (!buffer) {
            await download.delete().catch(() => {});
            continue;
          }

          // JS may create a blob URL (`blob:https://...`) that dies with the
          // browser session. The metainfo is kept for hashing, but a local blob
          // is never published as a download link.
          const finalUrl = isBlobUrl
            ? `torrent:stream:${buffer.toString('hex').slice(0, 16)}`
            : trustedDownloadUrl!;

          rendered.downloads.push({
            url: finalUrl,
            title: cleanText(`${rendered.title} ${download.suggestedFilename() || ''}`) || rendered.title,
            hints: renderedHints,
            buffer
          });

          await download.delete().catch(() => {});
        } catch (error) {
          this.metrics.add('browserErrors');
          this.log.warn(`Download button failed in ${url}: ${describeError(error)}`);
        }
      }

      return rendered;
    }, 30000);
  }

  protected override resetRunState(): void {
    super.resetRunState();
    // The cap is per run, not per process.
    this.browserSolves = 0;
  }

  public override async close(): Promise<void> {
    this.browserSolves = 0;
  }
}

/** Streams a Playwright download into memory, refusing anything over the cap. */
async function readDownloadCapped(download: { createReadStream(): Promise<import('node:stream').Readable | null> }): Promise<Buffer | null> {
  const stream = await download.createReadStream();
  if (!stream) return null;

  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_TORRENT_BYTES) {
        stream.destroy();
        return null;
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    stream.destroy();
    return null;
  }

  return Buffer.concat(chunks);
}

export function wolfDownloadUrl(value: string, base: string): string | null {
  if (!value || typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (/^magnet:\?/i.test(trimmed)) return parseMagnetUri(trimmed)?.infoHash ? trimmed : null;

  const target = httpUrl(trimmed, base);
  if (!target) return null;

  try {
    const url = new URL(target);

    if (/\.torrent(?:[?#]|$)/i.test(url.pathname)) {
      return isSameDomain(target, base) ? target : null;
    }

    // Intermediate same-domain download handlers, not external shorteners or
    // ads. The Wolf/WolfMax4K family uses `descarga/`, `get/`, `links/`,
    // `torrent/` and explicit query-based download actions, not only
    // `descargar` / `download`; generic query strings are not treated as links.
    const isQueryDownload =
      (url.pathname === '/' || /\/index\.php$/i.test(url.pathname)) && WOLF_DOWNLOAD_QUERY.test(url.search);
    if (isSameDomain(target, base) && (WOLF_DOWNLOAD_ENDPOINTS.test(url.pathname) || isQueryDownload)) {
      return target;
    }
  } catch {
    return null;
  }

  return null;
}

export default WolftorrentCrawler;
