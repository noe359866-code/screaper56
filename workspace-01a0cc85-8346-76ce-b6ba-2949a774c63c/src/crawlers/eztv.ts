import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { normalizeInfoHash, parseMagnetUri } from '../utils/magnet.js';
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

interface EztvApiTorrent {
  id?: number;
  hash: string;
  filename?: string;
  episode_url?: string;
  torrent_url?: string;
  magnet_url?: string;
  title?: string;
  imdb_id?: string;
  season?: string | number;
  episode?: string | number;
  seeds?: number;
  peers?: number;
  size_bytes?: string | number;
}

interface EztvApiResponse {
  torrents?: EztvApiTorrent[];
}

/**
 * EZTV: JSON API first, HTML catalogue as a fallback (some mirrors disable the
 * API while keeping the public listing). Missing season/episode values stay
 * `null` instead of collapsing into zero.
 */
export class EztvCrawler extends BaseCrawler {
  public readonly name = 'eztv';
  public baseUrl = process.env.EZTV_BASE_URL || 'https://eztv1.xyz';

  /** Known EZTV front-ends; extend with EZTV_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://eztv1.xyz',
    'https://eztvx.to',
    'https://eztv.re',
    'https://eztv.wf',
    'https://eztv.tf',
    'https://eztv.yt',
    'https://eztv.ch',
    'https://eztv.it'
  ];

  private readonly defaultTrackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce'
  ];

  private resolveUrl(target: string, base: string): string {
    return absoluteHttpUrl(target, base) ?? target;
  }

  private async getWorkingDomain(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'EZTV',
      defaults: EztvCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/api/get-torrents?limit=1',
          label: 'API',
          timeoutMs: 6000,
          validate: (data: unknown) => Array.isArray((data as EztvApiResponse | undefined)?.torrents)
        },
        {
          // The API may be disabled while the HTML catalogue remains public.
          path: '/home',
          label: 'catálogo HTML',
          timeoutMs: 6000,
          validate: htmlMarkerValidator([/class=["'][^"']*epinfo/])
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting EZTV crawl (maxPages=${maxPages})...`);

    const activeDomain = await this.getWorkingDomain();
    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

    // -------- API phase --------
    try {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        const apiUrl = `${activeDomain}/api/get-torrents?limit=80&page=${page}`;
        this.log.debug(`Querying EZTV API: ${apiUrl}`);

        const payload = await this.fetchJson<EztvApiResponse>(apiUrl);
        if (!Array.isArray(payload?.torrents)) throw new Error('Invalid EZTV API payload');
        this.metrics.add('listings');

        if (!payload.torrents.length) {
          this.log.debug(`API returned no more results at page ${page}.`);
          break;
        }

        for (const torrent of payload.torrents) {
          const record = this.mapApiTorrentToRecord(torrent, activeDomain);
          if (record && !uniqueHashes.has(record.info_hash)) {
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
          }
        }
      }

      if (results.length) {
        const deduplicated = this.deduplicateRecords(results);
        this.logRunSummary(deduplicated);
        return deduplicated;
      }
    } catch (error) {
      this.metrics.add('listingErrors');
      this.log.warn(`EZTV API failed (${describe(error)}). Falling back to the HTML catalogue...`);
    }

    // -------- HTML fallback --------
    try {
      for (let page = 0; page < maxPages; page++) {
        if (this.deadline.expired) break;
        const pageUrl = page === 0 ? `${activeDomain}/home` : `${activeDomain}/page_${page}`;
        this.log.debug(`Scraping HTML: ${pageUrl}`);

        const html = await this.fetchHtml(pageUrl);
        this.metrics.add('listings');
        const added = this.collectHtmlRows(html, activeDomain, uniqueHashes, results);
        if (!added) break;
      }
    } catch (error) {
      this.metrics.add('listingErrors');
      this.log.error(`HTML fallback error: ${describe(error)}`);
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  private collectHtmlRows(
    html: string,
    activeDomain: string,
    uniqueHashes: Set<string>,
    sink: TorrentRecord[]
  ): number {
    const $ = cheerio.load(html);
    let added = 0;

    $('tr.forum_header_border').each((_, el) => {
      const row = $(el);
      const titleAnchor = row.find('a.epinfo');
      const magnetLink = row.find('a.magnet').attr('href');
      if (!titleAnchor.length || !magnetLink) return;

      const parsedMagnet = parseMagnetUri(magnetLink);
      if (!parsedMagnet?.infoHash || uniqueHashes.has(parsedMagnet.infoHash)) return;

      const title = cleanText(titleAnchor.text());
      if (!title || isBlockedTitle(title)) return;

      const torrentLink = row.find('a.download_1').attr('href') || null;
      const meta = parseTorrentTitle(title, 'series');
      const langs = detectLanguages(title, ['eztv', 'tv']);

      const record = buildTorrentRecord({
        title,
        type: 'series',
        infoHash: parsedMagnet.infoHash,
        magnetUrl: magnetLink,
        torrentFileUrl: torrentLink ? this.resolveUrl(torrentLink, activeDomain) : null,
        sourceUrl: this.resolveUrl(titleAnchor.attr('href') || '', activeDomain),
        trackers: parsedMagnet.trackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parseSizeToBytes(cleanText(row.find('td:nth-child(4)').text())),
        seeders: parseCount(row.find('td:nth-child(6) font').text()),
        // The HTML catalogue does not publish leechers: unknown stays unknown.
        leechers: null,
        sourceTracker: parsedMagnet.trackers[0] || this.defaultTrackers[0]
      });

      if (!record) return;
      uniqueHashes.add(record.info_hash);
      sink.push(record);
      this.metrics.add('records');
      added++;
    });

    return added;
  }

  public mapApiTorrentToRecord(torrent: EztvApiTorrent, activeDomain: string): TorrentRecord | null {
    if (!torrent?.hash) return null;

    const infoHash = normalizeInfoHash(torrent.hash);
    if (!infoHash) return null;

    const fullTitle = cleanText(torrent.filename || torrent.title || '');
    if (!fullTitle || isBlockedTitle(fullTitle)) return null;

    const meta = parseTorrentTitle(fullTitle, 'series');
    const langs = detectLanguages(fullTitle, ['eztv', 'tv']);

    let imdbId: string | null = null;
    const rawImdb = torrent.imdb_id ? String(torrent.imdb_id).trim() : '';
    if (/^(?:tt)?\d{1,10}$/.test(rawImdb) && Number(rawImdb.replace(/^tt/, '')) > 0) {
      imdbId = `tt${rawImdb.replace(/^tt/, '').padStart(7, '0')}`;
    }

    const season = torrent.season !== undefined && torrent.season !== null && torrent.season !== ''
      ? parseCount(torrent.season)
      : meta.season ?? null;
    const episode = torrent.episode !== undefined && torrent.episode !== null && torrent.episode !== ''
      ? parseCount(torrent.episode)
      : meta.episode ?? null;

    const magnetUrl = torrent.magnet_url && torrent.magnet_url.includes('tr=') ? torrent.magnet_url : null;

    return buildTorrentRecord({
      title: fullTitle,
      type: 'series',
      infoHash,
      magnetUrl,
      torrentFileUrl: torrent.torrent_url || null,
      sourceUrl: torrent.episode_url || `${activeDomain}/ep/${torrent.id ?? ''}`,
      trackers: this.defaultTrackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      season,
      episode,
      quality: qualityOf(meta),
      sizeBytes: parseCount(torrent.size_bytes),
      seeders: torrent.seeds ?? null,
      leechers: torrent.peers ?? null,
      imdbId,
      sourceTracker: this.defaultTrackers[0]
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default EztvCrawler;
