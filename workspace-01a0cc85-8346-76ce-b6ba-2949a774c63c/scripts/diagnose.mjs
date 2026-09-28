// Deliberately does not import the orchestrator or Supabase repository.
import 'dotenv/config';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { CloudflareBypassEngine } from '../src/utils/anti-cloudflare.ts';
import { diagnoseFailure } from '../src/crawlers/failure-diagnosis.ts';

const spanish = ['dontorrent', 'mejortorrent', 'elitetorrent', 'pelispanda', 'wolftorrent', 'sinsitio'];
if (process.argv[2] === '--worker') {
  let crawler;
  let result;
  try {
    crawler = await CRAWLER_REGISTRY[process.argv[3]]();
    const records = crawler.deduplicateRecords(await crawler.crawl(1));
    const { accepted, discarded } = crawler.filterSpanishReleases(records);
    result = { status: !records.length ? 'EMPTY' : !accepted.length ? 'FILTERED' : 'OK',
      extracted: records.length, accepted: accepted.length, discarded: discarded.length };
  } catch (error) {
    result = { status: 'ERROR', error: error instanceof Error ? error.message : String(error), diagnosis: diagnoseFailure(process.argv[3], error) };
  }
  try {
    try { await crawler?.close(); }
    finally { await CloudflareBypassEngine.getInstance().shutdown(); }
  } catch (error) {
    result = { ...result, status: 'ERROR', cleanupError: error instanceof Error ? error.message : String(error) };
  }
  process.send({ ...result, mirror: crawler?.baseUrl, metrics: crawler?.diagnostics() }, () => process.exit(0));
} else {
  const args = process.argv.slice(2);
  const names = args.length === 1 && args[0] === '--spanish' ? spanish : args.length ? [...new Set(args)] : Object.keys(CRAWLER_REGISTRY);
  if (names.some(name => !Object.hasOwn(CRAWLER_REGISTRY, name))) {
    console.error('Use --spanish or crawler names: ' + Object.keys(CRAWLER_REGISTRY).join(', '));
    process.exit(1);
  }
  const timeout = Number(process.env.DIAGNOSE_TIMEOUT_MS || 60000);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 2_147_483_647) throw new Error('DIAGNOSE_TIMEOUT_MS must be an integer between 1000 and 2147483647');
  const results = [];
  for (const name of names) {
    const result = await new Promise(resolve => {
      const child = fork(fileURLToPath(import.meta.url), ['--worker', name], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DRY_RUN: 'true', CRAWLER_TIME_BUDGET_MS: String(timeout - 500), LOG_LEVEL: process.env.LOG_LEVEL || 'warn' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        detached: process.platform !== 'win32'
      });
      let report;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') child.kill('SIGKILL');
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }, timeout);
      child.on('message', message => { report = message; });
      child.on('error', error => { clearTimeout(timer); resolve({ status: 'ERROR', error: error.message }); });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(report || { status: timedOut ? 'TIMEOUT' : 'ERROR', error: 'Worker ended without results' });
      });
    });
    if (result.status === 'TIMEOUT') result.diagnosis = diagnoseFailure(name, 'Worker timed out');
    results.push({ crawler: name, ...result });
    console.log(JSON.stringify(results.at(-1)));
  }
  console.table(results.map(({ crawler, status, extracted, accepted, discarded, mirror }) => ({ crawler, status, extracted, accepted, discarded, mirror })));
  if (results.some(result => result.status !== 'OK')) process.exitCode = 1;
}
