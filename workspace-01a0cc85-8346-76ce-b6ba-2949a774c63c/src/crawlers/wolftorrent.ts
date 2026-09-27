import { DOWNLOAD_NODES, literalDownloadCandidates, spanishReleaseHints } from './spanish-catalog.js';
import * as cheerio from 'cheerio';
import { MAX_TORRENT_BYTES, MirrorSetup } from './base.js';
import { CatalogDetail, HtmlCatalogCrawler, httpUrl } from './html-catalog.js';
import { htmlMarkerValidator } from './mirrors.js';
import { cleanText, describeError } from './support.js';

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

    let baseOrigin = '';
    try {
      baseOrigin = new URL(url).origin;
    } catch {
      return [];
    }

    $('a[href]').each((_, el) => {
      const link = httpUrl($(el).attr('href'), url);
      if (!link) return;

      try {
        const parsed = new URL(link);
        if (parsed.origin === baseOrigin && /^\/(?:pelicula|serie)\/[^/]+\/[^/]+\/?$/i.test(parsed.pathname)) {
          links.add(link);
        }
      } catch {
        // Ignorar URLs malformadas en el atributo href
      }
    });

    return [...links];
  }

  public parseDetail(html: string, url: string): CatalogDetail {
    const $ = cheerio.load(html);
    $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();
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

      const rendered = this.parseDetail(await page.content(), url);
      if (rendered.downloads.length) return rendered;

      const buttons = page.getByRole('button', { name: /^descargar(?: torrent)?$/i })
        .or(page.getByRole('link', { name: /^descargar(?: torrent)?$/i }));

      const count = Math.min(await buttons.count(), 12);
      for (let index = 0; index < count; index++) {
        try {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 4000 }),
            buttons.nth(index).click({ timeout: 3000 })
          ]);

          const buffer = await readDownloadCapped(download);
          if (!buffer) continue;

          // JS may create a blob URL. Keep the metainfo for hashing, but never
          // persist a browser-local URL as a public download link.
          detail.downloads.push({
            url: download.url(),
            title: cleanText(`${detail.title} ${download.suggestedFilename() || ''}`) || detail.title,
            buffer
          });

          await download.delete().catch(() => {});
        } catch (error) {
          this.metrics.add('browserErrors');
          this.log.warn(`Download button failed in ${url}: ${describeError(error)}`);
        }
      }

      return detail;
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
  if (/^magnet:\?/i.test(trimmed)) return trimmed;

  const target = httpUrl(trimmed, base);
  if (!target) return null;

  try {
    const url = new URL(target);
    const baseUrl = new URL(base);

    if (/\.torrent$/i.test(url.pathname)) return target;

    // Intermediate same-site download handlers, not external shorteners or ads.
    if (url.origin === baseUrl.origin && /^\/(?:descargar|download)(?:\/|\.php)?/i.test(url.pathname)) {
      return target;
    }
  } catch {
    return null;
  }

  return null;
}

export default WolftorrentCrawler;
