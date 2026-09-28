/**
 * Shared crawler kit used by every adapter.
 *
 * Centralises the boring-but-critical plumbing so the 13 site crawlers stay
 * small and consistent:
 *
 *   - `CrawlerLogger` / `CrawlerMetrics` / `Deadline`: per-run observability
 *     and an optional wall-clock budget (`LOG_LEVEL`, `CRAWLER_TIME_BUDGET_MS`).
 *   - `politePause` / `sleep` / `mapWithConcurrency`: courtesy delays with
 *     jitter and order-preserving bounded parallelism.
 *   - `cleanText` / `parseCount` / `absoluteHttpUrl` / `sameOrigin` /
 *     `dedupeStrings` / `isBlockedTitle` / `qualityOf`: small pure helpers
 *     for titles, counters, links and release metadata.
 *   - `buildTorrentRecord`: the ONLY `TorrentRecord` constructor. It validates
 *     the infohash (hex or Base32, never all-zeros), trims the title, dedupes
 *     audio/subtitle tags, keeps unknown swarm counters as `null` (never
 *     fabricated) and always produces a valid magnet URI.
 *   - `recordScore` / `mergeRecords`: completeness scoring and gap-filling
 *     used by `BaseCrawler.deduplicateRecords` when two candidates share an
 *     infohash.
 */

import * as cheerio from 'cheerio';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import {
  DEFAULT_TRACKERS as MAGNET_DEFAULT_TRACKERS,
  normalizeInfoHash
} from '../utils/magnet.js';
import { canonicalAudioTag, canonicalSubtitleTag } from '../utils/language.js';
import { ParsedMetadata } from '../utils/regex.js';

/** Public trackers used as a fallback when a release lists none. */
export const DEFAULT_TRACKERS: readonly string[] = MAGNET_DEFAULT_TRACKERS;

// ============================================================================
// Text, counters and URLs
// ============================================================================

/**
 * Collapses every whitespace run to a single space and trims.
 * Non-string input (missing attributes, nulls) yields an empty string.
 */
export function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parses human-readable counters (`1,234`, `1 234`, `42`) into integers.
 * Anything else (`N/A`, empty, negative, non-numeric) yields `null` so
 * callers can keep the field unknown instead of storing garbage.
 */
/**
 * Single-line, log-safe description of any thrown value.
 *
 * Fourteen copies of this existed across the crawlers and the mirror layer,
 * each drifting slightly. Libraries throw plenty of non-`Error` values
 * (`{ message }` objects, strings, `undefined`), and `String(thrown)` turns
 * those into `[object Object]` in the logs, which hides the real reason a
 * source failed.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    const nested = (error as { error?: unknown }).error;
    if (nested && nested !== error) return describeError(nested);
    // Last resort for plain throwables: a JSON dump beats the information-free
    // `[object Object]`. Circular structures throw here and fall through.
    try {
      const json = JSON.stringify(error);
      if (json !== undefined && json.length <= 500) return json;
    } catch {
      /* circular or exotic */
    }
  }
  try {
    return String(error);
  } catch {
    return '[undescribable error]';
  }
}

