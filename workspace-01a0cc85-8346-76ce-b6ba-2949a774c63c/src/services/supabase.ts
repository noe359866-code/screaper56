import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TorrentRecord } from '../types/torrent.js';
import { config } from '../config/env.js';

export class SupabaseTorrentRepository {
  private client: SupabaseClient | null = null;
  private isDryRun: boolean;

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

  // --- MÉTODOS ESTÁTICOS DE UTILIDAD (Optimizan CPU y Memoria) ---

  private static parseNonNegativeInt(val: unknown, defaultValue: number | null = null): number | null {
    if (typeof val === 'number' && !isNaN(val)) {
      return val >= 0 ? Math.floor(val) : defaultValue;
    }
    if (typeof val === 'string') {
      const parsed = parseInt(val.trim(), 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
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
   * Sanitiza y valida según las restricciones exactas de tu tabla SQL
   */
  public sanitizeRecord(raw: TorrentRecord): Record<string, any> | null {
    if (typeof raw.info_hash !== 'string') return null;
    const cleanHash = raw.info_hash.toLowerCase().trim();
    
    // 1. Info hash obligatorio: 40 caracteres hexadecimales
    if (!/^[0-9a-f]{40}$/.test(cleanHash)) return null;

    // 2. Título obligatorio
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length === 0) return null;

    // 3. Validación de constraint torrents_imdb_format (^tt[0-9]+$)
    let validImdbId: string | null = null;
    if (typeof raw.imdb_id === 'string') {
      const trimmedId = raw.imdb_id.trim();
      if (/^tt[0-9]+$/.test(trimmedId)) validImdbId = trimmedId;
    }

    // 4. Validación de constraint torrents_type_valid ('movie', 'series', 'anime')
    let validType: 'movie' | 'series' | 'anime' = 'movie';
    if (raw.type === 'series' || raw.type === 'anime') validType = raw.type;

    // 5. Limpieza de Arrays (Evita guardar strings vacíos en los arrays)
    const cleanAudio = Array.isArray(raw.audio) 
      ? Array.from(new Set(raw.audio.filter(a => typeof a === 'string' && a.trim().length > 0))) 
      : [];
    const cleanSubs = Array.isArray(raw.subtitles) 
      ? Array.from(new Set(raw.subtitles.filter(s => typeof s === 'string' && s.trim().length > 0))) 
      : [];

    return {
      imdb_id: validImdbId,
      tmdb_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.tmdb_id),
      kitsu_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.kitsu_id),
      anilist_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.anilist_id),
      mal_id: SupabaseTorrentRepository.parseNonNegativeInt(raw.mal_id),

      type: validType,

      season: SupabaseTorrentRepository.parseNonNegativeInt(raw.season),
      episode: SupabaseTorrentRepository.parseNonNegativeInt(raw.episode),
      absolute_episode: SupabaseTorrentRepository.parseNonNegativeInt(raw.absolute_episode),
      file_index: SupabaseTorrentRepository.parseNonNegativeInt(raw.file_index),

      info_hash: cleanHash,
      title: title,
      release_group: SupabaseTorrentRepository.safeString(raw.release_group, 100),
      quality: SupabaseTorrentRepository.safeString(raw.quality, 20, 'Unknown'),
      codec: SupabaseTorrentRepository.safeString(raw.codec, 20),
      hdr_format: SupabaseTorrentRepository.safeString(raw.hdr_format, 20),

      audio: cleanAudio,
      subtitles: cleanSubs,
      channels: SupabaseTorrentRepository.safeString(raw.channels, 10),

      size_bytes: SupabaseTorrentRepository.parseNonNegativeInt(raw.size_bytes, 0),
      seeders: SupabaseTorrentRepository.parseNonNegativeInt(raw.seeders, 0),
      leechers: SupabaseTorrentRepository.parseNonNegativeInt(raw.leechers, 0),
      source_tracker: SupabaseTorrentRepository.safeString(raw.source_tracker, 100)
    };
  }

  /**
   * Ejecuta UPSERT masivo sobre el índice único idx_torrents_unique_hash (info_hash_clean)
   */
  public async upsertBatch(records: TorrentRecord[], batchSize = 100): Promise<number> {
    if (records.length === 0) return 0;

    // Deduplica por info_hash en memoria para evitar el error de lote en PostgreSQL
    const uniqueMap = new Map<string, Record<string, any>>();
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
      throw new Error('[SUPABASE] Client uninitialized. Database connection missing.');
    }

    let totalUpserted = 0;
    const maxRetries = 3;

    for (let i = 0; i < validRecords.length; i += batchSize) {
      const chunk = validRecords.slice(i, i + batchSize);
      let success = false;

      // Mecanismo de Retry para caídas temporales de red o de Supabase API
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const { error } = await this.client
            .from('torrents')
            .upsert(chunk, {
              onConflict: 'info_hash_clean', // Verifica que este nombre coincida con la columna/restricción
              ignoreDuplicates: false
            });

          if (error) {
            console.error(`[SUPABASE] Batch ${Math.floor(i / batchSize) + 1} (Attempt ${attempt}) failed:`, error.message);
            // Si el error es de sintaxis (400), reintentar no ayudará, abortamos el retry.
            if (error.code && error.code.startsWith('22')) break; 
            
            if (attempt < maxRetries) {
              await new Promise(res => setTimeout(res, 2000 * attempt)); // Backoff exponencial corto
              continue;
            }
          } else {
            success = true;
            totalUpserted += chunk.length;
            console.log(`[SUPABASE] Batch ${Math.floor(i / batchSize) + 1} saved: ${chunk.length} torrents.`);
            break; // Saliendo del bucle de retries
          }
        } catch (err: any) {
          console.error(`[SUPABASE] Network crash on batch [${i} to ${i + chunk.length}]:`, err.message);
          if (attempt < maxRetries) await new Promise(res => setTimeout(res, 2000 * attempt));
        }
      }

      if (!success) {
        console.error(`[SUPABASE] ❌ Critical: Batch ${Math.floor(i / batchSize) + 1} permanently failed after ${maxRetries} attempts.`);
      }
    }

    return totalUpserted;
  }
}
