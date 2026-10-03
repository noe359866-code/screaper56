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

test('CLI con AUTO_WATCHLIST=1 reemplaza watchlist.txt en cada corrida y no repite títulos ni torrents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'peerflix-autorotate-'));
  let seq = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/stream/')) {
      seq++;
      const h = seq.toString(16).padStart(40, '0');
      response.end(JSON.stringify({ streams: [{
        name: 'Peerflix\n1080p',
        title: `Release ${seq} [1080p][Castellano]\n👤 40 💾 2.0 GB`,
        infoHash: h, fileIdx: 0,
      }] }));
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
  await writeFile(join(dir, 'watchlist.txt'), 'tt6933238 Unabomber (2026)\n');

  const env = {
    ...process.env,
    WATCHLIST_PATH: 'watchlist.txt', PROVIDERS: 'peerflix', PEERFLIX_BASE_URL: baseUrl,
    CINEMETA: '0', TMDB_API_KEY: '', TRACKERS_URL: '', FETCH_CONCURRENCY: '2',
    DRY_RUN: '1', FIXTURE_MODE: '0', REPROCESS: '0',
    AUTO_WATCHLIST: '1', WATCHLIST_BATCH_SIZE: '3',
  };

  // Corrida 1: elimina tt6933238 y carga 3 títulos nuevos
  await exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 });
  const wl1 = await readFile(join(dir, 'watchlist.txt'), 'utf8');
  assert.doesNotMatch(wl1, /tt6933238/);
  const report1 = JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8'));
  assert.equal(report1.watchlist.autoUpdated, true);
  assert.equal(report1.watchlist.removedCount, 1);
  assert.equal(report1.watchlist.addedCount, 3);
  const run1Ids = report1.items.map(i => i.imdbId);
  assert.equal(run1Ids.length, 3);

  // Corrida 2: elimina los 3 títulos de la corrida 1 y carga 3 nuevos distintos
  await exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 });
  const report2 = JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8'));
  assert.equal(report2.watchlist.removedCount, 3);
  assert.equal(report2.watchlist.addedCount, 3);
  const run2Ids = report2.items.map(i => i.imdbId);
  for (const id of run2Ids) {
    assert.equal(run1Ids.includes(id), false, `No debe repetir ${id} en la segunda corrida`);
  }
});

test('CLI reanuda series largas donde quedaron (progress.json) y las conserva en watchlist.txt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'peerflix-resume-'));
  let seq = 0;
  // Cinemeta local: serie de 2 temporadas × 3 episodios (ya emitidos).
  const videos = [1, 2].flatMap(season => [1, 2, 3].map(episode => ({
    season, episode, name: `Ep ${season}x${episode}`, released: '2020-01-01T00:00:00Z',
  })));
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/meta/series/tt7777777.json') {
      response.end(JSON.stringify({ meta: { id: 'tt7777777', imdb_id: 'tt7777777', type: 'series', name: 'Serie Larga', year: '2020', videos } }));
    } else if (request.url === '/meta/movie/tt7777777.json') {
      response.end(JSON.stringify({ meta: {} }));
    } else if (request.url.startsWith('/stream/')) {
      seq++;
      response.end(JSON.stringify({ streams: [{
        name: 'Peerflix\n1080p',
        title: `Serie Larga ${request.url} [1080p][Castellano]\n👤 40 💾 2.0 GB`,
        infoHash: seq.toString(16).padStart(40, '0'), fileIdx: 0,
      }] }));
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
  await writeFile(join(dir, 'watchlist.txt'), 'tt7777777 Serie Larga\n');

  const env = {
    ...process.env,
    WATCHLIST_PATH: 'watchlist.txt', PROVIDERS: 'peerflix', PEERFLIX_BASE_URL: baseUrl,
    CINEMETA: '1', CINEMETA_URL: baseUrl, TMDB_API_KEY: '', OMDB_API_KEY: '', TRACKERS_URL: '',
    FETCH_CONCURRENCY: '2', DRY_RUN: '1', FIXTURE_MODE: '0', REPROCESS: '0',
    AUTO_WATCHLIST: '1', WATCHLIST_BATCH_SIZE: '1', MAX_EPISODES_PER_RUN: '4',
  };

  // Corrida 1: de los 6 episodios emitidos solo expande 4 (tope por corrida).
  await exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 });
  const report1 = JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8'));
  assert.equal(report1.items.length, 4, 'tope de 4 episodios expandidos en la corrida 1');
  const wl1 = await readFile(join(dir, 'watchlist.txt'), 'utf8');
  assert.match(wl1, /tt7777777/, 'la serie en progreso se conserva en el watchlist');
  const progress1 = JSON.parse(await readFile(join(dir, 'public/data/progress.json'), 'utf8'));
  const rec1 = progress1.series.tt7777777;
  assert.deepEqual([rec1.status, rec1.done, rec1.total], ['in-progress', 4, 6]);
  assert.deepEqual([rec1.lastSeason, rec1.lastEpisode], [2, 1], 'recuerda dónde quedó');
  assert.deepEqual([rec1.nextSeason, rec1.nextEpisode], [2, 2], 'sabe por dónde seguir');

  // Corrida 2: sigue donde quedó (solo los 2 episodios restantes).
  await exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 });
  const report2 = JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8'));
  assert.deepEqual(
    report2.items.map(i => `${i.imdbId}:${i.season}:${i.episode}`).sort(),
    ['tt7777777:2:2', 'tt7777777:2:3'],
    'no repite los episodios ya ingeridos',
  );
  const progress2 = JSON.parse(await readFile(join(dir, 'public/data/progress.json'), 'utf8'));
  const rec2 = progress2.series.tt7777777;
  assert.equal(rec2.status, 'complete');
  assert.equal(rec2.done, 6);
  assert.equal(rec2.nextSeason, null);
  assert.ok(rec2.startedAt, 'conserva cuándo empezó la serie');
});

