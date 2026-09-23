import dotenv from 'dotenv';

// Load environment variables from .env file if available
dotenv.config();

export interface EnvironmentConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  targetCrawlers: string[];
  dryRun: boolean;
  maxPagesPerSource: number;
  requestTimeoutMs: number;
  concurrencyLimit: number;
  nodeEnv: string;
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
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const dryRun = parseBoolean(process.env.DRY_RUN, false);

  if (!dryRun) {
    if (!supabaseUrl) {
      console.warn('⚠️ WARNING: SUPABASE_URL is not set. Execution will fail on database upserts.');
    }
    if (!supabaseServiceRoleKey) {
      console.warn('⚠️ WARNING: SUPABASE_SERVICE_ROLE_KEY is not set. Execution will fail on database upserts.');
    }
  }

  const targetCrawlersRaw = process.env.TARGET_CRAWLERS || 'all';
  const targetCrawlers = targetCrawlersRaw === 'all'
    ? ['pelispanda', 'leech1337x', 'torrentgalaxy', 'yts', 'eztv', 'thepiratebay', 'mejortorrent']
    : targetCrawlersRaw.split(',').map(s => s.trim().toLowerCase());

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    targetCrawlers,
    dryRun,
    maxPagesPerSource: parseInteger(process.env.MAX_PAGES, 3),
    requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS, 20000),
    concurrencyLimit: parseInteger(process.env.CRAWLER_CONCURRENCY, 2),
    nodeEnv: process.env.NODE_ENV || 'production'
  };
}

export const config = loadConfig();
