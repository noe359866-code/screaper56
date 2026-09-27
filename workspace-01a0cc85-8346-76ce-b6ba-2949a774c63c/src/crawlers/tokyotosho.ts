import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  describeError,
  isBlockedTitle,
  mapWithConcurrency,
  parseCount,
  qualityOf
} from './support.js';

interface TokyoRoute {
  /** Query string for `/` or `/search.php`. */
  path: string;
  type: ContentType;
  /** Category-level language hint ('sub_en' for English-translated anime). */
  hints: string[];
}

/**
 * Tokyo Toshokan: two-row listings (`td.desc-top` + `td.desc-bot`). The magnet
 * published in the row is required; the category only adds subtitle hints,
 * never audio.
 */
export class TokyoToshoCrawler extends BaseCrawler {
  public readonly name = 'tokyotosho';
  public baseUrl = process.env.TOKYOTOSHO_BASE_URL || 'https://www.tokyotosho.info';

  /** Official domains; extend with TOKYOTOSHO_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www.tokyotosho.info',
    'https://tokyotosho.info',
    'https://www.tokyotosho.se',
    'https://tokyotosho.se',
    'https://www.tokyo-tosho.net'
  ];

  private readonly concurrency = Math.max(
    1,
    Number.parseInt(process.env.TOKYOTOSHO_CONCURRENCY || '3', 10) || 3
  );

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'TOKYOTOSHO',
      defaults: TokyoToshoCrawler.DEFAULT_MIRRORS,
      fallback: this.baseUrl,
      probes: [
        {
          path: '/?cat=1',
          label: 'listado anime',
          timeoutMs: 8000,
          validate: htmlMarkerValidator([/desc-top|details\.php\?id=/i])
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting Tokyo Toshokan crawl (maxPages=${maxPages})...`);

    const mirror = (await this.getWorkingMirror()).replace(/\/+$/, '');
    this.baseUrl = mirror;

    const searches = (process.env.TOKYOTOSHO_SEARCH || 'spanish,latino,castellano,multisub')
      .split(/[,\n]+/).map(term => term.trim()).filter(Boolean);

    const routes: TokyoRoute[] = [
      { path: '/?cat=1', type: 'anime', hints: ['sub_en'] },   // Anime (English-translated)
      { path: '/?cat=11', type: 'anime', hints: [] },          // Batch
      { path: '/?cat=10', type: 'anime', hints: [] },          // Non-English
      { path: '/?cat=8', type: 'series', hints: [] },          // Drama
      ...searches.map(term => ({
        path: `/search.php?terms=${encodeURIComponent(term)}&type=0&searchName=true`,
        type: 'anime' as ContentType,
        hints: []
      }))
    ];

    // Routes in parallel, pages of a route in order (stop at the first page
    // that adds nothing new instead of fetching every page blindly).
    const nested = await mapWithConcurrency(routes, this.concurrency, async route => {
      const collected: TorrentRecord[] = [];
      const seen = new Set<string>();
      for (let page = 0; page < maxPages; page++) {
        if (this.deadline.expired) break;
        const url = page === 0 ? `${mirror}${route.path}` : `${mirror}${route.path}&page=${page}`;
        try {
          const html = await this.fetchHtml(url, { headers: { Referer: `${mirror}/` } });
          this.metrics.add('listings');
          const rows = this.parseListing(html, url, route.type, route.hints);
          let added = 0;
          for (const row of rows) {
            if (seen.has(row.info_hash)) continue;
            seen.add(row.info_hash);
            collected.push(row);
            added++;
          }
          this.metrics.add('records', added);
          if (added === 0) break;
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Listing failed ${url}: ${describeError(error)}`);
          break;
        }
      }
      return collected;
    });

    const deduplicated = this.deduplicateRecords(nested.flat());
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  public parseListing(html: string, pageUrl: string, defaultType: ContentType, categoryHints: string[] = []): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    $('td.desc-top').each((_, cell) => {
      const top = $(cell);
      const row = top.closest('tr');
      const bottom = row.next('tr');

      const magnet = top.find('a[href^="magnet:?"]').first().attr('href')
        ?? row.find('a[href^="magnet:?"]').first().attr('href');
      const parsed = magnet ? parseMagnetUri(magnet) : null;
      if (!magnet || !parsed?.infoHash) return;

      const titleAnchor = top.find('a').filter((__, a) => {
        const href = $(a).attr('href') || '';
        return !href.startsWith('magnet:') && cleanText($(a).text()).length > 0;
      }).last();
      const title = cleanText(titleAnchor.text()) || cleanText(parsed.displayName || '');
      if (!title || isBlockedTitle(title)) return;

      // Category icon (row class / link) — hentai/JAV/music/manga never indexed.
      const categoryText = `${row.attr('class') || ''} ${row.find('a[href*="cat="]').first().attr('href') || ''}`;
      if (/cat=(?:2|3|4|9|12|13|14|15)\b/.test(categoryText)) return;

      const bottomText = cleanText(bottom.find('td.desc-bot').text() || bottom.text());
      const statsText = cleanText(bottom.find('td.stats').text() || bottomText);
      const size = bottomText.match(/Size:\s*([\d.,]+\s*[KMGT]?i?B)/i)?.[1] ?? '';
      const comment = bottomText.match(/Comment:\s*(.{0,200})/i)?.[1] ?? '';

      const detailHref = row.find('a[href*="details.php?id="]').first().attr('href')
        ?? bottom.find('a[href*="details.php?id="]').first().attr('href');
      const torrentHref = titleAnchor.attr('href') || null;

      const type: ContentType = /\bdrama\b/i.test(title) ? 'series' : defaultType;
      const meta = parseTorrentTitle(title, type);
      // Titles and the uploader comment are evidence; "tokyotosho" is not a language.
      const langs = detectLanguages(`${title} ${comment}`, categoryHints, false);

      const record = buildTorrentRecord({
        title,
        type: meta.type,
        infoHash: parsed.infoHash,
        magnetUrl: magnet,
        torrentFileUrl: torrentHref ? absoluteHttpUrl(torrentHref, pageUrl) : null,
        sourceUrl: (detailHref ? absoluteHttpUrl(detailHref, pageUrl) : null) ?? pageUrl,
        trackers: parsed.trackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parseSizeToBytes(size.replace(/\s+/g, '')),
        seeders: parseCount(statsText.match(/S:\s*([\d,]+)/)?.[1] ?? null),
        leechers: parseCount(statsText.match(/L:\s*([\d,]+)/)?.[1] ?? null),
        sourceTracker: parsed.trackers[0] ?? null
      });
      if (record) records.push(record);
    });

    return records;
  }
}

export default TokyoToshoCrawler;
