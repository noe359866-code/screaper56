import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
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
  sameSiteHttpUrl as sharedSameSiteHttpUrl
} from './support.js';

interface PelispandaItemSummary {
  id?: number;
  slug: string;
  title?: string;
  type?: string;
}

/** Extract the list shape served by the API, distinguishing an empty list from a changed/error response. */
function pelispandaListItems(data: unknown, category: string): PelispandaItemSummary[] | null {
  let rawItems: unknown;
  if (Array.isArray(data)) {
    rawItems = data;
  } else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[category])) {
    rawItems = (data as Record<string, unknown>)[category];
  } else {
    return null;
  }

  const items = (rawItems as unknown[]).filter((item): item is PelispandaItemSummary =>
    Boolean(item && typeof item === 'object' && typeof (item as { slug?: unknown }).slug === 'string' &&
      (item as { slug: string }).slug.trim())
  );
  return (rawItems as unknown[]).length > 0 && items.length === 0 ? null : items;
}

/** Accept a metainfo URL only when it remains on the verified mirror site. */
function sameSiteHttpUrl(value: string, base: string): string | null {
  return sharedSameSiteHttpUrl(value, base);
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

  /** Parallel metainfo downloads inside ONE ficha (`PELISPANDA_DOWNLOAD_CONCURRENCY`). */
  private readonly downloadConcurrency = Math.max(
    1,
    Number.parseInt(process.env.PELISPANDA_DOWNLOAD_CONCURRENCY || '3', 10) || 3
  );

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
          validate: (data: unknown) => pelispandaListItems(data, 'movies') !== null
        }
      ]
    });

    const results: TorrentRecord[] = [];
    const visitedSlugs = new Set<string>();
    let successfulListings = 0;

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
          const data = await this.fetchJson<unknown>(listUrl);
          const items = pelispandaListItems(data, category.path);
          if (!items) throw new Error(`Unexpected ${category.path} catalogue response shape`);
          successfulListings++;
          this.metrics.add('listings');

          if (!items.length) {
            this.log.debug(`No more items on ${category.path} page ${page}.`);
            break;
          }

          this.log.debug(`Found ${items.length} items on ${category.path} page ${page}.`);

          const unvisitedItems: PelispandaItemSummary[] = [];
          for (const item of items) {
            const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
            if (!slug) continue;
            const key = `${category.type}:${slug}`;
            if (visitedSlugs.has(key)) continue;
            visitedSlugs.add(key);
            unvisitedItems.push({ ...item, slug });
          }

          // A page whose items were all already visited means the API is
          // repeating its last page: `continue` used to spin up to
          // `maxPages` requests for nothing.
          if (!unvisitedItems.length) break;

          const detailRecords = await mapWithConcurrency(unvisitedItems, this.concurrency, async item => {
            if (this.deadline.expired) return [];
            try {
              return await this.crawlDetail(category.type, item.slug, mirror);
            } catch (error) {
              rethrowIfBlockedOrRateLimited(error);
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
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Error reading ${category.path} page ${page}: ${describeError(error)}`);
          break;
        }
      }
    }

    if (successfulListings === 0) {
      throw new Error('[pelispanda] No usable catalogue responses. Check mirror availability, blocking and API layout.');
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  private async crawlDetail(categoryType: CategoryType, slug: string, mirror: string): Promise<TorrentRecord[]> {
    const routeType = categoryType === 'movie' ? 'movie' : categoryType === 'series' ? 'serie' : 'anime';
    const detailUrl = `${mirror}/wp-json/wpreact/v1/${routeType}/${encodeURIComponent(slug)}`;

    const rawDetail = await this.fetchJson<unknown>(detailUrl);
    if (!rawDetail || typeof rawDetail !== 'object' || Array.isArray(rawDetail)) {
      throw new Error(`Unexpected ${routeType} detail response shape for ${slug}`);
    }
    const detail = rawDetail as PelispandaDetail;
    if (typeof detail.title !== 'string' && !Array.isArray(detail.downloads) && !Array.isArray(detail.seasons)) {
      throw new Error(`Unexpected ${routeType} detail response shape for ${slug}`);
    }
    this.metrics.add('details');
    const detailTitle = cleanText(detail.title) || cleanText(detail.slug) || cleanText(slug);

    // Every download of the ficha is collected first and resolved with bounded
    // parallelism below: a season with dozens of `.torrent` entries used to be
    // downloaded strictly one after another.
    const tasks: Array<() => Promise<TorrentRecord | null>> = [];

    const tmdbId = detail.tmdb_id ? parseCount(detail.tmdb_id) : null;
    let imdbId: string | null = null;
    if (detail.imdb) {
      const rawImdb = String(detail.imdb).trim().replace(/^tt/i, '');
      if (/^\d{1,10}$/.test(rawImdb) && parseInt(rawImdb, 10) > 0) {
        imdbId = `tt${rawImdb.padStart(7, '0')}`;
      }
    }

    // 1. Películas / Descargas directas
    for (const download of Array.isArray(detail.downloads) ? detail.downloads : []) {
      if (!download || typeof download !== 'object') continue;
      const fallbackTitle = cleanText(`${detailTitle} ${download.quality ?? ''}`);
      tasks.push(() => this.buildRecord(download, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId));
    }

    // 2. Contenido episódico (Series / Animes)
    for (const season of Array.isArray(detail.seasons) ? detail.seasons : []) {
      if (!season || typeof season !== 'object') continue;
      const seasonNum = parseCount(season.season_number);
      for (const episode of Array.isArray(season.episodes) ? season.episodes : []) {
        if (!episode || typeof episode !== 'object') continue;
        const episodeNum = parseCount(episode.episode_number);
        // Keep absent numbering absent: defaulting missing values to S01E01
        // caused unrelated episodes to collide on the same release metadata.
        const seasonLabel = seasonNum !== null ? `S${String(seasonNum).padStart(2, '0')}` : '';
        const episodeLabel = episodeNum !== null ? `E${String(episodeNum).padStart(2, '0')}` : '';
        const episodeTag = seasonLabel || episodeLabel ? `${seasonLabel}${episodeLabel}` : '';

        for (const download of Array.isArray(episode.downloads) ? episode.downloads : []) {
          if (!download || typeof download !== 'object') continue;
          const fallbackTitle = cleanText(`${detailTitle} ${episodeTag} ${download.quality ?? ''}`);
          tasks.push(() => this.buildRecord(
            download, detailUrl, categoryType, fallbackTitle, tmdbId, imdbId,
            seasonNum ?? undefined, episodeNum ?? undefined
          ));
        }
      }
    }

    const built = await mapWithConcurrency(tasks, this.downloadConcurrency, async task => {
      if (this.deadline.expired) return null;
      return task();
    });

    const records: TorrentRecord[] = [];
    for (const record of built) {
      if (!record) continue;
      records.push(record);
      this.metrics.add('records');
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
    const rawLink = typeof download.download_link === 'string' ? download.download_link.trim() : '';
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
      const safeTorrentUrl = sameSiteHttpUrl(rawLink, sourceUrl);
      if (!safeTorrentUrl) {
        this.metrics.add('rejectedDownloadLinks');
        this.log.debug(`Skipping metainfo URL outside the verified mirror: ${rawLink}`);
        return null;
      }
      try {
        const parsedTorrent = await this.fetchTorrentMetainfoViaGet(safeTorrentUrl, sourceUrl);
        this.metrics.add('downloads');
        if (!parsedTorrent?.infoHash) return null;
        infoHash = parsedTorrent.infoHash;
        torrentFileUrl = safeTorrentUrl;
        metainfoName = parsedTorrent.name ?? null;
        metainfoTrackers = parsedTorrent.trackers ?? [];
        metainfoSize = parsedTorrent.sizeBytes ?? null;
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
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
