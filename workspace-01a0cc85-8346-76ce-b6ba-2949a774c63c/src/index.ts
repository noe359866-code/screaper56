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
  console.log('---------------------------------------------------------------\n');

  const repository = new SupabaseTorrentRepository();

  // Registro de todos los 10 crawlers activos
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

  for (const crawlerKey of config.targetCrawlers) {
    const crawlerFactory = crawlerRegistry[crawlerKey];
    if (!crawlerFactory) {
      console.warn(`[ROUTER] Unknown crawler module requested: "${crawlerKey}". Skipping.`);
      continue;
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
    console.log(`\n>>> Launching crawler [${crawler.name}] (${crawler.baseUrl}) <<<`);

    try {
      // 1. Obtener candidatos crudos del tracker
      const discoveredRecords = await crawler.crawl(config.maxPagesPerSource);
      stats.discovered = discoveredRecords.length;

      // 2. Aplicar filtro estricto de audio o subtítulos en español o inglés
      const { accepted, discarded } = crawler.filterSpanishReleases(discoveredRecords);
      stats.filteredSpanish = accepted.length;
      stats.discardedNonSpanish = discarded.length;

      console.log(`[${crawler.name}] Language Filter: ${accepted.length} accepted (Spanish / English content), ${discarded.length} discarded (other foreign languages).`);

      // 3. Ejecutar UPSERT en Supabase (sobre info_hash_clean)
      if (accepted.length > 0) {
        console.log(`[${crawler.name}] Commencing UPSERT for ${accepted.length} records into public.torrents...`);
        const upsertCount = await repository.upsertBatch(accepted);
        stats.upserted = upsertCount;
        console.log(`[${crawler.name}] Successfully synchronized ${upsertCount} records to database.`);
      } else {
        console.log(`[${crawler.name}] No Spanish/English records found to upsert in this run.`);
      }
    } catch (err: unknown) {
      stats.errors++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[FATAL] Unhandled failure in crawler [${crawler.name}]:`, errorMsg);
    } finally {
      stats.executionTimeMs = Date.now() - crawlStart;
      summary.crawlers.push(stats);
      summary.totalDiscovered += stats.discovered;
      summary.totalSpanishAccepted += stats.filteredSpanish;
      summary.totalDiscarded += stats.discardedNonSpanish;
      summary.totalUpserted += stats.upserted;
    }
  }

  summary.finishedAt = new Date().toISOString();

  // Resumen final de la ejecución
  console.log('\n===============================================================');
  console.log('                   SCRAPER EXECUTION SUMMARY                   ');
  console.log('===============================================================');
  console.table(summary.crawlers.map(c => ({
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
