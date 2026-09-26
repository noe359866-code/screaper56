import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, parseMagnetUri } from '../utils/magnet.js';
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
 * TorrentGalaxy: `.tgxtablerow` grids. The title comes from the release anchor
 * (never concatenated with the comments link) and the size is located by cell
 * content, because mirrors reorder columns.
 */
export class TorrentGalaxyCrawler extends BaseCrawler {
  public readonly name = 'torrentgalaxy';

  /** Known TGX front-ends; extend with TORRENTGALAXY_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://torrentgalaxy.to',
    'https://torrentgalaxy.one',
    'https://en.torrentgalaxy-official.is',
    'https://torrentgalaxy.buzz',
    'https://torrentgalaxy.su',
    'https://torrentgalaxy.mx',
    'https://tgx.rs',
    'https://tgx.sb',
    'https://torrentgalaxy.proxyninja.org'
  ];

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'TORRENTGALAXY',
      defaults: TorrentGalaxyCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/',
          label: 'portada',
          timeoutMs: 7000,
          validate: htmlMarkerValidator([/tgxtable/i, /href=["'][^"']*torrents\.php/i])
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting TorrentGalaxy crawl (maxPages=${maxPages})...`);

    const activeMirror = await this.getWorkingMirror();
    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

    const endpoints = [
      '/movies',
      '/torrents.php?search=spanish&sort=id&order=desc',
      '/torrents.php?search=latino&sort=id&order=desc',
      '/torrents.php?search=castellano&sort=id&order=desc',
      '/torrents.php?cat=41&sort=id&order=desc', // 4K movies
      '/torrents.php?cat=42&sort=id&order=desc', // HD movies
      '/torrents.php?cat=41&sort=id&order=desc&lang=3' // Spanish-tagged uploads
    ];

    for (const endpoint of endpoints) {
      this.log.debug(`Crawling endpoint: ${endpoint}`);

      for (let page = 0; page < maxPages; page++) {
        if (this.deadline.expired) break;

        const separator = endpoint.includes('?') ? '&' : '?';
        const fullUrl = `${activeMirror}${endpoint}${separator}page=${page}`;

        try {
          this.log.debug(`Fetching page ${page}: ${fullUrl}`);
          const html = await this.fetchHtml(fullUrl);
          this.metrics.add('listings');

          const records = this.parseTorrentGalaxyHtml(html, fullUrl, activeMirror);
          let added = 0;
          for (const record of records) {
            if (uniqueHashes.has(record.info_hash)) continue;
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
            added++;
          }
          this.log.debug(`Extracted ${added} new records from page ${page}.`);

          if (!records.length) {
            this.log.debug('No more records found. Moving to next endpoint.');
            break;
          }
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Failed fetching ${fullUrl}: ${describe(error)}. Skipping endpoint.`);
          break;
        }
      }
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  public parseTorrentGalaxyHtml(html: string, sourceUrl: string, activeMirror: string): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    // `.tgxtablerow` avoids picking up header/layout tables.
    $('.tgxtablerow').each((_, el) => {
      const row = $(el);

      // 1. Title and detail URL (comment anchors are excluded).
      const titleLink = row.find('a[href*="/torrent/"]:not([href*=".torrent"])').first();
      if (!titleLink.length) return;

      const title = cleanText(titleLink.attr('title') || titleLink.text());
      if (!title || isBlockedTitle(title)) return;

      const detailUrl = absoluteHttpUrl(titleLink.attr('href') || '', activeMirror);

      // 2. Magnet / infohash (falls back to the iTorrents hash in the file link).
      let magnetHref = row.find('a[href^="magnet:?xt="]').first().attr('href');
      let infoHash: string | null = null;

      if (magnetHref) {
        infoHash = parseMagnetUri(magnetHref)?.infoHash ?? null;
      } else {
        const itorrentLink = row.find('a[href*="/torrent/"][href$=".torrent"]').attr('href') || '';
        const hashMatch = itorrentLink.match(/torrent\/([0-9a-fA-F]{40})/i);
        if (hashMatch) {
          infoHash = hashMatch[1].toLowerCase();
          magnetHref = buildMagnetUri(infoHash, title);
        }
      }
      if (!infoHash || !magnetHref) return;

      // 3. Swarm counters (TGX colours them with <font> or classes).
      const seeders = parseCount(row.find('font[color="green"], span.seeders').first().text());
      const leechers = parseCount(row.find('font[color="#ff0000"], span.leechers').first().text());

      // 4. Size: badge first, then any cell that parses as a size.
      const badgeSize = parseSizeToBytes(cleanText(row.find('span.badge').first().text()));
      const cellSize = row.find('.tgxtablecell').toArray()
        .map(cell => parseSizeToBytes(cleanText($(cell).text())))
        .find(size => size !== null) ?? null;

      // 5. IMDb
      const imdbMatch = (row.find('a[href*="imdb.com/title/tt"]').attr('href') || '').match(/tt\d{7,8}/);

      const isSeries = /\bS\d{1,2}E\d+|\b\d{1,2}x\d{1,3}\b/i.test(title);
      const defaultType: ContentType = isSeries ? 'series' : 'movie';
      const meta = parseTorrentTitle(title, defaultType);
      // Search terms are discovery hints, not proof of a release's audio language.
      const langs = detectLanguages(title, ['tgx', 'torrentgalaxy']);

      const record = buildTorrentRecord({
        title,
        type: meta.type,
        infoHash,
        magnetUrl: magnetHref,
        // TGX redirects .torrent links to iTorrents; the magnet is the reliable source.
        torrentFileUrl: null,
        sourceUrl: detailUrl ?? sourceUrl,
        trackers: parseMagnetUri(magnetHref)?.trackers ?? [],
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes: badgeSize ?? cellSize,
        seeders,
        leechers,
        imdbId: imdbMatch ? imdbMatch[0] : null,
        sourceTracker: 'udp://tracker.opentrackr.org:1337/announce'
      });

      if (record) records.push(record);
    });

    return records;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default TorrentGalaxyCrawler;
