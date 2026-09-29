import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TorrentRecord } from '../types/torrent.js';
import { mergeRecords, recordScore } from '../crawlers/support.js';
import { config } from '../config/env.js';

// Estructura sanitizada garantizada lista para persistir en la BD
export interface SanitizedTorrentRecord {
  info_hash: string;
  title: string;
  type: 'movie' | 'series' | 'anime';
  imdb_id: string | null;
  tmdb_id: number | null;
  kitsu_id: number | null;
  anilist_id: number | null;
  mal_id: number | null;
  season: number | null;
  episode: number | null;
  absolute_episode: number | null;
  file_index: number | null;
  release_group: string | null;
  quality: string;
  codec: string | null;
  hdr_format: string | null;
  audio: string[];
  subtitles: string[];
  channels: string | null;
  /**
   * Unknown counters are OMITTED (left `undefined`) instead of being written as
   * `0`. Records must also be grouped by column set before bulk UPSERT:
   * PostgREST otherwise uses the union of keys and fills missing values.
   */
  size_bytes?: number;
  seeders?: number;
  leechers?: number;
  source_tracker: string | null;
}

// Regex pre-compilados fuera del flujo de ejecución (Ahorro importante de CPU)
const HEX_40_REGEX = /^[0-9a-f]{40}$/;
const IMDB_REGEX = /^tt\d{7,10}$/;
const DIGITS_ONLY_REGEX = /^\d+$/;

/** Every other column is capped by `safeString`; the title had no bound at all. */
const MAX_TITLE_LENGTH = 500;

export interface RepositoryOptions {
  dryRun?: boolean;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  client?: SupabaseClient;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Includes confirmed writes so the orchestrator can report a partial failure. */
export class BatchPersistenceError extends Error {
  constructor(public readonly persisted: number, public readonly attempted: number,
    public readonly rejected: number, public readonly failures: readonly string[]) {
    super(`Database persistence incomplete: ${persisted}/${attempted} saved, ${rejected} rejected. ${failures.join('; ')}`);
    this.name = 'BatchPersistenceError';
  }
}

export class SupabaseTorrentRepository {
  private client: SupabaseClient | null = null;
  private readonly isDryRun: boolean;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RepositoryOptions = {}) {
    this.isDryRun = options.dryRun ?? config.dryRun;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new Error('Invalid Supabase timeoutMs');
    }
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (!this.isDryRun) {
      this.client = options.client ?? createClient(options.supabaseUrl ?? config.supabaseUrl, options.supabaseServiceRoleKey ?? config.supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    }
  }

  // --- MÉTODOS ESTÁTICOS DE UTILIDAD ---

