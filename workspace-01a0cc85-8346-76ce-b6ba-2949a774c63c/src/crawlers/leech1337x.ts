import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';
import pLimit from 'p-limit';

interface ScrapedRow {
  detailUrl: string;
  title: string;
  seeders: number;
  leechers: number;
  sizeStr: string;
}

export class Leech1337xCrawler extends BaseCrawler {
  public readonly name = 'leech1337x';
  public readonly baseUrl = 'https://1337x.la'; // Primary active mirror for 1337x.tw network
  private readonly fallbackMirrors = ['https://www.1337x.tw', 'https://1337x.to', 'https://1337x.st'];

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting 1337x crawl (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(2);

    // Queries designed to discover both general trending and Spanish-specific releases
    const searchEndpoints = [
      '/sort-search/spanish/seeders/desc',
      '/sort-search/latino/seeders/desc',
      '/sort-search/castellano/seeders/desc',
      '/popular-movies',
      '/popular-tv'
    ];

    for (const endpoint of searchEndpoints) {
      for (let page = 1; page <= maxPages; page++) {
        const isSearch = endpoint.includes('sort-search');
        const url = isSearch ? `${this.baseUrl}${endpoint}/${page}/` : (page === 1 ? `${this.baseUrl}${endpoint}` : null);
        if (!url) break;

        try {
          console.log(`[${this.name}] Scraping listing: ${url}`);
          const response = await this.httpClient.get<string>(url);
          const $ = cheerio.load(response.data);

          const rows: ScrapedRow[] = [];
          $('table.table-list tbody tr, table tbody tr').each((_, el) => {
            const nameEl = $(el).find('td.name a[href^="/torrent/"]');
            if (!nameEl.length) return;

            const href = nameEl.attr('href') || '';
            const title = nameEl.text().trim();
            const seeders = parseInt($(el).find('td.seeds').text().trim(), 10) || 0;
            const leechers = parseInt($(el).find('td.leeches').text().trim(), 10) || 0;
            const sizeStr = $(el).find('td.size').clone().children().remove().end().text().trim();

            rows.push({
              detailUrl: href.startsWith('http') ? href : `${this.baseUrl}${href}`,
              title,
              seeders,
              leechers,
              sizeStr
            });
          });

          if (rows.length === 0) {
            console.log(`[${this.name}] No rows found on ${url}`);
            break;
          }

          console.log(`[${this.name}] Processing ${rows.length} torrent rows from ${url}...`);

          const detailTasks = rows.map(row => limit(async () => {
            try {
              return await this.crawlDetail(row);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[${this.name}] Failed to scrape detail for "${row.title}": ${msg}`);
              return null;
            }
          }));

          const records = await Promise.all(detailTasks);
          for (const rec of records) {
            if (rec) results.push(rec);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Failed loading listing ${url}: ${msg}`);
          break;
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total records retrieved: ${results.length}`);
    return results;
  }

  private async crawlDetail(row: ScrapedRow): Promise<TorrentRecord | null> {
    const response = await this.httpClient.get<string>(row.detailUrl);
    const $ = cheerio.load(response.data);

    // Extract Magnet Link
    const magnetHref = $('a[href^="magnet:?xt="]').first().attr('href');
    if (!magnetHref) return null;

    const parsedMagnet = parseMagnetUri(magnetHref);
    if (!parsedMagnet || !parsedMagnet.infoHash) return null;

    // Extract Infohash directly or verify
    const pageCategory = $('.torrent-category-detail strong:contains("Category")').next().text().trim().toLowerCase();
    const pageLanguage = $('.torrent-category-detail strong:contains("Language")').next().text().trim();

    let defaultType: ContentType = 'movie';
    if (pageCategory.includes('tv') || pageCategory.includes('television')) {
      defaultType = 'series';
    } else if (pageCategory.includes('anime')) {
      defaultType = 'anime';
    }

    const title = row.title || parsedMagnet.displayName || $('div.box-info-heading h1').text().trim();
    const parsedMeta = parseTorrentTitle(title, defaultType);
    const langs = detectLanguages(title, [pageLanguage, pageCategory]);

    // Check IMDB ID if present
    let imdbId: string | null = null;
    const imdbLink = $('a[href*="imdb.com/title/tt"]').attr('href');
    if (imdbLink) {
      const match = imdbLink.match(/tt\d{7,8}/);
      if (match) imdbId = match[0];
    }

    return {
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
      info_hash: parsedMagnet.infoHash,
      magnet_url: magnetHref,
      torrent_file_url: null,
      source_url: row.detailUrl,
      title,
      release_group: parsedMeta.releaseGroup,
      quality: parsedMeta.quality,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: parseSizeToBytes(row.sizeStr),
      seeders: row.seeders,
      leechers: row.leechers,
      source_tracker: parsedMagnet.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}
