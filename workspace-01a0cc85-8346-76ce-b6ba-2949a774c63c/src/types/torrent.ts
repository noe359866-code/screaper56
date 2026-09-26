/**
 * Torrent metadata and database representation interfaces.
 * Matches existing PostgreSQL schema in `public.torrents`.
 */

export type ContentType = 'movie' | 'series' | 'anime' | 'documentary';

/**
 * Representa un registro completo de torrent tal como se almacena en PostgreSQL.
 */
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

  // Audio, Subtitles and Audio Channels (códigos de idioma ISO normalizados, ej: 'es', 'en')
  audio: string[];
  subtitles: string[];
  channels?: string | null;

  // Swarm Statistics & Source Tracking
  size_bytes?: number | null;
  seeders?: number | null;
  leechers?: number | null;
  source_tracker?: string | null;

  // Timestamps (manejados por PostgreSQL)
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Tipo útil para operaciones de Inserción (omite campos autogenerados por la BD).
 */
export type InsertTorrentRecord = Omit<TorrentRecord, 'created_at' | 'updated_at'>;

/**
 * Tipo útil para operaciones de Actualización parcial en la BD.
 */
export type UpdateTorrentRecord = Partial<InsertTorrentRecord>;

export interface CrawlerStats {
  name: string;
  /** Dominio que realmente sirvió los datos (se resuelve en tiempo de ejecución). */
  mirror?: string | null;
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

/**
 * Expresión regular optimizada para validar un Info Hash de BitTorrent (SHA-1 en hex de 40 caracteres).
 */
const INFO_HASH_REGEX = /^[a-f0-9]{40}$/;

/**
 * Type Guard para validar en tiempo de ejecución si una cadena es un info_hash válido.
 */
export function isValidInfoHash(hash: string): boolean {
  if (typeof hash !== 'string') return false;
  return INFO_HASH_REGEX.test(hash.toLowerCase());
}
