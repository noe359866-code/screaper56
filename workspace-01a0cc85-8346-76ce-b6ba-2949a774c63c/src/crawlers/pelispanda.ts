import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import {
  buildTorrentRecord,
  cleanText,
  dedupeStrings,
  isBlockedTitle,
  mapWithConcurrency,
  qualityOf
} from './support.js';

interface PelispandaItemSummary {
  id?: number;
  slug: string;
  title?: string;
  type?: string;
}

interface PelispandaListResponse {
  [key: string]: PelispandaItemSummary[] | undefined;
}

interface PelispandaDownload {
  quality?: string;
  size?: string;
  subs?: number | boolean;
  download_type?: string;
  download_link?: string;
  language?: string;
}

interface PelispandaDetail {
  id?: number;
  slug?: string;
  title: string;
  year?: string | number;
  tmdb_id?: number | string;
  imdb?: string | number;
  type?: string;
  downloads?: PelispandaDownload[];
  seasons?: Array<{
    season_number: number;
    episodes: Array<{
      episode_number: number;
      downloads?: PelispandaDownload[];
    }>;
  }>;
}

type CategoryType = 'movie' | 'series' | 'anime';

/**
 * Pelispanda: WordPress `wpreact` JSON API (movies, series and anime).
 * Every download entry keeps its own quality/language, and swarm counters are
 * left as `null` because the API does not publish them.
 */
export class PelispandaCrawler extends BaseCrawler {
  public readonly name = 'pelispanda';
  public baseUrl = process.env.PELISPANDA_BASE_URL || 'https://pelispanda.org';

