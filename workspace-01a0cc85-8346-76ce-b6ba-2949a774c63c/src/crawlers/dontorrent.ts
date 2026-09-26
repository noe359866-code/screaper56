import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { extractBrandMirrors, htmlMarkerValidator, MirrorProbe } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  dedupeStrings,
  isBlockedTitle,
  mapWithConcurrency,
  politePause,
  qualityOf,
  sameOrigin
} from './support.js';

/**
 * DonTorrent (dontorrent.moi and its official mirrors).
 *
 * Layout observed on the live site:
 *   - Catalogues `/peliculas`, `/series`, `/documentales`, paginated with `?p=N`.
 *   - Poster grids and `.card-body p` rows linking to
 *     `/pelicula/:id/:slug`, `/serie/:id/:id/:slug`, `/documental/:id/:slug`.
 *   - Detail pages expose `Formato:`, `Episodios:` and, for series, an episode
 *     table whose rows are labelled `1x01`, `1x02`, ...
 *   - Search is a POST to `/buscar` (`valor=<term>&Buscar=Buscar`, page `p`).
 *
 * IMPORTANT / LÍMITE CONOCIDO: current DonTorrent templates hide the `.torrent`
 * behind a JavaScript challenge (proof-of-work posted to their own API) plus a
 * download rate limit. This adapter does **not** solve, emulate or bypass that
 * protection, does not automate CAPTCHAs and never invents an infohash. It reads
 * the links the page publishes as plain HTML (magnet, `.torrent`, same-site
 * download handlers, literal `data-*`/`atob` values). When a page only offers the
 * protected button, the release is reported as `gated` and skipped.
 */

export interface DonTorrentSection {
  path: string;
  type: ContentType;
  label: string;
}

export interface DonTorrentListItem {
  url: string;
  title: string;
  quality: string | null;
  category: string | null;
  type: ContentType;
}

export interface DonTorrentDownload {
  url: string;
  title: string;
  hints: string[];
  season: number | null;
  episode: number | null;
}

export interface DonTorrentDetail {
  title: string;
  type: ContentType;
  format: string | null;
  year: number | null;
  episodes: number | null;
  sizeBytes: number | null;
  downloads: DonTorrentDownload[];
  /** True when the page only offers the JavaScript/PoW protected button. */
  gated: boolean;
}

const DETAIL_PATH = /^\/(pelicula|serie|documental|variado|musica|juego)\/\d+(?:\/\d+)?\/[^/]+\/?$/i;
const EPISODE_LABEL = /^(\d{1,2})\s*[x×]\s*(\d{1,3})$/i;

const SECTION_TYPES: Record<string, ContentType> = {
  pelicula: 'movie',
  peliculas: 'movie',
  serie: 'series',
  series: 'series',
  documental: 'documentary',
  documentales: 'documentary',
  variado: 'movie',
  variados: 'movie'
};

/** Curated official domains (see `/dominios` on the live site for the full list). */
export const DONTORRENT_DEFAULT_MIRRORS: readonly string[] = [
  'https://dontorrent.moi',
  'https://dontorrent.com',
  'https://dontorrent.org',
  'https://dontorrent.net',
  'https://dontorrent.app',
  'https://dontorrent.eu',
  'https://dontorrent.one',
  'https://dontorrent.io',
  'https://dontorrent.cc',
  'https://dontorrent.to',
  'https://dontorrent.me',
  'https://dontorrent.xyz',
  'https://dontorrent.website',
  'https://dontorrent.cloud'
];

