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
  qualityOf,
  sameHost
} from './support.js';

interface TokyoRoute {
  /** Query string for `/` or `/search.php`. */
  path: string;
  type: ContentType;
  /** Category-level language hint ('sub_en' for English-translated anime). */
  hints: string[];
}

/** Keep source and metainfo URLs on the verified mirror; allow only www/apex variation. */
function sameSiteHttpUrl(value: string, resolveAgainst: string, siteBase: string): string | null {
  const candidate = absoluteHttpUrl(value, resolveAgainst);
  if (!candidate) return null;
  try {
    const left = new URL(candidate);
    const right = new URL(siteBase);
    if (left.username || left.password) return null;
    return left.protocol === right.protocol && left.port === right.port && sameHost(candidate, siteBase)
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function categoryCode(categoryText: string): string | null {
  return categoryText.match(/(?:[?&]cat=|cat[=_]|category[_-]?)(\d+)/i)?.[1] ?? null;
}

function inferTokyoType(categoryText: string, title: string, fallback: ContentType): ContentType {
  const code = categoryCode(categoryText);
  if (code === '8' || /\bdrama\b/i.test(categoryText)) return 'series';
  if (/live[\s_-]*action|\bmovie\b|\bfilm\b/i.test(categoryText)) return 'movie';
  if (/documentar/i.test(categoryText)) return 'documentary';
  if (/\banime\b/i.test(categoryText)) return 'anime';

  const inferred = parseTorrentTitle(title).type;
  return inferred === 'anime' || inferred === 'series' || inferred === 'documentary'
    ? inferred
    : fallback;
}

const NON_VIDEO_CATEGORY_IDS = new Set(['2', '3', '4', '9', '12', '13', '14', '15']);
const NON_VIDEO_CATEGORY_LABEL = /hentai|\bjav\b|music|manga|\braws?\b/i;

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

    // Routes run in parallel; each route's pages are fetched in order until
    // an actually empty page appears (overlapping pages may add no new hashes).
    let successfulListings = 0;
    const nested = await mapWithConcurrency(routes, this.concurrency, async route => {
      const collected: TorrentRecord[] = [];
      const seen = new Set<string>();
      // Tokyo Toshokan numbering is 1-based: starting at 0 requested page 1
      // twice (`/?cat=1` then `/?cat=1&page=1`).
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        const url = page === 1 ? `${mirror}${route.path}` : `${mirror}${route.path}&page=${page}`;
        try {
          const html = await this.fetchHtml(
            url,
            { headers: { Referer: `${mirror}/` } },
            { rejectBlocked: true }
          );
          successfulListings++;
          this.metrics.add('listings');
          const pageRowCount = cheerio.load(html)('td.desc-top').length;
          const rows = this.parseListing(html, url, route.type, route.hints, mirror);
          let added = 0;
          for (const row of rows) {
            // Guard against a record without a hash: `seen.add(undefined)`
            // would make every following release look like a duplicate.
            if (!row.info_hash || seen.has(row.info_hash)) continue;
            seen.add(row.info_hash);
            collected.push(row);
            added++;
          }
          this.metrics.add('records', added);
          // Keep following numbered pages when a full/overlapping page adds no
          // new hashes; only an actually empty page ends the route.
          if (pageRowCount === 0) break;
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Listing failed ${url}: ${describeError(error)}`);
          break;
        }
      }
      return collected;
    });

    if (successfulListings === 0) {
      throw new Error('[tokyotosho] No usable catalogue responses. Check mirror availability, blocking and page layout.');
    }

    const deduplicated = this.deduplicateRecords(nested.flat());
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  public parseListing(
    html: string,
    pageUrl: string,
    defaultType: ContentType,
    categoryHints: string[] = [],
    mirror = this.baseUrl
  ): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    $('td.desc-top').each((_, cell) => {
      const top = $(cell);
      const row = top.closest('tr');
      const bottom = row.next('tr');

      let magnet: string | null = null;
      let parsed: ReturnType<typeof parseMagnetUri> = null;
      for (const element of row.find('a[href]').toArray()) {
        const href = $(element).attr('href') || '';
        if (!/^magnet:/i.test(href)) continue;
        const candidate = parseMagnetUri(href);
        if (!candidate?.infoHash) continue;
        magnet = href;
        parsed = candidate;
        break;
      }
      if (!magnet || !parsed?.infoHash) return;

      // Skip category/download/uploader links when the template has no title
      // anchor; a valid magnet display name is the safe fallback.
      const titleAnchor = top.find('a[href]').filter((__, a) => {
        const href = $(a).attr('href') || '';
        const label = cleanText($(a).attr('title') || $(a).text());
        return !/^magnet:/i.test(href) &&
          !/\.torrent(?:[?#]|$)|download\.php|\/torrents\/|[?&]cat=/i.test(href) &&
          !/^\[?(?:details?|download|dl|website|web|comments?|torrent|magnet)\]?$/i.test(label) &&
          label.length > 0;
      }).first();
      const title = cleanText(titleAnchor.attr('title') || titleAnchor.text()) || cleanText(parsed.displayName || '');
      if (!title || isBlockedTitle(title)) return;

      // Category filter (row class / cat link / category icon): hentai, JAV,
      // music, manga and raws are never indexed.
      const categoryText = [
        row.attr('class') || '',
        bottom.attr('class') || '',
        row.find('a[href*="cat="]').first().attr('href') || '',
        row.find('td.cat img, img[src*="cat"]').first().attr('src') || ''
      ].join(' ');
      const code = categoryCode(categoryText);
      if ((code && NON_VIDEO_CATEGORY_IDS.has(code)) || NON_VIDEO_CATEGORY_LABEL.test(categoryText)) return;

      const bottomText = cleanText(bottom.find('td.desc-bot').text() || bottom.text());
      // `td.stats` lives in the TOP row next to `td.desc-top`, not in the
      // second row: reading it from `bottom` left seeders/leechers always null.
      const statsText = cleanText(
        row.find('td.stats').text() || bottom.find('td.stats').text() || bottomText
      );
      const size = bottomText.match(/Size:\s*([\d.,]+\s*[KMGT]?i?B)/i)?.[1] ?? '';
      const comment = bottomText.match(/Comment:\s*(.{0,200})/i)?.[1] ?? '';

      const detailHref = row.find('a[href*="details.php?id="]').first().attr('href')
        ?? bottom.find('a[href*="details.php?id="]').first().attr('href');
      // Only a real metainfo link belongs in `torrent_file_url`; pointing it at
      // the HTML details page stored a web page as if it were a .torrent.
      let torrentFileUrl: string | null = null;
      const downloadAnchors = [
        ...row.find('a[href]').toArray(),
        ...bottom.find('a[href]').toArray()
      ];
      for (const element of downloadAnchors) {
        const href = $(element).attr('href') || '';
        let isMetainfo = false;
        try {
          const candidateUrl = new URL(href, pageUrl);
          isMetainfo = /\.torrent$/i.test(candidateUrl.pathname) || /\/download\.php$/i.test(candidateUrl.pathname);
        } catch {
          continue;
        }
        if (!isMetainfo) continue;
        torrentFileUrl = sameSiteHttpUrl(href, pageUrl, mirror);
        if (torrentFileUrl) break;
      }

      const trustedDetailUrl = detailHref ? sameSiteHttpUrl(detailHref, pageUrl, mirror) : null;
      const type = inferTokyoType(categoryText, title, defaultType);
      const meta = parseTorrentTitle(title, type);
      // Titles and the uploader comment are evidence; "tokyotosho" is not a language.
      const langs = detectLanguages(`${title} ${comment}`, categoryHints, false);

      const record = buildTorrentRecord({
        title,
        type: meta.type,
        infoHash: parsed.infoHash,
        magnetUrl: magnet,
        torrentFileUrl,
        sourceUrl: trustedDetailUrl ?? pageUrl,
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
