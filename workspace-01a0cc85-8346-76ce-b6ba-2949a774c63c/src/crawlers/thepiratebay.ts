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
  isBlockedTitle,
  parseCount,
  qualityOf
} from './support.js';

interface ApibayItem {
  id: string;
  name: string;
  info_hash: string;
  leechers: string | number;
  seeders: string | number;
  size: string | number;
  category: string | number;
  imdb?: string;
}

/**
 * The Pirate Bay: APiBay JSON (video categories only) plus HTML mirrors for
 * Spanish-oriented searches. Sentinel rows ("No results returned") and
 * non-video categories are ignored instead of being stored.
 */
export class ThePirateBayCrawler extends BaseCrawler {
  public readonly name = 'thepiratebay';
  public baseUrl = 'https://thepiratebay.org';

  private readonly apibayBase = process.env.APIBAY_BASE_URL || 'https://apibay.org';

  /** Known TPB front-ends; extend with THEPIRATEBAY_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://thepiratebay10.org',
    'https://tpb.party',
    'https://pirate-bays.net',
    'https://thehiddenbay.com',
    'https://thepiratebay0.org',
    'https://piratebay.live',
    'https://pirateproxy.live',
    'https://thepiratebay.zone',
    'https://tpb.skynetcloud.site'
  ];

  private readonly defaultTrackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce'
  ];

  private resolveUrl(target: string, base: string): string {
    return absoluteHttpUrl(target, base) ?? target;
  }

  private async getWorkingWebMirror(): Promise<string | null> {
    try {
      return await this.resolveMirror({
        envPrefix: 'THEPIRATEBAY',
        defaults: ThePirateBayCrawler.DEFAULT_MIRRORS,
        probes: [
          {
            path: '/search/test/1/99/200',
            label: 'búsqueda',
            timeoutMs: 7000,
            validate: htmlMarkerValidator(['searchResult'])
          }
        ],
        fallback: null
      });
    } catch (error) {
      this.log.warn(`No working web mirror: ${formatError(error)}`);
      return null;
    }
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting The Pirate Bay crawl (maxPages=${maxPages})...`);

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

    // ========================================================================
    // PHASE 1: APiBay JSON (top 100 per video category)
    // ========================================================================
    const apiEndpoints = [
      '/precompiled/data_top100_200.json', // Video (all)
      '/precompiled/data_top100_201.json', // Movies
      '/precompiled/data_top100_207.json', // HD movies
      '/precompiled/data_top100_205.json', // TV shows
      '/precompiled/data_top100_208.json'  // HD TV shows
    ];

    for (const endpoint of apiEndpoints) {
      if (this.deadline.expired) break;
      try {
        const apiUrl = `${this.apibayBase}${endpoint}`;
        this.log.debug(`Querying Apibay: ${apiUrl}`);
        const items = await this.fetchJson<ApibayItem[]>(apiUrl);
        if (!Array.isArray(items)) continue;
        this.metrics.add('listings');

        for (const item of items) {
          const record = this.mapApibayItem(item);
          if (record && !uniqueHashes.has(record.info_hash)) {
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
          }
        }
      } catch (error) {
        this.metrics.add('listingErrors');
        this.log.warn(`Apibay ${endpoint} failed: ${formatError(error)}`);
      }
    }

    // ========================================================================
    // PHASE 2: APiBay search endpoint (still JSON, no scraping required)
    // ========================================================================
    const searchTerms = (process.env.THEPIRATEBAY_SEARCH || 'spanish,castellano,latino')
      .split(/[,\s]+/)
      .map(term => term.trim())
      .filter(Boolean);

    for (const term of searchTerms) {
      if (this.deadline.expired) break;
      try {
        const items = await this.fetchJson<ApibayItem[]>(
          `${this.apibayBase}/q.php?q=${encodeURIComponent(term)}&cat=200`
        );
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const record = this.mapApibayItem(item);
          if (record && !uniqueHashes.has(record.info_hash)) {
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
          }
        }
      } catch (error) {
        this.log.debug(`Apibay search "${term}" failed: ${formatError(error)}`);
      }
    }

    // ========================================================================
    // PHASE 3: HTML mirrors (only if the JSON API did not cover the searches)
    // ========================================================================
    const workingMirror = await this.getWorkingWebMirror();
    if (!workingMirror) {
      this.log.warn('Skipping HTML phase: no reachable web mirror.');
    } else {
      this.baseUrl = workingMirror;
      for (const term of searchTerms) {
        for (let page = 0; page < maxPages; page++) {
          if (this.deadline.expired) break;
          const searchUrl = `${workingMirror}/search/${encodeURIComponent(term)}/${page}/99/200`;

          try {
            this.log.debug(`Scraping search term '${term}': ${searchUrl}`);
            const html = await this.fetchHtml(searchUrl);
            this.metrics.add('listings');
            const added = this.collectHtmlRows(html, workingMirror, uniqueHashes, results);

            if (!added) {
              this.log.debug(`No more results for '${term}' at page ${page}.`);
              break;
            }
          } catch (error) {
            this.metrics.add('listingErrors');
            this.log.warn(`Failed scraping ${searchUrl}: ${formatError(error)}`);
            break;
          }
        }
      }
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  private collectHtmlRows(
    html: string,
    mirror: string,
    uniqueHashes: Set<string>,
    sink: TorrentRecord[]
  ): number {
    const $ = cheerio.load(html);
    let added = 0;

    $('#searchResult tr:not(.header)').each((_, el) => {
      const row = $(el);
      const titleEl = row.find('.detName a, a.detLink');
      const magnetEl = row.find('a[href^="magnet:?xt="]');
      if (!titleEl.length || !magnetEl.length) return;

      const title = cleanText(titleEl.text());
      const magnetUrl = magnetEl.attr('href') || '';
      const parsedMagnet = parseMagnetUri(magnetUrl);
      if (!title || !parsedMagnet?.infoHash || isBlockedTitle(title)) return;
      if (uniqueHashes.has(parsedMagnet.infoHash)) return;

      const tds = row.find('td');
      const descText = row.find('font.detDesc').text();
      const sizeMatch = descText.match(/Size\s+([^,]+)/i);

      const meta = parseTorrentTitle(title, 'movie');
      const langs = detectLanguages(title, ['thepiratebay']);

      const seedersText = tds.length >= 2 ? tds.eq(tds.length - 2).text() : '';
      const leechersText = tds.length >= 1 ? tds.eq(tds.length - 1).text() : '';

      const record = buildTorrentRecord({
        title,
        type: meta.type,
        infoHash: parsedMagnet.infoHash,
        magnetUrl,
        sourceUrl: this.resolveUrl(titleEl.attr('href') || '', mirror),
        trackers: parsedMagnet.trackers.length ? parsedMagnet.trackers : this.defaultTrackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: sizeMatch ? parseSizeToBytes(cleanText(sizeMatch[1])) : null,
        seeders: parseCount(seedersText),
        leechers: parseCount(leechersText),
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

  public mapApibayItem(item: ApibayItem): TorrentRecord | null {
    if (!item?.info_hash || !/^[0-9a-fA-F]{40}$/.test(item.info_hash)) return null;
    if (item.name === 'No results returned') return null;

    const cleanTitle = cleanText(item.name);
    if (!cleanTitle || isBlockedTitle(cleanTitle)) return null;

    const infoHash = item.info_hash.toLowerCase();
    const category = Number(item.category);
    
    // APiBay incluye categorías no de video; solo mantenemos video (200-299)
    if (!Number.isFinite(category) || category < 200 || category >= 300) return null;
    if (/^0{40}$/.test(infoHash)) return null;

    const defaultType: ContentType = category === 205 || category === 208 ? 'series' : 'movie';
    const meta = parseTorrentTitle(cleanTitle, defaultType);
    const langs = detectLanguages(cleanTitle, ['thepiratebay']);

    let imdbId: string | null = null;
    if (item.imdb) {
      const rawImdb = String(item.imdb).trim().replace(/^tt/i, '');
      if (/^\d{1,10}$/.test(rawImdb) && parseInt(rawImdb, 10) > 0) {
        imdbId = `tt${rawImdb.padStart(7, '0')}`;
      }
    }

    const trackersQuery = this.defaultTrackers.map((t) => `tr=${encodeURIComponent(t)}`).join('&');
    const magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(cleanTitle)}&${trackersQuery}`;

    return buildTorrentRecord({
      title: cleanTitle,
      type: meta.type,
      infoHash,
      magnetUrl,
      trackers: this.defaultTrackers,
      sourceUrl: `${this.baseUrl}/description.php?id=${item.id}`,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes: parseCount(item.size),
      seeders: parseCount(item.seeders),
      leechers: parseCount(item.leechers),
      imdbId,
      sourceTracker: this.defaultTrackers[0]
    });
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Alias de retrocompatibilidad
export class DivxTotalCrawler extends ThePirateBayCrawler {}

export default ThePirateBayCrawler;
