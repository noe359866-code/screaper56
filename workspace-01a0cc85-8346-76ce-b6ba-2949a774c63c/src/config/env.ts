import dotenv from 'dotenv';

// Carga las variables de entorno de forma segura
dotenv.config();

/**
 * Política de escritura sobre filas que YA existen en la tabla:
 *  - preserve : refresca seeders/leechers/tamaño y solo RELLENA metadatos
 *               vacíos (imdb_id, temporada, calidad, idiomas...). Nunca pisa
 *               ni pone a NULL lo que otro proceso haya enriquecido o reparado.
 *  - overwrite: comportamiento histórico del UPSERT de Supabase, todas las
 *               columnas se sobreescriben con lo que trae el crawler.
 */
export type DbWritePolicy = 'preserve' | 'overwrite';

/** Backend de persistencia elegido a partir del entorno. */
export type DbBackend = 'postgres' | 'supabase' | 'dry-run';

export interface EnvironmentConfig {
  /** Backend efectivo: `postgres` (DATABASE_URL), `supabase` (legado, REST) o `dry-run`. */
  readonly dbBackend: DbBackend;
  /** Cadena de conexión PostgreSQL (Supabase, CockroachDB o servidor propio). */
  readonly databaseUrl: string;
  /** CA en formato PEM (contenido o ruta a fichero) para verificar el servidor TLS. */
  readonly databaseSslCa: string;
  /** Desactiva la verificación del certificado TLS (solo como último recurso). */
  readonly databaseSslNoVerify: boolean;
  /** Tabla destino, opcionalmente con esquema (`public.torrents`). */
  readonly dbTable: string;
  readonly dbWritePolicy: DbWritePolicy;
  readonly dbBatchSize: number;
  /** Legado: API REST de Supabase. Solo se usa si no hay DATABASE_URL. */
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly targetCrawlers: readonly string[];
  readonly dryRun: boolean;
  readonly maxPagesPerSource: number;
  readonly requestTimeoutMs: number;
  readonly concurrencyLimit: number;
  readonly nodeEnv: string;
}

// Lista de crawlers por defecto (constante inmutable fuera de la función)
const DEFAULT_CRAWLERS = Object.freeze([
  'pelispanda',
  'leech1337x',
  'torrentgalaxy',
  'yts',
  'eztv',
  'thepiratebay',
  'mejortorrent',
  'elitetorrent',
  'limetorrents',
  'nyaa',
  'wolftorrent',
  'sinsitio',
  'dontorrent'
]) as readonly string[];

const DEFAULT_CRAWLERS_SET = new Set(DEFAULT_CRAWLERS);

const DB_TABLE_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Parsea un valor booleano de forma segura a partir de variables de entorno.
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Parsea un número entero estricto asegurando un valor mínimo.
 */
function parseInteger(value: string | undefined, defaultValue: number, min = 1): number {
  if (!value) return defaultValue;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return defaultValue;
  const parsed = parseInt(trimmed, 10);
  return isNaN(parsed) ? defaultValue : Math.max(min, parsed);
}

/**
 * Valida si un string es una URL válida con protocolo http/https.
 */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Valida una cadena de conexión PostgreSQL (`postgres://` o `postgresql://`).
 */
export function isValidPostgresUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function parseWritePolicy(value: string | undefined): DbWritePolicy {
  const normalized = (value || 'preserve').trim().toLowerCase();
  if (normalized === 'preserve' || normalized === 'overwrite') return normalized;
  throw new Error(`🚨 FATAL ERROR: DB_WRITE_POLICY "${value}" is invalid. Use "preserve" (default) or "overwrite".`);
}

let cachedConfig: EnvironmentConfig | null = null;

/**
 * Carga, valida y cachea la configuración del entorno de forma segura.
 */
