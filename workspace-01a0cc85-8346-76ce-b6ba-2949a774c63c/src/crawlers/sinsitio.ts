import { DOWNLOAD_NODES, literalDownloadCandidates, spanishReleaseHints } from './spanish-catalog.js';
import * as cheerio from 'cheerio';
import { MirrorSetup } from './base.js';
import { CatalogDetail, HtmlCatalogCrawler, httpUrl } from './html-catalog.js';
import { htmlMarkerValidator } from './mirrors.js';
import { cleanText, dedupeStrings, nextPaginationLink, sameSite as sharedSameSite } from './support.js';
import { parseMagnetUri } from '../utils/magnet.js';

function sameSite(a: string, b: string): boolean {
  return sharedSameSite(a, b);
}

/** DataLife Engine: numbered .html posts and public do=download attachments. */
export class SinsitioCrawler extends HtmlCatalogCrawler {
  public readonly name = 'sinsitio';
  public baseUrl = process.env.SINSITIO_BASE_URL || 'https://www.sinsitio.site/';
  protected readonly sections = ['/', '/dvdrip-bdrip/', '/series/'];

  /**
   * Known Sinsitio domains; add your own with SINSITIO_MIRRORS.
   * Live check 2026-09-28: `www.sinsitio.site` serves the full DLE site
   * (fresh posts, fichas with ddlUrl.php links that decode to public
   * `index.php?do=download&id=N` attachments) and the apex 301s to it.
   * `sinsitio.info` and `sinsitio.online` stopped answering entirely.
   */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www.sinsitio.site',
    'https://sinsitio.site'
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

    try {
      new URL(url);
    } catch {
      return [];
    }

    $('a[href]').each((_, el) => {
      const link = httpUrl($(el).attr('href'), url);
      if (!link) return;

      try {
        const parsed = new URL(link);
        // `www.sinsitio.site` and `sinsitio.site` are the same site: a strict
        // origin comparison dropped every post when the mirror alternated.
        if (sameSite(link, url) && /\/\d+-[^/]+\.html$/i.test(parsed.pathname)) {
          links.add(link);
        }
      } catch {
        // Ignorar URLs malformadas en atributos href
      }
    });

    return [...links];
  }

  /** Preserve DLE's www/apex pager links without crossing scheme or port boundaries. */
  public override nextPage(html: string, current: string): string | null {
    const next = nextPaginationLink(html, current, { linkSelector: '.navigation a' });
    return next && sameSite(next, current) ? next : null;
  }

  public parseDetail(html: string, url: string): CatalogDetail {
    const $ = cheerio.load(html);
    const title = cleanText($('h1').first().text());
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

    // Exclude comments, navigation and related posts: they may contain another release's links.
    $('.comments, #dle-comments-list, .related, .related-torrents, .recommendations, .recomendados, .sidebar, header, nav, footer').remove();

    // Hoisted: the hints are document-wide, not per-download.
    // The site marker matters: live posts publish their language ONLY inside
    // the ddlUrl name= («…Castellano») — and some don't even do that (the
    // classic-cinema post 35920 is «El Rostro Impenetrable 1961marlon Brando
    // Mkv» with no language anywhere, /series/ titles are «Crookhaven T1»).
    // `sinsitio` ∈ REGEX_ES_TRACKERS maps the marker to Spanish in explicit
    // mode too, so those records survive filterSpanishReleases instead of
    // being discarded with audio=[].
    const releaseHints = dedupeStrings([...spanishReleaseHints($), 'sinsitio']);

    $(DOWNLOAD_NODES).each((_, el) => {
      for (const href of literalDownloadCandidates($(el))) {
        const target = decodeSinsitioDownload(href, url);
        if (!target || seenUrls.has(target)) continue;

        seenUrls.add(target);

        let releaseTitle = '';
        try {
          if (!/^magnet:\?/i.test(target)) {
            releaseTitle = new URL(href, url).searchParams.get('name') || '';
          }
        } catch {
          /* Magnet o URL relativa malformada */
        }

        downloads.push({
          url: target,
          title: cleanText(releaseTitle) || cleanText(title),
          hints: releaseHints
        });
      }
    });

    return { title, type, downloads };
  }
}

export function decodeSinsitioDownload(href: string, base: string): string | null {
  if (!href || typeof href !== 'string') return null;

  const trimmed = href.trim();
  if (/^magnet:\?/i.test(trimmed)) return parseMagnetUri(trimmed)?.infoHash ? trimmed : null;

  const resolved = httpUrl(trimmed, base);
  if (!resolved) return null;

  try {
    let url = new URL(resolved);

    if (!sameSite(resolved, base)) return null;

    if (url.pathname === '/ddlUrl.php') {
      const encoded = url.searchParams.get('url');
      if (!encoded || encoded.length > 8192 || !/^[\w+/=-]+$/.test(encoded)) return null;

      try {
        const decodedText = Buffer.from(encoded, 'base64').toString('utf8').trim();

        if (/^magnet:\?/i.test(decodedText)) {
          return parseMagnetUri(decodedText)?.infoHash ? decodedText : null;
        }

        const decoded = httpUrl(decodedText, base);
        if (!decoded) return null;

        url = new URL(decoded);
        if (!sameSite(decoded, base)) return null;
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
