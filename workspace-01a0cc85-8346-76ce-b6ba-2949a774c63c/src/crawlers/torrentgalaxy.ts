import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { parseMagnetUri, buildMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

export class TorrentGalaxyCrawler extends BaseCrawler {
  public readonly name = 'torrentgalaxy';
  public readonly baseUrl = 'https://en.torrentgalaxy-official.is';
  
  // High-availability mirrors list with automatic fallback
  private readonly mirrors = [
    'https://torrentgalaxy.one',
    'https://en.torrentgalaxy-official.is',
    'https://torrentgalaxy.buzz',
    'https://torrentgalaxy.su'
  ];

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting advanced TorrentGalaxy crawl (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];

    const endpoints = [
      '/movies',
      '/torrents.php?search=spanish',
      '/torrents.php?search=latino',
      '/torrents.php?cat=41', // 4K Movies
      '/torrents.php?cat=42'  // HD Movies
    ];

    for (const endpoint of endpoints) {
      for (let page = 0; page < maxPages; page++) {
        const pageParam = page > 0 ? (endpoint.includes('?') ? `&page=${page}` : `?page=${page}`) : '';
        const targetPath = `${endpoint}${pageParam}`;

        const pageRecords = await this.crawlWithMirrorFailover(targetPath);
        results.push(...pageRecords);

        if (pageRecords.length === 0) break;
      }
    }

    console.log(`[${this.name}] Crawl completed. Total records retrieved: ${results.length}`);
    return results;
  }

  /**
   * Attempts to crawl the endpoint trying mirrors sequentially if blocked or down.
   */
  private async crawlWithMirrorFailover(path: string): Promise<TorrentRecord[]> {
    for (const mirror of this.mirrors) {
      const fullUrl = `${mirror}${path}`;
      try {
        console.log(`[${this.name}] Fetching: ${fullUrl}`);
        const resp = await this.httpClient.get<string>(fullUrl);
        const html = resp.data;

        if (!html || typeof html !== 'string') continue;

        const records = this.parseTorrentGalaxyHtml(html, fullUrl, mirror);
        if (records.length > 0) {
          console.log(`[${this.name}] Successfully extracted ${records.length} records from mirror ${mirror}`);
          return records;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Mirror ${mirror} failed: ${msg}. Switching to next mirror...`);
      }
    }

    return [];
  }

  private parseTorrentGalaxyHtml(html: string, sourceUrl: string, activeMirror: string): TorrentRecord[] {
    const $ = cheerio.load(html);
    const records: TorrentRecord[] = [];

    // Parse standard TGX table rows or cards
    $('.tgxtablerow, table tbody tr, div.panel').each((_, el) => {
      // Find title and link
      const titleLink = $(el).find('a[href^="/torrent/"], a[href*="itorrents.org"]');
      let title = '';
      let detailUrl = '';

      if (titleLink.length) {
        const href = titleLink.attr('href') || '';
        if (href.includes('title=')) {
          const match = href.match(/title=([^&]+)/);
          title = match ? decodeURIComponent(match[1]) : titleLink.text().trim();
        } else {
          title = titleLink.attr('title') || titleLink.text().trim();
        }
        detailUrl = href.startsWith('http') ? href : `${activeMirror}${href}`;
      }

      // Find Magnet link
      let magnetHref = $(el).find('a[href^="magnet:?xt="]').first().attr('href');
      let infoHash: string | null = null;

      if (magnetHref) {
        const parsed = parseMagnetUri(magnetHref);
        infoHash = parsed?.infoHash || null;
      } else {
        // Fallback: search for itorrents.org/torrent/<hash>.torrent
        const itorrentLink = $(el).find('a[href*="/torrent/"][href$=".torrent"]').attr('href') || '';
        const hashMatch = itorrentLink.match(/torrent\/([0-9a-fA-F]{40})/);
        if (hashMatch) {
          infoHash = hashMatch[1].toLowerCase();
          magnetHref = buildMagnetUri(infoHash, title);
        }
      }

      if (!infoHash || !magnetHref) return;

      const seedersText = $(el).find('span[title="Seeders"], font[color="green"], b:contains("Seeders")').text().trim();
      const leechersText = $(el).find('span[title="Leechers"], font[color="#ff0000"], b:contains("Leechers")').text().trim();
      const seeders = parseInt(seedersText.replace(/,/g, ''), 10) || 5;
      const leechers = parseInt(leechersText.replace(/,/g, ''), 10) || 1;

      const sizeText = $(el).find('span.badge, td:nth-child(8)').text().trim();
      const sizeBytes = parseSizeToBytes(sizeText);

      let imdbId: string | null = null;
      const imdbAnchor = $(el).find('a[href*="imdb.com/title/tt"]');
      if (imdbAnchor.length) {
        const match = (imdbAnchor.attr('href') || '').match(/tt\d{7,8}/);
        if (match) imdbId = match[0];
      }

      const isSeries = detailUrl.includes('cat=41') || /S\d{1,2}/i.test(title);
      const defaultType: ContentType = isSeries ? 'series' : 'movie';
      const parsedMeta = parseTorrentTitle(title, defaultType);
      const langs = detectLanguages(title, ['tgx', 'torrentgalaxy']);

      records.push({
        imdb_id: imdbId,
        tmdb_id: null,
        kitsu_id: null,
        anilist_id: null,
        mal_id: null,
        type: parsedMeta.type,
        season: parsedMeta.season,
        episode: parsedMeta.episode,
        absolute_episode: parsedMeta.absoluteEpisode,
        file_index: null,
        info_hash: infoHash,
        magnet_url: magnetHref,
        torrent_file_url: $(el).find('a[href$=".torrent"]').attr('href') || null,
        source_url: detailUrl || sourceUrl,
        title: title || parsedMeta.cleanTitle,
        release_group: parsedMeta.releaseGroup,
        quality: parsedMeta.quality,
        codec: parsedMeta.codec,
        hdr_format: parsedMeta.hdrFormat,
        audio: langs.audio,
        subtitles: langs.subtitles,
        channels: parsedMeta.channels,
        size_bytes: sizeBytes,
        seeders,
        leechers,
        source_tracker: 'udp://tracker.opentrackr.org:1337/announce'
      });
    });

    return records;
  }
}
