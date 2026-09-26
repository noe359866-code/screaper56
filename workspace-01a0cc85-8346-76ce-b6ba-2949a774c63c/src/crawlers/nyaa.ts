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
  isBlockedTitle,
  parseCount,
  qualityOf
} from './support.js';

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

  constructor() {
    super();
    this.baseUrl = process.env.NYAA_BASE_URL || NyaaCrawler.DEFAULT_MIRRORS[0];
  }

  private resolveUrl(target: string, base: string): string {
    return absoluteHttpUrl(target, base) ?? target;
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
    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

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

    for (const endpoint of queryEndpoints) {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;

        const separator = endpoint.includes('?') ? '&' : '?';
        const targetUrl = `${mirror}${endpoint}${separator}p=${page}`;

        try {
          this.log.debug(`Fetching anime catalog: ${targetUrl}`);
          const html = await this.fetchHtml(targetUrl);
          this.metrics.add('listings');

          const rows = this.parseRows(html, targetUrl, mirror, endpoint);
          if (!rows.length) {
            this.log.debug(`No rows on ${targetUrl}; stopping pagination for this endpoint.`);
            break;
          }

          for (const record of rows) {
            if (uniqueHashes.has(record.info_hash)) continue;
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
          }
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Failed fetching ${targetUrl}: ${describe(error)}`);
          break;
        }
      }
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** Extracted for testability: one HTML page -> records. */
  public parseRows(html: string, sourceUrl: string, mirror: string, endpoint = ''): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    $('table.torrent-list tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 7) return;

      // `a.comments` is the comment counter; the real title link is the other one.
      const titleAnchor = tds.eq(1).find('a:not(.comments)').last();
      const title = cleanText(titleAnchor.text());
      const viewHref = titleAnchor.attr('href') || '';
      const magnetHref = tds.eq(2).find('a[href^="magnet:"]').attr('href');
      if (!title || !magnetHref || isBlockedTitle(title)) return;

      const parsedMagnet = parseMagnetUri(magnetHref);
      if (!parsedMagnet?.infoHash) return;

      const meta = parseTorrentTitle(title, 'anime');
      // Category 1_2 means English *subtitles*, not English audio.
      const hints = endpoint.includes('1_2') ? ['nyaa', 'sub_en'] : ['nyaa'];
      const langs = detectLanguages(title, hints, false);

      const torrentHref = tds.eq(2).find('a[href^="/download/"]').attr('href');

      const record = buildTorrentRecord({
        title,
        type: 'anime',
        infoHash: parsedMagnet.infoHash,
        magnetUrl: magnetHref,
        torrentFileUrl: torrentHref ? this.resolveUrl(torrentHref, mirror) : null,
        sourceUrl: viewHref ? this.resolveUrl(viewHref, mirror) : sourceUrl,
        trackers: parsedMagnet.trackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parseSizeToBytes(cleanText(tds.eq(3).text())),
        seeders: parseCount(tds.eq(5).text()),
        leechers: parseCount(tds.eq(6).text()),
        sourceTracker: parsedMagnet.trackers[0] || 'http://nyaa.tracker.wf:7777/announce'
      });

      if (record) records.push(record);
    });

    return records;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default NyaaCrawler;
