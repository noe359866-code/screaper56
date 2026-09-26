import * as cheerio from 'cheerio';
import { MirrorSetup } from './base.js';
import { CatalogDetail, HtmlCatalogCrawler, httpUrl } from './html-catalog.js';
import { htmlMarkerValidator } from './mirrors.js';

/**
 * WolfMax4K catalog: /pelicula/:id/:slug and /serie/:id/:slug.
 * Download URLs are discovered from the page, never manufactured from an ID.
 */
export class WolftorrentCrawler extends HtmlCatalogCrawler {
  public readonly name = 'wolftorrent';
  public baseUrl = process.env.WOLFTORRENT_BASE_URL || 'https://wolftorrent.com/';
  protected readonly sections = ['/peliculas', '/series'];

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
    const title = $('h1').first().text().trim();
    const downloads: CatalogDetail['downloads'] = [];
    const seenUrls = new Set<string>();

    $('a[href], [data-url], [data-href], [data-magnet], [data-torrent], [onclick]').each((_, el) => {
      const node = $(el);
      const values: string[] = ['href', 'data-url', 'data-href', 'data-magnet', 'data-torrent']
        .map(attr => node.attr(attr) || '')
        .filter(Boolean);

      // Read literal URLs / literal atob only. Never eval arbitrary remote JavaScript.
      const onclick = node.attr('onclick') || '';
      if (onclick) {
        for (const match of onclick.matchAll(/['"]([^'"\n]+)['"]/g)) {
          values.push(match[1]);
        }
        for (const match of onclick.matchAll(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/g)) {
          try {
            const decoded = Buffer.from(match[1], 'base64').toString('utf8');
            values.push(decoded);
          } catch {
            // Ignorar decodificación base64 fallida
          }
        }
      }

      for (const value of values) {
        const target = wolfDownloadUrl(value, url);
        if (!target || seenUrls.has(target)) continue;

        seenUrls.add(target);
        const rowText = node.closest('tr, .episode, .episodio').text().replace(/\s+/g, ' ').trim();
        downloads.push({
          url: target,
          title: `${title} ${rowText}`.trim()
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
    if (detail.downloads.length || process.env.WOLFTORRENT_BROWSER === 'false') {
      return detail;
    }

    // Some Wolf templates only expose a JS button. A normal browser click allows
    // the site's own code to resolve the URL; no CAPTCHA/login automation.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ acceptDownloads: true });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        const rendered = this.parseDetail(await page.content(), url);
        if (rendered.downloads.length) return rendered;

        const buttons = page.getByRole('button', { name: /^descargar(?: torrent)?$/i })
          .or(page.getByRole('link', { name: /^descargar(?: torrent)?$/i }));

        const count = Math.min(await buttons.count(), 12);
        for (let i = 0; i < count; i++) {
          try {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 4000 }),
              buttons.nth(i).click({ timeout: 3000 })
            ]);

            const stream = await download.createReadStream();
            if (!stream) continue;

            const chunks: Buffer[] = [];
            let size = 0;

            for await (const chunk of stream) {
              size += chunk.length;
              if (size > 10 * 1024 * 1024) {
                stream.destroy();
                throw new Error('Torrent exceeds 10 MiB');
              }
              chunks.push(Buffer.from(chunk));
            }

            // JS may create a blob URL. Keep metainfo for hashing, but never persist
            // that browser-local URL as a publicly downloadable torrent link.
            detail.downloads.push({
              url: download.url(),
              title: detail.title,
              buffer: Buffer.concat(chunks)
            });

            await download.delete();
          } catch (error) {
            this.log.warn(`Download button failed in ${url}: ${formatError(error)}`);
          }
        }
      } finally {
        await page.close().catch(() => {});
      }

      return detail;
    } finally {
      await browser.close();
    }
  }
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default WolftorrentCrawler;