/** Hosts allowed to serve the actual metainfo file (DonTorrent uses a CDN). */
function cdnHostAllowList(): RegExp[] {
  const configured = (process.env.DONTORRENT_CDN_HOSTS || 'doncdn.com')
    .split(/[,\s]+/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
    .map(host => new RegExp(`(^|\\.)${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
  return [...configured, /(^|\.)dontorrent\.[a-z]{2,}$/i];
}

/**
 * Accepts only links that really point at torrent metainfo:
 * magnets, `.torrent` files on the site/CDN and same-site download handlers.
 * Adverts, Telegram/Discord invites and shorteners are rejected.
 */
export function dontorrentDownloadUrl(value: string | undefined | null, base: string): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (candidate.startsWith('magnet:?')) return candidate;

  const resolved = absoluteHttpUrl(candidate, base);
  if (!resolved) return null;

  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const isTorrentFile = /\.torrent$/i.test(url.pathname);
  const trusted = sameOrigin(resolved, base) || cdnHostAllowList().some(pattern => pattern.test(host));

  if (isTorrentFile && trusted) return url.href;

  // Same-site download handlers (`/descargar/...`, `/download/...`, `/torrents/...`).
  if (sameOrigin(resolved, base) && /^\/(descargar|download|torrents?)(\/|\.php|$)/i.test(url.pathname)) {
    return url.href;
  }

  return null;
}

/** Minimal structural view of a Cheerio selection: only attribute reads are needed. */
interface AttributeReader {
  attr(name: string): string | undefined;
}

/** Literal URL candidates embedded in attributes or inline handlers (never evaluated). */
function literalUrlCandidates(node: AttributeReader): string[] {
  const values: string[] = [];
  for (const attr of ['href', 'data-url', 'data-href', 'data-torrent', 'data-magnet', 'data-download', 'data-file']) {
    const value = node.attr(attr);
    if (value) values.push(value);
  }
  const onclick = node.attr('onclick') || '';
  if (onclick) {
    for (const match of onclick.matchAll(/['"]([^'"\n]+)['"]/g)) values.push(match[1]);
    for (const match of onclick.matchAll(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/g)) {
      try {
        values.push(Buffer.from(match[1], 'base64').toString('utf8'));
      } catch {
        /* ignore malformed base64 */
      }
    }
  }
  return values;
}

function labelledValue($: cheerio.CheerioAPI, labels: string[]): string | null {
  for (const label of labels) {
    const holder = $(`b, strong, span, dt, td, th`).filter((_, el) => {
      const text = cleanText($(el).text()).toLowerCase();
      return text === `${label}:` || text === label;
    }).first();
    if (holder.length) {
      const inline = cleanText(holder.parent().clone().children('b, strong, dt, th').remove().end().text());
      if (inline) return inline;
      const sibling = cleanText(holder.next().text());
      if (sibling) return sibling;
    }
  }

  // Fallback: plain "Formato: BluRay-1080p" inside any block of text.
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*:\\s*([^\\n<|]{2,60})`, 'i');
  const match = cleanText($.root().text()).match(pattern);
  return match ? cleanText(match[1]) : null;
}

export class DonTorrentCrawler extends BaseCrawler {
  public readonly name = 'dontorrent';
  public baseUrl: string;

  private static discoveredMirrors: string[] = [];
  private readonly detailConcurrency = Math.max(1, Number.parseInt(process.env.DONTORRENT_CONCURRENCY || '2', 10) || 2);

  constructor() {
    super();
    this.baseUrl = process.env.DONTORRENT_BASE_URL || DONTORRENT_DEFAULT_MIRRORS[0];
  }

  /** Catalogue routes; only video categories are crawled by default. */
  protected get sections(): DonTorrentSection[] {
    const configured = (process.env.DONTORRENT_SECTIONS || 'peliculas,series,documentales')
      .split(/[,\s]+/)
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);

    return configured
      .filter(section => SECTION_TYPES[section])
      .map(section => ({ path: `/${section}`, type: SECTION_TYPES[section], label: section }));
  }

  private get probes(): MirrorProbe[] {
    const validate = htmlMarkerValidator([
      /href=["'][^"']*\/(?:pelicula|serie|documental)\/\d+/i,
      /dontorrent/i
    ]);
    return [
      { path: '/peliculas', validate, timeoutMs: 8000, label: 'catálogo de películas' },
      { path: '/', validate, timeoutMs: 8000, label: 'portada' }
    ];
  }

  // ==========================================================================
  // Parsing
  // ==========================================================================

  /** Detail links from poster grids and from `.card-body` search/result rows. */
  public parseListing(html: string, url: string): DonTorrentListItem[] {
    const $ = cheerio.load(html);
    const items = new Map<string, DonTorrentListItem>();

    $('a[href]').each((_, el) => {
      const anchor = $(el);
      const link = absoluteHttpUrl(anchor.attr('href'), url);
      if (!link || !sameOrigin(link, url)) return;

      const path = new URL(link).pathname;
      if (!DETAIL_PATH.test(path)) return;

      const segment = path.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
      const type = SECTION_TYPES[segment] ?? 'movie';

      const row = anchor.closest('p, li, div.card-body, td');
      const title = cleanText(anchor.attr('title') || anchor.text() || anchor.find('img').attr('alt') || '');
      // `<span>(BluRay-1080p)</span>` sits next to the title inside the same row.
      const quality = cleanText(row.find('span > span, span.badge-secondary').first().text()).replace(/^\(|\)$/g, '');
      const category = cleanText(row.find('span.badge, .badge-primary').first().text());

      const existing = items.get(link);
      if (existing && existing.title) return;

      items.set(link, {
        url: link,
        title: title || slugTitle(path),
        quality: quality || null,
        category: category || null,
        type
      });
    });

    return [...items.values()];
  }

  /** Real pagination links (`?p=N`); guessed routes are never followed. */
  public nextPage(html: string, currentUrl: string): string | null {
    const $ = cheerio.load(html);
    const current = new URL(currentUrl);
    const currentPage = Number.parseInt(current.searchParams.get('p') || '1', 10) || 1;

    for (const el of $('a[href]').toArray()) {
      const anchor = $(el);
      const text = cleanText(anchor.text());
      const rel = anchor.attr('rel') || '';
      if (rel !== 'next' && !/^(siguiente|next|[»›→]|\d{1,3})$/i.test(text)) continue;

      const link = absoluteHttpUrl(anchor.attr('href'), currentUrl);
      if (!link || !sameOrigin(link, currentUrl)) continue;

      const target = new URL(link);
      if (target.pathname !== current.pathname) continue;

      const page = Number.parseInt(target.searchParams.get('p') || '0', 10) || 0;
      if (page === currentPage + 1) return target.href;
    }
    return null;
  }

  public parseDetail(html: string, url: string): DonTorrentDetail {
    const $ = cheerio.load(html);
    const path = new URL(url).pathname;
    const segment = path.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
    const type = SECTION_TYPES[segment] ?? 'movie';

    // Comments / recommendations may carry somebody else's links.
    $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();

    const heading = cleanText(
      $('h1').first().text() ||
      $('h2').first().text() ||
      $('meta[property="og:title"]').attr('content') ||
      ''
    );
    const title = heading
      .replace(/^descargar\s+/i, '')
      .replace(/\s+(?:por\s+)?torrent\b.*$/i, '')
      .trim() || slugTitle(path);

    const format = labelledValue($, ['formato', 'calidad']);
    const yearRaw = labelledValue($, ['año', 'ano']);
    const year = yearRaw ? Number.parseInt(yearRaw.slice(0, 4), 10) || null : null;
    const episodesRaw = labelledValue($, ['episodios', 'capítulos', 'capitulos']);
    const episodes = episodesRaw ? Number.parseInt(episodesRaw, 10) || null : null;
    const sizeRaw = labelledValue($, ['tamaño', 'tamano', 'peso']);
    const sizeBytes = sizeRaw ? parseSizeToBytes(sizeRaw) : null;

    const downloads: DonTorrentDownload[] = [];
    const seen = new Set<string>();

    $('a[href], button, [data-url], [data-href], [data-torrent], [data-magnet], [onclick]').each((_, el) => {
      const node = $(el);
      for (const value of literalUrlCandidates(node)) {
        const target = dontorrentDownloadUrl(value, url);
        if (!target || seen.has(target)) continue;
        seen.add(target);

        const row = node.closest('tr, li, .card-body');
        const rowLabel = cleanText(row.find('td, .col, span').first().text());
        const episodeMatch = rowLabel.match(EPISODE_LABEL);

        downloads.push({
          url: target,
          title: episodeMatch ? `${title} ${rowLabel}` : title,
          hints: dedupeStrings([format, rowLabel && !episodeMatch ? rowLabel : null]),
          season: episodeMatch ? Number.parseInt(episodeMatch[1], 10) : null,
          episode: episodeMatch ? Number.parseInt(episodeMatch[2], 10) : null
        });
      }
    });

    const bodyText = $.root().text();
    const gated = downloads.length === 0 && (
      /api_validate_pow|pow_challenge|validate_pow/i.test(html) ||
      /descargar/i.test(bodyText)
    );

    return { title, type, format, year, episodes, sizeBytes, downloads, gated };
  }

  // ==========================================================================
  // Crawl
  // ==========================================================================

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();

    const mirror = await this.resolveMirror({
      defaults: DONTORRENT_DEFAULT_MIRRORS,
      envPrefix: 'DONTORRENT',
      extra: DonTorrentCrawler.discoveredMirrors,
      probes: this.probes,
      maxCandidates: Number.parseInt(process.env.DONTORRENT_MAX_MIRROR_PROBES || '10', 10) || 10
    });

    await this.refreshOfficialMirrors(mirror);

    const detailPages = new Map<string, DonTorrentListItem>();
    await this.collectCatalogues(mirror, maxPages, detailPages);
    await this.collectSearches(mirror, maxPages, detailPages);

    if (!detailPages.size) {
      throw new Error(
        `[${this.name}] No detail pages found on ${mirror}. The template may have changed, ` +
        'the domain may be blocked, or the catalogue routes may need DONTORRENT_SECTIONS.'
      );
    }

    this.log.info(`Discovered ${detailPages.size} detail pages. Extracting public download links...`);

    const items = [...detailPages.values()];
    const nested = await mapWithConcurrency(items, this.detailConcurrency, async item => {
      if (this.deadline.expired) return [];
      try {
        return await this.crawlDetail(item);
      } catch (error) {
        this.metrics.add('detailErrors');
        this.log.warn(`Detail failed ${item.url}: ${describe(error)}`);
        return [];
      }
    });

    const records = this.deduplicateRecords(nested.flat());
    this.logRunSummary(records);

    if (!records.length) {
      const gated = this.metrics.get('gated');
      throw new Error(
        `[${this.name}] ${detailPages.size} pages read but no public torrent link produced a valid infohash` +
        (gated ? ` (${gated} pages only exposed the JavaScript/proof-of-work download button, which this adapter does not automate).` : '.')
      );
    }

    return records;
  }

  /** Catalogue traversal: `/peliculas`, `/series`, `/documentales` with `?p=N`. */
  private async collectCatalogues(
    mirror: string,
    maxPages: number,
    sink: Map<string, DonTorrentListItem>
  ): Promise<void> {
    for (const section of this.sections) {
      let listUrl: string | null = `${mirror}${section.path}`;
      const visited = new Set<string>();

      for (let page = 0; listUrl && page < maxPages; page++) {
        if (visited.has(listUrl) || this.deadline.expired) break;
        visited.add(listUrl);

        try {
          const html = await this.fetchHtml(listUrl, { headers: { Referer: `${mirror}/` } });
          this.metrics.add('listings');

          const items = this.parseListing(html, listUrl);
          let added = 0;
          for (const item of items) {
            if (isBlockedTitle(item.title)) continue;
            if (sink.has(item.url)) continue;
            sink.set(item.url, { ...item, type: item.type ?? section.type });
            added++;
          }
          this.log.debug(`${section.label} page ${page + 1}: ${items.length} links (${added} new).`);

          const next = this.nextPage(html, listUrl);
          listUrl = next ?? (page + 1 < maxPages ? `${mirror}${section.path}?p=${page + 2}` : null);
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Catalogue failed ${listUrl}: ${describe(error)}`);
          break;
        }
      }
    }
  }

  /**
   * Optional POST search (`DONTORRENT_SEARCH="castellano,1080p"`).
   * Disabled by default: catalogues already cover new releases and the site
   * applies stricter rate limits to the search endpoint.
   */
  private async collectSearches(
    mirror: string,
    maxPages: number,
    sink: Map<string, DonTorrentListItem>
  ): Promise<void> {
    const terms = (process.env.DONTORRENT_SEARCH || '')
      .split(/[,\n]+/)
      .map(term => term.trim())
      .filter(Boolean);
    if (!terms.length) return;

    for (const term of terms) {
      for (let page = 1; page <= maxPages; page++) {
        if (this.deadline.expired) return;
        try {
          await politePause();
          const response = await this.httpClient.request<string>({
            method: 'POST',
            url: `${mirror}/buscar`,
            data: new URLSearchParams({ valor: term, Buscar: 'Buscar', p: String(page) }).toString(),
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Referer: `${mirror}/`
            }
          });

          const html = typeof response.data === 'string' ? response.data : '';
          if (!html) break;
          this.metrics.add('listings');

          const items = this.parseListing(html, `${mirror}/buscar`);
          if (!items.length) break;
          for (const item of items) {
            if (isBlockedTitle(item.title) || sink.has(item.url)) continue;
            sink.set(item.url, item);
          }
        } catch (error) {
          this.metrics.add('listingErrors');
          this.log.warn(`Search "${term}" page ${page} failed: ${describe(error)}`);
          break;
        }
      }
    }
  }

  private async crawlDetail(item: DonTorrentListItem): Promise<TorrentRecord[]> {
    const html = await this.fetchHtml(item.url, { headers: { Referer: this.baseUrl } });
    this.metrics.add('details');

    const detail = this.parseDetail(html, item.url);
    if (!detail.downloads.length) {
      if (detail.gated) {
        this.metrics.add('gated');
        this.log.debug(
          `${item.url}: download is behind the site's JavaScript/proof-of-work button. ` +
          'Skipped on purpose (no challenge solving, no invented hash).'
        );
      } else {
        this.metrics.add('skipped');
        this.log.debug(`${item.url}: no public torrent or magnet link in the HTML.`);
      }
      return [];
    }

    const records: TorrentRecord[] = [];
    for (const download of detail.downloads) {
      try {
        const record = await this.buildRecord(download, detail, item);
        if (record) {
          records.push(record);
          this.metrics.add('records');
        }
      } catch (error) {
        this.metrics.add('downloadErrors');
        this.log.warn(`Invalid download ${download.url}: ${describe(error)}`);
      }
    }
    return records;
  }

  private async buildRecord(
    download: DonTorrentDownload,
    detail: DonTorrentDetail,
    item: DonTorrentListItem
  ): Promise<TorrentRecord | null> {
    const magnet = parseMagnetUri(download.url);
    const metainfo = magnet ? null : await this.fetchTorrentMetainfo(download.url, item.url);
    this.metrics.add('downloads');

    const infoHash = magnet?.infoHash || metainfo?.infoHash;
    if (!infoHash) return null;

    const title = cleanText(download.title || magnet?.displayName || metainfo?.name || detail.title);
    const context = dedupeStrings([
      title,
      metainfo?.name ?? null,
      detail.format,
      item.quality,
      ...download.hints
    ]).join(' ');

    const defaultType: ContentType = download.episode !== null ? 'series' : detail.type ?? item.type;
    const meta = parseTorrentTitle(context, defaultType);
    // DonTorrent publishes Spanish (Castellano) releases; the tracker hint only
    // applies when the title itself carries no explicit language tag.
    const languages = detectLanguages(context, ['dontorrent']);

    return buildTorrentRecord({
      title,
      type: meta.type,
      infoHash,
      sourceUrl: item.url,
      magnetUrl: magnet ? download.url : null,
      torrentFileUrl: magnet ? null : download.url,
      trackers: magnet?.trackers ?? metainfo?.trackers ?? [],
      audio: languages.audio,
      subtitles: languages.subtitles,
      meta,
      season: download.season ?? meta.season ?? null,
      episode: download.episode ?? meta.episode ?? null,
      quality: item.quality || detail.format || qualityOf(meta),
      sizeBytes: metainfo?.sizeBytes ?? detail.sizeBytes ?? null,
      // DonTorrent does not publish swarm counters: never fabricate them.
      seeders: null,
      leechers: null,
      sourceTracker: metainfo?.primaryTracker ?? magnet?.trackers[0] ?? null
    });
  }

  /**
   * Reads the site's own "Dominios Oficiales" page and feeds the extra domains
   * into the mirror pool for the rest of the process. Purely additive: the
   * operator can still pin everything with DONTORRENT_BASE_URL / _MIRRORS.
   */
  private async refreshOfficialMirrors(mirror: string): Promise<void> {
    if ((process.env.DONTORRENT_DISCOVER_MIRRORS || 'true').toLowerCase() === 'false') return;
    if (DonTorrentCrawler.discoveredMirrors.length) return;

    try {
      const html = await this.fetchHtml(`${mirror}/dominios`, { timeout: 8000 });
      const mirrors = extractBrandMirrors(html, /(^|\.)dontorrent\.[a-z]{2,}$/i, 40);
      if (mirrors.length) {
        DonTorrentCrawler.discoveredMirrors = mirrors;
        this.log.info(`Official domain list refreshed: ${mirrors.length} mirrors available as fallback.`);
      }
    } catch (error) {
      this.log.debug(`Official domain list unavailable: ${describe(error)}`);
    }
  }
}

function slugTitle(pathname: string): string {
  const slug = pathname.split('/').filter(Boolean).pop() || '';
  return cleanText(decodeURIComponent(slug).replace(/[-_]+/g, ' '));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default DonTorrentCrawler;
