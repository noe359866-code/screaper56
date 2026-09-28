import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
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

/** Keep source and metainfo links on the verified mirror (www/apex is OK). */
function sameSiteHttpUrl(value: string, base: string): string | null {
  const candidate = absoluteHttpUrl(value, base);
  if (!candidate) return null;
  try {
    const left = new URL(candidate);
    const right = new URL(base);
    if (left.username || left.password) return null;
    return left.protocol === right.protocol && left.port === right.port && sameHost(candidate, base)
      ? candidate
      : null;
  } catch {
    return null;
  }
}

/**
 * Nyaa: anime torrent lists. A category or a search term is a discovery hint,
 * never proof of the audio language, so `inferDefaults` stays disabled.
 */
export class NyaaCrawler extends BaseCrawler {
  public readonly name = 'nyaa';
  public baseUrl: string;

  /** Known Nyaa front-ends; extend with NYAA_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://nyaa.si',
    'https://nyaa.land',
    'https://nyaa.ink',
    'https://nyaa.net',
    'https://nyaa.digital',
    'https://nyaa.iss.ink',
    'https://nyaa.unblockit.day'
  ];

  private readonly concurrency = Math.max(
    1,
    Number.parseInt(process.env.NYAA_CONCURRENCY || '6', 10) || 6
  );

  constructor() {
    super();
    this.baseUrl = process.env.NYAA_BASE_URL || NyaaCrawler.DEFAULT_MIRRORS[0];
  }

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'NYAA',
      defaults: NyaaCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/?f=0&c=1_2&p=1',
          label: 'lista de torrents',
          timeoutMs: 6000,
          validate: htmlMarkerValidator(['torrent-list'])
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting Nyaa anime crawl (maxPages=${maxPages})...`);

    const mirror = await this.getWorkingMirror();

    const queryEndpoints: string[] = [
      '/?f=0&c=1_2',                 // Anime - English-translated
      '/?f=0&c=1_3',                 // Anime - Non-English-translated (fansubs)
      '/?f=0&c=1_4',                 // Anime - Raw
      '/?f=0&c=0_0&q=spanish',
      '/?f=0&c=0_0&q=latino',
      '/?f=0&c=0_0&q=castellano',
      '/?f=0&c=0_0&q=multisub',
      '/?f=0&c=0_0&q=dual+audio'
    ];

    // Endpoints run in parallel, pages of one endpoint run in order: niche
    // searches ("castellano") often have a single page, and fetching pages
    // 2..N blindly in parallel wasted most of the listing requests.
    let usableListingPages = 0;
    const nestedRecords = await mapWithConcurrency(
      queryEndpoints,
      this.concurrency,
      async endpoint => {
        const collected: TorrentRecord[] = [];
        const seen = new Set<string>();
        const separator = endpoint.includes('?') ? '&' : '?';
        for (let page = 1; page <= maxPages; page++) {
          if (this.deadline.expired) break;
          const url = `${mirror}${endpoint}${separator}p=${page}`;
          try {
            this.log.debug(`Fetching anime catalog: ${url}`);
            const html = await this.fetchHtml(url, {}, { rejectBlocked: true });
            const $ = cheerio.load(html);
            if ($('table.torrent-list').length === 0) {
              throw new Error('Expected table.torrent-list in Nyaa catalogue response');
            }
            const pageRowCount = $('table.torrent-list tbody tr').length;
            usableListingPages++;
            this.metrics.add('listings');
            const rows = this.parseRows(html, url, mirror, endpoint);
            let added = 0;
            for (const row of rows) {
              if (seen.has(row.info_hash)) continue;
              seen.add(row.info_hash);
              collected.push(row);
              added++;
            }
            this.metrics.add('records', added);
            // Nyaa pages hold 75 source rows. Count before filtering invalid
            // magnets or non-video categories; otherwise a full mixed page can
            // look short and hide eligible releases on the next page.
            if (pageRowCount < 75) break;
          } catch (error) {
            this.metrics.add('listingErrors');
            this.log.warn(`Failed fetching ${url}: ${describeError(error)}`);
            break;
          }
        }
        return collected;
      }
    );

    if (usableListingPages === 0) {
      throw new Error('[nyaa] No usable catalogue responses. Check mirror availability, blocking and page layout.');
    }

    const allRecords = nestedRecords.flat();
    const deduplicated = this.deduplicateRecords(allRecords);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** Extracted for testability: one HTML page -> records. */
  public parseRows(
    html: string,
    sourceUrl: string,
    mirror: string,
    endpoint = ''
  ): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    // Hints dinámicos basados en la consulta/endpoint de búsqueda
    const hints: string[] = ['nyaa'];
    if (endpoint.includes('1_2')) hints.push('sub_en');
    // q=spanish/latino/castellano are search hints, not proof that a release
    // has that language as audio; title metadata remains the audio source.
    // 'multi' alone matched no subtitle pattern, so MultiSubs searches were
    // silently losing their only language evidence.
    if (/multisub|multi[+\s_-]*sub/i.test(endpoint)) hints.push('multisubs');

