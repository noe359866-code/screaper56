import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import {
  buildTorrentRecord,
  cleanText,
  dedupeStrings,
  describeError,
  isBlockedTitle,
  mapWithConcurrency,
  parseCount,
  qualityOf,
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
  subs?: number | boolean | string;
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
    season_number: number | string;
    episodes: Array<{
      episode_number: number | string;
      downloads?: PelispandaDownload[];
    }>;
  }>;
}

type CategoryType = 'movie' | 'series' | 'anime';

/**
 * True for links that really are a metainfo file. Magnets are handled by
 * `parseMagnetUri`; everything else (shorteners, HTML pages, ad hosts) is
 * rejected before a single byte is downloaded.
 */
export function isPelispandaTorrentLink(link: string, downloadType?: string): boolean {
  if (!/^https?:\/\//i.test(link)) return false;
  if (/\.torrent(?:[?#]|$)/i.test(link)) return true;
  // `download_type: torrent` alone is not enough: some entries advertise it
  // while linking an HTML landing page. Only an explicit metainfo path
  // (`/torrent/...`, `/download/...torrent`) is downloaded.
  if (typeof downloadType === 'string' && /torrent/i.test(downloadType)) {
    return /\/torrent(?:\/|s?\.|$)|\/download\//i.test(link);
  }
  return false;
}

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

    const mirror = await this.resolveMirror({
      envPrefix: 'PELISPANDA',
      defaults: PelispandaCrawler.DEFAULT_MIRRORS,
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
    const visitedSlugs = new Set<string>();

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
          const rawItems = Array.isArray(data) ? data : (data?.[category.path] ?? []);
          const items = Array.isArray(rawItems) ? rawItems : [];

          if (!items.length) {
            this.log.debug(`No more items on ${category.path} page ${page}.`);
            break;
          }

          this.metrics.add('listings');
          this.log.debug(`Found ${items.length} items on ${category.path} page ${page}.`);

          const unvisitedItems = items.filter(item => {
            if (!item?.slug) return false;
            const key = `${category.type}:${item.slug}`;
            if (visitedSlugs.has(key)) return false;
            visitedSlugs.add(key);
            return true;
          });

          // A page whose items were all already visited means the API is
          // repeating its last page: `continue` used to spin up to
          // `maxPages` requests for nothing.
          if (!unvisitedItems.length) break;

          const detailRecords = await mapWithConcurrency(unvisitedItems, this.concurrency, async item => {
            if (this.deadline.expired) return [];
            try {
              return await this.crawlDetail(category.type, item.slug, mirror);
            } catch (error) {
              this.metrics.add('detailErrors');
              this.log.warn(`Failed to fetch detail for "${item.slug}": ${describeError(error)}`);
              return [];
            }
          });

          for (const records of detailRecords) {
            if (records && records.length > 0) {
              results.push(...records);
            }
          }
        } catch (error) {
          const status = (error as { response?: { status?: number } })?.response?.status;
          this.metrics.add('listingErrors');
          this.log.warn(`Error reading ${category.path} page ${page}: ${describeError(error)}`);
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

    const tmdbId = detail.tmdb_id ? parseCount(detail.tmdb_id) : null;
    let imdbId: string | null = null;
    if (detail.imdb) {
      const rawImdb = String(detail.imdb).trim().replace(/^tt/i, '');
      if (/^\d{1,10}$/.test(rawImdb) && parseInt(rawImdb, 10) > 0) {
        imdbId = `tt${rawImdb.padStart(7, '0')}`;
      }
    }

    // 1. Películas / Descargas directas
    for (const download of detail.downloads ?? []) {
      const fallbackTitle = cleanText(`${detail.title} ${download.quality ?? ''}`);
      const record = await this.buildRecord(download, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId);
      if (record) {
        records.push(record);
        this.metrics.add('records');
      }
    }

    // 2. Contenido episódico (Series / Animes)
    for (const season of detail.seasons ?? []) {
      const seasonNum = parseCount(season.season_number);
      for (const episode of season.episodes ?? []) {
        const episodeNum = parseCount(episode.episode_number);
        const seasonStr = seasonNum !== null ? String(seasonNum).padStart(2, '0') : '01';
        const episodeStr = episodeNum !== null ? String(episodeNum).padStart(2, '0') : '01';

        for (const download of episode.downloads ?? []) {
          const fallbackTitle = cleanText(`${detail.title} S${seasonStr}E${episodeStr} ${download.quality ?? ''}`);

          const record = await this.buildRecord(
            download, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId,
            seasonNum ?? undefined, episodeNum ?? undefined
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

  private async buildRecord(
    download: PelispandaDownload,
    sourceUrl: string,
    categoryType: CategoryType,
    fallbackTitle: string,
    tmdbId: number | null,
    imdbId: string | null,
    season?: number,
    episode?: number
  ): Promise<TorrentRecord | null> {
    const rawLink = download.download_link?.trim();
    if (!rawLink) return null;

    const parsedMagnet = parseMagnetUri(rawLink);
    let infoHash = parsedMagnet?.infoHash ?? null;
    let torrentFileUrl: string | null = null;
    let metainfoName: string | null = null;
    let metainfoTrackers: string[] = [];
    let metainfoSize: number | null = null;

    if (!parsedMagnet) {
      // Not every entry publishes a magnet: some publish a `.torrent` file
      // instead. The metainfo is downloaded so the hash is the real one —
      // a guessed hash would break every cross-source dedupe.
      if (!isPelispandaTorrentLink(rawLink, download.download_type)) return null;
      try {
        const parsedTorrent = await this.fetchTorrentMetainfoViaGet(rawLink, sourceUrl);
        this.metrics.add('downloads');
        if (!parsedTorrent?.infoHash) return null;
        infoHash = parsedTorrent.infoHash;
        torrentFileUrl = rawLink;
        metainfoName = parsedTorrent.name ?? null;
        metainfoTrackers = parsedTorrent.trackers ?? [];
        metainfoSize = parsedTorrent.sizeBytes ?? null;
      } catch (error) {
        this.metrics.add('downloadErrors');
        this.log.debug(`Metainfo unavailable for ${rawLink}: ${describeError(error)}`);
        return null;
      }
    }

    if (!infoHash) return null;

    const releaseTitle = cleanText(parsedMagnet?.displayName || metainfoName || fallbackTitle);
    if (!releaseTitle || isBlockedTitle(releaseTitle)) return null;

    const meta = parseTorrentTitle(releaseTitle, categoryType);
    const hasSubs = pelispandaHasSubtitles(download.subs);
    const hints = dedupeStrings([download.language ?? '', hasSubs ? 'sub_es' : '', 'pelispanda']);
    const langs = detectLanguages(releaseTitle, hints);

    // The API's own `language` field is authoritative: a Latino download used to
    // end up tagged ['Spanish', 'Spanish (Latino)'] because the site hint added
    // the generic Spanish tag first.
    const audioLangs = [...langs.audio];
    const language = (download.language ?? '').trim();
    if (/latino/i.test(language)) {
      const index = audioLangs.indexOf('Spanish');
      if (index !== -1 && !/castellano|espa[ñn]ol/i.test(language)) audioLangs.splice(index, 1);
      if (!audioLangs.includes('Spanish (Latino)')) audioLangs.push('Spanish (Latino)');
    } else if (/castellano|espa[ñn]ol|spanish/i.test(language) && !audioLangs.includes('Spanish')) {
      audioLangs.push('Spanish');
    } else if (/ingl[eé]s|english/i.test(language) && !audioLangs.includes('English')) {
      audioLangs.push('English');
    }

    const subLangs = [...langs.subtitles];
    if (hasSubs && !subLangs.includes('Sub_ES')) {
      subLangs.push('Sub_ES');
    }

    return buildTorrentRecord({
      title: releaseTitle,
      type: categoryType,
      infoHash,
      magnetUrl: parsedMagnet ? rawLink : null,
      torrentFileUrl,
      sourceUrl,
      trackers: parsedMagnet?.trackers ?? metainfoTrackers,
      audio: audioLangs,
      subtitles: subLangs,
      meta,
      season: season ?? meta.season ?? null,
      episode: episode ?? meta.episode ?? null,
      quality: download.quality || qualityOf(meta),
      sizeBytes: (download.size ? parseSizeToBytes(download.size) : null) ?? metainfoSize,
      seeders: null,
      leechers: null,
      tmdbId,
      imdbId,
      sourceTracker: parsedMagnet?.trackers[0] ?? metainfoTrackers[0] ?? null
    });
  }
}

/**
 * `subs` arrives as a boolean, a count or a string depending on the endpoint
 * version; `'0'`, `'no'` and `'false'` must not be read as "has subtitles".
 */
export function pelispandaHasSubtitles(subs: PelispandaDownload['subs']): boolean {
  if (typeof subs === 'boolean') return subs;
  if (typeof subs === 'number') return Number.isFinite(subs) && subs > 0;
  if (typeof subs === 'string') {
    const value = subs.trim().toLowerCase();
    if (!value) return false;
    if (/^(no|false|0)$/.test(value)) return false;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? true : parsed > 0;
  }
  return false;
}

export default PelispandaCrawler;
