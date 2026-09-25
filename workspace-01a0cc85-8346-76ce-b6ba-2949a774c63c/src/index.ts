import { config } from './config/env.js';
import { BaseCrawler } from './crawlers/base.js';
import { PelispandaCrawler } from './crawlers/pelispanda.js';
import { Leech1337xCrawler } from './crawlers/leech1337x.js';
import { TorrentGalaxyCrawler } from './crawlers/torrentgalaxy.js';
import { YtsCrawler } from './crawlers/yts.js';
import { EztvCrawler } from './crawlers/eztv.js';
import { ThePirateBayCrawler } from './crawlers/thepiratebay.js';
import { MejorTorrentCrawler } from './crawlers/mejortorrent.js';
import { EliteTorrentCrawler } from './crawlers/elitetorrent.js';
import { LimeTorrentsCrawler } from './crawlers/limetorrent.js';
import { NyaaCrawler } from './crawlers/nyaa.js';
import { SupabaseTorrentRepository } from './services/supabase.js';
import { CrawlerStats, ScraperExecutionSummary } from './types/torrent.js';

async function main() {
  const startedAt = new Date().toISOString();
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

  const crawlerRegistry: Record<string, () => BaseCrawler> = {
    pelispanda: () => new PelispandaCrawler(),
    leech1337x: () => new Leech1337xCrawler(),
    torrentgalaxy: () => new TorrentGalaxyCrawler(),
    yts: () => new YtsCrawler(),
    eztv: () => new EztvCrawler(),
    thepiratebay: () => new ThePirateBayCrawler(),
    mejortorrent: () => new MejorTorrentCrawler(),
    elitetorrent: () => new EliteTorrentCrawler(),
    limetorrents: () => new LimeTorrentsCrawler(),
    nyaa: () => new NyaaCrawler()
  };

  const summary: ScraperExecutionSummary = {
    startedAt,
    finishedAt: '',
    totalDiscovered: 0,
    totalSpanishAccepted: 0,
    totalDiscarded: 0,
    totalUpserted: 0,
    crawlers: []
  };

  // 1. Motor de Concurrencia Nativo (Promise Pool)
  // Permite ejecutar múltiples crawlers a la vez respetando el límite de RAM y CPU
  async function runWithConcurrency(tasks: string[], limit: number) {
    const executing = new Set<Promise<void>>();
    
    for (const crawlerKey of tasks) {
      // Envolvemos la ejecución individual en una promesa
      const p = processCrawler(crawlerKey).finally(() => executing.delete(p));
      executing.add(p);
      
      // Si alcanzamos el límite, esperamos a que el más rápido termine antes de lanzar otro
      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }
    
    // Esperamos a que terminen los últimos rezagados
    await Promise.all(executing);
  }

  // 2. Lógica aislada por cada Crawler
  async function processCrawler(crawlerKey: string): Promise<void> {
    const crawlerFactory = crawlerRegistry[crawlerKey];
    if (!crawlerFactory) {
      console.warn(`[ROUTER] Unknown crawler module requested: "${crawlerKey}". Skipping.`);
      return;
    }

    const crawler = crawlerFactory();
    const stats: CrawlerStats = {
      name: crawler.name,
      discovered: 0,
      filteredSpanish: 0,
      discardedNonSpanish: 0,
      upserted: 0,
      errors: 0,
      executionTimeMs: 0
    };

    const crawlStart = Date.now();
    const baseUrlLog = crawler.baseUrl ? ` (${crawler.baseUrl})` : ' (Dynamic Mirrors)';
    console.log(`\n>>> Launching crawler [${crawler.name}]${baseUrlLog} <<<`);

    try {
      // A. Obtener candidatos crudos
      const rawRecords = await crawler.crawl(config.maxPagesPerSource);
      
      // B. Deduplicar primero (Ahorra CPU en los siguientes pasos)
      const uniqueRecords = crawler.deduplicateRecords(rawRecords);
      stats.discovered = uniqueRecords.length;

      // C. Aplicar filtro
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
    } catch (err: unknown) {
      stats.errors++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[FATAL] Unhandled failure in crawler [${crawler.name}]:`, errorMsg);
    } finally {
      stats.executionTimeMs = Date.now() - crawlStart;
      
      // Al ser un entorno asíncrono concurrente, bloqueamos los push al summary 
      // mutando directamente los acumuladores (es seguro en Node.js al ser single-threaded)
      summary.crawlers.push(stats);
      summary.totalDiscovered += stats.discovered;
      summary.totalSpanishAccepted += stats.filteredSpanish;
      summary.totalDiscarded += stats.discardedNonSpanish;
      summary.totalUpserted += stats.upserted;
    }
  }

  // 3. Iniciar ejecución concurrente
  await runWithConcurrency(config.targetCrawlers, config.concurrencyLimit);

  summary.finishedAt = new Date().toISOString();

  // 4. Resumen Final
  console.log('\n===============================================================');
  console.log('                   SCRAPER EXECUTION SUMMARY                   ');
  console.log('===============================================================');
  
  // Ordenar los resultados por tiempo de ejecución (opcional, ayuda al profiling)
  const sortedStats = [...summary.crawlers].sort((a, b) => b.executionTimeMs - a.executionTimeMs);
  
  console.table(sortedStats.map(c => ({
    Source: c.name,
    Discovered: c.discovered,
    'Accepted OK': c.filteredSpanish,
    Discarded: c.discardedNonSpanish,
    Upserted: c.upserted,
    Errors: c.errors,
    'Time (s)': (c.executionTimeMs / 1000).toFixed(1)
  })));

  console.log(`Total Discovered:       ${summary.totalDiscovered}`);
  console.log(`Total Accepted:         ${summary.totalSpanishAccepted}`);
  console.log(`Total Dropped (Foreign): ${summary.totalDiscarded}`);
  console.log(`Total Database Upserts: ${summary.totalUpserted}`);
  console.log(`Finished at:            ${summary.finishedAt}`);
  console.log('===============================================================\n');
}

main().catch((err) => {
  console.error('[CRITICAL] Uncaught exception during scraper execution:', err);
  process.exit(1);
});
