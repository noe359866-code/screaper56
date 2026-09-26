import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TorrentRecord } from '../types/torrent.js';
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
  size_bytes: number;
  seeders: number;
  leechers: number;
  source_tracker: string | null;
}

// Regex pre-compilados fuera del flujo de ejecución (Ahorro importante de CPU)
const HEX_40_REGEX = /^[0-9a-f]{40}$/;
const IMDB_REGEX = /^tt\d+$/;
const DIGITS_ONLY_REGEX = /^\d+$/;

export class SupabaseTorrentRepository {
  private client: SupabaseClient | null = null;
  private readonly isDryRun: boolean;

  constructor() {
    this.isDryRun = config.dryRun;

    if (!this.isDryRun && config.supabaseUrl && config.supabaseServiceRoleKey) {
      this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      });
    }
  }

  // --- MÉTODOS ESTÁTICOS DE UTILIDAD ---

  private static parseNonNegativeInt(val: unknown, defaultValue: number | null = null): number | null {
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
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

  private static isNonRetriableError(code?: string): boolean {
    if (!code) return false;
    // Códigos de PostgreSQL: 22*** (Data Exception), 23*** (Integrity Violation), 42*** (Syntax/Schema Error)
    return code.startsWith('22') || code.startsWith('23') || code.startsWith('42');
  }

  /**
   * Sanitiza y valida un registro según las restricciones del esquema
   */
  public sanitizeRecord(raw: TorrentRecord): SanitizedTorrentRecord | null {
    if (!raw || typeof raw.info_hash !== 'string') return null;

    const cleanHash = raw.info_hash.toLowerCase().trim();
    if (!HEX_40_REGEX.test(cleanHash)) return null;

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length === 0) return null;

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
      title,
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

      size_bytes: SupabaseTorrentRepository.parseNonNegativeInt(raw.size_bytes, 0) ?? 0,
      seeders: SupabaseTorrentRepository.parseNonNegativeInt(raw.seeders, 0) ?? 0,
      leechers: SupabaseTorrentRepository.parseNonNegativeInt(raw.leechers, 0) ?? 0,
      source_tracker: SupabaseTorrentRepository.safeString(raw.source_tracker, 100)
    };
  }

  /**
   * Ejecuta UPSERT masivo deduplicado por info_hash
   */
  public async upsertBatch(
    records: TorrentRecord[],
    batchSize = 100,
    onConflictColumn = 'info_hash'
  ): Promise<number> {
    if (!Array.isArray(records) || records.length === 0) return 0;

    // Deduplicación en memoria por info_hash antes del envío a la BD
    const uniqueMap = new Map<string, SanitizedTorrentRecord>();
    for (const record of records) {
      const sanitized = this.sanitizeRecord(record);
      if (sanitized) uniqueMap.set(sanitized.info_hash, sanitized);
    }

    const validRecords = Array.from(uniqueMap.values());
    if (validRecords.length === 0) return 0;

    if (this.isDryRun) {
      console.log(`[DRY RUN] DB UPSERT: Would upsert ${validRecords.length} records. Skipping.`);
      return validRecords.length;
    }

    if (!this.client) {
      throw new Error('[SUPABASE] Client uninitialized. Database connection or credentials missing.');
    }

    let totalUpserted = 0;
    const maxRetries = 3;

    for (let i = 0; i < validRecords.length; i += batchSize) {
      const chunk = validRecords.slice(i, i + batchSize);
      let success = false;
      const currentBatchNumber = Math.floor(i / batchSize) + 1;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const { error } = await this.client
            .from('torrents')
            .upsert(chunk, {
              onConflict: onConflictColumn,
              ignoreDuplicates: false
            });

          if (error) {
            console.error(`[SUPABASE] Batch ${currentBatchNumber} (Attempt ${attempt}) failed:`, error.message);

            // Cancelar reintentos si el error no es solucionable reintentando (ej. error de sintaxis o constraint)
            if (SupabaseTorrentRepository.isNonRetriableError(error.code)) break;

            if (attempt < maxRetries) {
              await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt))); // Backoff exponencial
              continue;
            }
          } else {
            success = true;
            totalUpserted += chunk.length;
            console.log(`[SUPABASE] Batch ${currentBatchNumber} saved: ${chunk.length} torrents.`);
            break;
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error(`[SUPABASE] Network crash on batch [${i} to ${i + chunk.length}]:`, errorMessage);
          if (attempt < maxRetries) {
            await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt)));
          }
        }
      }

      if (!success) {
        console.error(`[SUPABASE] ❌ Critical: Batch ${currentBatchNumber} permanently failed after attempts.`);
      }
    }

    return totalUpserted;
  }
}
