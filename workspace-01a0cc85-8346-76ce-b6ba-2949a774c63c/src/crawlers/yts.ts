import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
import { buildTorrentRecord, cleanText, isBlockedTitle, qualityOf } from './support.js';

interface YtsApiTorrent {
  url?: string;
  hash: string;
  quality?: string;
  type?: string;
  is_repack?: string;
  video_codec?: string;
  bit_depth?: string;
  audio_channels?: string;
  seeds?: number;
  peers?: number;
  size_bytes?: number;
}

interface YtsApiMovie {
  id: number;
  url?: string;
  slug?: string;
  imdb_code?: string;
  title: string;
  title_english?: string;
  year?: number;
  rating?: number;
  language?: string;
  torrents?: YtsApiTorrent[];
}

interface YtsApiResponse {
  status?: string;
  data?: {
    movie_count?: number;
    movies?: YtsApiMovie[];
  };
}

/**
 * YTS: official v2 JSON API. Language comes from the API `language` field, so a
 * French or Japanese release is never relabelled as English by the generic
 * fallback heuristics.
 */
export class YtsCrawler extends BaseCrawler {
  public readonly name = 'yts';
  public baseUrl = process.env.YTS_BASE_URL || 'https://yts.mx';

  /** Known YTS domains; extend with YTS_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://yts.mx',
    'https://yts.do',
    'https://yts.rs',
    'https://yts.pm',
    'https://yts.lt',
    'https://yts.am',
    'https://yts.homes',
    'https://yts.nz'
  ];

  /** Trackers YTS ships in its own magnets. */
  private readonly defaultTrackers = [
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:80',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.leechers-paradise.org:6969/announce'
  ];

  private async getWorkingDomain(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'YTS',
      defaults: YtsCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/api/v2/list_movies.json?limit=1',
          label: 'API v2',
          timeoutMs: 6000,
          validate: (data: unknown) => {
            const payload = data as YtsApiResponse | undefined;
            if (!payload || typeof payload !== 'object') return false;
            if (payload.status !== 'ok' || !payload.data) return false;
            return Array.isArray(payload.data.movies) || payload.data.movie_count === 0;
          }
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting YTS crawl (maxPages=${maxPages})...`);

    const activeDomain = await this.getWorkingDomain();
    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

    // Popular + newest, plus an explicit Spanish-language query supported by the API.
    const queries = [
      'sort_by=download_count&order_by=desc',
      'sort_by=date_added&order_by=desc',
      'sort_by=date_added&order_by=desc&quality=2160p'
    ];

    for (const query of queries) {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        const listUrl = `${activeDomain}/api/v2/list_movies.json?${query}&limit=50&page=${page}`;

        try {
          this.log.debug(`Fetching ${listUrl}`);
          const payload = await this.fetchJson<YtsApiResponse>(listUrl);
          if (payload?.status !== 'ok' || !payload.data) throw new Error('Invalid YTS API payload');

          const movies = payload.data.movies ?? [];
          if (!Array.isArray(movies)) throw new Error('Invalid YTS movies array');
          this.metrics.add('listings');

          if (!movies.length) {
            this.log.debug(`No more movies on page ${page}.`);
            break;
          }

          for (const movie of movies) {
            for (const record of this.mapMovie(movie, activeDomain)) {
              if (uniqueHashes.has(record.info_hash)) continue;
              uniqueHashes.add(record.info_hash);
              results.push(record);
              this.metrics.add('records');
            }
          }
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Error reading YTS page ${page} (${query}): ${describe(error)}`);
          break;
        }
      }
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** One API movie -> one record per published quality. */
  public mapMovie(movie: YtsApiMovie, activeDomain: string): TorrentRecord[] {
    if (!movie?.torrents?.length) return [];

    const records: TorrentRecord[] = [];
    const nativeLanguage = (movie.language || '').toLowerCase();
    const langHints = nativeLanguage === 'es' || nativeLanguage === 'es-es'
      ? ['spanish']
      : /^es[-_](mx|ar|419)$/.test(nativeLanguage)
        ? ['latino']
        : nativeLanguage === 'en' ? ['english'] : [];

    for (const torrent of movie.torrents) {
      const baseTitle = cleanText(movie.title_english || movie.title);
      if (!baseTitle || isBlockedTitle(baseTitle)) continue;

      const torrentTitle = cleanText(
        `${baseTitle} ${movie.year ?? ''} ${torrent.quality ?? ''} ` +
        `${torrent.type === 'bluray' ? 'BluRay' : torrent.type ?? ''} YTS`
      );

      const meta = parseTorrentTitle(torrentTitle, 'movie');
      const langs = detectLanguages(torrentTitle, langHints);
      // Do not turn a French/Japanese API release into English by default.
      if (nativeLanguage && !langHints.length) langs.audio = [];

      const sourceUrl = movie.url
        || (movie.slug ? `${activeDomain}/movies/${movie.slug}` : `${activeDomain}/movie/${movie.id}`);

      const record = buildTorrentRecord({
        title: torrentTitle,
        type: 'movie', // YTS is movies only.
        infoHash: torrent.hash,
        torrentFileUrl: torrent.url || null,
        sourceUrl,
        trackers: this.defaultTrackers,
        audio: langs.audio,
        subtitles: langs.subtitles,
        meta,
        season: null,
        episode: null,
        releaseGroup: 'YTS',
        quality: torrent.quality || qualityOf(meta),
        codec: torrent.video_codec || meta.codec,
        channels: torrent.audio_channels || meta.channels,
        sizeBytes: torrent.size_bytes ?? null,
        seeders: torrent.seeds ?? null,
        leechers: torrent.peers ?? null,
        imdbId: movie.imdb_code && /^tt[0-9]{7,8}$/.test(movie.imdb_code) ? movie.imdb_code : null,
        sourceTracker: this.defaultTrackers[0]
      });

      if (record) records.push(record);
    }

    return records;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default YtsCrawler;
