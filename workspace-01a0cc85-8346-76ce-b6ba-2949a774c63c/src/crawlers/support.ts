/**
 * Shared toolkit for every adapter in `src/crawlers/`.
 *
 * The site-specific logic (routes, selectors, link decoding) stays inside each
 * adapter. What lives here is the boring, easy-to-get-wrong plumbing that used to
 * be copy-pasted a dozen times: logging, counters, URL handling, numeric parsing,
 * deadlines, concurrency and the construction of a valid `TorrentRecord`.
 */

import { ContentType, TorrentRecord } from '../types/torrent.js';
import { buildMagnetUri, normalizeInfoHash } from '../utils/magnet.js';
import { ParsedMetadata } from '../utils/regex.js';

// ============================================================================
// Logging
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').trim().toLowerCase();
  if (raw in LEVEL_WEIGHT) return raw as LogLevel;
  return 'info';
}

/** Small prefixed logger so every line can be traced back to its adapter. */
export class CrawlerLogger {
  constructor(private readonly scope: string) {}

  private enabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLevel()];
  }

  public debug(message: string): void {
    if (this.enabled('debug')) console.log(`[${this.scope}] ${message}`);
  }

  public info(message: string): void {
    if (this.enabled('info')) console.log(`[${this.scope}] ${message}`);
  }

  public warn(message: string): void {
    if (this.enabled('warn')) console.warn(`[${this.scope}] ${message}`);
  }

  public error(message: string): void {
    if (this.enabled('error')) console.error(`[${this.scope}] ${message}`);
  }
}

// ============================================================================
// Metrics
// ============================================================================

export type MetricKey =
  | 'listings'
  | 'listingErrors'
  | 'details'
  | 'detailErrors'
  | 'downloads'
  | 'downloadErrors'
  | 'records'
  | 'skipped'
  | 'gated';

/** Per-run counters used for the end-of-crawl diagnostic line. */
export class CrawlerMetrics {
  private readonly counters = new Map<string, number>();

  public add(key: MetricKey | string, amount = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  public get(key: MetricKey | string): number {
    return this.counters.get(key) ?? 0;
  }

  public snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()]);
  }

  public toString(): string {
    const entries = [...this.counters.entries()].filter(([, value]) => value !== 0);
    if (!entries.length) return 'no activity';
    return entries.map(([key, value]) => `${key}=${value}`).join(' ');
  }
}

// ============================================================================
// Timing / pacing
// ============================================================================

export function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function jitter(baseMs: number, spreadMs = baseMs / 2): number {
  if (!(baseMs > 0)) return 0;
  return Math.round(baseMs + (Math.random() * 2 - 1) * spreadMs);
}

function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

/** Optional politeness delay between requests (`CRAWLER_REQUEST_DELAY_MS`). */
export function requestDelayMs(): number {
  return envInt('CRAWLER_REQUEST_DELAY_MS', 0);
}

export async function politePause(): Promise<void> {
  const delay = requestDelayMs();
  if (delay > 0) await sleep(jitter(delay));
}

/**
 * Wall-clock budget for a single adapter. A dead mirror used to be able to burn
 * the whole GitHub Actions timeout; now the adapter stops and reports instead.
 */
export class Deadline {
  private readonly endsAt: number | null;

  constructor(budgetMs?: number | null) {
    const budget = budgetMs ?? envInt('CRAWLER_TIME_BUDGET_MS', 0);
    this.endsAt = budget > 0 ? Date.now() + budget : null;
  }

  public get enabled(): boolean {
    return this.endsAt !== null;
  }

  public get expired(): boolean {
    return this.endsAt !== null && Date.now() >= this.endsAt;
  }

  public get remainingMs(): number {
    if (this.endsAt === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.endsAt - Date.now());
  }
}

// ============================================================================
// Text / URL helpers
// ============================================================================

