import { config } from './config/env.js';
import { SupabaseTorrentRepository } from './services/supabase.js';
import { CrawlerStats, ScraperExecutionSummary } from './types/torrent.js';
import { CloudflareBypassEngine, installCloudflareTeardownHooks } from './utils/anti-cloudflare.js';

import { CRAWLER_REGISTRY } from './crawlers/registry.js';
import { diagnoseFailure } from './crawlers/failure-diagnosis.js';

async function main() {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  // A solved Cloudflare challenge keeps a Chromium driver connection open, and
  // an open handle stops Node from ever exiting. Register teardown first.
  installCloudflareTeardownHooks();
  console.log('===============================================================');
  console.log('   ASYNC TORRENT CRAWLER & SUPABASE INDEXER (PRODUCTION ENGINE) ');
  console.log('===============================================================');
  console.log(`[INIT] Started at: ${startedAt}`);
  console.log(`[INIT] Environment: ${config.nodeEnv}`);
  console.log(`[INIT] Dry Run Mode: ${config.dryRun ? 'ENABLED (No DB writes)' : 'DISABLED (Live DB Sync)'}`);
  console.log(`[INIT] Active Targets: ${config.targetCrawlers.join(', ')}`);
  console.log(`[INIT] Max Pages Per Source: ${config.maxPagesPerSource}`);
  console.log(`[INIT] Concurrency Limit: ${config.concurrencyLimit} parallel workers`);
  console.log('---------------------------------------------------------------\n');

  const repository = new SupabaseTorrentRepository();

  const summary: ScraperExecutionSummary = {
    startedAt,
    finishedAt: '',
    totalDiscovered: 0,
    totalSpanishAccepted: 0,
    totalDiscarded: 0,
    totalUpserted: 0,
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
    const crawlerFactory = CRAWLER_REGISTRY[crawlerKey];
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
      errors: 0,
      executionTimeMs: 0
    };

    const crawlStart = Date.now();
    let crawler: Awaited<ReturnType<typeof crawlerFactory>> | null = null;

    try {
      // Carga perezosa de la instancia del crawler
      crawler = await crawlerFactory();
      stats.name = crawler.name;
      stats.mirror = crawler.baseUrl ?? null;

      const baseUrlLog = crawler.baseUrl ? ` (${crawler.baseUrl})` : ' (Dynamic Mirrors)';
      console.log(`\n>>> Launching crawler [${crawler.name}]${baseUrlLog} <<<`);

      // A. Obtener candidatos
      const rawRecords = await crawler.crawl(config.maxPagesPerSource);

      stats.mirror = crawler.baseUrl ?? stats.mirror;
      if (!rawRecords.length) {
        throw new Error('Zero extracted records. Check mirror, layout, API and download errors; not a successful empty run.');
      }

      // B. Deduplicar
      const uniqueRecords = crawler.deduplicateRecords(rawRecords);
      stats.discovered = uniqueRecords.length;

      // C. Filtrar
      const { accepted, discarded } = crawler.filterSpanishReleases(uniqueRecords);
      stats.filteredSpanish = accepted.length;
      stats.discardedNonSpanish = discarded.length;

      // D. UPSERT en Base de Datos
      if (accepted.length > 0) {
        const upsertCount = await repository.upsertBatch(accepted);
        stats.upserted = upsertCount;
      } else {
        console.log(`[${crawler.name}] No Spanish/English records found to upsert in this run.`);
      }

      stats.mirror = crawler.baseUrl ?? stats.mirror ?? null;
    } catch (err: unknown) {
      stats.errors++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      stats.failureReason = errorMsg;
      stats.failureKind = diagnoseFailure(stats.name, err).kind;
      console.error(`[FATAL] Unhandled failure in crawler [${stats.name}]:`, errorMsg);
    } finally {
      // Adapters may own a browser page or a socket pool; release it before the
      // next run so a full crawl never accumulates Chromium instances.
      if (crawler) {
        await crawler.close().catch((closeError: unknown) => {
          console.warn(
            `[${stats.name}] close() failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`
          );
        });
      }

      stats.executionTimeMs = Date.now() - crawlStart;

      // Actualizar métricas globales
      summary.crawlers.push(stats);
      summary.totalDiscovered += stats.discovered;
      summary.totalSpanishAccepted += stats.filteredSpanish;
      summary.totalDiscarded += stats.discardedNonSpanish;
      summary.totalUpserted += stats.upserted;
    }
  }

  // Ejecución concurrente
  await runWithConcurrency(config.targetCrawlers, config.concurrencyLimit);

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
      Errors: c.errors,
      'Time (s)': (c.executionTimeMs / 1000).toFixed(1)
    }))
  );

  console.log(`Total Discovered:        ${summary.totalDiscovered}`);
  console.log(`Total Accepted:          ${summary.totalSpanishAccepted}`);
  console.log(`Total Dropped (Foreign): ${summary.totalDiscarded}`);
  console.log(`Total Database Upserts:  ${summary.totalUpserted}`);
  console.log(`Total wall time:         ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`);
  console.log(`Finished at:             ${summary.finishedAt}`);

  const failed = summary.crawlers.filter(crawler => crawler.errors > 0);
  if (failed.length) {
    console.log(`Failed sources (${failed.length}): ${failed.map(crawler => crawler.name).join(', ')}`);
    for (const crawler of failed) {
      const diagnosis = diagnoseFailure(crawler.name, crawler.failureReason);
      console.log(`  [${crawler.name}] ${crawler.failureKind ?? diagnosis.kind}: ${crawler.failureReason ?? 'Unknown error'}`);
      console.log(`    Next step: ${diagnosis.advice}`);
    }
  }
  console.log('===============================================================\n');

  // Si hubo errores en algún crawler, marcar el exit code para CI/CD
  const totalErrors = failed.length;
  if (totalErrors > 0) {
    process.exitCode = 1;
  }
}

// Manejo de excepciones globales
main()
  .catch(err => {
    console.error('[CRITICAL] Uncaught exception during scraper execution:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Always release the shared stealth browser, otherwise a successful run can
    // still hang with a live Chromium until the CI timeout kills it.
    await CloudflareBypassEngine.getInstance().shutdown().catch(() => {});
  });