export function loadConfig(forceReload = false): EnvironmentConfig {
  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  const dryRun = parseBoolean(process.env.DRY_RUN, false);
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const dbTable = (process.env.DB_TABLE || 'torrents').trim();

  if (!DB_TABLE_REGEX.test(dbTable)) {
    throw new Error(
      `🚨 FATAL ERROR: DB_TABLE "${dbTable}" is not a valid identifier. Use "torrents" or "schema.torrents" (letters, digits and underscores).`
    );
  }

  // 1. Selección del backend y FAIL-FAST si no es un modo DRY_RUN
  let dbBackend: DbBackend = 'dry-run';
  if (!dryRun) {
    if (databaseUrl) {
      if (!isValidPostgresUrl(databaseUrl)) {
        throw new Error(
          '🚨 FATAL ERROR: DATABASE_URL is not a valid PostgreSQL connection string. ' +
          'Expected postgresql://user:password@host:5432/dbname (Supabase, CockroachDB or your own server).'
        );
      }
      dbBackend = 'postgres';
    } else if (supabaseUrl || supabaseServiceRoleKey) {
      if (!supabaseUrl || !supabaseServiceRoleKey) {
        throw new Error(
          '🚨 FATAL ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (legacy REST backend), ' +
          'or provide DATABASE_URL instead.'
        );
      }
      if (!isValidUrl(supabaseUrl)) {
        throw new Error(
          `🚨 FATAL ERROR: SUPABASE_URL "${supabaseUrl}" is not a valid HTTP/HTTPS URL.`
        );
      }
      dbBackend = 'supabase';
    } else {
      throw new Error(
        '🚨 FATAL ERROR: No database configured while DRY_RUN is false. ' +
        'Set DATABASE_URL (PostgreSQL connection string: Supabase, CockroachDB or your own server) ' +
        'or the legacy SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Check your .env file or deployment variables.'
      );
    }
  }

  // Parseo y deduplicación de crawlers
  const targetCrawlersRaw = (process.env.TARGET_CRAWLERS || 'all').trim().toLowerCase();
  let targetCrawlers: readonly string[];

  if (targetCrawlersRaw === 'all') {
    targetCrawlers = DEFAULT_CRAWLERS;
  } else {
    const parsedList = Array.from(
      new Set(
        targetCrawlersRaw
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      )
    );

    const unknown = parsedList.filter(name => !DEFAULT_CRAWLERS_SET.has(name));
    if (unknown.length > 0) {
      throw new Error(`🚨 FATAL ERROR: Unknown TARGET_CRAWLERS specified: ${unknown.join(', ')}`);
    }

    targetCrawlers = Object.freeze(parsedList);
  }

  // 2. INMUTABILIDAD PROFUNDA: Congelamos el objeto raíz
  cachedConfig = Object.freeze({
    dbBackend,
    databaseUrl,
    databaseSslCa: (process.env.DATABASE_SSL_CA || '').trim(),
    databaseSslNoVerify: parseBoolean(process.env.DATABASE_SSL_NO_VERIFY, false),
    dbTable,
    dbWritePolicy: parseWritePolicy(process.env.DB_WRITE_POLICY),
    dbBatchSize: Math.min(parseInteger(process.env.DB_BATCH_SIZE, 100, 1), 500),
    supabaseUrl,
    supabaseServiceRoleKey,
    targetCrawlers,
    dryRun,
    maxPagesPerSource: parseInteger(process.env.MAX_PAGES, 3, 1),
    requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS, 20000, 1000),
    concurrencyLimit: parseInteger(process.env.CRAWLER_CONCURRENCY, 2, 1),
    nodeEnv: (process.env.NODE_ENV || 'production').trim().toLowerCase()
  });

  return cachedConfig;
}

/**
 * Instancia de configuración transparente con lazy-loading y soporte completo para introspección.
 */
export const config = new Proxy({} as EnvironmentConfig, {
  get(_target, prop: string | symbol) {
    if (typeof prop === 'symbol') {
      return Reflect.get(loadConfig(), prop);
    }
    return loadConfig()[prop as keyof EnvironmentConfig];
  },
  ownKeys() {
    return Reflect.ownKeys(loadConfig());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(loadConfig(), prop);
  }
});
