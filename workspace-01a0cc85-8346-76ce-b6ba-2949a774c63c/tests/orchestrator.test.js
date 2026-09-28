import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.ts';
import { BaseCrawler } from '../src/crawlers/base.ts';
import { BatchPersistenceError } from '../src/services/supabase.ts';
import { HASH, HASH2 } from './helpers.js';

const record = hash => ({ info_hash: hash, title: 'Sample Castellano', type: 'movie', audio: ['Spanish'], subtitles: [] });
const config = { dryRun: false, supabaseUrl: '', supabaseServiceRoleKey: '', nodeEnv: 'test', maxPagesPerSource: 1, requestTimeoutMs: 1000, concurrencyLimit: 2, targetCrawlers: ['demo'] };
class Demo extends BaseCrawler {
  name = 'demo';
  closed = 0;
  async crawl() { return [record(HASH)]; }
  async close() { this.closed++; }
}
const run = (crawler, repo = { upsertBatch: async rows => rows.length }, extra = {}) => main({ config, registry: { demo: async () => crawler }, repository: repo, ...extra });

test('index can be imported without running crawlers or modifying process exit code', () => {
  assert.equal(process.exitCode, undefined);
});

test('orchestrator counts successful writes and always closes the crawler', async () => {
  const crawler = new Demo();
  const summary = await run(crawler);
  assert.equal(summary.totalUpserted, 1);
  assert.equal(summary.crawlers[0].errors, 0);
  assert.equal(crawler.closed, 1);
  assert.ok(summary.finishedAt);
});

test('orchestrator distinguishes dry-run validation from real database writes', async () => {
  const summary = await run(new Demo(), undefined, { config: { ...config, dryRun: true } });
  assert.equal(summary.totalUpserted, 0);
  assert.equal(summary.totalWouldUpsert, 1);
  assert.equal(summary.crawlers[0].upserted, 0);
});

test('orchestrator preserves confirmed partial writes and flags persistence failure', async () => {
  const crawler = new Demo();
  crawler.crawl = async () => [record(HASH), record(HASH2)];
  const summary = await run(crawler, { upsertBatch: async () => { throw new BatchPersistenceError(1, 2, 0, ['offline']); } });
  assert.equal(summary.totalUpserted, 1);
  assert.equal(summary.crawlers[0].errors, 1);
  assert.equal(summary.crawlers[0].failureKind, 'persistence');
  assert.equal(crawler.closed, 1);
});

test('orchestrator incomplete legacy count is not reported as success', async () => {
  const summary = await run(new Demo(), { upsertBatch: async () => 0 });
  assert.equal(summary.crawlers[0].errors, 1);
});

test('orchestrator catches a synchronous cleanup failure and retains resolved mirror', async () => {
  const crawler = new Demo();
  crawler.crawl = async () => { crawler.baseUrl = 'https://resolved.test'; throw new Error('Network failure'); };
  crawler.close = () => { throw new Error('cleanup'); };
  const summary = await run(crawler);
  assert.equal(summary.crawlers[0].mirror, 'https://resolved.test');
  assert.equal(summary.crawlers[0].errors, 2);
});

test('orchestrator all-invalid hashes cannot become a successful empty run', async () => {
  const crawler = new Demo();
  crawler.crawl = async () => [record('0'.repeat(40))];
  const summary = await run(crawler);
  assert.equal(summary.crawlers[0].errors, 1);
  assert.equal(summary.totalDiscovered, 0);
});

test('orchestrator respects concurrency and isolates factory/crawl failures', async () => {
  let active = 0; let peak = 0; let closed = 0;
  const registry = Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [name, async () => {
    if (name === 'b') throw new Error('factory failed');
    const crawler = new Demo(); crawler.name = name;
    crawler.crawl = async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      if (name === 'c') throw new Error('crawl failed');
      return [record(HASH)];
    };
    crawler.close = async () => { closed++; };
    return crawler;
  }]));
  const summary = await main({ config: { ...config, targetCrawlers: Object.keys(registry) }, registry, repository: { upsertBatch: async rows => rows.length } });
  assert.equal(summary.crawlers.length, 4);
  assert.equal(summary.crawlers.filter(row => row.errors).length, 2);
  assert.equal(closed, 3);
  assert.ok(peak <= 2);
});

test('orchestrator rejects invalid targets and concurrency before executing anything', async () => {
  for (const targets of [[], ['missing'], ['toString']]) {
    await assert.rejects(main({ config: { ...config, targetCrawlers: targets }, registry: {} }), /targets|unknown/);
  }
  await assert.rejects(main({ config: { ...config, concurrencyLimit: 0 } }), /concurrency/);
});
