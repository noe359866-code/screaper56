import * as cheerio from 'cheerio';
import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
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

/** Same verified front-end, allowing `www.` without crossing scheme or port. */
function sameSiteUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol && left.port === right.port && sameHost(a, b);
  } catch {
    return false;
  }
}

/**
 * The Pirate Bay: APiBay JSON (video categories only) plus HTML mirrors for
 * Spanish-oriented searches. Sentinel rows ("No results returned") and
 * non-video categories are ignored instead of being stored.
 */
export class ThePirateBayCrawler extends BaseCrawler {
  public readonly name = 'thepiratebay';

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

  /**
   * `thepiratebay.org` is intentionally not used as a default. This is merely
   * the first candidate in the pool; source links are emitted only after a
   * front-end passes the content probe.
   */
  public baseUrl = process.env.THEPIRATEBAY_BASE_URL || ThePirateBayCrawler.DEFAULT_MIRRORS[0];

  private readonly apibayBase = process.env.APIBAY_BASE_URL || 'https://apibay.org';

  /** Only publish constructed detail URLs after a mirror passed its content probe. */
  private webMirrorVerified = false;

  /**
   * Fichas HTML que se leen como máximo por ejecución. La fase HTML solo llega
   * aquí cuando el JSON no cubre el término, así que el presupuesto evita que
   * `maxPages` grande se convierta en cientos de peticiones de ficha.
   */
  private detailBudget = 0;

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
      rethrowIfBlockedOrRateLimited(error);
      this.log.warn(`No working web mirror: ${describeError(error)}`);
      return null;
    }
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting The Pirate Bay crawl (maxPages=${maxPages})...`);

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();
    let successfulListings = 0;
    this.webMirrorVerified = false;

    // ========================================================================
    // PHASE 0: resolve a live web front-end first. `source_url` is built from it
    // for every APiBay record, so it has to be a domain that actually answers.
    // ========================================================================
    const workingMirror = await this.getWorkingWebMirror();
    if (workingMirror) {
      this.baseUrl = workingMirror;
      this.webMirrorVerified = true;
    } else {
      this.log.warn('No reachable web mirror; APiBay records will not get a constructed source URL.');
    }

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
        successfulListings++;

        for (const item of items) {
          const record = this.mapApibayItem(item);
          if (record && !uniqueHashes.has(record.info_hash)) {
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
          }
        }
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('listingErrors');
        this.log.warn(`Apibay ${endpoint} failed: ${describeError(error)}`);
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
        this.metrics.add('listings');
        successfulListings++;
        for (const item of items) {
          const record = this.mapApibayItem(item);
          if (record && !uniqueHashes.has(record.info_hash)) {
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
          }
        }
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('listingErrors');
        this.log.debug(`Apibay search "${term}" failed: ${describeError(error)}`);
      }
    }

    // ========================================================================
    // PHASE 3: HTML mirrors (Spanish-oriented searches the JSON API cannot do)
    // ========================================================================
    if (!workingMirror) {
      this.log.warn('Skipping HTML phase: no reachable web mirror.');
    } else {
      this.detailBudget = Math.max(60, maxPages * 30);
      for (const term of searchTerms) {
        for (let page = 0; page < maxPages; page++) {
          if (this.deadline.expired) break;
          const searchUrl = `${workingMirror}/search/${encodeURIComponent(term)}/${page}/99/200`;

          try {
            this.log.debug(`Scraping search term '${term}': ${searchUrl}`);
            const html = await this.fetchHtml(searchUrl, {}, { rejectBlocked: true });
            this.metrics.add('listings');
            successfulListings++;
            const before = results.length;
            const { rows } = this.collectHtmlRows(html, workingMirror, uniqueHashes, results);

            // IMDb and the metainfo link live on the `/description.php?id=`
            // page, not on the listing row: they are read here so the HTML
            // phase stores the same fields the JSON phase already had.
            const pageRecords = results.slice(before);
            if (pageRecords.length) {
              await this.enrichFromDetails(pageRecords, workingMirror);
            }

            // Stop on an empty page, not on a page whose rows were already
            // known from APiBay: that used to end pagination after page 1.
            if (!rows) {
              this.log.debug(`No more results for '${term}' at page ${page}.`);
              break;
            }
          } catch (error) {
            rethrowIfBlockedOrRateLimited(error);
            this.metrics.add('listingErrors');
            this.log.warn(`Failed scraping ${searchUrl}: ${describeError(error)}`);
            break;
          }
        }
      }
    }

    if (successfulListings === 0) {
      throw new Error(
        '[thepiratebay] No usable responses from APiBay or the web mirror. Check connectivity, ' +
        'mirror availability and API response shape.'
      );
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
  ): { rows: number; added: number } {
    const $ = cheerio.load(html);
    let added = 0;
    let rows = 0;

    $('#searchResult tr:not(.header)').each((_, el) => {
      const row = $(el);
      const titleEl = row.find('.detName a, a.detLink').first();
      if (!titleEl.length) return;
      rows++;

      const title = cleanText(titleEl.text());
      const magnetUrl = row.find('a[href]').toArray()
        .map(anchor => $(anchor).attr('href') || '')
        .find(href => parseMagnetUri(href)?.infoHash) || '';
      const parsedMagnet = parseMagnetUri(magnetUrl);
      if (!title || !parsedMagnet?.infoHash || isBlockedTitle(title)) return;
      if (uniqueHashes.has(parsedMagnet.infoHash)) return;

      const tds = row.find('td');
      const descText = row.find('font.detDesc').text();
      const sizeMatch = descText.match(/Size\s+([^,]+)/i);

      // The first cell of a result row is the category link ("Movies",
      // "TV shows", "HD - Movies", ...): typing from it avoids labelling
      // every episode as a movie just because the parser defaulted to one.
      const categoryText = cleanText(tds.first().text());
      const meta = parseTorrentTitle(title, this.typeFromCategory(categoryText));
      const langs = detectLanguages(title, ['thepiratebay']);

      const seedersText = tds.length >= 2 ? tds.eq(tds.length - 2).text() : '';
      const leechersText = tds.length >= 1 ? tds.eq(tds.length - 1).text() : '';

      // Real metainfo link, when the template publishes one next to the
      // magnet (`/download/<id>/<name>.torrent` or a `.torrent` anchor).
      const torrentFileUrl = this.torrentLink(
        row.find('a[href$=".torrent"], a[href*="/download"]').first().attr('href'),
        mirror
      );
      const rawSourceUrl = absoluteHttpUrl(titleEl.attr('href') || '', mirror);
      const sourceUrl = rawSourceUrl && sameSiteUrl(rawSourceUrl, mirror) ? rawSourceUrl : null;

      const record = buildTorrentRecord({
        title,
        type: meta.type,
        infoHash: parsedMagnet.infoHash,
        magnetUrl,
        torrentFileUrl,
        sourceUrl,
        trackers: parsedMagnet.trackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: sizeMatch ? parseSizeToBytes(cleanText(sizeMatch[1])) : null,
        seeders: parseCount(seedersText),
        leechers: parseCount(leechersText),
        sourceTracker: parsedMagnet.trackers[0] ?? null
      });

      if (!record) return;
      uniqueHashes.add(record.info_hash);
      sink.push(record);
      this.metrics.add('records');
      added++;
    });

    return { rows, added };
  }

  /** Type advertised by a TPB category cell; `undefined` when it says nothing. */
  public typeFromCategory(category: string): ContentType | undefined {
    if (!category) return undefined;
    if (/\b(?:tv|series|shows?|episode|temporada|cap[ií]tulo)\b/i.test(category)) return 'series';
    if (/anime/i.test(category)) return 'anime';
    if (/document(?:al|ary|ales|aries)/i.test(category)) return 'documentary';
    if (/movies?|peliculas?|films?/i.test(category)) return 'movie';
    return undefined;
  }

  /** Keeps only same-host links that really point at a metainfo file. */
  private torrentLink(href: string | undefined, mirror: string): string | null {
    if (!href) return null;
    const url = absoluteHttpUrl(href, mirror);
    if (!url || !sameSiteUrl(url, mirror)) return null;
    try {
      const { pathname } = new URL(url);
      if (/\.torrent$/i.test(pathname) || /\/download(?:\.php)?(?:$|\/|\?)/i.test(pathname)) return url;
    } catch {
      return null;
    }
    return null;
  }

  /** `/description.php?id=` -> IMDb id and metainfo link published there. */
  public parseDetail(html: string, sourceUrl: string): {
    imdbId: string | null;
    torrentFileUrl: string | null;
  } {
    const $ = cheerio.load(html);
    const imdbMatch = html.match(/imdb\.com\/title\/(tt\d{7,10})/i);
    const imdbId = imdbMatch ? imdbMatch[1].toLowerCase() : null;

    const href = $('a[href*="imdb.com/title/tt"]').first().attr('href');
    const fromAnchor = href?.match(/(tt\d{7,10})/i)?.[1]?.toLowerCase() ?? null;

    const torrentFileUrl = this.torrentLink(
      $('a[href$=".torrent"], a[href*="/download"]').first().attr('href'),
      sourceUrl
    );

    return { imdbId: imdbId ?? fromAnchor, torrentFileUrl };
  }

  /**
   * Fills `imdb_id` / `torrent_file_url` on the records of the HTML phase.
   * Bounded by the runtime deadline: a detail that fails is skipped instead of
   * being turned into a fabricated value.
   */
  private async enrichFromDetails(records: TorrentRecord[], mirror: string): Promise<void> {
    const limit = Math.max(
      1,
      Number.parseInt(process.env.THEPIRATEBAY_DETAIL_CONCURRENCY || '3', 10) || 3
    );

    await mapWithConcurrency(records, limit, async record => {
      if (this.deadline.expired || this.detailBudget <= 0) return null;
      if (!record.source_url) return null;
      this.detailBudget--;
      try {
        const html = await this.fetchHtml(record.source_url, { headers: { Referer: `${mirror}/` } });
        this.metrics.add('details');
        const detail = this.parseDetail(html, record.source_url);
        if (detail.imdbId && !record.imdb_id) record.imdb_id = detail.imdbId;
        if (detail.torrentFileUrl && !record.torrent_file_url) {
          record.torrent_file_url = detail.torrentFileUrl;
        }
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('detailErrors');
        this.log.debug(`Detail unavailable for ${record.source_url}: ${describeError(error)}`);
      }
      return null;
    });
  }

  public mapApibayItem(item: ApibayItem): TorrentRecord | null {
    if (!item?.info_hash || !/^[0-9a-fA-F]{40}$/.test(item.info_hash)) return null;
    // APiBay answers "no hits" with a sentinel row, not an empty array.
    if (typeof item.name !== 'string' || /^no results returned$/i.test(item.name.trim())) return null;

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

    // The API supplies a hash, not a tracker's announce URL. Keep the magnet
    // valid without fabricating tracker metadata or a source page on an
    // unverified front-end.
    const magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(cleanTitle)}`;
    const itemId = String(item.id ?? '').trim();
    const sourceUrl = this.webMirrorVerified && /^[1-9]\d{0,19}$/.test(itemId)
      ? `${this.baseUrl.replace(/\/+$/, '')}/description.php?id=${encodeURIComponent(itemId)}`
      : null;

    return buildTorrentRecord({
      title: cleanTitle,
      type: meta.type,
      infoHash,
      magnetUrl,
      trackers: [],
      sourceUrl,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes: parseCount(item.size),
      seeders: parseCount(item.seeders),
      leechers: parseCount(item.leechers),
      imdbId,
      sourceTracker: null
    });
  }
}

export default ThePirateBayCrawler;
