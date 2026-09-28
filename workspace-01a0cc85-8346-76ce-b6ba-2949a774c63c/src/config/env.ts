import dotenv from 'dotenv';

// Carga las variables de entorno de forma segura
dotenv.config();

export interface EnvironmentConfig {
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
  'dontorrent',
  'rarbg',
  'magnetdl',
  'tokyotosho',
  'grantorrent',
  'rutracker',
  't0rrenta',
  'estrenostorrent'
]) as readonly string[];

/**
 * Curated operational preset: Spanish-focused sources plus high-volume global
 * sources. Keep niche/legacy adapters selectable through `all` or explicitly.
 */
const PRIORITY_CRAWLERS = Object.freeze([
  'pelispanda',
  't0rrenta',
  'estrenostorrent',
  'mejortorrent',
  'elitetorrent',
  'wolftorrent',
  'sinsitio',
  'dontorrent',
  'leech1337x',
  'torrentgalaxy',
  'yts',
  'eztv',
  'thepiratebay',
  'limetorrents',
  'magnetdl',
  'nyaa',
  'rutracker'
]) as readonly string[];

const DEFAULT_CRAWLERS_SET = new Set(DEFAULT_CRAWLERS);

/**
 * Parsea un valor booleano de forma segura a partir de variables de entorno.
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error('DRY_RUN must be true/false, 1/0 or yes/no.');
}

/**
 * Parsea un número entero estricto asegurando un valor mínimo.
 */
function parseInteger(value: string | undefined, defaultValue: number, min = 1): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed < min || parsed > 2_147_483_647) {
    throw new Error(`Invalid integer configuration: expected ${min}..2147483647.`);
  }
  return parsed;
}

/**
 * Valida si un string es una URL válida con protocolo http/https.
 */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

let cachedConfig: EnvironmentConfig | null = null;

/**
 * Carga, valida y cachea la configuración del entorno de forma segura.
 */
export function loadConfig(forceReload = false): EnvironmentConfig {
  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  // A failed reload must not leave an older live configuration cached.
  cachedConfig = null;

  const dryRun = parseBoolean(process.env.DRY_RUN, false);
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  // 1. FAIL-FAST: Validación estricta si no es un modo DRY_RUN
  if (!dryRun) {
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error(
        '🚨 FATAL ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DRY_RUN is false. ' +
        'Check your .env file or deployment variables.'
      );
    }

    if (!isValidUrl(supabaseUrl)) {
      throw new Error(
        '🚨 FATAL ERROR: SUPABASE_URL must be an HTTP/HTTPS URL without credentials, query or fragment.'
      );
    }
  }

  // Parseo y deduplicación de crawlers
  const targetCrawlersRaw = (process.env.TARGET_CRAWLERS || 'priority').trim().toLowerCase();
  let targetCrawlers: readonly string[];

  if (targetCrawlersRaw === 'all') {
    targetCrawlers = DEFAULT_CRAWLERS;
  } else if (targetCrawlersRaw === 'priority') {
    targetCrawlers = PRIORITY_CRAWLERS;
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

  if (!targetCrawlers.length) throw new Error('TARGET_CRAWLERS must select at least one source.');

  // 2. INMUTABILIDAD PROFUNDA: Congelamos el objeto raíz
  cachedConfig = Object.freeze({
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
  set() { return false; },
  defineProperty() { return false; },
  deleteProperty() { return false; },
  preventExtensions() { return false; },
  ownKeys() {
    return Reflect.ownKeys(loadConfig());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(loadConfig(), prop);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  }
});
