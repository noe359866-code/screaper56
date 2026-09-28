import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, normalizeInfoHash } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  describeError,
  isBlockedTitle,
  parseCount,
  qualityOf,
  sameHost,
} from './support.js';

interface YtsApiTorrent {
  url?: string;
  hash: string;
  quality?: string;
  type?: string;
  is_repack?: string;
  video_codec?: string;
  bit_depth?: string | number;
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

const YTS_API_PAGE_SIZE = 50;

/**
 * YTS: official v2 JSON API. Language comes from the API `language` field, so a
 * French or Japanese release is never relabelled as English by the generic
 * fallback heuristics.
 */
/**
 * The API's own `language` field -> language hints. Region variants
 * (`es-ve`, `en-gb`, ...) used to fall through to "unknown", which dropped the
 * audio tag of perfectly well labelled releases.
 */
export function ytsLanguageHints(language: string): string[] {
  const native = cleanText(language).toLowerCase();
  if (!native) return [];
  if (native === 'spanish' || /^es(?:[-_]|$)/.test(native)) {
    return /^es[-_](?:mx|ar|419|co|ve|pe|cl|ec|uy|gt|cu|do|hn|ni|pa|bo|py|sv|cr)$/.test(native) ? ['latino'] : ['spanish'];
  }
  if (native === 'latino' || /^español\s+latino$/.test(native)) return ['latino'];
  if (native === 'english' || /^en(?:[-_]|$)/.test(native)) return ['english'];
  if (/^pt(?:[-_]|$)/.test(native)) return ['portuguese'];
  return [];
}

/** Resolve API-provided URLs only when they remain on the verified YTS mirror. */
function trustedYtsUrl(value: string | undefined, mirror: string): string | null {
  const resolved = absoluteHttpUrl(value, mirror);
  if (!resolved) return null;
  try {
    const candidate = new URL(resolved);
    const site = new URL(mirror);
    if (candidate.username || candidate.password || site.username || site.password) return null;
    return candidate.protocol === site.protocol && candidate.port === site.port && sameHost(resolved, mirror)
      ? resolved
      : null;
  } catch {
    return null;
  }
}

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
    let successfulListings = 0;

    // Popular + newest, plus explicit Spanish-language queries supported by the API.
    const queries = [
      'sort_by=download_count&order_by=desc',
      'sort_by=date_added&order_by=desc',
      'sort_by=date_added&order_by=desc&quality=2160p',
      'query_term=spanish&sort_by=date_added&order_by=desc'
    ];

    for (const query of queries) {
      const pageSignatures = new Set<string>();
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;
        const listUrl = `${activeDomain}/api/v2/list_movies.json?${query}&limit=${YTS_API_PAGE_SIZE}&page=${page}`;

        try {
          this.log.debug(`Fetching ${listUrl}`);
          const payload = await this.fetchJson<YtsApiResponse>(listUrl);
          if (payload?.status !== 'ok' || !payload.data) throw new Error('Invalid YTS API payload');

          const movies = payload.data.movies;
          if (!Array.isArray(movies)) {
            if (payload.data.movie_count === 0) {
              this.metrics.add('listings');
              successfulListings++;
              break;
            }
            throw new Error('Invalid YTS movies array');
          }
          this.metrics.add('listings');
          successfulListings++;

          if (!movies.length) {
            this.log.debug(`No more movies on page ${page}.`);
            break;
          }

          // Some mirrors ignore `page=`. Stop only when the raw movie/torrent
          // identities repeat; filtered rows or overlap must not hide later pages.
          const signatureParts = movies.map(movie => {
            if (!movie || typeof movie !== 'object') return String(movie);
            const torrentHashes = Array.isArray(movie.torrents)
              ? movie.torrents.map(torrent => normalizeInfoHash(torrent?.hash ?? '') ?? torrent?.hash ?? '').sort()
              : [];
            return JSON.stringify([
              movie.id ?? null,
              movie.slug ?? null,
              movie.url ?? null,
              movie.title ?? null,
              torrentHashes
            ]);
          }).sort();
          const pageSignature = signatureParts.join('|');
          if (pageSignatures.has(pageSignature)) {
            this.log.debug(`YTS repeated page ${page} for ${query}; ending that route.`);
            break;
          }
          pageSignatures.add(pageSignature);

          for (const movie of movies) {
            for (const record of this.mapMovie(movie, activeDomain)) {
              if (uniqueHashes.has(record.info_hash)) continue;
              uniqueHashes.add(record.info_hash);
              results.push(record);
              this.metrics.add('records');
            }
          }
          // Fewer than `limit` movies = last page; skip the empty follow-up request.
          if (movies.length < YTS_API_PAGE_SIZE) break;
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Error reading YTS page ${page} (${query}): ${describeError(error)}`);
          break;
        }
      }
    }

    if (successfulListings === 0) {
      throw new Error('[yts] No usable catalogue responses. Check mirror availability, blocking and API schema.');
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  /** One API movie -> one record per published quality. */
  public mapMovie(movie: YtsApiMovie, activeDomain: string): TorrentRecord[] {
    if (!movie || !Array.isArray(movie.torrents) || movie.torrents.length === 0) return [];

    const records: TorrentRecord[] = [];
    const nativeLanguage = cleanText(movie.language).toLowerCase();
    const langHints = ytsLanguageHints(nativeLanguage);

    let imdbId: string | null = null;
    if (movie.imdb_code) {
      const rawImdb = String(movie.imdb_code).trim().replace(/^tt/i, '');
      if (/^\d{1,10}$/.test(rawImdb) && parseInt(rawImdb, 10) > 0) {
        imdbId = `tt${rawImdb.padStart(7, '0')}`;
      }
    }

    const publishedSourceUrl = trustedYtsUrl(movie.url, activeDomain);
    const slug = typeof movie.slug === 'string' ? movie.slug.trim() : '';
    const slugSourceUrl = /^[a-z0-9-]+$/i.test(slug)
      ? `${activeDomain}/movies/${slug}`
      : null;
    const movieId = Number(movie.id);
    const idSourceUrl = Number.isSafeInteger(movieId) && movieId > 0
      ? `${activeDomain}/movie/${movieId}`
      : null;
    const sourceUrl = publishedSourceUrl ?? slugSourceUrl ?? idSourceUrl;

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

      // YTS publishes `url` as a root-relative path; resolve it only when it
      // remains on the verified mirror, never to an off-site download host.
      const torrentFileUrl = trustedYtsUrl(torrent.url, activeDomain);
      // The API provides a hash, not tracker URLs. Keep the generated magnet
      // tracker-free instead of inventing announce endpoints.
      const magnetUrl = buildMagnetUri(infoHash, torrentTitle, [], { includeDefaultTrackers: false });

      const record = buildTorrentRecord({
        title: torrentTitle,
        type: 'movie', // YTS is movies only.
        infoHash,
        magnetUrl,
        torrentFileUrl,
        sourceUrl,
        trackers: [],
        audio: audioLangs,
        subtitles: langs.subtitles,
        meta,
        season: null,
        episode: null,
        releaseGroup: 'YTS',
        quality: torrent.quality || qualityOf(meta),
        codec: [torrent.video_codec, String(torrent.bit_depth) === '10' ? '10-bit' : null]
          .filter(Boolean).join(' ') || meta.codec,
        channels: torrent.audio_channels || meta.channels,
        sizeBytes: parseCount(torrent.size_bytes),
        seeders: parseCount(torrent.seeds),
        leechers: parseCount(torrent.peers),
        imdbId,
        sourceTracker: null
      });

      if (record) records.push(record);
    }

    return records;
  }
}

export default YtsCrawler;
