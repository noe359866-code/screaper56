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
  imdb_id?: string | number;
  season?: string | number;
  episode?: string | number;
  seeds?: string | number;
  peers?: string | number;
  size_bytes?: string | number;
}

interface EztvApiResponse {
  torrents?: EztvApiTorrent[];
}

/**
 * EZTV: JSON API primer intento, catálogo HTML como fallback (algunos espejos
 * desactivan la API manteniendo el catálogo público).
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

    let apiSuccess = false;

    // -------- Fase 1: API JSON --------
    try {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        const apiUrl = `${activeDomain}/api/get-torrents?limit=80&page=${page}`;
        this.log.debug(`Querying EZTV API: ${apiUrl}`);

        const payload = await this.fetchJson<EztvApiResponse>(apiUrl);
        if (!Array.isArray(payload?.torrents)) {
          throw new Error('Invalid EZTV API payload structure');
        }
        this.metrics.add('listings');

        if (payload.torrents.length === 0) {
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
      apiSuccess = true;
    } catch (error) {
      this.metrics.add('listingErrors');
      this.log.warn(`EZTV API failed (${formatError(error)}). Falling back to HTML catalogue...`);
    }

    if (apiSuccess && results.length > 0) {
      const deduplicated = this.deduplicateRecords(results);
      this.logRunSummary(deduplicated);
      return deduplicated;
    }

    // -------- Fase 2: Fallback HTML --------
    try {
      for (let page = 0; page < maxPages; page++) {
        if (this.deadline.expired) break;
        const pageUrl = page === 0 ? `${activeDomain}/home` : `${activeDomain}/page_${page}`;
        this.log.debug(`Scraping HTML: ${pageUrl}`);

        const html = await this.fetchHtml(pageUrl);
        this.metrics.add('listings');

        const rowCount = this.collectHtmlRows(html, activeDomain, uniqueHashes, results);
        if (rowCount === 0) break;
      }
    } catch (error) {
      this.metrics.add('listingErrors');
      this.log.error(`HTML fallback error: ${formatError(error)}`);
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
    const rows = $('tr.forum_header_border');
    if (rows.length === 0) return 0;

    rows.each((_, el) => {
      const row = $(el);
      const titleAnchor = row.find('a.epinfo');
      if (!titleAnchor.length) return;

      const magnetLink = row.find('a.magnet').attr('href');
      if (!magnetLink) return;

      const parsedMagnet = parseMagnetUri(magnetLink);
      if (!parsedMagnet?.infoHash || uniqueHashes.has(parsedMagnet.infoHash)) return;

      const title = cleanText(titleAnchor.text());
      if (!title || isBlockedTitle(title)) return;

      const torrentLink = row.find('a.download_1').attr('href') || null;
      const meta = parseTorrentTitle(title, 'series');
      const langs = detectLanguages(title, ['eztv', 'tv']);

      const tds = row.find('td');
      const sizeText = tds.length >= 4 ? cleanText($(tds[3]).text()) : '';
      const seedersText = tds.length >= 6 ? cleanText($(tds[5]).find('font').text() \vert{}\vert{}$(tds[5]).text()) : '';

      const record = buildTorrentRecord({
        title,
        type: 'series',
        infoHash: parsedMagnet.infoHash,
        magnetUrl: magnetLink,
        torrentFileUrl: torrentLink ? this.resolveUrl(torrentLink, activeDomain) : null,
        sourceUrl: this.resolveUrl(titleAnchor.attr('href') || '', activeDomain),
        trackers: parsedMagnet.trackers.length ? parsedMagnet.trackers : this.defaultTrackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parseSizeToBytes(sizeText),
        seeders: parseCount(seedersText),
        leechers: null,
        sourceTracker: parsedMagnet.trackers[0] || this.defaultTrackers[0]
      });

      if (!record) return;
      uniqueHashes.add(record.info_hash);
      sink.push(record);
      this.metrics.add('records');
    });

    return rows.length;
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
    if (torrent.imdb_id) {
      const rawImdb = String(torrent.imdb_id).trim().replace(/^tt/i, '');
      if (/^\d{1,10}$/.test(rawImdb) && parseInt(rawImdb, 10) > 0) {
        imdbId = `tt${rawImdb.padStart(7, '0')}`;
      }
    }

    const parsedSeason = parseCount(torrent.season);
    const parsedEpisode = parseCount(torrent.episode);

    const season = (parsedSeason !== null && parsedSeason > 0)
      ? parsedSeason
      : (meta.season ?? (parsedSeason === 0 ? 0 : null));

    const episode = (parsedEpisode !== null && parsedEpisode > 0)
      ? parsedEpisode
      : (meta.episode ?? (parsedEpisode === 0 ? 0 : null));

    // Si el magnet_url no viene en la API o es incompleto, construimos uno válido
    let magnetUrl = torrent.magnet_url || null;
    if (!magnetUrl) {
      const trackersQuery = this.defaultTrackers.map((t) => `tr=${encodeURIComponent(t)}`).join('&');
      magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(fullTitle)}&${trackersQuery}`;
    }

    const torrentFileUrl = torrent.torrent_url ? this.resolveUrl(torrent.torrent_url, activeDomain) : null;
    const sourceUrl = torrent.episode_url
      ? this.resolveUrl(torrent.episode_url, activeDomain)
      : `${activeDomain}/ep/${torrent.id ?? ''}`;

    return buildTorrentRecord({
      title: fullTitle,
      type: 'series',
      infoHash,
      magnetUrl,
      torrentFileUrl,
      sourceUrl,
      trackers: this.defaultTrackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      season,
      episode,
      quality: qualityOf(meta),
      sizeBytes: parseCount(torrent.size_bytes),
      seeders: parseCount(torrent.seeds),
      leechers: parseCount(torrent.peers),
      imdbId,
      sourceTracker: this.defaultTrackers[0]
    });
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default EztvCrawler;
