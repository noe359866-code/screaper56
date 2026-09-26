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

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function parseInteger(value: string | undefined, defaultValue: number, min = 1): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value.trim(), 10);
  if (isNaN(parsed)) return defaultValue;
  return Math.max(min, parsed);
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
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  // 1. FAIL-FAST: Si no es un dry-run, es obligatorio tener base de datos.
  if (!dryRun) {
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error(
        '🚨 FATAL ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DRY_RUN is false. ' +
        'Check your .env file or deployment variables.'
      );
    }
  }

  const targetCrawlersRaw = (process.env.TARGET_CRAWLERS || 'all').trim().toLowerCase();
  const defaultCrawlers = [
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
  ];

  const targetCrawlers = targetCrawlersRaw === 'all'
    ? defaultCrawlers
    : [...new Set(targetCrawlersRaw.split(',').map(s => s.trim()).filter(Boolean))];

  const unknown = targetCrawlers.filter(name => !defaultCrawlers.includes(name));
  if (unknown.length) throw new Error(`Unknown TARGET_CRAWLERS: ${unknown.join(', ')}`);

  // 2. INMUTABILIDAD: Congelamos el objeto para prevenir mutaciones accidentales.
  cachedConfig = Object.freeze({
    supabaseUrl,
    supabaseServiceRoleKey,
    targetCrawlers,
    dryRun,
    maxPagesPerSource: parseInteger(process.env.MAX_PAGES, 3, 1),
    requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS, 20000, 1000),
    concurrencyLimit: parseInteger(process.env.CRAWLER_CONCURRENCY, 2, 1),
    nodeEnv: (process.env.NODE_ENV || 'production').trim()
  });

  return cachedConfig;
}

/**
 * Instancia de configuración de acceso rápido (se carga perezosamente al primer uso).
 */
export const config = new Proxy({} as EnvironmentConfig, {
  get(_target, prop: keyof EnvironmentConfig) {
    return loadConfig()[prop];
  }
});
