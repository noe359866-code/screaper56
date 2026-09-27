import { config, DbBackend } from '../config/env.js';
import { TorrentRecord } from '../types/torrent.js';
import { sanitizeAndDeduplicate } from './sanitize.js';

/** Contadores acumulados de una ejecución (todas las llamadas a upsertBatch). */
export interface RepositoryWriteStats {
  /** Filas nuevas insertadas. */
  inserted: number;
  /** Filas existentes que cambiaron realmente (contadores o metadatos rellenados). */
  updated: number;
  /** Filas existentes que ya estaban al día: no se escribió nada. */
  unchanged: number;
  /** Registros que no se pudieron persistir tras agotar los reintentos. */
  failed: number;
}

/**
 * Contrato de persistencia usado por el orquestador. Implementaciones:
 *  - PostgresTorrentRepository : cualquier PostgreSQL (Supabase, CockroachDB, servidor propio).
 *  - SupabaseTorrentRepository : API REST de Supabase (legado).
 *  - DryRunTorrentRepository   : no escribe, solo cuenta.
 */
export interface TorrentRepository {
  readonly backend: DbBackend;
  /** Descripción legible (sin credenciales) para los logs de arranque. */
  describe(): string;
  /**
   * Persiste los registros deduplicados por `info_hash`.
   * Devuelve cuántos registros quedaron sincronizados (nuevos + actualizados + sin cambios).
   */
  upsertBatch(records: TorrentRecord[], batchSize?: number): Promise<number>;
  /** Estadísticas acumuladas de escritura. */
  getStats(): RepositoryWriteStats;
  /** Libera conexiones. Obligatorio antes de terminar el proceso. */
  close(): Promise<void>;
}

export function emptyStats(): RepositoryWriteStats {
  return { inserted: 0, updated: 0, unchanged: 0, failed: 0 };
}

export class DryRunTorrentRepository implements TorrentRepository {
  public readonly backend: DbBackend = 'dry-run';
  private readonly stats = emptyStats();

  describe(): string {
    return 'dry-run (no DB writes)';
  }

  async upsertBatch(records: TorrentRecord[]): Promise<number> {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const validRecords = sanitizeAndDeduplicate(records);
    if (validRecords.length === 0) return 0;
    console.log(`[DRY RUN] DB UPSERT: Would upsert ${validRecords.length} records. Skipping.`);
    this.stats.unchanged += validRecords.length;
    return validRecords.length;
  }

  getStats(): RepositoryWriteStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    /* nada que cerrar */
  }
}

/**
 * Elige la implementación según el entorno:
 *  DRY_RUN=true  → DryRunTorrentRepository
 *  DATABASE_URL  → PostgresTorrentRepository (recomendado)
 *  SUPABASE_URL  → SupabaseTorrentRepository (legado)
 */
export async function createTorrentRepository(): Promise<TorrentRepository> {
  switch (config.dbBackend) {
    case 'dry-run':
      return new DryRunTorrentRepository();
    case 'postgres': {
      const { PostgresTorrentRepository } = await import('./postgres.js');
      const repository = new PostgresTorrentRepository({
        connectionString: config.databaseUrl,
        table: config.dbTable,
        writePolicy: config.dbWritePolicy,
        sslCa: config.databaseSslCa || undefined,
        sslNoVerify: config.databaseSslNoVerify,
        batchSize: config.dbBatchSize,
        poolSize: config.concurrencyLimit + 1
      });
      // Comprobación previa: conexión, TLS y tabla. Falla ANTES de gastar media
      // hora crawleando si la base de datos está mal configurada.
      try {
        await repository.getTableMeta();
      } catch (error) {
        await repository.close().catch(() => undefined);
        throw error;
      }
      return repository;
    }
    case 'supabase': {
      const { SupabaseTorrentRepository } = await import('./supabase.js');
      console.warn('[DB] Using the legacy Supabase REST backend. Set DATABASE_URL to use the provider-agnostic PostgreSQL backend.');
      return new SupabaseTorrentRepository();
    }
    default: {
      const unreachable: never = config.dbBackend;
      throw new Error(`Unknown database backend: ${String(unreachable)}`);
    }
  }
}