  /** Known Pelispanda domains; extend with PELISPANDA_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://pelispanda.org',
    'https://pelispanda.com',
    'https://www.pelispanda.org',
    'https://pelispanda.net',
    'https://pelispanda.tv'
  ];

  private readonly concurrency = Math.max(1, Number.parseInt(process.env.PELISPANDA_CONCURRENCY || '3', 10) || 3);

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting crawl across movies, series and animes (maxPages=${maxPages})...`);

    // Soft resolution: if no mirror validates we keep the configured domain and
    // let the per-category errors explain what happened.
    const mirror = await this.resolveMirror({
      envPrefix: 'PELISPANDA',
      defaults: PelispandaCrawler.DEFAULT_MIRRORS,
      fallback: this.baseUrl,
      probes: [
        {
          path: '/wp-json/wpreact/v1/movies?page=1',
          label: 'API wpreact',
          timeoutMs: 7000,
          validate: (data: unknown) => {
            if (Array.isArray(data)) return true;
            if (data && typeof data === 'object') {
              return Object.values(data as Record<string, unknown>).some(value => Array.isArray(value));
            }
            return false;
          }
        }
      ]
    });

    const results: TorrentRecord[] = [];
    const categories: Array<{ path: string; type: CategoryType }> = [
      { path: 'movies', type: 'movie' },
      { path: 'series', type: 'series' },
      { path: 'animes', type: 'anime' }
    ];

    for (const category of categories) {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) break;

        const listUrl = `${mirror}/wp-json/wpreact/v1/${category.path}?page=${page}`;
        try {
          const data = await this.fetchJson<PelispandaListResponse | PelispandaItemSummary[]>(listUrl);
          const items: PelispandaItemSummary[] = Array.isArray(data) ? data : (data?.[category.path] ?? []);

          if (!items.length) {
            this.log.debug(`No more items on ${category.path} page ${page}.`);
            break;
          }
          this.metrics.add('listings');
          this.log.debug(`Found ${items.length} items on ${category.path} page ${page}.`);

          const nested = await mapWithConcurrency(items, this.concurrency, async item => {
            if (!item?.slug || this.deadline.expired) return [];
            try {
              return await this.crawlDetail(category.type, item.slug, mirror);
            } catch (error) {
              this.metrics.add('detailErrors');
              this.log.warn(`Failed to fetch detail for "${item.slug}": ${describe(error)}`);
              return [];
            }
          });

          results.push(...nested.flat());
        } catch (error) {
          const status = (error as { response?: { status?: number } })?.response?.status;
          this.metrics.add('listingErrors');
          this.log.warn(`Error reading ${category.path} page ${page}: ${describe(error)}`);
          if (status === 404) break;
        }
      }
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  private async crawlDetail(categoryType: CategoryType, slug: string, mirror: string): Promise<TorrentRecord[]> {
    const routeType = categoryType === 'movie' ? 'movie' : categoryType === 'series' ? 'serie' : 'anime';
    const detailUrl = `${mirror}/wp-json/wpreact/v1/${routeType}/${slug}`;

    const detail = await this.fetchJson<PelispandaDetail>(detailUrl);
    if (!detail) return [];
    this.metrics.add('details');

    const records: TorrentRecord[] = [];
    const tmdbId = detail.tmdb_id ? Number(detail.tmdb_id) || null : null;
    const imdbId = detail.imdb && String(detail.imdb).startsWith('tt') ? String(detail.imdb) : null;

    // 1. Movies / direct downloads
    for (const download of detail.downloads ?? []) {
      const fallbackTitle = cleanText(`${detail.title} ${download.quality ?? ''}`);
      const record = this.buildRecord(download, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId);
      if (record) {
        records.push(record);
        this.metrics.add('records');
      }
    }

    // 2. Episodic content
    for (const season of detail.seasons ?? []) {
      for (const episode of season.episodes ?? []) {
        for (const download of episode.downloads ?? []) {
          const seasonStr = String(season.season_number).padStart(2, '0');
          const episodeStr = String(episode.episode_number).padStart(2, '0');
          const fallbackTitle = cleanText(`${detail.title} S${seasonStr}E${episodeStr} ${download.quality ?? ''}`);

          const record = this.buildRecord(
            download, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId,
            season.season_number, episode.episode_number
          );
          if (record) {
            records.push(record);
            this.metrics.add('records');
          }
        }
      }
    }

    return records;
  }

  private buildRecord(
    download: PelispandaDownload,
    sourceUrl: string,
    categoryType: CategoryType,
    fallbackTitle: string,
    tmdbId: number | null,
    imdbId: string | null,
    season?: number,
    episode?: number
  ): TorrentRecord | null {
    if (!download.download_link?.startsWith('magnet:?')) return null;

    const parsedMagnet = parseMagnetUri(download.download_link);
    if (!parsedMagnet?.infoHash) return null;

    const releaseTitle = cleanText(parsedMagnet.displayName || fallbackTitle);
    if (!releaseTitle || isBlockedTitle(releaseTitle)) return null;

    const meta = parseTorrentTitle(releaseTitle, categoryType);
    const hints = dedupeStrings([download.language ?? '', download.subs ? 'sub_es' : '', 'pelispanda']);
    const langs = detectLanguages(releaseTitle, hints);

    if (download.language) {
      if (/latino/i.test(download.language) && !langs.audio.includes('Spanish (Latino)')) {
        langs.audio.push('Spanish (Latino)');
      } else if (/castellano|español/i.test(download.language) && !langs.audio.includes('Spanish')) {
        langs.audio.push('Spanish');
      }
    }
    if (download.subs && !langs.subtitles.includes('Sub_ES')) langs.subtitles.push('Sub_ES');

    return buildTorrentRecord({
      title: releaseTitle,
      type: categoryType,
      infoHash: parsedMagnet.infoHash,
      magnetUrl: download.download_link,
      sourceUrl,
      trackers: parsedMagnet.trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      season: season ?? meta.season ?? null,
      episode: episode ?? meta.episode ?? null,
      quality: download.quality || qualityOf(meta),
      sizeBytes: download.size ? parseSizeToBytes(download.size) : null,
      // The API does not publish swarm counters.
      seeders: null,
      leechers: null,
      tmdbId,
      imdbId,
      sourceTracker: parsedMagnet.trackers[0] ?? null
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default PelispandaCrawler;
