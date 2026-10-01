import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HASH = '1234567890abcdef1234567890abcdef12345678';

// CLI real en una copia temporal, con proveedores y PostgREST locales simulados.
// No se consulta ningún addon real ni se toca una base de datos externa.
async function setup(t, { configured = false, rejectWrite = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'peerflix-persistence-'));
  const writes = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/stream/movie/tt0111161.json') {
      response.end(JSON.stringify({ streams: [{
        name: 'Peerflix\n1080p',
        title: 'The Shawshank Redemption (1994) [1080p][Castellano]\n👤 30 💾 2.0 GB',
        infoHash: HASH, fileIdx: 0,
      }] }));
    } else if (request.url.startsWith('/rest/v1/torrents')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      writes.push(JSON.parse(body));
      response.statusCode = rejectWrite ? 403 : 201;
      response.end(JSON.stringify(rejectWrite ? { code: '42501', message: 'permission denied for table torrents' } : []));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await cp(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  await cp(join(ROOT, 'public/lib'), join(dir, 'public/lib'), { recursive: true });
  await cp(join(ROOT, 'package.json'), join(dir, 'package.json'));
  await symlink(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  await writeFile(join(dir, 'watchlist.txt'), 'tt0111161 The Shawshank Redemption (1994)\n');
  const env = {
    ...process.env,
    WATCHLIST_PATH: 'watchlist.txt', PROVIDERS: 'peerflix', PEERFLIX_BASE_URL: baseUrl,
    CINEMETA: '0', TMDB_API_KEY: '', TRACKERS_URL: '', FETCH_CONCURRENCY: '1',
    DRY_RUN: '0', DRY_RUN_DB: '0', FIXTURE_MODE: '0', REPROCESS: '0',
    SUPABASE_URL: configured ? baseUrl : '',
    SUPABASE_SERVICE_ROLE_KEY: configured ? 'test-service-role-key' : '',
  };
  return {
    writes,
    run: () => exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 }),
    readReport: async () => JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8')),
    readStreams: async () => JSON.parse(await readFile(join(dir, 'public/stream/movie/tt0111161.json'), 'utf8')),
  };
}

test('CLI sin Secrets publica JSON pero confirma cero guardados y el motivo', async t => {
  const context = await setup(t);
  const run = await context.run();
  const report = await context.readReport();
  assert.equal(report.db.inserted, 0);
  assert.equal(report.db.prepared, 1);
  assert.equal(report.db.skipReason, 'missing-credentials');
  assert.deepEqual(report.db.missingCredentials, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  assert.match(run.stdout, /0 guardados/);
  assert.equal(context.writes.length, 0);
  assert.equal((await context.readStreams()).streams.length, 1);
});

test('CLI con una escritura confirmada cuenta el hash y conserva el payload', async t => {
  const context = await setup(t, { configured: true });
  const run = await context.run();
  const report = await context.readReport();
  assert.equal(report.db.inserted, 1);
  assert.equal(report.db.prepared, 1);
  assert.equal(report.db.dryRun, false);
  assert.equal(report.db.mode, 'upsert');
  assert.deepEqual(report.db.failures, []);
  assert.equal(context.writes.length, 1);
  assert.equal(context.writes[0][0].info_hash, HASH);
  assert.match(run.stdout, /1 registros guardados\/actualizados/);
});

test('CLI con error Supabase conserva el reporte publicado y termina con error', async t => {
  const context = await setup(t, { configured: true, rejectWrite: true });
  await assert.rejects(context.run(), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /42501/);
    return true;
  });
  const report = await context.readReport();
  assert.equal(report.db.inserted, 0);
  assert.equal(report.db.prepared, 1);
  assert.equal(report.db.dryRun, false);
  assert.equal(report.db.failures.length, 1);
  assert.match(report.db.failures[0], /42501.*persisted=0\/1/);
  assert.equal(context.writes.length, 3);
  assert.equal((await context.readStreams()).streams.length, 1);
});