export function cleanText(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** Resolves a possibly relative link and rejects anything that is not plain http(s). */
export function absoluteHttpUrl(value: string | undefined | null, base: string): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (!candidate || candidate.startsWith('#') || /^(javascript|data|mailto|tel):/i.test(candidate)) return null;
  try {
    const url = new URL(candidate, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Parses "1,234" / "1 234" / "N/A" swarm counters. Unknown stays `null`. */
export function parseCount(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  if (!value) return null;
  const match = String(value).replace(/[\s,.\u00a0]/g, '').match(/-?\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function clampNonNegative(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** `quality` column: resolution first, release source as a fallback. */
export function qualityOf(meta: Pick<ParsedMetadata, 'resolution' | 'source'>): string | null {
  return meta.resolution || meta.source || null;
}

export function dedupeStrings(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const clean = cleanText(value ?? '');
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output;
}

/** Adult / non-catalogue noise that should never reach the media database. */
const BLOCKED_TITLE_REGEX = /\b(xxx|porn(?:o|hub)?|onlyfans|brazzers|hentai|camrip[-_]?xxx|sexo\s+explicito)\b/i;

export function isBlockedTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return BLOCKED_TITLE_REGEX.test(title);
}

export const DEFAULT_TRACKERS: readonly string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

// ============================================================================
// Concurrency
// ============================================================================

/** Runs `worker` over `items` with a bounded pool, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner));
  return results;
}

// ============================================================================
// Record construction
// ============================================================================

export interface RecordDraft {
  title: string;
  type: ContentType;
  infoHash: string;
  sourceUrl?: string | null;
  magnetUrl?: string | null;
  torrentFileUrl?: string | null;
  trackers?: readonly string[];
  audio?: readonly string[];
  subtitles?: readonly string[];
  meta?: ParsedMetadata | null;
  season?: number | null;
  episode?: number | null;
  absoluteEpisode?: number | null;
  quality?: string | null;
  codec?: string | null;
  hdrFormat?: string | null;
  releaseGroup?: string | null;
  channels?: string | null;
  sizeBytes?: number | null;
  seeders?: number | null;
  leechers?: number | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  sourceTracker?: string | null;
  fileIndex?: number | null;
}

function normalizeImdb(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  return /^tt\d{7,9}$/.test(trimmed) ? trimmed : null;
}

/**
 * Single place where a `TorrentRecord` is created. It validates the infohash,
 * refuses sentinel/zero hashes, keeps unknown swarm counters as `null` (never
 * fabricates a zero) and always produces a usable magnet URI.
 */
export function buildTorrentRecord(draft: RecordDraft): TorrentRecord | null {
  const infoHash = normalizeInfoHash(draft.infoHash);
  if (!infoHash || /^0{40}$/.test(infoHash)) return null;

  const title = cleanText(draft.title) || cleanText(draft.meta?.cleanTitle ?? '');
  if (!title) return null;

  const meta = draft.meta ?? null;
  const trackers = dedupeStrings([...(draft.trackers ?? [])]);
  const magnet = draft.magnetUrl && draft.magnetUrl.startsWith('magnet:?')
    ? draft.magnetUrl
    : buildMagnetUri(infoHash, title, trackers);

  return {
    imdb_id: normalizeImdb(draft.imdbId),
    tmdb_id: draft.tmdbId && Number.isFinite(draft.tmdbId) ? Number(draft.tmdbId) : null,
    kitsu_id: null,
    anilist_id: null,
    mal_id: null,
    type: draft.type,
    season: clampNonNegative(draft.season ?? meta?.season ?? null),
    episode: clampNonNegative(draft.episode ?? meta?.episode ?? null),
    absolute_episode: clampNonNegative(draft.absoluteEpisode ?? meta?.absoluteEpisode ?? null),
    file_index: draft.fileIndex ?? null,
    info_hash: infoHash,
    magnet_url: magnet,
    torrent_file_url: draft.torrentFileUrl ?? null,
    source_url: draft.sourceUrl ?? null,
    title,
    release_group: draft.releaseGroup ?? meta?.releaseGroup ?? null,
    quality: draft.quality ?? (meta ? qualityOf(meta) : null),
    codec: draft.codec ?? meta?.codec ?? null,
    hdr_format: draft.hdrFormat ?? meta?.hdrFormat ?? null,
    audio: dedupeStrings(draft.audio ?? []),
    subtitles: dedupeStrings(draft.subtitles ?? []),
    channels: draft.channels ?? meta?.channels ?? null,
    size_bytes: clampNonNegative(draft.sizeBytes ?? null),
    seeders: clampNonNegative(draft.seeders ?? null),
    leechers: clampNonNegative(draft.leechers ?? null),
    source_tracker: draft.sourceTracker ?? trackers[0] ?? null
  };
}

/** Counts how much real information a record carries, used when merging duplicates. */
export function recordScore(record: TorrentRecord): number {
  let score = 0;
  const fields: Array<keyof TorrentRecord> = [
    'imdb_id', 'tmdb_id', 'season', 'episode', 'absolute_episode', 'magnet_url', 'torrent_file_url',
    'source_url', 'release_group', 'quality', 'codec', 'hdr_format', 'channels', 'size_bytes',
    'seeders', 'leechers', 'source_tracker'
  ];
  for (const field of fields) {
    const value = record[field];
    if (value !== null && value !== undefined && value !== '') score++;
  }
  score += record.audio.length + record.subtitles.length;
  return score;
}

/** Field-wise merge that prefers real values over nulls without inventing data. */
export function mergeRecords(primary: TorrentRecord, secondary: TorrentRecord): TorrentRecord {
  const pick = <K extends keyof TorrentRecord>(key: K): TorrentRecord[K] => {
    const value = primary[key];
    if (value === null || value === undefined || value === '') return secondary[key];
    return value;
  };

  return {
    ...primary,
    imdb_id: pick('imdb_id'),
    tmdb_id: pick('tmdb_id'),
    season: pick('season'),
    episode: pick('episode'),
    absolute_episode: pick('absolute_episode'),
    magnet_url: pick('magnet_url'),
    torrent_file_url: pick('torrent_file_url'),
    source_url: pick('source_url'),
    release_group: pick('release_group'),
    quality: pick('quality'),
    codec: pick('codec'),
    hdr_format: pick('hdr_format'),
    channels: pick('channels'),
    size_bytes: pick('size_bytes'),
    seeders: pick('seeders'),
    leechers: pick('leechers'),
    source_tracker: pick('source_tracker'),
    audio: dedupeStrings([...primary.audio, ...secondary.audio]),
    subtitles: dedupeStrings([...primary.subtitles, ...secondary.subtitles])
  };
}
