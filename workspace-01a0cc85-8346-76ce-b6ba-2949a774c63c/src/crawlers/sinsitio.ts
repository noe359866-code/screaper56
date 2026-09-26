import * as cheerio from 'cheerio';
import { MirrorSetup } from './base.js';
import { CatalogDetail, HtmlCatalogCrawler, httpUrl } from './html-catalog.js';
import { htmlMarkerValidator } from './mirrors.js';

/** DataLife Engine: numbered .html posts and public do=download attachments. */
export class SinsitioCrawler extends HtmlCatalogCrawler {
  public readonly name = 'sinsitio';
  public baseUrl = process.env.SINSITIO_BASE_URL || 'https://www.sinsitio.site/';
  protected readonly sections = ['/', '/dvdrip-bdrip/', '/series/'];

  /** Known Sinsitio domains; add your own with SINSITIO_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www.sinsitio.site',
    'https://sinsitio.site',
    'https://www.sinsitio.info',
    'https://sinsitio.online'
  ];

  protected override get mirrorSetup(): MirrorSetup {
    return {
      envPrefix: 'SINSITIO',
      defaults: SinsitioCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/',
          label: 'portada DLE',
          timeoutMs: 8000,
          validate: htmlMarkerValidator([/href=["'][^"']*\/\d+-[^"']+\.html/i])
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
        if (parsed.origin === baseOrigin && /\/\d+-[^/]+\.html$/i.test(parsed.pathname)) {
          links.add(link);
        }
      } catch {
        // Ignorar URLs malformadas en atributos href
      }
    });

    return [...links];
  }

  public parseDetail(html: string, url: string): CatalogDetail {
    const $ = cheerio.load(html);
    const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
    const downloads: CatalogDetail['downloads'] = [];
    const seenUrls = new Set<string>();

    let type: 'movie' | 'series' = 'movie';
    try {
      if (/\/(?:series|serie)[^/]*\//i.test(new URL(url).pathname)) {
        type = 'series';
      }
    } catch {
      // Fallback a 'movie' ante URL no válida
    }

    // Exclude comments/recommendations: they may contain somebody else's magnets.
    $('.comments, #dle-comments-list, .related').remove();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const target = decodeSinsitioDownload(href, url);
      if (!target || seenUrls.has(target)) return;

      seenUrls.add(target);

      let releaseTitle = '';
      try {
        if (!target.startsWith('magnet:?')) {
          releaseTitle = new URL(href, url).searchParams.get('name') || '';
        }
      } catch {
        /* Magnet o URL relativa malformada */
      }

      downloads.push({
        url: target,
        title: (releaseTitle.trim() || title).replace(/\s+/g, ' ').trim()
      });
    });

    return { title, type, downloads };
  }
}

export function decodeSinsitioDownload(href: string, base: string): string | null {
  if (!href || typeof href !== 'string') return null;

  const trimmed = href.trim();
  if (/^magnet:\?/i.test(trimmed)) return trimmed;

  const resolved = httpUrl(trimmed, base);
  if (!resolved) return null;

  try {
    const baseUrl = new URL(base);
    let url = new URL(resolved);

    if (url.origin !== baseUrl.origin) return null;

    if (url.pathname === '/ddlUrl.php') {
      const encoded = url.searchParams.get('url');
      if (!encoded || encoded.length > 8192 || !/^[\w+/=-]+$/.test(encoded)) return null;

      try {
        const decodedText = Buffer.from(encoded, 'base64').toString('utf8').trim();

        if (/^magnet:\?/i.test(decodedText)) {
          return decodedText;
        }

        const decoded = httpUrl(decodedText, base);
        if (!decoded) return null;

        url = new URL(decoded);
        if (url.origin !== baseUrl.origin) return null;
      } catch {
        return null;
      }
    }

    const isAttachment =
      (url.pathname === '/index.php' && url.searchParams.get('do') === 'download') ||
      url.pathname === '/engine/download.php';

    if (isAttachment) {
      const id = url.searchParams.get('id');
      if (id && /^\d+$/.test(id)) return url.href;
      return null;
    }

    return /\.torrent$/i.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

export default SinsitioCrawler;
