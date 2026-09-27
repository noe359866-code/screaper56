import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TorrentRecord } from '../types/torrent.js';
import { config, DbBackend } from '../config/env.js';
import {
  LegacyTorrentRow,
  SanitizedTorrentRecord,
  sanitizeAndDeduplicate,
  sanitizeTorrentRecord,
  toLegacyRow
} from './sanitize.js';
import { emptyStats, RepositoryWriteStats, TorrentRepository } from './torrent-repository.js';

export type { SanitizedTorrentRecord } from './sanitize.js';

/**
 * Backend LEGADO sobre la API REST de Supabase (PostgREST).
 * Se mantiene para no romper despliegues existentes; el backend recomendado es
 * `PostgresTorrentRepository` (DATABASE_URL), que funciona con Supabase,
 * CockroachDB o cualquier PostgreSQL y respeta los metadatos de otros procesos.
 */
export class SupabaseTorrentRepository implements TorrentRepository {
  public readonly backend: DbBackend = 'supabase';
  private client: SupabaseClient | null = null;
  private readonly isDryRun: boolean;
  private readonly stats: RepositoryWriteStats = emptyStats();

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

  describe(): string {
    return `supabase-rest ${config.supabaseUrl} (legacy)`;
  }

  getStats(): RepositoryWriteStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    /* el cliente REST no mantiene conexiones abiertas */
  }

  /**
   * Sanitiza y valida un registro (delegado al módulo compartido).
   */
  public sanitizeRecord(raw: TorrentRecord): SanitizedTorrentRecord | null {
    return sanitizeTorrentRecord(raw);
  }

  /**
   * Intenta insertar un chunk sin ON CONFLICT (fallback cuando falta el índice único).
   * Primero prueba insert masivo; si falla por duplicados, hace upsert fila a fila.
   */
  private async fallbackInsertChunk(chunk: LegacyTorrentRow[]): Promise<{ inserted: number; error?: string }> {
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

    // Deduplicación en memoria por info_hash antes del envío a la BD.
    // PostgREST no distingue "desconocido" de "cero": se aplica el default histórico.
    const validRecords: LegacyTorrentRow[] = sanitizeAndDeduplicate(records).map(toLegacyRow);
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
          this.stats.inserted += inserted;
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
                this.stats.inserted += inserted;
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
            this.stats.updated += chunk.length; // PostgREST no informa de nuevos vs. actualizados
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

      if (!success) {
        this.stats.failed += chunk.length;
        if (!schemaFallbackMode) {
          console.error(`[SUPABASE] ❌ Critical: Batch ${currentBatchNumber}/${totalBatches} permanently failed after ${maxRetries} attempts. ${chunk.length} records lost.`);
        }
      }
    }

    if (schemaFallbackMode) {
      console.log(`[SUPABASE] Fallback mode completed: ${totalUpserted}/${validRecords.length} records persisted without ON CONFLICT. Crea el índice único para restaurar UPSERT idempotente.`);
    }

    return totalUpserted;
  }
}