    $('table.torrent-list tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 7) return;

      // The title cell holds both the release anchor and a `#comments` anchor
      // pointing at the same /view/ route. `.last()` picked the comment counter
      // on templates that render it second, so fragments are excluded first.
      const titleAnchor = tds.eq(1).find('a[href*="/view/"]:not([href*="#"])').first();
      const title = cleanText(titleAnchor.attr('title') || titleAnchor.text());
      const viewHref = titleAnchor.attr('href') || '';
      let magnetHref: string | null = null;
      let parsedMagnet: ReturnType<typeof parseMagnetUri> = null;
      for (const element of tds.eq(2).find('a[href]').toArray()) {
        const href = $(element).attr('href') || '';
        if (!/^magnet:/i.test(href)) continue;
        const candidate = parseMagnetUri(href);
        if (!candidate?.infoHash) continue;
        magnetHref = href;
        parsedMagnet = candidate;
        break;
      }

      if (!title || !parsedMagnet?.infoHash || isBlockedTitle(title)) return;

      // Nyaa publishes its category in the icon title of the first cell
      // ("Anime - English-translated", "Live Action - ..."). A `c=0_0` search
      // spans every category, so a live-action movie is no longer filed as anime.
      const categoryLabel = cleanText(tds.eq(0).find('img').attr('title') || tds.eq(0).text());
      // Nyaa also indexes audio, books, software and pictures. A `c=0_0` search
      // spans every one of them, and the schema only stores video, so those
      // rows are dropped instead of being filed as anime releases.
      if (/audio|literature|software|pictures|games?|other/i.test(categoryLabel)) return;
      const contentType: 'anime' | 'movie' = /^live\s*action/i.test(categoryLabel) ? 'movie' : 'anime';

      const meta = parseTorrentTitle(title, contentType);
      const langs = detectLanguages(title, hints, false);
      let torrentFileUrl: string | null = null;
      for (const element of tds.eq(2).find('a[href]').toArray()) {
        const candidate = sameSiteHttpUrl($(element).attr('href') || '', mirror);
        if (!candidate) continue;
        try {
          if (/^\/download\/.+\.torrent$/i.test(new URL(candidate).pathname)) {
            torrentFileUrl = candidate;
            break;
          }
        } catch {
          /* Invalid URL: ignore this download anchor and keep checking. */
        }
      }

      const trustedViewUrl = viewHref ? sameSiteHttpUrl(viewHref, mirror) : null;
      const record = buildTorrentRecord({
        title,
        type: contentType,
        infoHash: parsedMagnet.infoHash,
        magnetUrl: magnetHref,
        torrentFileUrl,
        sourceUrl: trustedViewUrl ?? sourceUrl,
        trackers: parsedMagnet.trackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parseSizeToBytes(cleanText(tds.eq(3).text())),
        seeders: parseCount(tds.eq(5).text()),
        leechers: parseCount(tds.eq(6).text()),
        // The row magnet is the source of truth; do not invent a tracker when it omits `tr=`.
        sourceTracker: parsedMagnet.trackers[0] ?? null
      });

      if (record) records.push(record);
    });

    return records;
  }
}

export default NyaaCrawler;
