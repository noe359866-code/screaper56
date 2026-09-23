import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { extractInfoHashFromTorrentBuffer } from '../utils/bencode.js';
import { buildMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
import pLimit from 'p-limit';

interface DivxTotalRow {
  title: string;
  detailUrl: string;
  category: string;
  dateStr: string;
  type: ContentType;
}

export class DivxTotalCrawler extends BaseCrawler {
  public readonly name = 'divxtotal';
  public readonly baseUrl = 'https://divxtotal.foo';

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting DivxTotal crawl (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(2);

    const sections: Array<{ path: string; type: ContentType }> = [
      { path: '/peliculas/', type: 'movie' },
      { path: '/peliculas-hd/', type: 'movie' },
      { path: '/series/', type: 'series' }
    ];

    for (const section of sections) {
      for (let page = 1; page <= maxPages; page++) {
        const pageUrl = page === 1 ? `${this.baseUrl}${section.path}` : `${this.baseUrl}${section.path}page/${page}/`;

        try {
          console.log(`[${this.name}] Scraping listing: ${pageUrl}`);
          const resp = await this.httpClient.get<string>(pageUrl);
          const $ = cheerio.load(resp.data);

          const rows: DivxTotalRow[] = [];
          $('table tr, .seccontcont tr').each((_, el) => {
            const link = $(el).find('a[href*="/peliculas/"], a[href*="/series/"]').first();
            if (!link.length) return;

            const href = link.attr('href') || '';
            const title = link.text().trim();
            const category = $(el).find('td:nth-child(2)').text().trim();
            const dateStr = $(el).find('td:nth-child(3)').text().trim();

            if (title && href && !href.endsWith('/peliculas/') && !href.endsWith('/series/')) {
              rows.push({
                title,
                detailUrl: href,
                category,
                dateStr,
                type: section.type
              });
            }
          });

          if (rows.length === 0) break;

          console.log(`[${this.name}] Found ${rows.length} items on ${pageUrl}. Fetching details and torrent hashes...`);

          const detailTasks = rows.map(row => limit(async () => {
            try {
              return await this.crawlDetail(row);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[${this.name}] Failed to process detail for "${row.title}": ${msg}`);
              return null;
            }
          }));

          const items = await Promise.all(detailTasks);
          for (const item of items) {
            if (item) results.push(item);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error reading ${pageUrl}: ${msg}`);
          break;
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total records retrieved: ${results.length}`);
    return results;
  }

  private async crawlDetail(row: DivxTotalRow): Promise<TorrentRecord | null> {
    const resp = await this.httpClient.get<string>(row.detailUrl);
    const $ = cheerio.load(resp.data);

    // Look for download link: download_tt.php?u=BASE64
    let torrentDownloadUrl: string | null = null;
    $('a[href*="download_tt.php?u="]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/[?&]u=([A-Za-z0-9+/=]+)/);
      if (match && match[1]) {
        try {
          const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
          if (decoded.startsWith('http')) {
            torrentDownloadUrl = decoded;
          }
        } catch {
          // ignore base64 decode failure
        }
      }
    });

    // Fallback: direct .torrent link
    if (!torrentDownloadUrl) {
      const direct = $('a[href$=".torrent"]').attr('href');
      if (direct) torrentDownloadUrl = direct.startsWith('http') ? direct : `${this.baseUrl}${direct}`;
    }

    if (!torrentDownloadUrl) {
      console.warn(`[${this.name}] No torrent download URL found on ${row.detailUrl}`);
      return null;
    }

    // Download the .torrent file buffer to extract exact SHA-1 info_hash
    const torrentBuf = await this.httpClient.getBuffer(torrentDownloadUrl);
    const infoHash = extractInfoHashFromTorrentBuffer(torrentBuf);
    if (!infoHash) {
      console.warn(`[${this.name}] Failed to compute SHA-1 infohash for ${torrentDownloadUrl}`);
      return null;
    }

    // Extract metadata fields from page text
    const pageText = $('body').text();
    const qualityMatch = pageText.match(/Calidad:\s*([^\n\r<]+)/i);
    const formatMatch = pageText.match(/Formato:\s*([^\n\r<]+)/i);
    const languageMatch = pageText.match(/Idioma:\s*([^\n\r<]+)/i);

    const quality = qualityMatch ? qualityMatch[1].trim() : null;
    const format = formatMatch ? formatMatch[1].trim() : null;
    const langStr = languageMatch ? languageMatch[1].trim() : 'Español';

    const parsedMeta = parseTorrentTitle(row.title, row.type);
    const langs = detectLanguages(row.title, [langStr, 'divxtotal', 'español']);

    // DivxTotal releases are natively in Spanish unless noted
    if (langs.audio.length === 0) {
      langs.audio.push('Spanish');
    }

    // Build standard magnet URL
    const magnetUrl = buildMagnetUri(infoHash, row.title);

    return {
      imdb_id: null,
      tmdb_id: null,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: row.type,
      season: parsedMeta.season,
      episode: parsedMeta.episode,
      absolute_episode: parsedMeta.absoluteEpisode,
      file_index: null,
      info_hash: infoHash,
      magnet_url: magnetUrl,
      torrent_file_url: torrentDownloadUrl,
      source_url: row.detailUrl,
      title: row.title,
      release_group: parsedMeta.releaseGroup,
      quality: quality || parsedMeta.quality,
      codec: format || parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: null,
      seeders: 15, // Default active seeders estimate for verified Spanish trackers
      leechers: 3,
      source_tracker: 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}
