import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, normalizeInfoHash, parseMagnetUri } from '../utils/magnet.js';
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
  sameHost,
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

  private resolveUrl(target: string | null | undefined, base: string): string | null {
    const resolved = absoluteHttpUrl(target, base);
    if (!resolved) return null;
    try {
      const candidate = new URL(resolved);
      const site = new URL(base);
      if (candidate.username || candidate.password || site.username || site.password) return null;
      return candidate.protocol === site.protocol && candidate.port === site.port && sameHost(resolved, base)
        ? resolved
        : null;
    } catch {
      return null;
    }
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
    let successfulListings = 0;
    const apiPageSignatures = new Set<string>();

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
        successfulListings++;

        if (payload.torrents.length === 0) {
          this.log.debug(`API returned no more results at page ${page}.`);
          break;
        }

        // Deduplicate page identities rather than stopping on `added === 0`:
        // a full page of malformed/filtered rows can still precede valid pages.
        const pageSignature = payload.torrents.map(torrent => {
          if (!torrent || typeof torrent !== 'object') return String(torrent);
          return normalizeInfoHash(torrent.hash) ?? JSON.stringify([
            torrent.id ?? null,
            torrent.episode_url ?? null,
            torrent.torrent_url ?? null,
            torrent.filename ?? torrent.title ?? null
          ]);
        }).sort().join('|');
        if (apiPageSignatures.has(pageSignature)) {
          this.log.debug(`API repeated the page ${page}; ending pagination.`);
          break;
        }
        apiPageSignatures.add(pageSignature);

        for (const torrent of payload.torrents) {
          const record = this.mapApiTorrentToRecord(torrent, activeDomain);
          if (record && !uniqueHashes.has(record.info_hash)) {
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
          }
        }
        if (payload.torrents.length < EZTV_API_PAGE_SIZE) break;
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
    const htmlPageSignatures = new Set<string>();
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
        }, { rejectBlocked: true });
        this.metrics.add('listings');
        successfulListings++;

        const signature = this.htmlListingSignature(html);
        const { rows, added } = this.collectHtmlRows(html, activeDomain, uniqueHashes, results);
        this.log.debug(`HTML page ${page + 1}: ${rows} rows, ${added} new records.`);
        if (rows === 0) break;
        if (htmlPageSignatures.has(signature)) {
          this.log.debug(`HTML repeated the same release rows on page ${page + 1}; ending pagination.`);
          break;
        }
        htmlPageSignatures.add(signature);
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

    if (successfulListings === 0) {
      throw new Error('[eztv] No usable catalogue responses. Check mirror availability, blocking and page layout.');
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  private htmlListingSignature(html: string): string {
    const $ = cheerio.load(html);
    const identities: string[] = [];
    $('tr.forum_header_border').each((_, element) => {
      const row = $(element);
      const magnet = row.find('a.magnet').attr('href') || '';
      const detail = row.find('a.epinfo').attr('href') || '';
      identities.push(magnet || detail || cleanText(row.text()));
    });
    return identities.sort().join('|');
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

      let magnetLink: string | null = null;
      let parsedMagnet: ReturnType<typeof parseMagnetUri> = null;
      for (const element of row.find('a.magnet[href]').toArray()) {
        const href = $(element).attr('href') || '';
        const candidate = parseMagnetUri(href);
        if (!candidate?.infoHash) continue;
        magnetLink = href;
        parsedMagnet = candidate;
        break;
      }
      if (!magnetLink || !parsedMagnet?.infoHash || uniqueHashes.has(parsedMagnet.infoHash)) return;

      const title = cleanText(titleAnchor.attr('title') || titleAnchor.text());
      if (!title || isBlockedTitle(title)) return;

      let torrentLink: string | null = null;
      for (const element of row.find('a.download_1[href]').toArray()) {
        const resolved = this.resolveUrl($(element).attr('href'), activeDomain);
        if (resolved) {
          torrentLink = resolved;
          break;
        }
      }
      const meta = parseTorrentTitle(title, 'series');
      const langs = detectLanguages(title, ['eztv', 'tv']);

      // Mirrors reorder/shrink these columns, so they are located by content
      // instead of by a hard-coded index.
      const { sizeText, seedersText } = EztvCrawler.readRowCounters($, row);

      // Some mirrors link the show's IMDb page from the row; it is stored
      // when present so these releases can dedupe against the API rows.
      const imdbHref = row.find('a[href*="imdb.com/title/tt"]').first().attr('href') ?? '';
      const imdbMatch = imdbHref.match(/(tt\d{7,10})/i);

      const record = buildTorrentRecord({
        title,
        type: 'series',
        infoHash: parsedMagnet.infoHash,
        magnetUrl: magnetLink,
        torrentFileUrl: torrentLink,
        sourceUrl: this.resolveUrl(titleAnchor.attr('href') || '', activeDomain),
        trackers: parsedMagnet.trackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: parseSizeToBytes(sizeText),
        seeders: parseCount(seedersText),
        leechers: null,
        imdbId: imdbMatch ? imdbMatch[1].toLowerCase() : null,
        sourceTracker: parsedMagnet.trackers[0] ?? null
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

    const parsedApiMagnet = torrent.magnet_url ? parseMagnetUri(torrent.magnet_url) : null;
    const magnetMatchesHash = parsedApiMagnet?.infoHash === infoHash;
    const trackers = magnetMatchesHash ? parsedApiMagnet.trackers : [];
    // Keep only a published magnet that agrees with the API hash. If the API
    // omits one, build a DHT-capable magnet without fabricating tracker URLs.
    const magnetUrl = magnetMatchesHash
      ? torrent.magnet_url!.trim()
      : buildMagnetUri(infoHash, fullTitle, [], { includeDefaultTrackers: false });

    const torrentFileUrl = this.resolveUrl(torrent.torrent_url, activeDomain);
    const publishedEpisodeUrl = this.resolveUrl(torrent.episode_url, activeDomain);
    // Never emit a dangling `/ep/` when the API omits the id.
    const apiId = parseCount(torrent.id);
    const sourceUrl = publishedEpisodeUrl ?? (apiId !== null ? `${activeDomain}/ep/${apiId}` : null);

    return buildTorrentRecord({
      title: fullTitle,
      type: 'series',
      infoHash,
      magnetUrl,
      torrentFileUrl,
      sourceUrl,
      trackers,
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
      sourceTracker: trackers[0]
    });
  }
}

export default EztvCrawler;
