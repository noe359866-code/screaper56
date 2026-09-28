import { pathToFileURL } from 'node:url';
import { config, EnvironmentConfig } from './config/env.js';
import { SupabaseTorrentRepository, BatchPersistenceError } from './services/supabase.js';
import { CrawlerStats, ScraperExecutionSummary } from './types/torrent.js';
import { CloudflareBypassEngine, installCloudflareTeardownHooks } from './utils/anti-cloudflare.js';

import { CRAWLER_REGISTRY } from './crawlers/registry.js';
import { diagnoseFailure, summarizeFailure } from './crawlers/failure-diagnosis.js';

export interface ExecutionOptions {
  config?: EnvironmentConfig;
  repository?: Pick<SupabaseTorrentRepository, 'upsertBatch'>;
  registry?: typeof CRAWLER_REGISTRY;
}

/** Import-safe orchestration; dependencies can be replaced by offline fixtures. */
export async function main(options: ExecutionOptions = {}): Promise<ScraperExecutionSummary> {
  const settings = options.config ?? config;
  const registry = options.registry ?? CRAWLER_REGISTRY;
  if (!Number.isSafeInteger(settings.concurrencyLimit) || settings.concurrencyLimit < 1) {
    throw new Error('Invalid crawler concurrency');
  }
  if (!settings.targetCrawlers.length || settings.targetCrawlers.some(name => !Object.hasOwn(registry, name))) {
    throw new Error('No targets selected or unknown crawler requested');
  }
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  console.log('===============================================================');
  console.log('   ASYNC TORRENT CRAWLER & SUPABASE INDEXER (PRODUCTION ENGINE) ');
  console.log('===============================================================');
  console.log(`[INIT] Started at: ${startedAt}`);
  console.log(`[INIT] Environment: ${settings.nodeEnv}`);
  console.log(`[INIT] Dry Run Mode: ${settings.dryRun ? 'ENABLED (No DB writes)' : 'DISABLED (Live DB Sync)'}`);
  console.log(`[INIT] Active Targets: ${settings.targetCrawlers.join(', ')}`);
  console.log(`[INIT] Max Pages Per Source: ${settings.maxPagesPerSource}`);
  console.log(`[INIT] Concurrency Limit: ${settings.concurrencyLimit} parallel workers`);
  console.log('---------------------------------------------------------------\n');

  const repository = options.repository ?? new SupabaseTorrentRepository({
    dryRun: settings.dryRun, timeoutMs: settings.requestTimeoutMs, supabaseUrl: settings.supabaseUrl, supabaseServiceRoleKey: settings.supabaseServiceRoleKey
  });

  const summary: ScraperExecutionSummary = {
    startedAt,
    finishedAt: '',
    totalDiscovered: 0,
    totalSpanishAccepted: 0,
    totalDiscarded: 0,
    totalUpserted: 0,
    totalWouldUpsert: 0,
    crawlers: []
  };

  /**
   * Motor de concurrencia optimizado (Promise Pool estricto).
   */
  async function runWithConcurrency(tasks: readonly string[], limit: number): Promise<void> {
    const pool = new Set<Promise<void>>();

    for (const crawlerKey of tasks) {
      const taskPromise: Promise<void> = (async () => {
        await processCrawler(crawlerKey);
      })();

      pool.add(taskPromise);

      // Limpieza segura del Set cuando finaliza la promesa
      const cleanUp = () => pool.delete(taskPromise);
      taskPromise.then(cleanUp, cleanUp);

      if (pool.size >= limit) {
        await Promise.race(pool);
      }
    }

    await Promise.all(pool);
  }

  /**
   * Procesamiento aislado y seguro de cada crawler.
   */
  async function processCrawler(crawlerKey: string): Promise<void> {
    const crawlerFactory = registry[crawlerKey];
    if (!crawlerFactory) {
      console.warn(`[ROUTER] Unknown crawler module requested: "${crawlerKey}". Skipping.`);
      return;
    }

    const stats: CrawlerStats = {
      name: crawlerKey,
      mirror: null,
      discovered: 0,
      filteredSpanish: 0,
      discardedNonSpanish: 0,
      upserted: 0,
      wouldUpsert: 0,
      errors: 0,
      executionTimeMs: 0
    };

    const crawlStart = Date.now();
    let crawler: Awaited<ReturnType<typeof crawlerFactory>> | null = null;

    let persisting = false;
    try {
      // Carga perezosa de la instancia del crawler
      crawler = await crawlerFactory();
      stats.name = crawler.name;
      stats.mirror = crawler.baseUrl ?? null;

      const baseUrlLog = crawler.baseUrl ? ` (${crawler.baseUrl})` : ' (Dynamic Mirrors)';
      console.log(`\n>>> Launching crawler [${crawler.name}]${baseUrlLog} <<<`);

      // A. Obtener candidatos
      const rawRecords = await crawler.crawl(settings.maxPagesPerSource);

      stats.mirror = crawler.baseUrl ?? stats.mirror;
      if (!rawRecords.length) {
        throw new Error('Zero extracted records. Check mirror, layout, API and download errors; not a successful empty run.');
      }

      // B. Deduplicar
      const uniqueRecords = crawler.deduplicateRecords(rawRecords);
      stats.discovered = uniqueRecords.length;
      if (!uniqueRecords.length) throw new Error('Zero extracted valid records after deduplication.');

      // C. Filtrar
      const { accepted, discarded } = crawler.filterSpanishReleases(uniqueRecords);
      stats.filteredSpanish = accepted.length;
      stats.discardedNonSpanish = discarded.length;

      // D. UPSERT en Base de Datos
      if (accepted.length > 0) {
        persisting = true;
        const upsertCount = await repository.upsertBatch(accepted);
        if (!Number.isSafeInteger(upsertCount) || upsertCount < 0 || upsertCount > accepted.length) {
          throw new Error('Repository returned an invalid persistence count');
        }
        if (settings.dryRun) stats.wouldUpsert = upsertCount;
        else stats.upserted = upsertCount;
        if (upsertCount !== accepted.length) throw new Error('Repository returned an incomplete persistence count');
        persisting = false;
      } else {
        console.log(`[${crawler.name}] No Spanish/English records found to upsert in this run.`);
      }

      stats.mirror = crawler.baseUrl ?? stats.mirror ?? null;
    } catch (err: unknown) {
      stats.errors++;
      if (err instanceof BatchPersistenceError && !settings.dryRun) stats.upserted = err.persisted;
      const errorMsg = summarizeFailure(err);
      stats.failureReason = errorMsg;
      const diagnosis = diagnoseFailure(stats.name, err);
      stats.failureKind = persisting ? 'persistence' : diagnosis.kind;
      stats.failureAdvice = persisting ? 'Inspect database schema, permissions and request failures; partial writes are not rolled back.' : diagnosis.advice;
      console.error(`[FATAL] Unhandled failure in crawler [${stats.name}]:`, errorMsg);
    } finally {
      // Adapters may own a browser page or a socket pool; release it before the
      // next run so a full crawl never accumulates Chromium instances.
      if (crawler) {
        stats.mirror = crawler.baseUrl ?? stats.mirror;
        try { await crawler.close(); } catch (closeError: unknown) {
          stats.errors++;
          if (!stats.failureReason) {
            stats.failureReason = `Cleanup failed: ${summarizeFailure(closeError)}`;
            const diagnosis = diagnoseFailure(stats.name, closeError);
            stats.failureKind = diagnosis.kind;
            stats.failureAdvice = diagnosis.advice;
          }
          console.warn(`[${stats.name}] close() failed: ${summarizeFailure(closeError)}`);
        }
      }

      stats.executionTimeMs = Date.now() - crawlStart;

      // Actualizar métricas globales
      summary.crawlers.push(stats);
      summary.totalDiscovered += stats.discovered;
      summary.totalSpanishAccepted += stats.filteredSpanish;
      summary.totalDiscarded += stats.discardedNonSpanish;
      summary.totalUpserted += stats.upserted;
      summary.totalWouldUpsert += stats.wouldUpsert;
    }
  }

  // Ejecución concurrente
  await runWithConcurrency([...new Set(settings.targetCrawlers)], settings.concurrencyLimit);

  summary.finishedAt = new Date().toISOString();

  // Imprimir Resumen Final
  console.log('\n===============================================================');
  console.log('                     SCRAPER EXECUTION SUMMARY                 ');
  console.log('===============================================================');

  const sortedStats = [...summary.crawlers].sort((a, b) => b.executionTimeMs - a.executionTimeMs);

  console.table(
    sortedStats.map(c => ({
      Source: c.name,
      Mirror: c.mirror ? c.mirror.replace(/^https?:\/\//, '') : '-',
      Discovered: c.discovered,
      'Accepted OK': c.filteredSpanish,
      Discarded: c.discardedNonSpanish,
      Upserted: c.upserted,
      ...(settings.dryRun ? { 'Would upsert': c.wouldUpsert } : {}),
      Errors: c.errors,
      'Time (s)': (c.executionTimeMs / 1000).toFixed(1)
    }))
  );

  console.log(`Total Discovered:        ${summary.totalDiscovered}`);
  console.log(`Total Accepted:          ${summary.totalSpanishAccepted}`);
  console.log(`Total Dropped (Foreign): ${summary.totalDiscarded}`);
  console.log(`Total Database Upserts:  ${summary.totalUpserted}`);
  if (settings.dryRun) console.log(`Dry-run would upsert:    ${summary.totalWouldUpsert}`);
  console.log(`Total wall time:         ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`);
  console.log(`Finished at:             ${summary.finishedAt}`);

  const failed = summary.crawlers.filter(crawler => crawler.errors > 0);
  if (failed.length) {
    console.log(`Failed sources (${failed.length}): ${failed.map(crawler => crawler.name).join(', ')}`);
    for (const crawler of failed) {
      console.log(`  [${crawler.name}] ${crawler.failureKind ?? 'unknown'}: ${crawler.failureReason ?? 'Unknown error'}`);
      console.log(`    Next step: ${crawler.failureAdvice ?? 'Inspect the fatal error and crawler metrics.'}`);
    }
  }
  console.log('===============================================================\n');

  return summary;
}

/** CLI alone owns process state and the shared browser lifetime. */
export async function runCli(): Promise<void> {
  installCloudflareTeardownHooks();
  try {
    const summary = await main();
    if (summary.crawlers.some(crawler => crawler.errors > 0)) process.exitCode = 1;
  } catch (error) {
    console.error('[CRITICAL] Scraper execution failed:', summarizeFailure(error));
    process.exitCode = 1;
  } finally {
    try { await CloudflareBypassEngine.getInstance().shutdown(); }
    catch (error) {
      console.error('[CRITICAL] Browser cleanup failed:', summarizeFailure(error));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
