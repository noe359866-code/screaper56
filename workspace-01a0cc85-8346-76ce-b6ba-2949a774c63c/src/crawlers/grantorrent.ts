import * as cheerio from 'cheerio';
import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { parseSizeToBytes } from '../utils/regex.js';
import { detectLanguages } from '../utils/language.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  describeError,
  mapWithConcurrency,
  sameSite as sharedSameSite
} from './support.js';

/**
 * Path segments that are site sections, never a movie: a poster link inside
 * one of them is navigation, not a movie card.
 */
const RESERVED_SEGMENTS = new Set([
  'categoria', 'category', 'categorias', 'categories', 'genero', 'generos', 'genre',
  'tag', 'tags', 'author', 'autor', 'authors', 'page', 'pages', 'pagina', 'paginas',
  'paged', 'feed', 'archive', 'wp-content', 'wp-json', 'buscar', 'search', 'blog',
  'noticias', 'contacto', 'dmca'
]);

function sameSite(a: string, b: string): boolean {
  return sharedSameSite(a, b);
}

/**
 * A movie card permalink: `/movie/` or `/section/movie/`. Category, tag and
 * pagination paths are rejected so the sidebar is never crawled as content.
 */
export function isMovieCardPath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return false;
  if (!segments.every(segment => /^[a-z0-9-]+$/i.test(segment))) return false;
  if (segments.some(segment => RESERVED_SEGMENTS.has(segment.toLowerCase()))) return false;
  return true;
}

/** GranTorrent WordPress movie catalogue. Never follows ad/shortener links. */
export class GranTorrentCrawler extends BaseCrawler {
  public readonly name = 'grantorrent';
  public baseUrl = process.env.GRANTORRENT_BASE_URL || '';

  public parseListing(html: string, base: string): string[] {
    const $ = cheerio.load(html);
    const found = new Set<string>();
    // Posters are the actual movie cards; links in the sidebar/navigation are not.
    $('a:has(img[src*="/wp-content/uploads/"])').each((_, element) => {
      const url = absoluteHttpUrl($(element).attr('href'), base);
      if (!url) return;
      // `www.` and the apex domain are the same site: a strict `origin`
      // comparison dropped every card on mirrors that mix both.
      if (!sameSite(url, base)) return;
      try {
        if (!isMovieCardPath(new URL(url).pathname)) return;
      } catch {
        return;
      }
      found.add(url);
    });
    return [...found];
  }

  public parseDetail(html: string, url: string): {
    title: string; quality: string | null; imdbId: string | null;
    downloads: Array<{ link: string; audio: string[]; size: number | null }>;
    gated: number;
  } {
    const $ = cheerio.load(html);
    const title = cleanText($('h1').first().text()).replace(/\s*\(\d{4}\)\s*$/, '');
    const quality = cleanText($('body').text().match(/Formato:\s*(4K|2160p|1080p|720p|DVDRip)/i)?.[1]) || null;
    // IMDb is what lets the same movie dedupe against the other sources.
    const imdbId = html.match(/imdb\.com\/title\/(tt\d{7,10})/i)?.[1]?.toLowerCase() ?? null;
    const downloads: Array<{ link: string; audio: string[]; size: number | null }> = [];
    const byLink = new Map<string, typeof downloads[number]>();
    const addDownload = (link: string, audio: string[], size: number | null): void => {
      const previous = byLink.get(link);
      if (previous) {
        previous.audio = [...new Set([...previous.audio, ...audio])];
        previous.size ??= size;
      } else {
        const download = { link, audio, size };
        byLink.set(link, download);
        downloads.push(download);
      }
    };
    let gated = 0;
    $('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const language = cleanText(cells.eq(0).find('img').attr('alt') || cells.eq(0).text());
      const audio = detectLanguages(language, [], false).audio;
      const sizeText = cleanText($(row).text());
      const size = parseSizeToBytes(sizeText.match(/\d+(?:[.,]\d+)?\s*(?:GB|MB|GiB|MiB)/i)?.[0] ?? '');
      $(row).find('a[href]').each((_, a) => {
        const raw = $(a).attr('href') || '';
        if (/^magnet:/i.test(raw)) {
          if (parseMagnetUri(raw)) addDownload(raw, audio, size);
          return;
        }
        const link = absoluteHttpUrl(raw, url);
        if (!link) return;
        // No redirect following to super-enlace or other unverified third
        // parties: only the site's own metainfo files are downloaded.
        if (sameSite(link, url) && /\.torrent$/i.test(new URL(link).pathname)) {
          addDownload(link, audio, size);
        } else if (/descargar/i.test(cleanText($(a).text()))) gated++;
      });
    });
    return { title, quality, imdbId, downloads, gated };
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    const hasConfiguredMirror = Boolean(
      process.env.GRANTORRENT_BASE_URL?.trim() || process.env.GRANTORRENT_MIRRORS?.trim()
    );
    if (!hasConfiguredMirror) {
      throw new Error(
        '[grantorrent] No verified default domain is configured. Set GRANTORRENT_BASE_URL ' +
        'or GRANTORRENT_MIRRORS before selecting this crawler.'
      );
    }

