import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

interface EztvApiTorrent {
  id: number;
  hash: string;
  filename: string;
  episode_url?: string;
  torrent_url?: string;
  magnet_url?: string;
  title: string;
  imdb_id?: string;
  season?: string | number;
  episode?: string | number;
  seeds?: number;
  peers?: number;
  size_bytes?: string | number;
}

export class EztvCrawler extends BaseCrawler {
  public readonly name = 'eztv';
  public readonly baseUrl = 'https://eztv1.xyz';
  private readonly fallbackMirrors = ['https://eztv.re', 'https://eztv.wf', 'https://eztv.tf'];

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting EZTV crawl (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];

    // Attempt API extraction first
    try {
      for (let page = 1; page <= maxPages; page++) {
        const apiUrl = `${this.baseUrl}/api/get-torrents?limit=80&page=${page}`;
        console.log(`[${this.name}] Querying EZTV API: ${apiUrl}`);

        const resp = await this.httpClient.get<any>(apiUrl);
        const torrents: EztvApiTorrent[] = resp.data?.torrents || [];

        if (!torrents || torrents.length === 0) break;

        for (const t of torrents) {
          const rec = this.mapApiTorrentToRecord(t);
          if (rec) results.push(rec);
        }
      }

      if (results.length > 0) {
        console.log(`[${this.name}] EZTV API yielded ${results.length} records.`);
        return results;
      }
    } catch (apiErr: unknown) {
      const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      console.warn(`[${this.name}] EZTV API failed (${msg}), falling back to HTML scraper...`);
    }

    // HTML Table Scraper Fallback
    try {
      for (let page = 0; page < maxPages; page++) {
        const pageUrl = page === 0 ? `${this.baseUrl}/home` : `${this.baseUrl}/page_${page}`;
        console.log(`[${this.name}] Scraping HTML: ${pageUrl}`);

        const resp = await this.httpClient.get<string>(pageUrl);
        const $ = cheerio.load(resp.data);

        $('tr.forum_header_border').each((_, el) => {
          const titleAnchor = $(el).find('a.epinfo');
          if (!titleAnchor.length) return;

          const title = titleAnchor.text().trim();
          const detailPath = titleAnchor.attr('href') || '';
          const detailUrl = detailPath.startsWith('http') ? detailPath : `${this.baseUrl}${detailPath}`;

          const magnetLink = $(el).find('a.magnet').attr('href');
          const torrentLink = $(el).find('a.download_1').attr('href') || null;

          if (!magnetLink) return;

          const parsedMagnet = parseMagnetUri(magnetLink);
          if (!parsedMagnet || !parsedMagnet.infoHash) return;

          const sizeText = $(el).find('td:nth-child(4)').text().trim();
          const seedsText = $(el).find('td:nth-child(6) font').text().trim();
          const seeders = parseInt(seedsText.replace(/,/g, ''), 10) || 0;

          const parsedMeta = parseTorrentTitle(title, 'series');
          const langs = detectLanguages(title, ['eztv', 'tv']);

          results.push({
            imdb_id: null,
            tmdb_id: null,
            kitsu_id: null,
            anilist_id: null,
            mal_id: null,
            type: 'series',
            season: parsedMeta.season,
            episode: parsedMeta.episode,
            absolute_episode: parsedMeta.absoluteEpisode,
            file_index: null,
            info_hash: parsedMagnet.infoHash,
            magnet_url: magnetLink,
            torrent_file_url: torrentLink,
            source_url: detailUrl,
            title,
            release_group: parsedMeta.releaseGroup,
            quality: parsedMeta.quality,
            codec: parsedMeta.codec,
            hdr_format: parsedMeta.hdrFormat,
            audio: langs.audio,
            subtitles: langs.subtitles,
            channels: parsedMeta.channels,
            size_bytes: parseSizeToBytes(sizeText),
            seeders,
            leechers: 0,
            source_tracker: parsedMagnet.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
          });
        });
      }
    } catch (htmlErr: unknown) {
      const msg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
      console.error(`[${this.name}] HTML fallback error: ${msg}`);
    }

    console.log(`[${this.name}] Crawl completed. Total records retrieved: ${results.length}`);
    return results;
  }

  private mapApiTorrentToRecord(t: EztvApiTorrent): TorrentRecord | null {
    if (!t.hash) return null;

    const fullTitle = t.filename || t.title;
    const parsedMeta = parseTorrentTitle(fullTitle, 'series');
    const langs = detectLanguages(fullTitle, ['eztv', 'tv']);

    // Standardize IMDB ID
    let imdbId: string | null = null;
    if (t.imdb_id) {
      const raw = String(t.imdb_id).trim();
      imdbId = raw.startsWith('tt') ? raw : `tt${raw.padStart(7, '0')}`;
    }

    const season = t.season ? parseInt(String(t.season), 10) : parsedMeta.season;
    const episode = t.episode ? parseInt(String(t.episode), 10) : parsedMeta.episode;
    const sizeBytes = t.size_bytes ? parseInt(String(t.size_bytes), 10) : null;

    const magnetUrl = t.magnet_url || (t.hash ? `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(fullTitle)}` : null);

    return {
      imdb_id: imdbId,
      tmdb_id: null,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: 'series',
      season: isNaN(Number(season)) ? null : Number(season),
      episode: isNaN(Number(episode)) ? null : Number(episode),
      absolute_episode: parsedMeta.absoluteEpisode,
      file_index: null,
      info_hash: t.hash.toLowerCase(),
      magnet_url: magnetUrl,
      torrent_file_url: t.torrent_url || null,
      source_url: t.episode_url || `${this.baseUrl}/ep/${t.id}`,
      title: fullTitle,
      release_group: parsedMeta.releaseGroup,
      quality: parsedMeta.quality,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: sizeBytes,
      seeders: t.seeds || 0,
      leechers: t.peers || 0,
      source_tracker: 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}
