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
   * Sanitizes and validates a TorrentRecord prior to database transmission.
   * Ensures strict compliance with PostgreSQL data types.
   */
  public sanitizeRecord(raw: TorrentRecord): TorrentRecord | null {
    // Info hash validation: strictly 40 hexadecimal characters
    if (!raw.info_hash || !/^[0-9a-fA-F]{40}$/.test(raw.info_hash)) {
      console.warn(`[VALIDATION] Discarding record due to invalid info_hash: "${raw.info_hash}" (${raw.title})`);
      return null;
    }

    // Title validation
    if (!raw.title || raw.title.trim().length === 0) {
      console.warn(`[VALIDATION] Discarding record due to empty title for info_hash: ${raw.info_hash}`);
      return null;
    }

    // Sanitize integer fields
    const toIntOrNull = (val: unknown): number | null => {
      if (typeof val === 'number' && !isNaN(val)) return Math.floor(val);
      if (typeof val === 'string' && /^-?\d+$/.test(val.trim())) return parseInt(val.trim(), 10);
      return null;
    };

    return {
      imdb_id: raw.imdb_id ? raw.imdb_id.trim() : null,
      tmdb_id: toIntOrNull(raw.tmdb_id),
      kitsu_id: toIntOrNull(raw.kitsu_id),
      anilist_id: toIntOrNull(raw.anilist_id),
      mal_id: toIntOrNull(raw.mal_id),

      type: raw.type || 'movie',

      season: toIntOrNull(raw.season),
      episode: toIntOrNull(raw.episode),
      absolute_episode: toIntOrNull(raw.absolute_episode),
      file_index: toIntOrNull(raw.file_index),

      info_hash: raw.info_hash.toLowerCase().trim(),
      magnet_url: raw.magnet_url ? raw.magnet_url.trim() : null,
      torrent_file_url: raw.torrent_file_url ? raw.torrent_file_url.trim() : null,
      source_url: raw.source_url ? raw.source_url.trim() : null,

      title: raw.title.trim(),
      release_group: raw.release_group ? raw.release_group.trim() : null,
      quality: raw.quality ? raw.quality.trim() : null,
      codec: raw.codec ? raw.codec.trim() : null,
      hdr_format: raw.hdr_format ? raw.hdr_format.trim() : null,

      audio: Array.isArray(raw.audio) ? Array.from(new Set(raw.audio.filter(Boolean))) : [],
      subtitles: Array.isArray(raw.subtitles) ? Array.from(new Set(raw.subtitles.filter(Boolean))) : [],
      channels: raw.channels ? raw.channels.trim() : null,

      size_bytes: toIntOrNull(raw.size_bytes),
      seeders: toIntOrNull(raw.seeders) ?? 0,
      leechers: toIntOrNull(raw.leechers) ?? 0,
      source_tracker: raw.source_tracker ? raw.source_tracker.trim() : null,

      updated_at: new Date().toISOString()
    };
  }

  /**
   * Executes batch UPSERT operations on the existing `public.torrents` table.
   * On conflict over `info_hash`, Postgres updates dynamic tracking fields.
   */
  public async upsertBatch(records: TorrentRecord[], batchSize = 50): Promise<number> {
    if (records.length === 0) return 0;

    // Filter, sanitize and deduplicate records by info_hash to prevent Postgres batch conflict error
    const uniqueMap = new Map<string, TorrentRecord>();
    for (const record of records) {
      const sanitized = this.sanitizeRecord(record);
      if (sanitized) {
        uniqueMap.set(sanitized.info_hash, sanitized);
      }
    }

    const validRecords = Array.from(uniqueMap.values());

    if (validRecords.length === 0) {
      console.warn('[SUPABASE] No valid records to upsert after schema validation.');
      return 0;
    }

    if (this.isDryRun) {
      console.log(`[DRY RUN] Would upsert ${validRecords.length} records into public.torrents. Skipping Supabase push.`);
      return validRecords.length;
    }

    if (!this.client) {
      throw new Error('[SUPABASE] Cannot upsert: Supabase client is uninitialized. Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    }

    let totalUpserted = 0;

    // Split into manageable chunks
    for (let i = 0; i < validRecords.length; i += batchSize) {
      const chunk = validRecords.slice(i, i + batchSize);

      try {
        const { data, error } = await this.client
          .from('torrents')
          .upsert(chunk, {
            onConflict: 'info_hash',
            ignoreDuplicates: false
          })
          .select('info_hash');

        if (error) {
          console.error(`[SUPABASE] Error upserting batch ${i / batchSize + 1}:`, error.message);
          throw error;
        }

        const count = data ? data.length : chunk.length;
        totalUpserted += count;
        console.log(`[SUPABASE] Batch ${i / batchSize + 1} upserted successfully: ${count} torrents.`);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SUPABASE] Failed batch execution [${i} to ${i + chunk.length}]:`, errorMsg);
        // Continue with subsequent batches to ensure resilience
      }
    }

    return totalUpserted;
  }
}
