import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
import pLimit from 'p-limit';

interface YtsMovieItem {
  id: number;
  title: string;
  original_language?: string;
  release_date?: string;
  vote_average?: number;
}

interface YtsTorrentHit {
  title: string;
  seeds: number;
  peers: number;
  bytes: number;
  magnetUrl: string;
  hash: string;
  source: string;
}

export class YtsCrawler extends BaseCrawler {
  public readonly name = 'yts';
  public readonly baseUrl = 'https://en.yts-official.com';

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting YTS crawl (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(3);

    const discoveryModes = ['popular', 'trending'];

    for (const mode of discoveryModes) {
      for (let page = 1; page <= maxPages; page++) {
        try {
          const listUrl = `${this.baseUrl}/?api=${mode}&mode=movie&page=${page}`;
          console.log(`[${this.name}] Fetching movie catalog: ${listUrl}`);
          const resp = await this.httpClient.get<any>(listUrl);
          const movies: YtsMovieItem[] = resp.data?.results || [];

          if (!movies || movies.length === 0) break;

          console.log(`[${this.name}] Found ${movies.length} movies on ${mode} page ${page}. Querying torrent feeds...`);

          const movieTorrentTasks = movies.map(movie => limit(async () => {
            try {
              return await this.fetchTorrentsForMovie(movie);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[${this.name}] Failed fetching torrents for "${movie.title}": ${msg}`);
              return [];
            }
          }));

          const movieRecordsNested = await Promise.all(movieTorrentTasks);
          for (const records of movieRecordsNested) {
            results.push(...records);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error reading YTS ${mode} page ${page}: ${msg}`);
          break;
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total records retrieved: ${results.length}`);
    return results;
  }

  private async fetchTorrentsForMovie(movie: YtsMovieItem): Promise<TorrentRecord[]> {
    const year = movie.release_date ? movie.release_date.substring(0, 4) : '';
    const queryUrl = `${this.baseUrl}/?api=torrents&mode=movie&name=${encodeURIComponent(movie.title)}&year=${year}&quality=all`;

    const resp = await this.httpClient.get<any>(queryUrl);
    const hits: YtsTorrentHit[] = resp.data?.hits || [];
    if (!hits || hits.length === 0) return [];

    const records: TorrentRecord[] = [];

    for (const hit of hits) {
      if (!hit.magnetUrl) continue;

      const parsedMagnet = parseMagnetUri(hit.magnetUrl);
      const infoHash = hit.hash || parsedMagnet?.infoHash;
      if (!infoHash) continue;

      const parsedMeta = parseTorrentTitle(hit.title, 'movie');

      // Extra language hints based on original language of the movie
      const langHints = [hit.source || ''];
      if (movie.original_language === 'es') {
        langHints.push('spanish');
      }

      const langs = detectLanguages(hit.title, langHints);

      // If original language is Spanish and no audio detected yet, add Spanish
      if (movie.original_language === 'es' && langs.audio.length === 0) {
        langs.audio.push('Spanish');
      }

      records.push({
        imdb_id: null,
        tmdb_id: movie.id ? Number(movie.id) : null,
        kitsu_id: null,
        anilist_id: null,
        mal_id: null,
        type: 'movie',
        season: null,
        episode: null,
        absolute_episode: null,
        file_index: null,
        info_hash: infoHash.toLowerCase(),
        magnet_url: hit.magnetUrl,
        torrent_file_url: null,
        source_url: `${this.baseUrl}/movie/${movie.id}`,
        title: hit.title,
        release_group: parsedMeta.releaseGroup || hit.source,
        quality: parsedMeta.quality,
        codec: parsedMeta.codec,
        hdr_format: parsedMeta.hdrFormat,
        audio: langs.audio,
        subtitles: langs.subtitles,
        channels: parsedMeta.channels,
        size_bytes: hit.bytes || null,
        seeders: hit.seeds || 0,
        leechers: hit.peers || 0,
        source_tracker: parsedMagnet?.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
      });
    }

    return records;
  }
}
