import { TorrentRecord } from '../types/torrent.js';

/**
 * Registro saneado, listo para persistir. Es independiente del proveedor
 * (Supabase, CockroachDB o un PostgreSQL propio): la capa de persistencia
 * decide cómo tratar los valores desconocidos (`null`).
 *
 * `seeders`, `leechers` y `size_bytes` son `null` cuando la fuente NO publica
 * el dato. Nunca se fabrican ceros aquí: eso permite que la base de datos
 * conserve el último valor conocido en lugar de pisarlo con un 0 inventado.
 */
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
  size_bytes: number | null;
  seeders: number | null;
  leechers: number | null;
  source_tracker: string | null;
}

/** Columnas que escribe el crawler, en orden estable (se usa para generar SQL). */
export const SANITIZED_COLUMNS = [
  'info_hash',
  'title',
  'type',
  'imdb_id',
  'tmdb_id',
  'kitsu_id',
  'anilist_id',
  'mal_id',
  'season',
  'episode',
  'absolute_episode',
  'file_index',
  'release_group',
  'quality',
  'codec',
  'hdr_format',
  'audio',
  'subtitles',
  'channels',
  'size_bytes',
  'seeders',
  'leechers',
  'source_tracker'
] as const satisfies readonly (keyof SanitizedTorrentRecord)[];

export type SanitizedColumn = (typeof SANITIZED_COLUMNS)[number];

/** Valor que se persiste cuando la fuente no publica el dato y la columna no admite NULL. */
export const UNKNOWN_COUNTER_DEFAULT = 0;
export const UNKNOWN_QUALITY = 'Unknown';

// Regex pre-compilados fuera del flujo de ejecución
const HEX_40_REGEX = /^[0-9a-f]{40}$/;
const IMDB_REGEX = /^tt\d+$/;
const DIGITS_ONLY_REGEX = /^\d+$/;

function parseNonNegativeInt(val: unknown): number | null {
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
  return null;
}

function safeString(val: unknown, maxLength: number): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (trimmed.length === 0) return null;
  return trimmed.substring(0, maxLength);
}

function cleanStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return Array.from(
    new Set(
      val
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item.length > 0)
    )
  );
}

/**
 * Sanitiza y valida un registro según las restricciones del esquema.
 * Devuelve `null` si el registro no es persistible (hash o título inválidos).
 */
export function sanitizeTorrentRecord(raw: TorrentRecord): SanitizedTorrentRecord | null {
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

  return {
    info_hash: cleanHash,
    title,
    type: validType,
    imdb_id: validImdbId,
    tmdb_id: parseNonNegativeInt(raw.tmdb_id),
    kitsu_id: parseNonNegativeInt(raw.kitsu_id),
    anilist_id: parseNonNegativeInt(raw.anilist_id),
    mal_id: parseNonNegativeInt(raw.mal_id),

    season: parseNonNegativeInt(raw.season),
    episode: parseNonNegativeInt(raw.episode),
    absolute_episode: parseNonNegativeInt(raw.absolute_episode),
    file_index: parseNonNegativeInt(raw.file_index),

    release_group: safeString(raw.release_group, 100),
    quality: safeString(raw.quality, 20) ?? UNKNOWN_QUALITY,
    codec: safeString(raw.codec, 20),
    hdr_format: safeString(raw.hdr_format, 20),

    audio: cleanStringArray(raw.audio),
    subtitles: cleanStringArray(raw.subtitles),
    channels: safeString(raw.channels, 10),

    size_bytes: parseNonNegativeInt(raw.size_bytes),
    seeders: parseNonNegativeInt(raw.seeders),
    leechers: parseNonNegativeInt(raw.leechers),
    source_tracker: safeString(raw.source_tracker, 100)
  };
}

/**
 * Sanea y deduplica en memoria por `info_hash` (gana el último registro visto).
 */
export function sanitizeAndDeduplicate(records: readonly TorrentRecord[]): SanitizedTorrentRecord[] {
  const uniqueMap = new Map<string, SanitizedTorrentRecord>();
  for (const record of records) {
    const sanitized = sanitizeTorrentRecord(record);
    if (sanitized) uniqueMap.set(sanitized.info_hash, sanitized);
  }
  return Array.from(uniqueMap.values());
}

/** Fila con los contadores desconocidos convertidos a su default (comportamiento histórico). */
export type LegacyTorrentRow = Omit<SanitizedTorrentRecord, 'size_bytes' | 'seeders' | 'leechers'> & {
  size_bytes: number;
  seeders: number;
  leechers: number;
};

export function toLegacyRow(record: SanitizedTorrentRecord): LegacyTorrentRow {
  return {
    ...record,
    size_bytes: record.size_bytes ?? UNKNOWN_COUNTER_DEFAULT,
    seeders: record.seeders ?? UNKNOWN_COUNTER_DEFAULT,
    leechers: record.leechers ?? UNKNOWN_COUNTER_DEFAULT
  };
}
