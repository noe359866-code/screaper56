import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { parseSizeToBytes } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import { absoluteHttpUrl, buildTorrentRecord, cleanText, describeError, mapWithConcurrency } from './support.js';

/** GranTorrent WordPress movie catalogue. Never follows ad/shortener links. */
export class GranTorrentCrawler extends BaseCrawler {
  public readonly name = 'grantorrent';
  public baseUrl = process.env.GRANTORRENT_BASE_URL || 'https://grantorrent.foo';

  public parseListing(html: string, base: string): string[] {
    const $ = cheerio.load(html);
    const origin = new URL(base).origin;
    const found = new Set<string>();
    // Posters are the actual movie cards; links in the sidebar/navigation are not.
    $('a:has(img[src*="/wp-content/uploads/"])').each((_, element) => {
      const url = absoluteHttpUrl($(element).attr('href'), base);
      if (!url) return;
      const parsed = new URL(url);
      if (parsed.origin !== origin || !/^\/[a-z0-9-]+\/$/i.test(parsed.pathname)) return;
      found.add(url);
    });
    return [...found];
  }

  public parseDetail(html: string, url: string): {
    title: string; quality: string | null; downloads: Array<{ link: string; audio: string[]; size: number | null }>;
    gated: number;
  } {
    const $ = cheerio.load(html);
    const title = cleanText($('h1').first().text()).replace(/\s*\(\d{4}\)\s*$/, '');
    const quality = cleanText($('body').text().match(/Formato:\s*(4K|2160p|1080p|720p|DVDRip)/i)?.[1]) || null;
    const downloads: Array<{ link: string; audio: string[]; size: number | null }> = [];
    let gated = 0;
    $('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const language = cleanText(cells.eq(0).find('img').attr('alt') || cells.eq(0).text());
      const audio = /castellano|español|spanish/i.test(language) ? ['es'] : /english|inglés/i.test(language) ? ['en'] : [];
      const sizeText = cleanText($(row).text());
      const size = parseSizeToBytes(sizeText.match(/\d+(?:[.,]\d+)?\s*(?:GB|MB|GiB|MiB)/i)?.[0] ?? '');
      $(row).find('a[href]').each((_, a) => {
        const raw = $(a).attr('href') || '';
        if (raw.startsWith('magnet:')) {
          if (parseMagnetUri(raw)) downloads.push({ link: raw, audio, size });
          return;
        }
        const link = absoluteHttpUrl(raw, url);
        if (!link) return;
        // No redirect following to super-enlace or other unverified third parties.
        if (new URL(link).origin === new URL(url).origin && /\.torrent(?:\?.*)?$/i.test(new URL(link).pathname + new URL(link).search)) {
          downloads.push({ link, audio, size });
        } else if (/descargar/i.test(cleanText($(a).text()))) gated++;
      });
    });
    return { title, quality, downloads, gated };
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    const base = await this.resolveMirror({
      defaults: ['https://grantorrent.foo'],
      probes: [{ path: '/', label: 'WordPress movie cards', timeoutMs: 7000,
        validate: htmlMarkerValidator([/wp-content\/uploads\//i, /href=["'][^"']*\/categoria\//i]) }]
    });
    const candidates = new Set<string>();
    for (let page = 1; page <= maxPages && !this.deadline.expired; page++) {
      try {
        const html = await this.fetchHtml(page === 1 ? `${base}/` : `${base}/page/${page}/`,
          { headers: { Referer: `${base}/` } }, { rejectBlocked: true });
        this.metrics.add('listings');
        const links = this.parseListing(html, base);
        const before = candidates.size;
        for (const link of links) candidates.add(link);
        if (!links.length || candidates.size === before) break;
      } catch (error) {
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
        this.metrics.add('gated', detail.gated);
        const records: TorrentRecord[] = [];
        for (const download of detail.downloads) {
          try {
            const magnet = download.link.startsWith('magnet:') ? parseMagnetUri(download.link) : null;
            const metainfo = magnet ? null : await this.fetchTorrentMetainfoViaGet(download.link, url);
            if (!magnet && !metainfo) continue;
            const record = buildTorrentRecord({
              infoHash: (magnet ?? metainfo)!.infoHash,
              title: detail.title, type: 'movie', sourceUrl: url,
              magnetUrl: magnet ? download.link : undefined,
              torrentFileUrl: magnet ? undefined : download.link,
              audio: download.audio, quality: detail.quality, sizeBytes: download.size
            });
            if (record) records.push(record);
          } catch (error) {
            this.metrics.add('downloadErrors');
            this.log.warn(`Download metadata failed: ${describeError(error)}`);
          }
        }
        return records;
      } catch (error) {
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
