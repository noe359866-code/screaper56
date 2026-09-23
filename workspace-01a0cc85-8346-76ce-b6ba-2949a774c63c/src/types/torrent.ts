/**
 * Torrent metadata and database representation interfaces.
 * Matches existing PostgreSQL schema in `public.torrents`.
 */

export type ContentType = 'movie' | 'series' | 'anime';

export interface TorrentRecord {
  // External Provider IDs
  imdb_id?: string | null;
  tmdb_id?: number | null;
  kitsu_id?: number | null;
  anilist_id?: number | null;
  mal_id?: number | null;

  // Media Classification
  type: ContentType;

  // Episodic / Structure Info
  season?: number | null;
  episode?: number | null;
  absolute_episode?: number | null;
  file_index?: number | null;

  // Cryptographic & Swarm Identifiers
  info_hash: string; // 40-character hexadecimal string (lowercase)
  magnet_url?: string | null;
  torrent_file_url?: string | null;
  source_url?: string | null;

  // Release Identification & Metadata
  title: string;
  release_group?: string | null;
  quality?: string | null;
  codec?: string | null;
  hdr_format?: string | null;

  // Audio, Subtitles and Audio Channels
  audio: string[];
  subtitles: string[];
  channels?: string | null;

  // Swarm Statistics & Source Tracking
  size_bytes?: number | null;
  seeders?: number | null;
  leechers?: number | null;
  source_tracker?: string | null;

  // Timestamps (managed by PostgreSQL / Supabase, but useful for upsert tracking)
  updated_at?: string | null;
}

export interface CrawlerStats {
  name: string;
  discovered: number;
  filteredSpanish: number;
  discardedNonSpanish: number;
  upserted: number;
  errors: number;
  executionTimeMs: number;
}

export interface ScraperExecutionSummary {
  startedAt: string;
  finishedAt: string;
  totalDiscovered: number;
  totalSpanishAccepted: number;
  totalDiscarded: number;
  totalUpserted: number;
  crawlers: CrawlerStats[];
}
