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
  DEFAULT_TRACKERS,
  isBlockedTitle,
  mapWithConcurrency,
  parseCount,
  qualityOf,
  sleep
} from './support.js';

interface LimeCandidate {
  title: string;
  detailUrl: string;
  sizeBytes?: number | null;
  seeders?: number | null;
  leeches?: number | null;
  type: ContentType;
}

/**
 * LimeTorrents: `table2` listings plus search. The age column is detected
 * dynamically so size/seeders/leechers never shift by one cell.
 */
export class LimeTorrentsCrawler extends BaseCrawler {
  public readonly name = 'limetorrents';
  public baseUrl: string;

  /** Known LimeTorrents domains; extend with LIMETORRENTS_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://limetorrent.store',
    'https://www.limetorrents.fun',
    'https://limetorrents.lol',
    'https://limetorrents.asia',
    'https://limetorrents.pro',
    'https://limetorrent.net',
    'https://limetorrents.cc',
    'https://www.limetorrents.to'
  ];

  private readonly detailConcurrency = Math.max(1, Number.parseInt(process.env.LIMETORRENTS_CONCURRENCY || '3', 10) || 3);

  constructor() {
    super();
    this.baseUrl = process.env.LIMETORRENTS_BASE_URL || LimeTorrentsCrawler.DEFAULT_MIRRORS[0];
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting crawl across catalogs and searches (maxPages=${maxPages})...`);

    const validate = htmlMarkerValidator([/class=["'][^"']*table2/]);
    const mirror = await this.resolveMirror({
      envPrefix: 'LIMETORRENTS',
      defaults: LimeTorrentsCrawler.DEFAULT_MIRRORS,
      probes: [
        { path: '/latest100', label: 'latest100', timeoutMs: 6000, validate },
        { path: '/top100', label: 'top100', timeoutMs: 6000, validate }
      ]
    });

    const candidateMap = new Map<string, LimeCandidate>();

    // 1. Catalogues
    const categories: Array<{ path: string; type: ContentType; paginated: boolean }> = [
      { path: '/latest100', type: 'movie', paginated: false },
      { path: '/top100', type: 'movie', paginated: false },
      { path: '/browse-torrents/Movies/', type: 'movie', paginated: true },
      { path: '/browse-torrents/TV-shows/', type: 'series', paginated: true },
      { path: '/browse-torrents/Anime/', type: 'anime', paginated: true }
    ];

    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        if (page > 1 && !cat.paginated) break;

        const listUrl = page > 1 ? `${mirror}${cat.path}${page}/` : `${mirror}${cat.path}`;
        try {
          this.log.debug(`Fetching catalog listing: ${listUrl}`);
          const html = await this.fetchHtml(listUrl);
          this.metrics.add('listings');
          this.collectRows(html, listUrl, mirror, cat.type, candidateMap);
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Failed fetching listing ${listUrl}: ${describe(error)}`);
          break;
        }
      }
    }

    // 2. Spanish-oriented searches (discovery only, never language evidence)
    const spanishQueries = (process.env.LIMETORRENTS_SEARCH || 'spanish,castellano,latino')
      .split(/[,\s]+/)
      .map(q => q.trim())
      .filter(Boolean);

    for (const query of spanishQueries) {
      if (this.deadline.expired) break;
      const html = await this.searchHtml(mirror, query);
      if (!html) continue;
      this.metrics.add('listings');
      this.collectRows(html, `${mirror}/search`, mirror, null, candidateMap);
    }

    this.log.info(`Discovered ${candidateMap.size} candidates. Extracting release details...`);

    const maxCandidates = Math.max(30, maxPages * 25);
    const candidates = [...candidateMap.values()].slice(0, maxCandidates);

    const records = await mapWithConcurrency(candidates, this.detailConcurrency, async item => {
      if (this.deadline.expired) return null;
      try {
        await sleep(100);
        const record = await this.parseLimeDetail(item, mirror);
        if (record) this.metrics.add('records');
        return record;
      } catch (error) {
        this.metrics.add('detailErrors');
        this.log.warn(`Error parsing ${item.detailUrl}: ${describe(error)}`);
        return null;
      }
    });

    const deduplicated = this.deduplicateRecords(records.filter((r): r is TorrentRecord => Boolean(r)));
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** POST search with a GET fallback: mirrors disagree on which one they expose. */
  private async searchHtml(mirror: string, query: string): Promise<string | null> {
    this.log.debug(`Querying search for "${query}"...`);
    try {
      const response = await this.httpClient.request<string>({
        method: 'POST',
        url: `${mirror}/search`,
        data: new URLSearchParams({ q: query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (typeof response.data === 'string' && response.data.includes('table2')) return response.data;
    } catch (error) {
      this.log.debug(`POST search failed for "${query}": ${describe(error)}`);
    }

    try {
      return await this.fetchHtml(`${mirror}/search/all/${encodeURIComponent(query)}/seeds/1/`);
    } catch (error) {
      this.metrics.add('listingErrors');
      this.log.warn(`Search error for "${query}": ${describe(error)}`);
      return null;
    }
  }

  /** Parses a `table2` grid; the age column is located by content, not by index. */
  private collectRows(
    html: string,
    sourceUrl: string,
    mirror: string,
    forcedType: ContentType | null,
    sink: Map<string, LimeCandidate>
  ): void {
    const $ = cheerio.load(html);

    $('table.table2 tr').each((index, tr) => {
      if (index === 0) return;
      const tds = $(tr).find('td');
      if (tds.length < 2) return;

      const nameAnchor = tds.eq(0).find('div.tt-name a, a').last();
      const href = nameAnchor.attr('href');
      const title = cleanText(nameAnchor.text());
      if (!href || !title || !href.endsWith('.html')) return;
      if (isBlockedTitle(title)) return;

      const fullUrl = absoluteHttpUrl(href, sourceUrl) ?? absoluteHttpUrl(href, mirror);
      if (!fullUrl || sink.has(fullUrl)) return;

      // Columns: name, age, size, seeds, leeches. Some mirrors omit age.
      const sizeIndex = tds.toArray().findIndex((td, position) =>
        position > 0 && /[KMGT]i?B/i.test($(td).text()) && parseSizeToBytes(cleanText($(td).text())) !== null
      );
      const sizeText = sizeIndex >= 0 ? cleanText(tds.eq(sizeIndex).text()) : '';
      const seedsText = sizeIndex >= 0 ? cleanText(tds.eq(sizeIndex + 1).text()) : '';
      const leechesText = sizeIndex >= 0 ? cleanText(tds.eq(sizeIndex + 2).text()) : '';

      sink.set(fullUrl, {
        title,
        detailUrl: fullUrl,
        sizeBytes: parseSizeToBytes(sizeText),
        seeders: parseCount(seedsText),
        leeches: parseCount(leechesText),
        type: forcedType ?? (/s\d{1,2}|season|temporada/i.test(title) ? 'series' : 'movie')
      });
    });
  }

  private async parseLimeDetail(item: LimeCandidate, mirror: string): Promise<TorrentRecord | null> {
    const html = await this.fetchHtml(item.detailUrl);
    this.metrics.add('details');
    const $ = cheerio.load(html);

    const effectiveTitle = cleanText($('h1').first().text()) || item.title;
    if (!effectiveTitle || isBlockedTitle(effectiveTitle)) return null;

    let infoHash: string | null = null;
    let magnetUri: string | null = null;
    let sizeBytes = item.sizeBytes ?? null;
    let seeders = item.seeders ?? null;
    let leechers = item.leeches ?? null;
    const trackers: string[] = [];

    const magnetHref = $('a[href^="magnet:?xt="]').first().attr('href');
    if (magnetHref) {
      magnetUri = magnetHref;
      const parsed = parseMagnetUri(magnetHref);
      if (parsed?.infoHash) {
        infoHash = parsed.infoHash;
        trackers.push(...parsed.trackers);
      }
    }

    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      const key = cleanText(tds.eq(0).text());
      const value = cleanText(tds.eq(1).text());

      if (/torrent hash/i.test(key) && !infoHash) {
        const hashMatch = value.match(/([0-9a-fA-F]{40})/);
        if (hashMatch) infoHash = hashMatch[1].toLowerCase();
      }
      if (/torrent size/i.test(key) && !sizeBytes) sizeBytes = parseSizeToBytes(value);
      if (/^(udp|https?):\/\//i.test(key) && !trackers.includes(key)) trackers.push(key);
    });

    if (seeders === null || leechers === null) {
      const text = $.root().text();
      if (seeders === null) seeders = parseCount(text.match(/Seeders?\s*:\s*([\d,.]+)/i)?.[1]);
      if (leechers === null) leechers = parseCount(text.match(/Leechers?\s*:\s*([\d,.]+)/i)?.[1]);
    }

    if (!infoHash) return null;
    if (!trackers.length) trackers.push(...DEFAULT_TRACKERS.slice(0, 3));

    const meta = parseTorrentTitle(effectiveTitle, item.type);
    const langs = detectLanguages(effectiveTitle, ['limetorrents']);

    return buildTorrentRecord({
      title: effectiveTitle,
      type: meta.type,
      infoHash,
      magnetUrl: magnetUri,
      sourceUrl: item.detailUrl,
      trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes,
      seeders,
      leechers,
      sourceTracker: trackers[0] ?? null
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default LimeTorrentsCrawler;