test('CLI con FOLLOW_SERIES=only sigue una única serie hasta terminarla antes de pasar a la siguiente', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'peerflix-follow-series-'));
  let seq = 0;
  const videosA = [1, 2, 3].map(episode => ({
    season: 1, episode, name: `Ep A ${episode}`, released: '2020-01-01T00:00:00Z',
  }));
  const videosB = [1, 2].map(episode => ({
    season: 1, episode, name: `Ep B ${episode}`, released: '2021-01-01T00:00:00Z',
  }));
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/meta/series/tt7777771.json') {
      response.end(JSON.stringify({ meta: { id: 'tt7777771', imdb_id: 'tt7777771', type: 'series', name: 'Serie Uno', year: '2020', videos: videosA } }));
    } else if (request.url === '/meta/series/tt7777772.json') {
      response.end(JSON.stringify({ meta: { id: 'tt7777772', imdb_id: 'tt7777772', type: 'series', name: 'Serie Dos', year: '2021', videos: videosB } }));
    } else if (request.url.startsWith('/stream/')) {
      seq++;
      response.end(JSON.stringify({ streams: [{
        name: 'Peerflix\n1080p',
        title: `Stream ${request.url} [1080p][Castellano]\n👤 40 💾 2.0 GB`,
        infoHash: seq.toString(16).padStart(40, '0'), fileIdx: 0,
      }] }));
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
  await writeFile(join(dir, 'watchlist.txt'), [
    '# --- Películas ---',
    'tt0111161 The Shawshank Redemption (1994)',
    '# --- Series ---',
    'tt7777771 Serie Uno',
    'tt7777772 Serie Dos',
  ].join('\n') + '\n');

  const env = {
    ...process.env,
    WATCHLIST_PATH: 'watchlist.txt', PROVIDERS: 'peerflix', PEERFLIX_BASE_URL: baseUrl,
    CINEMETA: '1', CINEMETA_URL: baseUrl, TMDB_API_KEY: '', OMDB_API_KEY: '', TRACKERS_URL: '',
    FETCH_CONCURRENCY: '2', DRY_RUN: '1', FIXTURE_MODE: '0', REPROCESS: '0',
    AUTO_WATCHLIST: '1', FOLLOW_SERIES: 'only', MAX_EPISODES_PER_RUN: '2',
  };

  // Corrida 1: solo procesa 2 episodios de Serie Uno (0 películas, 0 de Serie Dos).
  await exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 });
  const report1 = JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8'));
  assert.deepEqual(
    report1.items.map(i => `${i.imdbId}:${i.season}:${i.episode}`),
    ['tt7777771:1:1', 'tt7777771:1:2'],
    'solo avanza en Serie Uno',
  );
  const progress1 = JSON.parse(await readFile(join(dir, 'public/data/progress.json'), 'utf8'));
  assert.equal(progress1.activeSeries, 'tt7777771');
  assert.equal(progress1.series.tt7777771.status, 'in-progress');
  assert.equal(progress1.series.tt7777772.status, 'in-progress', 'Serie Dos queda en cola en progress.json');

  // Corrida 2: termina el episodio restante de Serie Uno y marca Serie Dos como siguiente activa.
  await exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 });
  const report2 = JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8'));
  assert.deepEqual(
    report2.items.map(i => `${i.imdbId}:${i.season}:${i.episode}`),
    ['tt7777771:1:3'],
    'termina Serie Uno sin mezclar Serie Dos todavía',
  );
  const progress2 = JSON.parse(await readFile(join(dir, 'public/data/progress.json'), 'utf8'));
  assert.equal(progress2.series.tt7777771.status, 'complete');
  assert.equal(progress2.activeSeries, 'tt7777772', 'al terminar Serie Uno pasa automáticamente a Serie Dos');

  // Corrida 3: ahora sí continúa con Serie Dos hasta terminarla.
  await exec('npm', ['run', 'fetch'], { cwd: dir, env, timeout: 30000 });
  const report3 = JSON.parse(await readFile(join(dir, 'public/data/report.json'), 'utf8'));
  assert.deepEqual(
    report3.items.map(i => `${i.imdbId}:${i.season}:${i.episode}`),
    ['tt7777772:1:1', 'tt7777772:1:2'],
  );
  const progress3 = JSON.parse(await readFile(join(dir, 'public/data/progress.json'), 'utf8'));
  assert.equal(progress3.series.tt7777772.status, 'complete');
  assert.equal(progress3.activeSeries, null);
});

