import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
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
  describeError,
  isBlockedTitle,
  parseCount,
  qualityOf,
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

/** Hard limit of the public EZTV API; larger values are ignored server-side. */
const EZTV_API_PAGE_SIZE = 50;

/** A cell that is nothing but a size, e.g. `650 MiB` / `1.4 GB` / `700 MB`. */
const SIZE_CELL_PATTERN = /^\d+(?:[.,]\d+)?\s*(?:[KMGT]i?B|bytes?)$/i;

export class EztvCrawler extends BaseCrawler {
  public readonly name = 'eztv';
  public baseUrl = process.env.EZTV_BASE_URL || 'https://eztv1.xyz';

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
          headers: { Accept: 'application/json, text/plain, */*' },
          validate: (data: unknown) => Array.isArray((data as EztvApiResponse | undefined)?.torrents)
        },
        {
          path: '/home',
          label: 'catálogo HTML',
          timeoutMs: 6000,
          validate: htmlMarkerValidator([/class=[\"'][^\"']*epinfo/])
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

    try {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        // The public EZTV API caps `limit` at 50; asking for more returns the
        // default page and made every crawl re-read the same 50 rows.
        const apiUrl = `${activeDomain}/api/get-torrents?limit=${EZTV_API_PAGE_SIZE}&page=${page}`;
        this.log.debug(`Querying EZTV API: ${apiUrl}`);

        // Headers específicos para API JSON — reduce 403 por fingerprint
        const payload = await this.fetchJson<EztvApiResponse>(apiUrl, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            Referer: `${activeDomain}/`
          },
          timeout: 8000
        });
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
      const msg = describeError(error);
      const is403 = msg.includes('403') || msg.toLowerCase().includes('forbidden');
      const isCloudflare = msg.toLowerCase().includes('cloudflare') || msg.toLowerCase().includes('just a moment');
      if (is403) {
        this.log.warn(`EZTV API bloqueada (403) en ${activeDomain} — probablemente WAF/bot protection. Fallback inmediato a HTML sin reintentos adicionales.`);
      } else if (isCloudflare) {
        this.log.warn(`EZTV API con Cloudflare challenge (${msg}). Fallback a HTML...`);
      } else {
        this.log.warn(`EZTV API failed (${msg}). Falling back to HTML catalogue...`);
      }
      // No rethrow — el fallback HTML se encarga
    }

    if (apiSuccess && results.length > 0) {
      const deduplicated = this.deduplicateRecords(results);
      this.logRunSummary(deduplicated);
      return deduplicated;
    }

    // HTML fallback — funciona incluso cuando la API está bloqueada por 403
    try {
      for (let page = 0; page < maxPages; page++) {
        if (this.deadline.expired) break;
        // `/home` and `/page_1` are the same listing, so page N maps to
        // `/page_${N + 1}`. The old `page_${page}` re-fetched `/home` twice.
        const pageUrl = page === 0 ? `${activeDomain}/home` : `${activeDomain}/page_${page + 1}`;
        this.log.debug(`Scraping HTML: ${pageUrl}`);

        const html = await this.fetchHtml(pageUrl, {
          headers: { Referer: `${activeDomain}/` },
          timeout: 8000
        });
        this.metrics.add('listings');

        // `added` (not the row count) decides when to stop: a page full of rows
        // we have already seen must not keep the pagination loop alive.
        const { rows, added } = this.collectHtmlRows(html, activeDomain, uniqueHashes, results);
        this.log.debug(`HTML page ${page + 1}: ${rows} rows, ${added} new records.`);
        if (rows === 0 || added === 0) break;
      }
    } catch (error) {
      this.metrics.add('listingErrors');
      const msg = describeError(error);
      if (msg.includes('403')) {
        this.log.warn(`EZTV HTML también bloqueado (403) en ${activeDomain}. Prueba EZTV_BASE_URL con otro mirror o espera unos minutos.`);
      } else {
        this.log.error(`HTML fallback error: ${msg}`);
      }
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
  ): { rows: number; added: number } {
    const $ = cheerio.load(html);
    const rows = $('tr.forum_header_border');
    if (rows.length === 0) return { rows: 0, added: 0 };

    let added = 0;

    rows.each((_, el) => {
      const row = $(el);
      const titleAnchor = row.find('a.epinfo');
      if (!titleAnchor.length) return;

      const magnetLink = row.find('a.magnet').attr('href');
      if (!magnetLink) return;

      const parsedMagnet = parseMagnetUri(magnetLink);
      if (!parsedMagnet?.infoHash || uniqueHashes.has(parsedMagnet.infoHash)) return;

      const title = cleanText(titleAnchor.attr('title') || titleAnchor.text());
      if (!title || isBlockedTitle(title)) return;

      const torrentLink = row.find('a.download_1').attr('href') || null;
      const meta = parseTorrentTitle(title, 'series');
      const langs = detectLanguages(title, ['eztv', 'tv']);

      // Mirrors reorder/shrink these columns, so they are located by content
      // instead of by a hard-coded index.
      const { sizeText, seedersText } = EztvCrawler.readRowCounters($, row);

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
      added++;
      this.metrics.add('records');
    });

    return { rows: rows.length, added };
  }

  /** Size comes from the only pure-size cell; seeds from the last numeric cell. */
  private static readRowCounters(
    $: cheerio.CheerioAPI,
    row: cheerio.Cheerio<Element>
  ): { sizeText: string; seedersText: string } {
    const cells = row.find('td');
    let sizeText = '';
    let sizeIndex = -1;
    let seedersText = '';

    cells.each((index, cell) => {
      const text = cleanText($(cell).text());
      if (sizeIndex === -1 && SIZE_CELL_PATTERN.test(text)) {
        sizeText = text;
        sizeIndex = index;
      }
    });

    // Legacy templates keep the size at a fixed offset.
    if (sizeIndex === -1 && cells.length >= 4) {
      sizeText = cleanText(cells.eq(3).text());
      sizeIndex = 3;
    }

    cells.each((index, cell) => {
      if (index === sizeIndex) return;
      const node = $(cell);
      const text = cleanText(node.find('font').first().text() || node.text());
      if (parseCount(text) !== null) seedersText = text;
    });

    return { sizeText, seedersText };
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

    // The API publishes structured season/episode numbers: they are
    // authoritative. Title heuristics only fill the gaps (a `0` season is a real
    // "specials" value, so it must not be overwritten by an S01 guess).
    const parsedSeason = parseCount(torrent.season);
    const parsedEpisode = parseCount(torrent.episode);

    const season = parsedSeason ?? meta.season ?? null;
    const episode = parsedEpisode ?? meta.episode ?? null;

    let magnetUrl = torrent.magnet_url || null;
    if (!magnetUrl) {
      const trackersQuery = this.defaultTrackers.map((t) => `tr=${encodeURIComponent(t)}`).join('&');
      magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(fullTitle)}&${trackersQuery}`;
    }

    const torrentFileUrl = torrent.torrent_url ? this.resolveUrl(torrent.torrent_url, activeDomain) : null;
    // Never emit a dangling `/ep/` when the API omits the id.
    const sourceUrl = torrent.episode_url
      ? this.resolveUrl(torrent.episode_url, activeDomain)
      : (torrent.id !== undefined && torrent.id !== null
        ? `${activeDomain}/ep/${torrent.id}`
        : null);

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

export default EztvCrawler;
