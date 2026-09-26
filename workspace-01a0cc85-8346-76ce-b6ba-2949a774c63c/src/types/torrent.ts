/**
 * Torrent metadata and database representation interfaces.
 * Matches existing PostgreSQL schema in `public.torrents`.
 */

export type ContentType = 'movie' | 'series' | 'anime' | 'documentary';

/**
 * Representa un registro completo de torrent tal como se almacena en PostgreSQL.
 */
export interface TorrentRecord {
  // Primary Keys & DB Identifiers
  id?: number;

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
  info_hash: string; // 40-character hexadecimal string
  magnet_url?: string | null;
  torrent_file_url?: string | null;
  source_url?: string | null;

  // Release Identification & Metadata
  title: string;
  release_group?: string | null;
  quality?: string | null;
  codec?: string | null;
  hdr_format?: string | null;

  // Audio, Subtitles and Audio Channels (códigos ISO o etiquetas normalizadas, ej: 'es', 'en')
  audio: string[];
  subtitles: string[];
  channels?: string | null;

  // Swarm Statistics & Source Tracking
  size_bytes?: number | null;
  seeders?: number | null;
  leechers?: number | null;
  source_tracker?: string | null;

  // Timestamps (manejados automáticamente por PostgreSQL)
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Tipo útil para operaciones de Inserción (omite campos autogenerados por la BD).
 */
export type InsertTorrentRecord = Omit<TorrentRecord, 'id' | 'created_at' | 'updated_at'>;

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

// --- VALIDACIONES Y TYPE GUARDS DE METADATA ---

/**
 * Expresión regular para validar un Info Hash de BitTorrent (SHA-1 en hex de 40 caracteres, case-insensitive).
 */
const INFO_HASH_REGEX = /^[a-f0-9]{40}$/i;

/**
 * Expresión regular para validar identificadores de IMDb (ej: tt1234567 o tt12345678).
 */
const IMDB_REGEX = /^tt\d{7,10}$/;

/**
 * Type Guard runtime para validar si un valor es un info_hash de BitTorrent válido.
 * Acepta `unknown` para permitir la validación segura de datos de origen no confiable.
 */
export function isValidInfoHash(hash: unknown): hash is string {
  return typeof hash === 'string' && INFO_HASH_REGEX.test(hash);
}

/**
 * Type Guard runtime para validar si un valor es un ID de IMDb válido (ej: tt0111161).
 */
export function isValidImdbId(id: unknown): id is string {
  return typeof id === 'string' && IMDB_REGEX.test(id.trim());
}

/**
 * Type Guard runtime para comprobar si una cadena es un tipo de contenido válido.
 */
export function isValidContentType(type: unknown): type is ContentType {
  return (
    typeof type === 'string' &&
    (type === 'movie' || type === 'series' || type === 'anime' || type === 'documentary')
  );
}
