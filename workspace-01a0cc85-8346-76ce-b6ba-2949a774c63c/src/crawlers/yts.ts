import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { normalizeInfoHash } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
import { buildTorrentRecord, cleanText, isBlockedTitle, parseCount, qualityOf } from './support.js';

interface YtsApiTorrent {
  url?: string;
  hash: string;
  quality?: string;
  type?: string;
  is_repack?: string;
  video_codec?: string;
  bit_depth?: string;
  audio_channels?: string;
  seeds?: number | string;
  peers?: number | string;
  size_bytes?: number | string;
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
    this.baseUrl = activeDomain;

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

    // Popular + newest, plus explicit Spanish-language queries supported by the API.
    const queries = [
      'sort_by=download_count&order_by=desc',
      'sort_by=date_added&order_by=desc',
      'sort_by=date_added&order_by=desc&quality=2160p',
      'query_term=spanish&sort_by=date_added&order_by=desc'
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
          this.log.warn(`Error reading YTS page ${page} (${query}): ${formatError(error)}`);
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
    const nativeLanguage = (movie.language || '').toLowerCase().trim();
    const langHints = nativeLanguage === 'es' || nativeLanguage === 'es-es' || nativeLanguage === 'spanish'
      ? ['spanish']
      : /^es[-_](mx|ar|419)$/.test(nativeLanguage) || nativeLanguage === 'latino'
        ? ['latino']
        : nativeLanguage === 'en' || nativeLanguage === 'english' ? ['english'] : [];

    let imdbId: string | null = null;
    if (movie.imdb_code) {
      const rawImdb = String(movie.imdb_code).trim().replace(/^tt/i, '');
      if (/^\d{1,10}$/.test(rawImdb) && parseInt(rawImdb, 10) > 0) {
        imdbId = `tt${rawImdb.padStart(7, '0')}`;
      }
    }

    const sourceUrl = movie.url
      || (movie.slug ? `${activeDomain}/movies/${movie.slug}` : `${activeDomain}/movie/${movie.id}`);

    const baseTitle = cleanText(movie.title_english || movie.title);

    for (const torrent of movie.torrents) {
      if (!torrent?.hash) continue;

      const infoHash = normalizeInfoHash(torrent.hash);
      if (!infoHash) continue;

      if (!baseTitle || isBlockedTitle(baseTitle)) continue;

      const torrentTitle = cleanText(
        `${baseTitle} ${movie.year ?? ''} ${torrent.quality ?? ''} ` +
        `${torrent.type === 'bluray' ? 'BluRay' : torrent.type ?? ''} YTS`
      );

      const meta = parseTorrentTitle(torrentTitle, 'movie');
      const langs = detectLanguages(torrentTitle, langHints);
      
      const audioLangs = [...langs.audio];
      // Do not turn a French/Japanese API release into English by default.
      if (nativeLanguage && !langHints.length) {
        audioLangs.length = 0;
      }

      const trackersQuery = this.defaultTrackers.map((t) => `tr=${encodeURIComponent(t)}`).join('&');
      const magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(torrentTitle)}&${trackersQuery}`;

      const record = buildTorrentRecord({
        title: torrentTitle,
        type: 'movie', // YTS is movies only.
        infoHash,
        magnetUrl,
        torrentFileUrl: torrent.url || null,
        sourceUrl,
        trackers: this.defaultTrackers,
        audio: audioLangs,
        subtitles: langs.subtitles,
        meta,
        season: null,
        episode: null,
        releaseGroup: 'YTS',
        quality: torrent.quality || qualityOf(meta),
        codec: torrent.video_codec || meta.codec,
        channels: torrent.audio_channels || meta.channels,
        sizeBytes: parseCount(torrent.size_bytes),
        seeders: parseCount(torrent.seeds),
        leechers: parseCount(torrent.peers),
        imdbId,
        sourceTracker: this.defaultTrackers[0]
      });

      if (record) records.push(record);
    }

    return records;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default YtsCrawler;