export function parseCount(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // "1,234" / "1.234" / "1 234" are thousands separators, never decimals.
    const normalized = /^\d{1,3}(?:[.,\s\u00a0]\d{3})+$/.test(trimmed)
      ? trimmed.replace(/[.,\s\u00a0]/g, '')
      : trimmed.replace(/[,\s]+/g, '');
    if (!/^\d+$/.test(normalized)) return null;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves `value` against `base` and returns a plain http(s) URL, or `null`.
 * Fragments are stripped (they only create false duplicates), and anything
 * that is not fetchable over HTTP (`javascript:`, `data:`, `magnet:`,
 * `blob:`, bare `#fragment`, ...) is rejected.
 */
export function absoluteHttpUrl(
  value: string | undefined | null,
  base: string
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (SCHEME_PATTERN.test(trimmed) && !/^https?:/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** True when both URLs share the same scheme + host + port. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * True when both URLs are served by the same host, ignoring a `www.` prefix.
 *
 * Sites link the apex from the `www` host (and back) all the time; comparing
 * full origins silently discarded every one of those links, which emptied whole
 * crawls on mirrors that disagree with their own canonical host.
 */
export function sameHost(a: string, b: string): boolean {
  try {
    const left = new URL(a).hostname.replace(/^www\./i, '').toLowerCase();
    const right = new URL(b).hostname.replace(/^www\./i, '').toLowerCase();
    return left.length > 0 && left === right;
  } catch {
    return false;
  }
}

/**
 * Trims, drops empties and dedupes case-insensitively while preserving the
 * first-seen spelling (`[' a ', 'A', 'b']` -> `['a', 'b']`).
 */
export function dedupeStrings(
  values: readonly (string | null | undefined)[] | null | undefined
): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

const BLOCKED_TITLE_PATTERN =
  /\b(xxx|porn|porno|hentai|erotic|erotica|adult|onlyfans|escort|webcam)\b/i;

/**
 * Rejects adult/spam titles (and empty ones) before a record is built.
 * Ordinary releases such as `Poli malo 2025` always pass.
 */
export function isBlockedTitle(title: unknown): boolean {
  if (typeof title !== 'string') return true;
  const text = title.trim();
  if (!text) return true;
  // "Adult Swim" / "Young Adult" are mainstream titles, not adult content.
  return BLOCKED_TITLE_PATTERN.test(text.replace(/\b(?:adult\s+swim|young\s+adult|adult\s+education)\b/gi, ' '));
}

/** Release quality shorthand derived from parsed title metadata. */
export function qualityOf(meta: ParsedMetadata | null | undefined): string | null {
  return meta?.resolution ?? null;
}

// ============================================================================
// Published pagination
// ============================================================================

/** Anchors that can hold a pagination pointer, in any template. */
const PAGER_LINK_SELECTOR = [
  'a[rel="next"]',
  '.pagination a',
  '.pagination2 a',
  '.pager a',
  '.pages a',
  '.paginacion a',
  '.wp-pagenavi a',
  'ul.page-numbers a',
  'a.pg',
  'a[href*="page="]',
  'a[href*="start="]'
].join(', ');

/** Default "next page" wording (`next`, `siguiente`, arrows, `more results`). */
const DEFAULT_NEXT_TEXT = /^(?:next|siguiente|siguientes?|pr[oó]xima?|›|»|>|→|more(?:\s+torrent)?(?:\s+results?)?|\d+\s*(?:›|»))$/i;

const PAGE_QUERY_KEYS = ['page', 'p', 'pagina', 'paged', 'pagenum'] as const;
const OFFSET_QUERY_KEYS = ['start', 'offset'] as const;

/** Page number carried by the query string, or `null`. */
function queryPage(url: URL): number | null {
  for (const key of PAGE_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value && /^\d{1,5}$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

/** Numeric page carried by the path (`/movies/2/`, `/page/3/`), or `null`. */
function pathPage(url: URL): number | null {
  const explicit = url.pathname.match(/\/(?:page|pagina|paged|p)\/(\d{1,5})(?:\/)?$/i);
  if (explicit) return Number.parseInt(explicit[1], 10);
  const trailing = url.pathname.match(/\/(\d{1,5})(?:\/)?$/);
  return trailing ? Number.parseInt(trailing[1], 10) : null;
}

/** Offset carried by the query string (`start=50`), or `null`. */
function queryOffset(url: URL): number | null {
  for (const key of OFFSET_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value && /^\d{1,7}$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

/**
 * The path without its trailing page number: `/movies/2/` -> `/movies/` and
 * `/peliculas/page/2/` -> `/peliculas/`. The `/page/N` form is stripped first,
 * otherwise the trailing-number rule ate the `2` and left `/peliculas/page/`.
 */
function pageBasePath(url: URL): string {
  return url.pathname.replace(/\/page\/\d+(?:\/)?$/i, '/').replace(/\/(\d{1,5})(?:\/)?$/, '/');
}

export interface NextPageOptions {
  /** Extra anchors to consider (merged with the built-in pager selectors). */
  linkSelector?: string;
  /** Wording that marks the "next" link. */
  nextText?: RegExp;
}

/**
 * Returns the next listing URL the page itself publishes, or `null`.
 *
 * Supporting the same helper everywhere is what stops adapters from guessing
 * offsets: a `rel="next"` / "Next" / "»" link wins, otherwise the page number
 * (query `page=`, path `/2/` or `/page/2/`) or the `start=` offset has to move
 * forward on the same base path. Guessing `?p=N` in a loop is what made
 * single-page sections cost `maxPages` requests each.
 */
export function nextPaginationLink(
  html: string,
  currentUrl: string,
  options: NextPageOptions = {}
): string | null {
  const $ = cheerio.load(html);

  let current: URL;
  try {
    current = new URL(currentUrl);
    current.hash = '';
  } catch {
    return null;
  }

  const currentOffset = queryOffset(current);
  const currentPage = queryPage(current) ?? (currentOffset === null ? pathPage(current) : null);
  const hasMarker = currentPage !== null || currentOffset !== null;
  const currentNumber = currentPage ?? currentOffset ?? 1;
  const currentBase = pageBasePath(current).replace(/\/+$/, '');
  const normalizedCurrent = current.href;

  const nextText = options.nextText ?? DEFAULT_NEXT_TEXT;
  const candidates: Array<{
    href: string;
    number: number;
    offset: number | null;
    label: string;
    rel: boolean;
    sameBase: boolean;
  }> = [];

  $(options.linkSelector ? `${PAGER_LINK_SELECTOR}, ${options.linkSelector}` : PAGER_LINK_SELECTOR)
    .each((_, el) => {
      const anchor = $(el);
      const rawHref = anchor.attr('href');
      if (!rawHref) return;

      const href = absoluteHttpUrl(rawHref, currentUrl);
      if (!href || !sameHost(href, currentUrl)) return;

      let parsed: URL;
      try {
        parsed = new URL(href);
        parsed.hash = '';
      } catch {
        return;
      }
      if (parsed.href === normalizedCurrent) return;

      const offset = queryOffset(parsed);
      const page = offset === null ? (queryPage(parsed) ?? pathPage(parsed)) : null;
      if (page === null && offset === null) return;

      candidates.push({
        href,
        number: page ?? offset ?? 0,
        offset,
        label: cleanText(anchor.text()),
        rel: (anchor.attr('rel') || '').split(/\s+/).includes('next'),
        sameBase: pageBasePath(parsed).replace(/\/+$/, '') === currentBase
      });
    });

  if (!candidates.length) return null;

  // 1. The pager's own pointer, whatever numbering the mirror uses.
  const relNext = candidates.find(candidate => candidate.rel);
  if (relNext) return relNext.href;

  const textNext = candidates.find(candidate => nextText.test(candidate.label));
  if (textNext) return textNext.href;

  // 2. Forward movement on the same base path. A page without any marker is
  //    page 1, and there the pager's first link is the next one (mirrors
  //    disagree on whether their numbering starts at 0 or at 1).
  const forward = candidates.filter(candidate => {
    if (!candidate.sameBase) return false;
    if (candidate.offset !== null && currentOffset !== null) return candidate.offset > currentOffset;
    return candidate.number > currentNumber;
  });

  if (forward.length) {
    const ordered = hasMarker
      ? [...forward].sort((a, b) => a.number - b.number)
      : forward;
    return ordered[0].href;
  }

  return null;
}

// ============================================================================
// Timing and bounded concurrency
// ============================================================================

/** Plain promise-based delay. */
export function sleep(ms: number): Promise<void> {
  const delay = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Courtesy pause between requests of a single crawler.
 * Reads `CRAWLER_REQUEST_DELAY_MS` (default `0` = disabled) and adds up to
 * 1s of random jitter so parallel workers do not march in lockstep.
 * The env value is parsed once: this runs before every single request.
 */
let cachedRequestDelayMs: number | null = null;

export function configuredRequestDelayMs(): number {
  if (cachedRequestDelayMs === null) {
    const parsed = Number.parseInt(process.env.CRAWLER_REQUEST_DELAY_MS || '0', 10);
    cachedRequestDelayMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return cachedRequestDelayMs;
}

/** Test/CLI hook: forget the cached `CRAWLER_REQUEST_DELAY_MS` value. */
export function resetRequestDelayCache(): void {
  cachedRequestDelayMs = null;
}

export async function politePause(): Promise<void> {
  const configured = configuredRequestDelayMs();
  if (configured <= 0) return;
  const jitter = Math.floor(Math.random() * Math.min(configured, 1000));
  await sleep(configured + jitter);
}

/**
 * Maps `items` through `fn` with at most `limit` promises in flight.
 * Results keep the input order; an empty input resolves immediately.
 *
 * If one worker throws, the remaining in-flight workers are still awaited
 * before the rejection surfaces. Rejecting early used to orphan live HTTP
 * requests and browser downloads that kept mutating shared state after the
 * caller had already moved on.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const workers = Math.max(1, Math.floor(limit) || 1);
  const results: R[] = new Array(list.length);
  let cursor = 0;
  let aborted = false;

  const run = async (): Promise<void> => {
    while (cursor < list.length && !aborted) {
      const index = cursor++;
      try {
        results[index] = await fn(list[index], index);
      } catch (error) {
        // Stop handing out new work immediately, but let the already in-flight
        // workers settle (Promise.allSettled below) so nothing is orphaned.
        aborted = true;
        throw error;
      }
    }
  };

  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(workers, list.length) }, () => run())
  );

  const failure = settled.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  if (failure) {
    aborted = true;
    throw failure.reason;
  }
  return results;
}

// ============================================================================
// Logging, metrics and deadlines
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4
};

function currentLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  if (
    raw === 'debug' ||
    raw === 'info' ||
    raw === 'warn' ||
    raw === 'error' ||
    raw === 'silent'
  ) {
    return raw;
  }
  return 'info';
}

/**
 * Level-filtered logger that prefixes every line with the crawler name.
 * Controlled by `LOG_LEVEL=debug|info|warn|error|silent` (default `info`).
 */
export class CrawlerLogger {
  constructor(private readonly name: string) {}

  private enabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLogLevel()];
  }

  public debug(message: string): void {
    if (this.enabled('debug')) console.debug(`[${this.name}] ${message}`);
  }

  public info(message: string): void {
    if (this.enabled('info')) console.log(`[${this.name}] ${message}`);
  }

  public warn(message: string): void {
    if (this.enabled('warn')) console.warn(`[${this.name}] ${message}`);
  }

  public error(message: string): void {
    if (this.enabled('error')) console.error(`[${this.name}] ${message}`);
  }
}

/** Simple string-keyed counters printed at the end of each adapter run. */
export class CrawlerMetrics {
  private readonly counters = new Map<string, number>();

  public add(key: string, count = 1): void {
    if (!key) return;
    const delta = Number.isFinite(count) ? Math.floor(count) : 1;
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  public get(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  public reset(): void {
    this.counters.clear();
  }

  public toString(): string {
    if (!this.counters.size) return '(no metrics)';
    return [...this.counters.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }
}

/**
 * Optional wall-clock budget for a whole adapter run.
 * `new Deadline()` reads `CRAWLER_TIME_BUDGET_MS` (`0` = disabled);
 * an explicit millisecond budget overrides the environment.
 */
export class Deadline {
  private readonly startedAt = Date.now();
  private readonly budgetMs: number;

  constructor(budgetMs?: number) {
    if (typeof budgetMs === 'number' && Number.isFinite(budgetMs)) {
      this.budgetMs = Math.max(0, Math.floor(budgetMs));
    } else {
      const fromEnv = Number.parseInt(
        process.env.CRAWLER_TIME_BUDGET_MS || '0',
        10
      );
      this.budgetMs = Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 0;
    }
  }

  public get enabled(): boolean {
    return this.budgetMs > 0;
  }

  public get expired(): boolean {
    if (!this.enabled) return false;
    return Date.now() - this.startedAt >= this.budgetMs;
  }

  public get remainingMs(): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }
}

// ============================================================================
// Record construction, scoring and merging
// ============================================================================

export interface BuildTorrentRecordInput {
  title: string;
  type: ContentType;
  /** Hex (40 chars) or Base32 (32 chars); normalised to lowercase hex. */
  infoHash: string;
  magnetUrl?: string | null;
  torrentFileUrl?: string | null;
  sourceUrl?: string | null;
  trackers?: readonly string[] | null;
  audio?: readonly string[] | null;
  subtitles?: readonly string[] | null;
  /** Parsed title metadata used as a fallback for season/episode/codec/... */
  meta?: ParsedMetadata | null;
  season?: number | null;
  episode?: number | null;
  absoluteEpisode?: number | null;
  releaseGroup?: string | null;
  quality?: string | null;
  codec?: string | null;
  channels?: string | null;
  hdrFormat?: string | null;
  sizeBytes?: number | null;
  /** Unknown swarm counters stay `null`: they are never fabricated here. */
  seeders?: number | null;
  leechers?: number | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  sourceTracker?: string | null;
}

function cleanOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function cleanNonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return null;
}

/** Sizes must be real byte counts: rejects NaN, negatives and > 2^53. */
function cleanSafePositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? floored : null;
}

function normalizeImdbId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/^tt/i, '');
  if (/^\d{1,10}$/.test(digits) && Number.parseInt(digits, 10) > 0) {
    return `tt${digits.padStart(7, '0')}`;
  }
  return null;
}

function isContentType(value: unknown): value is ContentType {
  return (
    value === 'movie' || value === 'series' || value === 'anime' || value === 'documentary'
  );
}

/**
 * Builds a validated `TorrentRecord`, or `null` when the hash/title are bad.
 *
 *   - The infohash is normalised (hex/Base32 accepted, all-zeros rejected).
 *   - The title is whitespace-normalised and must be non-empty.
 *   - Trackers/audio/subtitles are deduped; `source_tracker` falls back to
 *     the first tracker.
 *   - When no magnet is supplied, a valid one is generated from the hash,
 *     title and trackers (public fallback trackers when the release lists
 *     none).
 *   - `meta` fills season/episode/codec/channels/quality gaps; explicit
 *     parameters always win.
 */
export function buildTorrentRecord(
  input: BuildTorrentRecordInput
): TorrentRecord | null {
  if (!input || typeof input !== 'object') return null;

  const hash = normalizeInfoHash(input.infoHash);
  if (!hash || /^0{40}$/.test(hash)) return null;

  const title = cleanText(input.title);
  if (!title) return null;

  const type: ContentType = isContentType(input.type) ? input.type : 'movie';
  const meta = input.meta ?? null;

  const trackers = dedupeStrings([...(input.trackers ?? [])]);
  // Canonicalising here (instead of in every adapter) is what stops the same
  // language from being stored as both 'Castellano' and 'Spanish'.
  const audio = dedupeStrings((input.audio ?? []).map(canonicalAudioTag));
  const subtitles = dedupeStrings((input.subtitles ?? []).map(canonicalSubtitleTag));

  const magnetTrackers = trackers.length
    ? trackers
    : [...MAGNET_DEFAULT_TRACKERS.slice(0, 3)];
  const trackerQuery = magnetTrackers
    .map(tracker => `&tr=${encodeURIComponent(tracker)}`)
    .join('');
  const magnetUrl =
    cleanOptionalText(input.magnetUrl) ??
    `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackerQuery}`;

  return {
    type,
    info_hash: hash,
    title,
    audio,
    subtitles,
    magnet_url: magnetUrl,
    torrent_file_url: cleanOptionalText(input.torrentFileUrl),
    source_url: cleanOptionalText(input.sourceUrl),
    season: cleanNonNegativeInt(input.season ?? meta?.season),
    episode: cleanNonNegativeInt(input.episode ?? meta?.episode),
    absolute_episode: cleanNonNegativeInt(input.absoluteEpisode ?? meta?.absoluteEpisode),
    release_group:
      cleanOptionalText(input.releaseGroup) ?? cleanOptionalText(meta?.releaseGroup),
    quality:
      cleanOptionalText(input.quality) ?? cleanOptionalText(meta?.resolution),
    codec: cleanOptionalText(input.codec) ?? cleanOptionalText(meta?.codec),
    hdr_format:
      cleanOptionalText(input.hdrFormat) ?? cleanOptionalText(meta?.hdrFormat),
    channels:
      cleanOptionalText(input.channels) ?? cleanOptionalText(meta?.channels),
    size_bytes: cleanSafePositiveInt(input.sizeBytes),
    seeders: cleanNonNegativeInt(input.seeders),
    leechers: cleanNonNegativeInt(input.leechers),
    imdb_id: normalizeImdbId(input.imdbId),
    tmdb_id: cleanNonNegativeInt(input.tmdbId),
    source_tracker: cleanOptionalText(input.sourceTracker) ?? trackers[0] ?? null
  };
}

/**
 * Completeness score: the richer of two same-hash candidates becomes the
 * merge base in `BaseCrawler.deduplicateRecords`.
 */
export function recordScore(record: TorrentRecord): number {
  if (!record || typeof record !== 'object') return 0;
  let score = 0;
  if (record.title) score += Math.min(record.title.length, 80) / 10;
  if (record.imdb_id) score += 6;
  if (record.tmdb_id) score += 4;
  if (record.size_bytes) score += 3;
  if (record.seeders !== null && record.seeders !== undefined) score += 2;
  if (record.leechers !== null && record.leechers !== undefined) score += 1;
  if (record.quality) score += 2;
  if (record.season !== null && record.season !== undefined) score += 1;
  if (record.episode !== null && record.episode !== undefined) score += 1;
  if (record.codec) score += 1;
  if (record.channels) score += 1;
  if (record.release_group) score += 1;
  if (record.hdr_format) score += 1;
  if (record.magnet_url) score += 1;
  if (record.torrent_file_url) score += 1;
  if (record.source_url) score += 1;
  if (Array.isArray(record.audio)) score += record.audio.length;
  if (Array.isArray(record.subtitles)) score += record.subtitles.length;
  return score;
}

/**
 * Fills the gaps of `primary` with values from `secondary` (same infohash).
 * Scalars keep the primary value whenever set; audio/subtitle tags are
 * unioned. Nothing is ever invented.
 */
export function mergeRecords(
  primary: TorrentRecord,
  secondary: TorrentRecord
): TorrentRecord {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const merged: TorrentRecord = { ...primary };
  const target = merged as unknown as Record<string, unknown>;

  const fill = (key: keyof TorrentRecord): void => {
    const current = target[key as string];
    if (current === null || current === undefined || current === '') {
      const fallback = (secondary as unknown as Record<string, unknown>)[key as string];
      target[key as string] = fallback ?? null;
    }
  };

  fill('imdb_id');
  fill('tmdb_id');
  fill('kitsu_id');
  fill('anilist_id');
  fill('mal_id');
  fill('season');
  fill('episode');
  fill('absolute_episode');
  fill('file_index');
  fill('magnet_url');
  fill('torrent_file_url');
  fill('source_url');
  fill('release_group');
  fill('quality');
  fill('codec');
  fill('hdr_format');
  fill('channels');
  fill('size_bytes');
  fill('seeders');
  fill('leechers');
  fill('source_tracker');

  merged.audio = dedupeStrings([...(primary.audio ?? []), ...(secondary.audio ?? [])].map(canonicalAudioTag));
  merged.subtitles = dedupeStrings(
    [...(primary.subtitles ?? []), ...(secondary.subtitles ?? [])].map(canonicalSubtitleTag)
  );

  return merged;
}
