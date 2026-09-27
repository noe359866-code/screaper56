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
    // Nota: 42P10 (no unique constraint matching ON CONFLICT) se maneja aparte con fallback, no como fallo crítico
    if (code === '42P10') return false;
    return code.startsWith('22') || code.startsWith('23') || code.startsWith('42');
  }

  private static isMissingOnConflictConstraintError(error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined): boolean {
    if (!error) return false;
    if (error.code === '42P10') return true;
    const combined = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();
    return combined.includes('no unique or exclusion constraint matching the on conflict');
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
   * Intenta insertar un chunk sin ON CONFLICT (fallback cuando falta el índice único).
   * Primero prueba insert masivo; si falla por duplicados, hace upsert fila a fila.
   */
  private async fallbackInsertChunk(chunk: SanitizedTorrentRecord[]): Promise<{ inserted: number; error?: string }> {
    if (!this.client) return { inserted: 0, error: 'Client uninitialized' };

    // Intento 1: insert masivo simple (funciona si no hay constraint, o si no hay duplicados)
    const { error: insertError } = await this.client.from('torrents').insert(chunk);
    if (!insertError) {
      return { inserted: chunk.length };
    }

    // Si el error NO es de duplicado, lo reportamos
    const isDuplicate = insertError.code === '23505' || insertError.message?.toLowerCase().includes('duplicate');
    if (!isDuplicate) {
      // No es duplicado, puede ser otro error de esquema; intentamos registro a registro para rescatar los que sí entran
    }

    // Intento 2: fila por fila con manejo de duplicado -> update
    let inserted = 0;
    let lastError = insertError.message;
    for (const rec of chunk) {
      const { error: rowInsertError } = await this.client.from('torrents').insert(rec);
      if (!rowInsertError) {
        inserted++;
        continue;
      }
      // Si es duplicado y tenemos constraint, intentamos update
      if (rowInsertError.code === '23505' || rowInsertError.message?.toLowerCase().includes('duplicate')) {
        const { error: updateError } = await this.client
          .from('torrents')
          .update(rec)
          .eq('info_hash', rec.info_hash);
        if (!updateError) {
          inserted++;
        } else {
          lastError = updateError.message;
        }
      } else {
        lastError = rowInsertError.message;
      }
    }
    if (inserted > 0) return { inserted };
    return { inserted: 0, error: lastError };
  }

  /**
   * Ejecuta UPSERT masivo deduplicado por info_hash con fallback automático si falta el índice único.
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
    let schemaFallbackMode = false;
    let schemaWarningLogged = false;

    for (let i = 0; i < validRecords.length; i += batchSize) {
      const chunk = validRecords.slice(i, i + batchSize);
      let success = false;
      const currentBatchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(validRecords.length / batchSize);

      // Si ya detectamos falta de constraint, vamos directo a fallback sin intentar onConflict
      if (schemaFallbackMode) {
        const { inserted, error } = await this.fallbackInsertChunk(chunk);
        if (inserted > 0) {
          totalUpserted += inserted;
          console.log(`[SUPABASE] Batch ${currentBatchNumber}/${totalBatches} saved via fallback INSERT: ${inserted}/${chunk.length} torrents.`);
          success = true;
        } else {
          console.error(`[SUPABASE] Batch ${currentBatchNumber}/${totalBatches} fallback failed: ${error ?? 'unknown'}`);
        }
        if (!success) {
          console.error(`[SUPABASE] ❌ Batch ${currentBatchNumber} could not be saved via fallback.`);
        }
        continue;
      }

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const { error } = await this.client
            .from('torrents')
            .upsert(chunk, {
              onConflict: onConflictColumn,
              ignoreDuplicates: false
            });

          if (error) {
            // --- FIX CRÍTICO: detectar falta de índice único y hacer fallback en lugar de reintentar indefinidamente ---
            if (SupabaseTorrentRepository.isMissingOnConflictConstraintError(error)) {
              if (!schemaWarningLogged) {
                console.warn(`[SUPABASE] ⚠️  Schema error detectado: la tabla "torrents" NO tiene UNIQUE constraint en "${onConflictColumn}".`);
                console.warn(`[SUPABASE]    El error "there is no unique or exclusion constraint matching the ON CONFLICT specification" indica que falta el índice.`);
                console.warn(`[SUPABASE]    Solución permanente (ejecuta en Supabase SQL Editor):`);
                console.warn(`[SUPABASE]    → CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique ON public.torrents (info_hash);`);
                console.warn(`[SUPABASE]    Activando fallback automático INSERT para este run (sin ON CONFLICT). Datos no se perderán, pero pueden quedar duplicados hasta crear el índice.`);
                schemaWarningLogged = true;
              }
              schemaFallbackMode = true;
              // Intentar fallback inmediato para este chunk
              const { inserted, error: fbError } = await this.fallbackInsertChunk(chunk);
              if (inserted > 0) {
                totalUpserted += inserted;
                console.log(`[SUPABASE] Batch ${currentBatchNumber}/${totalBatches} recovered via fallback INSERT: ${inserted}/${chunk.length} torrents.`);
                success = true;
              } else {
                console.error(`[SUPABASE] Batch ${currentBatchNumber} (Attempt ${attempt}) fallback failed: ${fbError ?? error.message}`);
              }
              break; // salir del bucle de reintentos, pasar al siguiente batch en modo fallback
            }

            console.error(`[SUPABASE] Batch ${currentBatchNumber}/${totalBatches} (Attempt ${attempt}/${maxRetries}) failed:`, error.message);

            // Cancelar reintentos si el error no es solucionable reintentando (ej. error de sintaxis o constraint)
            if (SupabaseTorrentRepository.isNonRetriableError(error.code)) {
              console.error(`[SUPABASE] Non-retriable error (code ${error.code}). Skipping batch ${currentBatchNumber}.`);
              break;
            }

            if (attempt < maxRetries) {
              await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt))); // Backoff exponencial
              continue;
            }
          } else {
            success = true;
            totalUpserted += chunk.length;
            console.log(`[SUPABASE] Batch ${currentBatchNumber}/${totalBatches} saved: ${chunk.length} torrents.`);
            break;
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error(`[SUPABASE] Network crash on batch ${currentBatchNumber} [${i} to ${i + chunk.length}]:`, errorMessage);
          if (attempt < maxRetries) {
            await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt)));
          }
        }
      }

      if (!success && !schemaFallbackMode) {
        console.error(`[SUPABASE] ❌ Critical: Batch ${currentBatchNumber}/${totalBatches} permanently failed after ${maxRetries} attempts. ${chunk.length} records lost.`);
      } else if (!success && schemaFallbackMode) {
        // Ya logueado arriba en fallback
      }
    }

    if (schemaFallbackMode) {
      console.log(`[SUPABASE] Fallback mode completed: ${totalUpserted}/${validRecords.length} records persisted without ON CONFLICT. Crea el índice único para restaurar UPSERT idempotente.`);
    }

    return totalUpserted;
  }
}
