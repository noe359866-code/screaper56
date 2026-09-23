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

  /**
   * Sanitiza y valida según las restricciones exactas de tu tabla SQL:
   * - info_hash: 40 caracteres hexadecimales
   * - imdb_id: formato ^tt[0-9]+$ o null
   * - type: 'movie' | 'series' | 'anime'
   * - enteros no negativos (>= 0)
   * - omite columnas que no existen (magnet_url, torrent_file_url, etc.)
   */
  public sanitizeRecord(raw: TorrentRecord): Record<string, any> | null {
    // 1. Info hash obligatorio: 40 caracteres hexadecimales
    if (!raw.info_hash || !/^[0-9a-fA-F]{40}$/.test(raw.info_hash)) {
      return null;
    }

    // 2. Título obligatorio
    if (!raw.title || raw.title.trim().length === 0) {
      return null;
    }

    const toNonNegativeIntOrNull = (val: unknown): number | null => {
      if (typeof val === 'number' && !isNaN(val)) return val >= 0 ? Math.floor(val) : null;
      if (typeof val === 'string' && /^\d+$/.test(val.trim())) return parseInt(val.trim(), 10);
      return null;
    };

    const toNonNegativeIntWithDefault = (val: unknown, def = 0): number => {
      if (typeof val === 'number' && !isNaN(val)) return val >= 0 ? Math.floor(val) : def;
      if (typeof val === 'string' && /^\d+$/.test(val.trim())) return parseInt(val.trim(), 10);
      return def;
    };

    // 3. Validación de constraint torrents_imdb_format (^tt[0-9]+$)
    let validImdbId: string | null = null;
    if (raw.imdb_id) {
      const trimmed = raw.imdb_id.trim();
      if (/^tt[0-9]+$/.test(trimmed)) {
        validImdbId = trimmed;
      }
    }

    // 4. Validación de constraint torrents_type_valid ('movie', 'series', 'anime')
    let validType: 'movie' | 'series' | 'anime' = 'movie';
    if (raw.type === 'series' || raw.type === 'anime') {
      validType = raw.type;
    }

    // Solo se envían las columnas exactas que existen en tu tabla public.torrents
    return {
      imdb_id: validImdbId,
      tmdb_id: toNonNegativeIntOrNull(raw.tmdb_id),
      kitsu_id: toNonNegativeIntOrNull(raw.kitsu_id),
      anilist_id: toNonNegativeIntOrNull(raw.anilist_id),
      mal_id: toNonNegativeIntOrNull(raw.mal_id),

      type: validType,

      season: toNonNegativeIntOrNull(raw.season),
      episode: toNonNegativeIntOrNull(raw.episode),
      absolute_episode: toNonNegativeIntOrNull(raw.absolute_episode),
      file_index: toNonNegativeIntOrNull(raw.file_index),

      info_hash: raw.info_hash.toLowerCase().trim(),
      title: raw.title.trim(),
      release_group: raw.release_group ? raw.release_group.trim().substring(0, 100) : null,
      quality: raw.quality ? raw.quality.trim().substring(0, 20) : 'Unknown',
      codec: raw.codec ? raw.codec.trim().substring(0, 20) : null,
      hdr_format: raw.hdr_format ? raw.hdr_format.trim().substring(0, 20) : null,

      audio: Array.isArray(raw.audio) ? Array.from(new Set(raw.audio.filter(Boolean))) : [],
      subtitles: Array.isArray(raw.subtitles) ? Array.from(new Set(raw.subtitles.filter(Boolean))) : [],
      channels: raw.channels ? raw.channels.trim().substring(0, 10) : null,

      size_bytes: toNonNegativeIntWithDefault(raw.size_bytes, 0),
      seeders: toNonNegativeIntWithDefault(raw.seeders, 0),
      leechers: toNonNegativeIntWithDefault(raw.leechers, 0),
      source_tracker: raw.source_tracker ? raw.source_tracker.trim().substring(0, 100) : null
    };
  }

  /**
   * Ejecuta UPSERT masivo sobre el índice único idx_torrents_unique_hash (info_hash_clean)
   */
  public async upsertBatch(records: TorrentRecord[], batchSize = 50): Promise<number> {
    if (records.length === 0) return 0;

    // Deduplica por info_hash en memoria para evitar el error de lote en PostgreSQL
    const uniqueMap = new Map<string, Record<string, any>>();
    for (const record of records) {
      const sanitized = this.sanitizeRecord(record);
      if (sanitized) {
        uniqueMap.set(sanitized.info_hash, sanitized);
      }
    }

    const validRecords = Array.from(uniqueMap.values());
    if (validRecords.length === 0) return 0;

    if (this.isDryRun) {
      console.log(`[DRY RUN] Would upsert ${validRecords.length} records into public.torrents. Skipping Supabase push.`);
      return validRecords.length;
    }

    if (!this.client) {
      throw new Error('[SUPABASE] Supabase client uninitialized. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    }

    let totalUpserted = 0;

    for (let i = 0; i < validRecords.length; i += batchSize) {
      const chunk = validRecords.slice(i, i + batchSize);

      try {
        // Conflicto apuntando exactamente a tu índice: info_hash_clean
        const { error } = await this.client
          .from('torrents')
          .upsert(chunk, {
            onConflict: 'info_hash_clean',
            ignoreDuplicates: false
          });

        if (error) {
          console.error(`[SUPABASE ERROR] Batch ${Math.floor(i / batchSize) + 1} failed:`, {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code
          });
          continue;
        }

        totalUpserted += chunk.length;
        console.log(`[SUPABASE] Batch ${Math.floor(i / batchSize) + 1} upserted successfully: ${chunk.length} torrents.`);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
        console.error(`[SUPABASE] Failed batch execution [${i} to ${i + chunk.length}]:`, errorMsg);
      }
    }

    return totalUpserted;
  }
}
