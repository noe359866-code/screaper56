import { DOWNLOAD_NODES, literalDownloadCandidates, spanishReleaseHints } from './spanish-catalog.js';
import * as cheerio from 'cheerio';
import { BaseCrawler, rethrowIfBlockedOrRateLimited } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  dedupeStrings,
  describeError,
  isBlockedTitle,
  mapWithConcurrency,
  qualityOf,
} from './support.js';

interface EliteRoute {
  path: string;
  hasPagination: boolean;
  type: ContentType;
}

/** Host comparison that ignores a `www.` prefix on either side. */
export function sameHost(a: string, b: string): boolean {
  try {
    const left = new URL(a).hostname.replace(/^www\./i, '').toLowerCase();
    const right = new URL(b).hostname.replace(/^www\./i, '').toLowerCase();
    return left === right && left.length > 0;
  } catch {
    return false;
  }
}

function sameSiteUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return !left.username && !left.password && !right.username && !right.password &&
      left.protocol === right.protocol && left.port === right.port && sameHost(a, b);
  } catch {
    return false;
  }
}

/**
 * Path segments that always belong to a listing, a filter or the pager —
 * never to a single release. `/peliculas/accion/` or `/series/page/2/` used to
 * be queued as details: every one of them cost a request and an empty record.
 */
const ELITE_LISTING_SEGMENTS =
  /^(?:page|pagina|paginas|paged|feed|rss|categoria|categorias|cat|genero|generos|calidad|idioma|idiomas|orden|order|etiquetas?|tags?|autor|autores|buscar|search|busqueda|index|inicio|home|ultimas?|ultimos?|estrenos?|estreno|novedades|destacad[ao]s?|accion|animacion|anime|aventura|belic[ao]|biografia|ciencia-ficcion|comedia|crimen|documental|drama|erotic[oa]s?|familia|fantasia|guerra|historia|horror|intriga|misterio|musical|policiac[ao]|romance|suspenso|suspense|terror|thriller|western|deporte|adultos?|xxx|hentai)$/i;

/**
 * Root sections that hold releases. Everything else (`/foro/`, `/noticias/`,
 * `/contacto/`, ...) is not a torrent and is dropped.
 */
const ELITE_SECTIONS = /^(?:peliculas|peliculas-1|series|series-1|documentales|documentales-1)$/i;

/**
 * True when `href` points at one release ("…/peliculas/1234-slug",
 * "…/series/1234/nombre/" or "…/series/slug/"), false for every category,
 * filter or pager route.
 */
export function isEliteDetailUrl(href: string, base: string): boolean {
  if (!href || typeof href !== 'string') return false;

  const fullUrl = absoluteHttpUrl(href, base);
  if (!fullUrl) return false;

  let url: URL;
  try {
    url = new URL(fullUrl);
  } catch {
    return false;
  }

  if (!sameSiteUrl(fullUrl, base)) return false;
  // `/page/N/` inside the path is a pager, wherever it appears.
  if (/\/(?:page|pagina|paged)\/\d+/i.test(url.pathname)) return false;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return false; // "/peliculas/" is the catalogue root.
  if (!ELITE_SECTIONS.test(segments[0])) return false;

  const rest = segments.slice(1);
  if (rest.some(segment => ELITE_LISTING_SEGMENTS.test(segment))) return false;

  const slug = rest[rest.length - 1].replace(/\.html?$/i, '');
  if (!slug) return false;
  // A pure numeric slug is an id, not a title, unless a real slug follows it.
  if (!/[a-z]/i.test(slug)) return false;
  // Scripts, feeds and images are never a release.
  if (/\.(?:php|asp|aspx|json|xml|css|js|png|jpe?g|gif|webp|svg|ico)$/i.test(rest[rest.length - 1])) return false;

  return true;
}

/**
 * EliteTorrent: detail pages, Base64/ROT13 shortener, hex/Base32 magnets and
 * relative `.torrent` URLs with a query string. Swarm counters are not published
 * by the site, so they stay `null` instead of being faked as zero.
 */
export class EliteTorrentCrawler extends BaseCrawler {
  public readonly name = 'elitetorrent';
  public baseUrl: string;

  /** Known EliteTorrent domains; extend with ELITETORRENT_MIRRORS. */
  public static readonly DEFAULT_MIRRORS: readonly string[] = [
    'https://www.elitetorrent.com',
    'https://elitetorrent.li',
    'https://elitetorrent.app',
    'https://elitetorrent.wtf',
    'https://www.elitetorrent.ec',
    'https://elitetorrent.biz',
    'https://elitetorrent.ms',
    'https://elitetorrents.pro',
    'https://www.elitetorrent.nu'
  ];

  private readonly detailConcurrency = Math.max(1, Number.parseInt(process.env.ELITETORRENT_CONCURRENCY || '5', 10) || 5);