    const base = await this.resolveMirror({
      envPrefix: 'GRANTORRENT',
      defaults: [],
      probes: [{ path: '/', label: 'WordPress movie cards', timeoutMs: 7000,
        validate: htmlMarkerValidator([/wp-content\/uploads\//i, /href=["'][^"']*\/categoria\//i]) }]
    });
    const candidates = new Set<string>();
    const listingSignatures = new Set<string>();
    for (let page = 1; page <= maxPages && !this.deadline.expired; page++) {
      try {
        const html = await this.fetchHtml(page === 1 ? `${base}/` : `${base}/page/${page}/`,
          { headers: { Referer: `${base}/` } }, { rejectBlocked: true });
        this.metrics.add('listings');
        const links = this.parseListing(html, base);
        if (!links.length) break;
        const signature = [...links].sort().join('|');
        if (listingSignatures.has(signature)) break;
        listingSignatures.add(signature);
        for (const link of links) candidates.add(link);
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('listingErrors');
        this.log.warn(`Listing failed: ${describeError(error)}`);
        break;
      }
    }
    const results = (await mapWithConcurrency([...candidates], 2, async url => {
      if (this.deadline.expired) return [] as TorrentRecord[];
      try {
        const html = await this.fetchHtml(url, { headers: { Referer: `${base}/` } }, { rejectBlocked: true });
        const detail = this.parseDetail(html, url);
        this.metrics.add('details');
        this.metrics.add('gated', detail.gated);
        const records: TorrentRecord[] = [];
        for (const download of detail.downloads) {
          try {
            const magnet = /^magnet:/i.test(download.link) ? parseMagnetUri(download.link) : null;
            const metainfo = magnet ? null : await this.fetchTorrentMetainfoViaGet(download.link, url);
            if (!magnet && !metainfo) continue;
            const record = buildTorrentRecord({
              infoHash: (magnet ?? metainfo)!.infoHash,
              title: detail.title, type: 'movie', sourceUrl: url,
              magnetUrl: magnet ? download.link : undefined,
              torrentFileUrl: magnet ? undefined : download.link,
              audio: download.audio, quality: detail.quality, sizeBytes: metainfo?.sizeBytes ?? download.size,
              trackers: (magnet ?? metainfo)!.trackers,
              sourceTracker: magnet?.trackers[0] ?? metainfo?.primaryTracker ?? null,
              imdbId: detail.imdbId
            });
            if (record) { records.push(record); this.metrics.add('records'); }
          } catch (error) {
            rethrowIfBlockedOrRateLimited(error);
            this.metrics.add('downloadErrors');
            this.log.warn(`Download metadata failed: ${describeError(error)}`);
          }
        }
        return records;
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('detailErrors');
        this.log.warn(`Detail failed ${url}: ${describeError(error)}`);
        return [] as TorrentRecord[];
      }
    })).flat();
    const unique = this.deduplicateRecords(results);
    this.logRunSummary(unique);
    if (!unique.length) throw new Error(
      `[grantorrent] No verified infohash: details=${candidates.size}, gated=${this.metrics.get('gated')}, ` +
      `listingErrors=${this.metrics.get('listingErrors')}. External shorteners are not followed.`
    );
    return unique;
  }
}