  private static parseNonNegativeInt(val: unknown, defaultValue: number | null = null): number | null {
    if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) {
      return Math.floor(val);
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (DIGITS_ONLY_REGEX.test(trimmed)) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
    }
    return defaultValue;
  }

  private static safeString(val: unknown, maxLength: number, defaultValue: string | null = null): string | null {
    if (typeof val !== 'string') return defaultValue;
    const trimmed = val.trim();
    if (trimmed.length === 0) return defaultValue;
    return trimmed.substring(0, maxLength);
  }

  /**
   * Sanitiza y valida un registro según las restricciones del esquema
   */
  public sanitizeRecord(raw: TorrentRecord): SanitizedTorrentRecord | null {
    if (!raw || typeof raw.info_hash !== 'string') return null;

    const cleanHash = raw.info_hash.toLowerCase().trim();
    if (!HEX_40_REGEX.test(cleanHash) || /^0{40}$/.test(cleanHash)) return null;

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length === 0 || title.includes('\0')) return null;

    let validImdbId: string | null = null;
    if (typeof raw.imdb_id === 'string') {
      const trimmedId = raw.imdb_id.trim();
      if (IMDB_REGEX.test(trimmedId)) validImdbId = trimmedId;
    }

    let validType: 'movie' | 'series' | 'anime' = 'movie';
    if (raw.type === 'series' || raw.type === 'anime') validType = raw.type;

    // Trimeado y deduplicado estricto de elementos en arrays
    const cleanAudio = Array.isArray(raw.audio)
      ? Array.from(
          new Set(
            raw.audio
              .filter((a): a is string => typeof a === 'string')
              .map(a => a.trim())
              .filter(a => a.length > 0)
          )
        )
      : [];

    const cleanSubs = Array.isArray(raw.subtitles)
      ? Array.from(
          new Set(
            raw.subtitles
              .filter((s): s is string => typeof s === 'string')
              .map(s => s.trim())
              .filter(s => s.length > 0)
          )
        )
      : [];

    return {
      info_hash: cleanHash,
      // Same bounding discipline as every other string column: a 300+ char
      // release name must not break a whole batch against a varchar column.
      title: title.substring(0, MAX_TITLE_LENGTH),
      type: validType,
      imdb_id: validImdbId,
      tmdb_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.tmdb_id),
      kitsu_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.kitsu_id),
      anilist_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.anilist_id),
      mal_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.mal_id),

      season: SupabaseTorrentRepository.parseNonNegativeInt(raw.season),
      episode: SupabaseTorrentRepository.parseNonNegativeInt(raw.episode),
      absolute_episode: SupabaseTorrentRepository.parseNonNegativeInt(raw.absolute_episode),
      file_index: SupabaseTorrentRepository.parseNonNegativeInt(raw.file_index),

      release_group: SupabaseTorrentRepository.safeString(raw.release_group, 100),
      quality: SupabaseTorrentRepository.safeString(raw.quality, 20, 'Unknown') ?? 'Unknown',
      codec: SupabaseTorrentRepository.safeString(raw.codec, 20),
      hdr_format: SupabaseTorrentRepository.safeString(raw.hdr_format, 20),

      audio: cleanAudio,
      subtitles: cleanSubs,
      channels: SupabaseTorrentRepository.safeString(raw.channels, 10),

      size_bytes: SupabaseTorrentRepository.parseNonNegativeInt(raw.size_bytes) ?? undefined,
      seeders: SupabaseTorrentRepository.parseNonNegativeInt(raw.seeders) ?? undefined,
      leechers: SupabaseTorrentRepository.parseNonNegativeInt(raw.leechers) ?? undefined,
      source_tracker: SupabaseTorrentRepository.safeString(raw.source_tracker, 100)
    };
  }

  /** Unknown metadata must not erase an existing value on UPDATE. */
  private static pruneUnknown(record: SanitizedTorrentRecord): SanitizedTorrentRecord {
    return Object.fromEntries(Object.entries(record).filter(([key, value]) =>
      value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0) &&
      !(key === 'quality' && value === 'Unknown')
    )) as SanitizedTorrentRecord;
  }

  /**
   * Requires UNIQUE(info_hash). Never falls back to non-idempotent INSERT.
   * Sparse records are grouped by key set to preserve absent columns on UPDATE.
   * A return value means the entire validated batch succeeded; otherwise throws
   * BatchPersistenceError with confirmed writes (not a transaction rollback).
   */
  public async upsertBatch(records: TorrentRecord[], batchSize = 100, onConflictColumn = 'info_hash'): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('batchSize must be an integer between 1 and 10000');
    }
    if (onConflictColumn !== 'info_hash') throw new Error('Only info_hash conflict resolution is supported');
    if (!Array.isArray(records)) throw new Error('records must be an array');
    if (!records.length) return 0;

    const unique = new Map<string, TorrentRecord>();
    let rejected = 0;
    for (const record of records) {
      const sanitized = this.sanitizeRecord(record);
      if (!sanitized) { rejected++; continue; }
      const normalized: TorrentRecord = { ...sanitized, quality: sanitized.quality === 'Unknown' ? null : sanitized.quality };
      const previous = unique.get(sanitized.info_hash);
      unique.set(sanitized.info_hash, previous
        ? recordScore(previous) >= recordScore(normalized) ? mergeRecords(previous, normalized) : mergeRecords(normalized, previous)
        : normalized);
    }
    const valid: SanitizedTorrentRecord[] = [];
    for (const record of unique.values()) {
      const resanitized = this.sanitizeRecord(record);
      // Defensive: merged records are sanitizeRecord outputs, so a null here
      // can only be a merge bug. Count it as rejected (the same contract as
      // the first pass) instead of crashing with a TypeError on pruneUnknown.
      if (!resanitized) { rejected++; continue; }
      valid.push(SupabaseTorrentRepository.pruneUnknown(resanitized));
    }
    const failures: string[] = [];
    let persisted = 0;

    if (this.isDryRun) {
      if (rejected) throw new BatchPersistenceError(0, valid.length, rejected, ['Validation failed in dry run']);
      console.log(`[DRY RUN] Would upsert ${valid.length} records; no database writes.`);
      return valid.length;
    }
    if (!this.client) throw new Error('[SUPABASE] Client uninitialized');

    // PostgREST derives its columns from the union of all keys in an array.
    // Grouping is essential even after removing undefined/null values.
    const groups = new Map<string, SanitizedTorrentRecord[]>();
    for (const record of valid) {
      const key = Object.keys(record).sort().join(',');
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    let fatal = false;
    const save = async (chunk: SanitizedTorrentRecord[]): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let error: { code?: string; message?: string } | null;
        let status = 0;
        try {
          const response = await this.client!.from('torrents')
            .upsert(chunk, { onConflict: 'info_hash', ignoreDuplicates: false, defaultToNull: false })
            .abortSignal(AbortSignal.timeout(this.timeoutMs));
          error = response.error;
          status = response.status;
        } catch (caught) {
          error = { message: caught instanceof Error ? caught.message : String(caught) };
        }
        if (!error) { persisted += chunk.length; return; }
        const code = error.code ?? '';
        // Splitting retains UPSERT semantics, including when a smaller request
        // fails again. A bad row must not discard unrelated valid rows.
        const splittable = status === 413 || ['413', '54000'].includes(code) || /^(22|23)/.test(code);
        if (splittable && chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          await save(chunk.slice(0, half));
          if (!fatal) await save(chunk.slice(half));
          return;
        }
        const permanent = splittable || (/^(42|28|PGRST)/.test(code) && !/^PGRST00[0-3]$/.test(code)) ||
          (status >= 400 && status < 500 && ![408, 429].includes(status));
        if (!permanent && attempt < 2) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        // Do not expose row contents, tokens, or server error details in logs.
        const reason = code === '42P10'
          ? 'Missing UNIQUE(info_hash); create the unique index after resolving existing duplicates. Unsafe INSERT fallback disabled.'
          : `Database request failed (status=${status}, code=${code || 'network'}; rows=${chunk.length})`;
        failures.push(reason);
        if (!splittable) fatal = true;
        return;
      }
    };
    for (const group of groups.values()) {
      for (let i = 0; i < group.length && !fatal; i += batchSize) await save(group.slice(i, i + batchSize));
      if (fatal) break;
    }
    if (failures.length || rejected) throw new BatchPersistenceError(persisted, valid.length, rejected, failures);
    return persisted;
  }
}