  constructor() {
    super();
    this.baseUrl = process.env.ELITETORRENT_BASE_URL || EliteTorrentCrawler.DEFAULT_MIRRORS[0];
  }

  private async getWorkingMirror(): Promise<string> {
    return this.resolveMirror({
      envPrefix: 'ELITETORRENT',
      defaults: EliteTorrentCrawler.DEFAULT_MIRRORS,
      probes: [
        {
          path: '/',
          label: 'portada',
          timeoutMs: 7000,
          validate: htmlMarkerValidator([/href=["'][^"']*\/(peliculas|series)\/[^"']+/i])
        },
        {
          path: '/series/',
          label: 'catálogo de series',
          timeoutMs: 7000,
          validate: htmlMarkerValidator([/href=["'][^"']*\/(peliculas|series)\/[^"']+/i])
        }
      ]
    });
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting EliteTorrent crawl (maxPages=${maxPages})...`);

    const mirror = await this.getWorkingMirror();
    this.baseUrl = mirror;

    const results: TorrentRecord[] = [];
    const visitedUrls = new Set<string>();
    let successfulListings = 0;

    const sectionRoutes: EliteRoute[] = [
      { path: '/', hasPagination: false, type: 'movie' },
      { path: '/series/', hasPagination: true, type: 'series' },
      { path: '/idioma/castellano-17-1/', hasPagination: true, type: 'movie' },
      { path: '/idioma/espanol-latino-11-1/', hasPagination: true, type: 'movie' },
      { path: '/calidad/1080p-10-1/', hasPagination: true, type: 'movie' },
      { path: '/calidad/4k-uhd-23-1/', hasPagination: true, type: 'movie' }
    ];

    for (const route of sectionRoutes) {
      const pagesToCrawl = route.hasPagination ? maxPages : 1;
      // Fingerprint of the links published by the previous page of this route.
      let previousSignature = '';

      for (let page = 1; page <= pagesToCrawl; page++) {
        if (this.deadline.expired) break;

        const listUrl = page > 1
          ? `${mirror}${route.path.replace(/\/$/, '')}/page/${page}/`
          : `${mirror}${route.path}`;

        try {
          this.log.debug(`Fetching listing: ${listUrl}`);
          const html = await this.fetchHtml(listUrl, {}, { rejectBlocked: true });
          successfulListings++;
          this.metrics.add('listings');

          const candidates: string[] = [];
          const $ = cheerio.load(html);

          $('a[href*="/peliculas/"], a[href*="/series/"], a[href*="/documentales/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            // Genre / quality / language filters (`/peliculas/accion/`) and the
            // pager match the loose `href*=` selector: `isEliteDetailUrl` keeps
            // only real releases, and the host check ignores a missing `www.`.
            if (!isEliteDetailUrl(href, listUrl)) return;

            const fullUrl = absoluteHttpUrl(href, listUrl);
            if (!fullUrl) return;
            if (!sameSiteUrl(fullUrl, mirror)) return;
            candidates.push(fullUrl);
          });

          if (!candidates.length) {
            // The page publishes no release link at all: the route is over.
            this.log.debug(`No release links on page ${page} for ${route.path}. Ending pagination.`);
            break;
          }

          // `page=N` ignored by the template: the very same listing came back,
          // so every further page would repeat these links (the old code spent
          // `maxPages - page` requests on them).
          const candidateSignature = [...new Set(candidates)].sort().join('|');
          if (candidateSignature === previousSignature) {
            this.log.debug(`Page ${page} repeated the previous listing for ${route.path}. Ending pagination.`);
            break;
          }
          previousSignature = candidateSignature;

          const pageDetailUrls: string[] = [];
          for (const fullUrl of candidates) {
            if (visitedUrls.has(fullUrl)) continue;
            visitedUrls.add(fullUrl);
            pageDetailUrls.push(fullUrl);
          }

          if (!pageDetailUrls.length) {
            // Links exist but every one of them was already crawled through
            // another route: keep paginating (bounded by `maxPages`), the next
            // page can still hold new releases.
            continue;
          }

          const records = await mapWithConcurrency(pageDetailUrls, this.detailConcurrency, async url => {
            if (this.deadline.expired) return null;
            try {
              const record = await this.parseEliteTorrentDetail(url, mirror);
              if (record) this.metrics.add('records');
              return record;
            } catch (error) {
              rethrowIfBlockedOrRateLimited(error);
              this.metrics.add('detailErrors');
              this.log.warn(`Error parsing detail [${url}]: ${describeError(error)}`);
              return null;
            }
          });

          for (const record of records) {
            if (record) results.push(record);
          }
        } catch (error) {
          rethrowIfBlockedOrRateLimited(error);
          this.metrics.add('listingErrors');
          this.log.warn(`Failed fetching ${listUrl}: ${describeError(error)}. Skipping to next route.`);
          break;
        }
      }
    }

    if (successfulListings === 0) {
      throw new Error('[elitetorrent] No usable catalogue responses. Check mirror availability, blocking and page layout.');
    }

    const deduplicated = this.deduplicateRecords(results);
    this.logRunSummary(deduplicated);
    return deduplicated;
  }

  public async parseEliteTorrentDetail(url: string, mirror: string): Promise<TorrentRecord | null> {
    const trustedUrl = absoluteHttpUrl(url, mirror);
    if (!trustedUrl || !sameSiteUrl(trustedUrl, mirror)) return null;
    url = trustedUrl;

    // fetchHtml (not a raw httpClient.get) so the courtesy pause, HTML type,
    // blocked-page and shared Referer checks apply to detail pages too.
    const html = await this.fetchHtml(
      url,
      { headers: { Referer: `${mirror}/` } },
      { rejectBlocked: true }
    );
    if (!html) return null;
    this.metrics.add('details');

    const $ = cheerio.load(html);
    $('.comments, #comentarios, .related, .relacionados, footer, nav').remove();
    const rawH1 = cleanText($('h1').first().text());
    if (!rawH1) return null;

    const cleanTitle = rawH1
      .replace(/^Descargar\s+/i, '')
      .replace(/\s+por torrent.*$/i, '')
      .replace(/^["\u201C\u201D\x27]+|["\u201C\u201D\x27]+$/g, '')
      .trim();

    if (!cleanTitle || isBlockedTitle(cleanTitle)) return null;

    let sizeStr = '';
    let idiomaStr = '';
    let calidadStr = '';
    let formatoStr = '';

    // The selector matches `<li>` AND the `<span>` inside it, so the loop used
    // to read "1.5 GB" from the li and then overwrite it with the empty value
    // of the child `<span>Tamaño:</span>`. A field is only replaced when the
    // candidate really carries a value.
    $('p.descrip span, .ficha span, li').each((_, el) => {
      const txt = cleanText($(el).text());
      const extract = (prefix: RegExp): string | null => {
        if (!prefix.test(txt)) return null;
        const value = txt.replace(prefix, '').trim();
        // "Tamaño:" on its own (the label span) must never blank a real value.
        return value.length > 0 ? value : null;
      };

      sizeStr = extract(/^Tamaño:/i) ?? sizeStr;
      idiomaStr = extract(/^Idioma:/i) ?? idiomaStr;
      calidadStr = extract(/^Calidad:/i) ?? calidadStr;
      formatoStr = extract(/^Formato:/i) ?? formatoStr;
    });

    let magnetLink: string | null = null;
    let torrentDownloadUrl: string | null = null;

    $(DOWNLOAD_NODES).each((_, el) => {
      // Early break if both magnet and torrent download URLs are found
      if (magnetLink && torrentDownloadUrl) return false;

      for (const href of literalDownloadCandidates($(el))) {

        if (/acortame-esto\.com\/s\.php\?i=/i.test(href)) {
          const param = safeQueryParam(href, url, 'i');
          if (param) {
            const decoded = decodeAcortameString(param);
            if (/^magnet:/i.test(decoded) && !magnetLink) {
              if (parseMagnetUri(decoded)?.infoHash) magnetLink = decoded;
            } else if (decoded.includes('.torrent') && !torrentDownloadUrl) {
              const resolved = absoluteHttpUrl(decoded, url);
              if (resolved && sameSiteUrl(resolved, url)) torrentDownloadUrl = resolved;
            }
          }
        } else if (/^magnet:/i.test(href) && !magnetLink) {
          if (parseMagnetUri(href)?.infoHash) magnetLink = href;
        } else if (/\.torrent(?:[?#]|$)/i.test(href) && !torrentDownloadUrl) {
          const resolved = absoluteHttpUrl(href, url);
          if (resolved && sameSiteUrl(resolved, url)) torrentDownloadUrl = resolved;
        }
      }
    });

    const parsedMagnet = magnetLink ? parseMagnetUri(magnetLink) : null;
    let infoHash: string | null = parsedMagnet?.infoHash ?? null;
    let trackers: string[] = parsedMagnet?.trackers ?? [];
    let sizeBytes = parseSizeToBytes(sizeStr);

    if ((!infoHash || !sizeBytes) && torrentDownloadUrl) {
      try {
        const parsed = await this.fetchTorrentMetainfoViaGet(torrentDownloadUrl, url);
        if (!infoHash) infoHash = parsed.infoHash;
        if (!sizeBytes && parsed.sizeBytes > 0) sizeBytes = parsed.sizeBytes;
        if (!trackers.length) trackers = parsed.trackers;
      } catch (error) {
        rethrowIfBlockedOrRateLimited(error);
        this.metrics.add('downloadErrors');
        this.log.debug(`Metainfo download failed for ${torrentDownloadUrl}: ${describeError(error)}`);
      }
    }

    if (!infoHash) return null;

    // Fallback: build a valid magnet URI if infoHash exists but no original
    // magnet was found. Only the trackers the metainfo really announces are
    // written; public defaults are never fabricated into a source's magnet.
    if (!magnetLink && infoHash) {
      magnetLink = buildMagnetUri(infoHash, cleanTitle, trackers, { includeDefaultTrackers: false });
    }

    const isSeries = url.includes('/series/') || /\bS\d{1,2}(?:E\d{1,3})?\b|Temporada|\b\d{1,2}[xX×]\d{1,3}\b/i.test(cleanTitle);
    const defaultType: ContentType = isSeries ? 'series' : 'movie';

    const normalizedTitleForParsing = cleanTitle.replace(
      /(\d{1,2})[xX×](\d{1,3})/g,
      (_, season: string, episode: string) => `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`
    );

    const releaseHints = spanishReleaseHints($);
    const context = dedupeStrings([normalizedTitleForParsing, calidadStr, formatoStr, ...releaseHints]).join(' ');
    const meta = parseTorrentTitle(context, defaultType);
    const hints = dedupeStrings(['elitetorrent', idiomaStr, calidadStr, formatoStr, ...releaseHints]);
    const langs = detectLanguages(cleanTitle, hints);

    // The ficha publishes an explicit language field. `detectLanguages` always
    // falls back to 'Spanish' for this site, so the previous "only when empty"
    // guard was dead code and a VOSE release was stored as Spanish audio.
    // The explicit field now wins over that generic default.
    if (idiomaStr) {
      if (/vose|v\.o\.s\.e|subtitulad/i.test(idiomaStr)) {
        // VOSE is English audio + Spanish subs; no other audio track applies.
        langs.audio = ['English'];
        if (!langs.subtitles.includes('Sub_ES')) langs.subtitles.push('Sub_ES');
      } else {
        // Not mutually exclusive: "Castellano / Inglés" or "Dual (Latino /
        // Castellano)" used to lose the second language to `else if`.
        if (/latino/i.test(idiomaStr) && !langs.audio.includes('Spanish (Latino)')) {
          langs.audio.push('Spanish (Latino)');
        }
        if (/castellano|espa[ñn]ol/i.test(idiomaStr) && !langs.audio.includes('Spanish')) {
          langs.audio.push('Spanish');
        }
        if (/ingl[eé]s|english|v\.o\./i.test(idiomaStr) && !langs.audio.includes('English')) {
          langs.audio.push('English');
        }
      }
    }

    return buildTorrentRecord({
      title: cleanTitle,
      type: meta.type,
      infoHash,
      magnetUrl: magnetLink,
      torrentFileUrl: torrentDownloadUrl,
      sourceUrl: url,
      trackers,
      audio: langs.audio,
      subtitles: langs.subtitles,
      meta,
      quality: calidadStr || qualityOf(meta),
      sizeBytes,
      // EliteTorrent listings do not expose seeders/leechers: keep them unknown.
      seeders: null,
      leechers: null,
      sourceTracker: trackers[0] ?? null
    });
  }
}

function safeQueryParam(href: string, base: string, key: string): string | null {
  try {
    return new URL(href, base).searchParams.get(key);
  } catch {
    return null;
  }
}

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 65 && code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

/** Decodes the site's own Base64/ROT13 shortener parameter (no remote calls). */
export function decodeAcortameString(raw: string): string {
  if (!raw) return '';
  const s = raw.trim();

  if (/^(magnet:|http:\/\/|https:\/\/)/i.test(s)) return s;

  const initialRot = rot13(s);
  if (/^(magnet:|http:\/\/|https:\/\/)/i.test(initialRot)) return initialRot;

  // Multi-layer encoding: every decoded layer is re-normalised, because URL-safe
  // characters ("-" / "_") and missing padding only appeared in the FIRST layer
  // under the old single-pass normalisation, which broke nested payloads.
  let current = s;
  for (let i = 0; i < 8; i++) {
    const normalized = current.trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.length % 4
      ? normalized + '='.repeat(4 - (normalized.length % 4))
      : normalized;

    // Buffer.from(..., 'base64') never throws: without this guard the loop
    // happily decoded garbage eight times before giving up.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) break;
    try {
      current = Buffer.from(padded, 'base64').toString('utf-8');
      if (/^(magnet:|http:\/\/|https:\/\/)/i.test(current)) return current;

      const rotDecoded = rot13(current);
      if (/^(magnet:|http:\/\/|https:\/\/)/i.test(rotDecoded)) return rotDecoded;
    } catch {
      break;
    }
  }

  return initialRot;
}

export default EliteTorrentCrawler;
