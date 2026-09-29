import * as cheerio from 'cheerio';
import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  describeError,
  isBlockedTitle,
  nextPaginationLink,
  parseCount,
  qualityOf,
  sameSite
} from './support.js';

function sameSiteUrl(a: string, b: string): boolean {
  return sameSite(a, b);
}

/** Read a hash only from an iTorrents metainfo path, not arbitrary URL text. */
function itorrentHash(href: string, base: string): string | null {
  const absolute = absoluteHttpUrl(href, base);
  if (!absolute) return null;
  try {
    const pathname = new URL(absolute).pathname;
    return pathname.match(/\/torrent\/([0-9a-fA-F]{40})(?:\/[^/]+)?\.torrent$/i)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Only TG itself and the documented iTorrents file host may publish metainfo. */
function isTrustedMetainfoUrl(url: string, mirror: string): boolean {
  if (sameSiteUrl(url, mirror)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'itorrents.org';
  } catch {
    return false;
  }
}

/** True when an iTorrents-style link points at the very same infohash. */
function itorrentHashMatches(href: string, infoHash: string, base: string): boolean {
  return itorrentHash(href, base) === infoHash.toLowerCase();
}

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
    this.baseUrl = activeMirror;

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();
    let successfulListings = 0;

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

      // The bare endpoint IS the first page; every following page comes from
      // the pager the response publishes. Guessing `page=N` was hopeless here:
      // TGX mirrors disagree on whether numbering starts at 0 or at 1, so either
      // the second request repeated page 1 (endpoint aborted) or page 2 was
      // skipped entirely.
      let listUrl: string | null = `${activeMirror}${endpoint}`;
      const visited = new Set<string>();
      let previousPageSignature = '';

      for (let page = 1; listUrl && page <= maxPages; page++) {
        if (this.deadline.expired) break;
        if (visited.has(listUrl)) break;
        visited.add(listUrl);

        const fullUrl = listUrl;

        try {
          this.log.debug(`Fetching page ${page}: ${fullUrl}`);
          const html = await this.fetchHtml(
            fullUrl,
            { headers: { Referer: `${activeMirror}/` } },
            { rejectBlocked: true }
          );
          this.metrics.add('listings');
          successfulListings++;

          const records = this.parseTorrentGalaxyHtml(html, fullUrl, activeMirror);
          const signature = records.map(record => record.info_hash).sort().join('|');
          if (signature && signature === previousPageSignature) {
            this.log.debug(`Page ${page} repeated the previous result set for ${endpoint}; stopping pagination.`);
            break;
          }
          if (signature) previousPageSignature = signature;

          let added = 0;
          for (const record of records) {
            if (uniqueHashes.has(record.info_hash)) continue;
            uniqueHashes.add(record.info_hash);
            results.push(record);
            this.metrics.add('records');
            added++;
          }
          this.log.debug(`Extracted ${added} new records from page ${page}.`);

          // Global deduplication is separate from page exhaustion: a page can
          // repeat records from another endpoint and still publish new releases
          // on its own next page. Follow only a same-site published pager.
          const nextUrl = nextPaginationLink(html, fullUrl);
          listUrl = nextUrl && sameSiteUrl(nextUrl, activeMirror) ? nextUrl : null;
          if (!listUrl) break;
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Failed fetching ${fullUrl}: ${describeError(error)}. Skipping endpoint.`);
          break;
        }
      }
    }

    if (successfulListings === 0) {
      throw new Error(
        '[torrentgalaxy] No usable catalogue responses. Check mirror availability, blocking and page layout.'
      );
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  private torrentLink(href: string, mirror: string, expectedHash: string): string | null {
    const url = absoluteHttpUrl(href, mirror);
    if (!url || !isTrustedMetainfoUrl(url, mirror)) return null;

    try {
      const pathname = new URL(url).pathname;
      if (/\.torrent$/i.test(pathname)) {
        if (!sameSiteUrl(url, mirror) && !itorrentHashMatches(url, expectedHash, mirror)) return null;
        return url;
      }
      if (sameSiteUrl(url, mirror) && /\/download(?:\.php)?(?:$|\/)/i.test(pathname)) return url;
    } catch {
      return null;
    }
    return null;
  }

  public parseTorrentGalaxyHtml(html: string, sourceUrl: string, activeMirror: string): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    // `.tgxtablerow` avoids picking up header/layout tables.
    $('.tgxtablerow').each((_, el) => {
      const row = $(el);

      // 1. Title and detail URL (comment anchors are excluded).
      const titleLink = row.find(
        'a[href*="/torrent/"]:not([href*=".torrent"]):not([href*="#comments"]):not(.comments)'
      ).first();
      if (!titleLink.length) return;

      const title = cleanText(titleLink.attr('title') || titleLink.text());
      if (!title || isBlockedTitle(title)) return;

      const rawDetailUrl = absoluteHttpUrl(titleLink.attr('href') || '', activeMirror);
      const detailUrl = rawDetailUrl && sameSiteUrl(rawDetailUrl, activeMirror) ? rawDetailUrl : null;

      // 2. Magnet / infohash (falls back to the iTorrents hash in the file link).
      let magnetHref: string | undefined;
      let parsedMagnet: ReturnType<typeof parseMagnetUri> = null;
      for (const anchor of row.find('a[href]').toArray()) {
        const href = $(anchor).attr('href') ?? '';
        const candidate = parseMagnetUri(href);
        if (!candidate?.infoHash) continue;
        magnetHref = href;
        parsedMagnet = candidate;
        break;
      }
      let infoHash: string | null = null;

      // TG may publish the metainfo on its own mirror or on iTorrents. Only
      // accept its known host and a path carrying the exact release infohash.
      const itorrentHrefs = row
        .find('a[href*="/torrent/"][href*=".torrent"]')
        .toArray()
        .map(anchor => $(anchor).attr('href') || '')
        .filter(Boolean);
      let torrentFileUrl: string | null = null;

      if (parsedMagnet?.infoHash) {
        infoHash = parsedMagnet.infoHash;
        for (const href of itorrentHrefs) {
          if (!itorrentHashMatches(href, infoHash, activeMirror)) continue;
          torrentFileUrl = this.torrentLink(href, activeMirror, infoHash);
          if (torrentFileUrl) break;
        }
      } else {
        for (const href of itorrentHrefs) {
          const candidateHash = itorrentHash(href, activeMirror);
          if (!candidateHash) continue;
          const candidateUrl = absoluteHttpUrl(href, activeMirror);
          if (!candidateUrl || !this.torrentLink(href, activeMirror, candidateHash)) continue;
          infoHash = candidateHash;
          torrentFileUrl = candidateUrl;
          magnetHref = buildMagnetUri(infoHash, title, [], { includeDefaultTrackers: false });
          parsedMagnet = parseMagnetUri(magnetHref);
          break;
        }
      }

      if (!infoHash || !magnetHref) return;

      // 3. Swarm counters. TGX colours them with <font>, but newer templates
      //    use `td.tgxtablecell` with `seed`/`leech` classes or a `<b>` inside.
      let seeders = parseCount(
        row.find('[class*="seed"], font[color="green"], font[color="lime"], span.seeders, .seeders')
          .first().text()
      );
      let leechers = parseCount(
        row.find('[class*="leech"], font[color="#ff0000"], font[color="red"], span.leechers, .leechers')
          .first().text()
      );

      // When no class- or colour-based selector matched, the last two
      // pure-numeric cells of the row are the swarm counters (a comment count
      // may precede them, so only the final pair is trusted, and only when
      // BOTH counters are missing).
      if (seeders === null && leechers === null) {
        const numericCells = row.find('td, .tgxtablecell').toArray()
          .map(cell => cleanText($(cell).text()))
          .filter(text => parseCount(text) !== null);
        if (numericCells.length >= 2) {
          seeders = parseCount(numericCells[numericCells.length - 2]);
          leechers = parseCount(numericCells[numericCells.length - 1]);
        }
      }

      // 4. Size: badge first, then short-circuit evaluation on cells.
      let sizeBytes = parseSizeToBytes(cleanText(row.find('span.badge').first().text()));

      if (sizeBytes === null) {
        const cells = row.find('.tgxtablecell').toArray();
        for (const cell of cells) {
          const parsed = parseSizeToBytes(cleanText($(cell).text()));
          if (parsed !== null) {
            sizeBytes = parsed;
            break;
          }
        }
      }

      // 5. IMDb ID (up to 10 digits)
      const imdbMatch = (row.find('a[href*="imdb.com/title/tt"]').attr('href') || '').match(/tt\d{7,10}/);

      const isSeries = /\bS\d{1,2}E\d+|\b\d{1,2}x\d{1,3}\b/i.test(title);
      const defaultType: ContentType = isSeries ? 'series' : 'movie';
      const meta = parseTorrentTitle(title, defaultType);
      
      // Search terms are discovery hints, not proof of a release's audio language.
      const langs = detectLanguages(title, ['tgx', 'torrentgalaxy']);
      const safeSourceUrl = sameSiteUrl(sourceUrl, activeMirror) ? sourceUrl : null;

      const record = buildTorrentRecord({
        title,
        type: meta.type,
        infoHash,
        magnetUrl: magnetHref,
        // Only a metainfo link describing this very hash is stored.
        torrentFileUrl,
        sourceUrl: detailUrl ?? safeSourceUrl,
        trackers: parsedMagnet?.trackers ?? [],
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        quality: qualityOf(meta),
        sizeBytes,
        seeders,
        leechers,
        imdbId: imdbMatch ? imdbMatch[0] : null,
        // The tracker has to be one the release really announces: the previous
        // hard-coded value was written even for magnets that listed none.
        sourceTracker: parsedMagnet?.trackers[0] ?? null
      });

      if (record) records.push(record);
    });

    return records;
  }
}

export default TorrentGalaxyCrawler;
