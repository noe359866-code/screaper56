import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SupabaseTorrentRepository, BatchPersistenceError } from '../src/services/supabase.ts';
import { HASH, HASH2 } from './helpers.js';

const row = (hash = HASH, extra = {}) => ({ info_hash: hash, title: 'Sample Castellano', type: 'movie', audio: ['Spanish'], subtitles: [], ...extra });
const failure = (code, status = 400) => new Response(JSON.stringify({ code, message: 'Private server detail must not be logged' }), { status, headers: { 'Content-Type': 'application/json' } });
function repository(handler = () => new Response(null, { status: 201 }), options = {}) {
  const calls = [];
  // Exercise real supabase-js/PostgREST serialization, but never the network.
  const client = createClient('https://database.test', 'offline-placeholder-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, init) => {
      const call = { url: String(url), ...init, body: JSON.parse(init.body) };
      calls.push(call);
      return handler(call, calls.length);
    } }
  });
  const repo = new SupabaseTorrentRepository({ dryRun: false, client, sleep: async () => {}, ...options });
  return { repo, calls };
}

test('repository groups sparse rows so missing counters cannot become NULL in a mixed batch', async () => {
  const { repo, calls } = repository();
  assert.equal(await repo.upsertBatch([row(HASH, { seeders: 12 }), row(HASH2)]), 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body[0].seeders, 12);
  assert.equal('seeders' in calls[1].body[0], false);
  for (const call of calls) {
    assert.equal(new URL(call.url).searchParams.get('on_conflict'), 'info_hash');
    assert.match(new Headers(call.headers).get('Prefer'), /resolution=merge-duplicates/);
    assert.match(new Headers(call.headers).get('Prefer'), /missing=default/);
    assert.ok(call.signal);
    assert.equal('imdb_id' in call.body[0], false);
    assert.equal('subtitles' in call.body[0], false);
    assert.equal('quality' in call.body[0], false);
  }
});

test('repository duplicate hashes merge evidence rather than retaining only the last row', async () => {
  const { repo, calls } = repository();
  assert.equal(await repo.upsertBatch([
    row(HASH, { seeders: 12, imdb_id: 'tt1234567', audio: ['Spanish'] }),
    row(HASH.toUpperCase(), { seeders: null, audio: ['English'] })
  ]), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body[0].seeders, 12);
  assert.equal(calls[0].body[0].imdb_id, 'tt1234567');
  assert.deepEqual(calls[0].body[0].audio, ['Spanish', 'English']);
});

test('repository missing unique constraint fails safely without INSERT fallback', async () => {
  const { repo, calls } = repository(() => failure('42P10'));
  await assert.rejects(repo.upsertBatch([row(), row(HASH2)], 1), error => {
    assert.ok(error instanceof BatchPersistenceError);
    assert.equal(error.persisted, 0);
    assert.match(error.message, /UNIQUE\(info_hash\)/);
    assert.doesNotMatch(error.message, /Private server detail/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('repository recursively splits oversized batches while keeping UPSERT', async () => {
  const { repo, calls } = repository(call => call.body.length > 1 ? failure('413', 413) : new Response(null, { status: 201 }));
  const records = [HASH, HASH2, 'a'.repeat(40), 'b'.repeat(40)].map(hash => row(hash));
  assert.equal(await repo.upsertBatch(records), 4);
  assert.deepEqual(calls.map(call => call.body.length), [4, 2, 1, 1, 2, 1, 1]);
  assert.ok(calls.every(call => new URL(call.url).searchParams.get('on_conflict') === 'info_hash'));
});

test('repository reports partial writes and isolates a bad row', async () => {
  const { repo, calls } = repository(call => call.body.some(row => row.info_hash === HASH2)
    ? failure('23505', 409) : new Response(null, { status: 201 }));
  await assert.rejects(repo.upsertBatch([row(), row(HASH2)]), error => {
    assert.equal(error.persisted, 1);
    assert.equal(error.attempted, 2);
    assert.equal(error.failures.length, 1);
    return true;
  });
  assert.equal(calls.length, 3);
});

test('repository permission failure stops later batches rather than hammering the server', async () => {
  const { repo, calls } = repository(() => failure('42501', 403));
  await assert.rejects(repo.upsertBatch([row(), row(HASH2)], 1), BatchPersistenceError);
  assert.equal(calls.length, 1);
});

test('repository transient errors retry up to three attempts', async () => {
  const { repo, calls } = repository((_call, attempt) => attempt < 3 ? failure('40001', 503) : new Response(null, { status: 201 }));
  assert.equal(await repo.upsertBatch([row()]), 1);
  assert.equal(calls.length, 3);
});

test('repository exhausted transient failures preserve confirmed counts', async () => {
  const { repo, calls } = repository((_call, attempt) => attempt === 1 ? new Response(null, { status: 201 }) : failure('40001', 503));
  await assert.rejects(repo.upsertBatch([row(), row(HASH2)], 1), error => error.persisted === 1 && error.attempted === 2);
  assert.equal(calls.length, 4);
});

test('repository rejects invalid batch sizes and unsupported conflict keys before I/O', async () => {
  const { repo, calls } = repository();
  for (const size of [0, -1, 1.5, NaN, Infinity, 10001]) await assert.rejects(repo.upsertBatch([row()], size), /batchSize/);
  await assert.rejects(repo.upsertBatch([row()], 100, 'title'), /info_hash/);
  assert.equal(calls.length, 0);
});

test('repository rejects unsafe numeric metadata and zero hashes', () => {
  const repo = new SupabaseTorrentRepository({ dryRun: true });
  assert.equal(repo.sanitizeRecord(row('0'.repeat(40))), null);
  assert.equal(repo.sanitizeRecord(row(HASH, { title: 'bad\0title' })), null);
  const sanitized = repo.sanitizeRecord(row(HASH, { seeders: 1.2, size_bytes: Number.MAX_SAFE_INTEGER + 1, imdb_id: 'tt1' }));
  assert.equal(sanitized.seeders, undefined);
  assert.equal(sanitized.size_bytes, undefined);
  assert.equal(sanitized.imdb_id, null);
  assert.equal(repo.sanitizeRecord(row(HASH, { seeders: 0 })).seeders, 0);
});

test('repository does not silently discard invalid records alongside valid ones', async () => {
  const { repo } = repository();
  await assert.rejects(repo.upsertBatch([row(), row('invalid')]), error => error.persisted === 1 && error.rejected === 1);
});

test('dry run validates without creating or using a client', async () => {
  const client = { from() { throw new Error('Database must not be used'); } };
  const repo = new SupabaseTorrentRepository({ dryRun: true, client });
  assert.equal(await repo.upsertBatch([row()]), 1);
  await assert.rejects(repo.upsertBatch([row('invalid')]), error => error.rejected === 1 && error.persisted === 0);
});

test('repository aborted network requests cannot hang or count as successful writes', async () => {
  const { repo, calls } = repository(call => new Promise((_resolve, reject) => {
    if (call.signal.aborted) reject(new Error('aborted'));
    else call.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { timeoutMs: 10 });
  // AbortSignal.timeout uses an unref timer; keep this mock-only test alive.
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(repo.upsertBatch([row()]), error => error.persisted === 0); }
  finally { clearInterval(keepAlive); }
  assert.equal(calls.length, 3);
});


test('repository retries PostgREST connection-pool exhaustion, not just SQL errors', async () => {
  const { repo, calls } = repository((_call, attempt) => attempt < 2 ? failure('PGRST003', 504) : new Response(null, { status: 201 }));
  assert.equal(await repo.upsertBatch([row()]), 1);
  assert.equal(calls.length, 2);
});
