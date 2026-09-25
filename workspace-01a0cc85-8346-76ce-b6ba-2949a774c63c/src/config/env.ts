import dotenv from 'dotenv';

// Aseguramos que las variables de entorno se cargan antes de hacer nada más
dotenv.config();

export interface EnvironmentConfig {
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly targetCrawlers: string[];
  readonly dryRun: boolean;
  readonly maxPagesPerSource: number;
  readonly requestTimeoutMs: number;
  readonly concurrencyLimit: number;
  readonly nodeEnv: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function loadConfig(): EnvironmentConfig {
  const dryRun = parseBoolean(process.env.DRY_RUN, false);
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  // 1. FAIL-FAST: Si no es un dry-run, es obligatorio tener base de datos.
  // Es mejor fallar en el milisegundo 1 que después de haber escaneado 500 páginas.
  if (!dryRun) {
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error(
        '🚨 FATAL ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DRY_RUN is false. ' +
        'Check your .env file or deployment variables.'
      );
    }
  }

  const targetCrawlersRaw = process.env.TARGET_CRAWLERS || 'all';
  const targetCrawlers = targetCrawlersRaw === 'all'
    ? [
        'pelispanda',
        'leech1337x',
        'torrentgalaxy',
        'yts',
        'eztv',
        'thepiratebay',
        'mejortorrent',
        'elitetorrent',
        'limetorrents',
        'nyaa'
      ]
    : targetCrawlersRaw.split(',').map(s => s.trim().toLowerCase());

  // 2. INMUTABILIDAD: Congelamos el objeto para que ninguna otra parte del código
  // pueda modificar la configuración accidentalmente en tiempo de ejecución.
  return Object.freeze({
    supabaseUrl,
    supabaseServiceRoleKey,
    targetCrawlers,
    dryRun,
    maxPagesPerSource: parseInteger(process.env.MAX_PAGES, 3),
    requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS, 20000),
    concurrencyLimit: parseInteger(process.env.CRAWLER_CONCURRENCY, 2),
    nodeEnv: process.env.NODE_ENV || 'production'
  });
}

export const config = loadConfig();
