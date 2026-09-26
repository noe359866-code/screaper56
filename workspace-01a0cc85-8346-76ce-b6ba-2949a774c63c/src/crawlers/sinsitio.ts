import * as cheerio from 'cheerio';
import { CatalogDetail, HtmlCatalogCrawler, httpUrl } from './html-catalog.js';

/** DataLife Engine: numbered .html posts and public do=download attachments. */
export class SinsitioCrawler extends HtmlCatalogCrawler {
  public readonly name = 'sinsitio';
  public readonly baseUrl = process.env.SINSITIO_BASE_URL || 'https://www.sinsitio.site/';
  protected readonly sections = ['/', '/dvdrip-bdrip/', '/series/'];

  public parseListing(html: string, url: string): string[] {
    const $ = cheerio.load(html);
    const links = new Set<string>();
    $('a[href]').each((_, el) => {
      const link = httpUrl($(el).attr('href'), url);
      if (!link) return;
      const parsed = new URL(link);
      if (parsed.origin === new URL(url).origin && /\/\d+-[^/]+\.html$/.test(parsed.pathname)) links.add(link);
    });
    return [...links];
  }

  public parseDetail(html: string, url: string): CatalogDetail {
    const $ = cheerio.load(html);
    const title = $('h1').first().text().trim();
    const type = /\/[^/]*series[^/]*\//i.test(new URL(url).pathname) ? 'series' : 'movie';
    const downloads: CatalogDetail['downloads'] = [];
    // Exclude comments/recommendations: they may contain somebody else's magnets.
    $('.comments, #dle-comments-list, .related').remove();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const target = decodeSinsitioDownload(href, url);
      if (!target) return;
      let releaseTitle = '';
      try { releaseTitle = new URL(href, url).searchParams.get('name') || ''; } catch { /* magnet */ }
      downloads.push({ url: target, title: releaseTitle || title });
    });
    return { title, type, downloads };
  }
}

export function decodeSinsitioDownload(href: string, base: string): string | null {
  if (href.startsWith('magnet:?')) return href;
  const resolved = httpUrl(href, base);
  if (!resolved) return null;
  let url = new URL(resolved);
  if (url.origin !== new URL(base).origin) return null;
  if (url.pathname === '/ddlUrl.php') {
    const encoded = url.searchParams.get('url');
    if (!encoded || encoded.length > 8192 || !/^[\w+/=-]+$/.test(encoded)) return null;
    const decoded = httpUrl(Buffer.from(encoded, 'base64').toString('utf8'), base);
    if (!decoded) return null;
    url = new URL(decoded);
    if (url.origin !== new URL(base).origin) return null;
  }
  const attachment = (url.pathname === '/index.php' && url.searchParams.get('do') === 'download') ||
    url.pathname === '/engine/download.php';
  if (attachment && /^\d+$/.test(url.searchParams.get('id') || '')) return url.href;
  return /\.torrent$/i.test(url.pathname) ? url.href : null;
}

export default SinsitioCrawler;
