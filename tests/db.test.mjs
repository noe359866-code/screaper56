import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, streamToTorrentRecord } from '../src/db.mjs';

const HASH = '0123456789abcdef0123456789abcdef01234567';

function candidate(overrides = {}) {
  return {
    item: { imdbId: 'tt0111161', type: 'movie', season: null, episode: null },
    stream: {
      infoHash: HASH.toUpperCase(),
      title: 'The Shawshank Redemption 1080p [ES-EN]',
      quality: '1080p',
      audioLangs: ['es', 'en', 'es'],
      fileIdx: 0,
      seeders: 12,
      sizeBytes: 1234,
      providers: ['peerflix', 'torrentio'],
      magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      ...overrides,
    },
  };
}

test('mapea el stream al esquema existente sin inventar magnet_url', () => {
  const record = streamToTorrentRecord(candidate().item, candidate().stream);
  assert.equal(record.info_hash, HASH);
  assert.equal(record.imdb_id, 'tt0111161');
  assert.deepEqual(record.audio, ['es', 'en']);
  assert.deepEqual(record.subtitles, ['es', 'en']);
  assert.equal(record.source_tracker, 'peerflix+torrentio');
  assert.equal(record.magnet_url, undefined);
  assert.equal(record.seeders, 12);
  assert.equal(record.size_bytes, 1234);
});

test('rechaza info-hashes que no sean 40 hex distintos de cero', () => {
  assert.equal(streamToTorrentRecord(candidate().item, { ...candidate().stream, infoHash: '0'.repeat(40) }), null);
  assert.equal(streamToTorrentRecord(candidate().item, { ...candidate().stream, infoHash: 'not-a-hash' }), null);
});

test('dry-run deduplica por info_hash y cuenta rechazos', async () => {
  const repo = createRepository({ dryRun: true });
  const result = await repo.upsert([
    candidate(),
    candidate({ title: 'same hash, richer title' }),
    { item: candidate().item, stream: { ...candidate().stream, infoHash: 'bad' } },
  ]);
  assert.deepEqual(result, { inserted: 1, rejected: 1, dryRun: true });
});

// Cliente Supabase simulado: registra las llamadas y contesta como PostgREST.
function fakeSupabase({ upsertError = null, insertError = null, existing = [] } = {}) {
  const calls = [];
  const table = new Map(existing.map(hash => [hash, { info_hash: hash }]));
  const reply = (result) => ({ abortSignal: async () => result });
  return {
    calls,
    table,
    from(name) {
      assert.equal(name, 'torrents');
      return {
        upsert(rows, options) {
          calls.push({ op: 'upsert', rows, options });
          if (typeof upsertError === 'function' ? upsertError(rows) : upsertError) {
            return reply({ error: typeof upsertError === 'function' ? upsertError(rows) : upsertError, status: 400 });
          }
          for (const row of rows) table.set(row.info_hash, row);
          return reply({ error: null, status: 201 });
        },
        select(columns) {
          return {
            in(column, values) {
              calls.push({ op: 'select', columns, column, values });
              return reply({ data: values.filter(v => table.has(v)).map(v => ({ info_hash: v })), error: null, status: 200 });
            },
          };
        },
        insert(rows, options) {
          calls.push({ op: 'insert', rows, options });
          const error = typeof insertError === 'function' ? insertError(rows) : insertError;
          if (error) return reply({ error, status: 400 });
          for (const row of rows) table.set(row.info_hash, row);
          return reply({ error: null, status: 201 });
        },
        update(changes) {
          return {
            eq(column, value) {
              calls.push({ op: 'update', changes, column, value });
              table.set(value, { ...table.get(value), ...changes });
              return reply({ error: null, status: 204 });
            },
          };
        },
      };
    },
  };
}

const HASH2 = 'fedcba9876543210fedcba9876543210fedcba98';

test('sin UNIQUE(info_hash) (error 42P10) cambia a insert + update y no pierde registros', async () => {
  const client = fakeSupabase({
    upsertError: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' },
    existing: [HASH],
  });
  const repo = createRepository({ client, sleep: async () => {} });
  // Mismas columnas → un solo grupo (PostgREST exige las mismas claves en cada petición).
  const result = await repo.upsert([candidate(), candidate({ infoHash: HASH2, title: 'Otro 720p [ES-EN]' })]);
  assert.deepEqual(result, { inserted: 2, rejected: 0, dryRun: false, mode: 'insert+update', created: 1, updated: 1 });
  assert.deepEqual(client.calls.map(c => c.op), ['upsert', 'select', 'insert', 'update']);
  assert.deepEqual(client.calls[2].rows.map(r => r.info_hash), [HASH2]);
  assert.equal(client.calls[3].value, HASH);
  assert.equal('info_hash' in client.calls[3].changes, false);
  assert.equal(repo.mode, 'insert+update');
});

test('UPSERT nativo cuando la tabla sí tiene la restricción', async () => {
  const client = fakeSupabase();
  const repo = createRepository({ client, sleep: async () => {} });
  const result = await repo.upsert([candidate()]);
  assert.deepEqual(result, { inserted: 1, rejected: 0, dryRun: false, mode: 'upsert' });
  assert.equal(client.calls[0].options.onConflict, 'info_hash');
});

test('si la tabla no tiene codec/hdr_format/channels, reintenta sin esas columnas', async () => {
  const client = fakeSupabase({
    upsertError: rows => (rows.some(r => 'codec' in r) ? { code: 'PGRST204', message: "Could not find the 'codec' column" } : null),
  });
  const repo = createRepository({ client, sleep: async () => {} });
  const stream = { ...candidate().stream, release: { codec: 'HEVC', hdr: ['DV', 'HDR10'], channels: '5.1' } };
  const record = streamToTorrentRecord(candidate().item, stream);
  assert.deepEqual([record.codec, record.hdr_format, record.channels], ['HEVC', 'DV,HDR10', '5.1']);
  const result = await repo.upsert([{ item: candidate().item, stream }]);
  assert.equal(result.inserted, 1);
  assert.deepEqual(result.skippedColumns, ['codec', 'hdr_format', 'channels']);
  assert.equal('codec' in client.calls.at(-1).rows[0], false);
});

test('errores persistentes: 3 intentos y error con el detalle', async () => {
  const client = fakeSupabase({ upsertError: { code: '57014', message: 'canceling statement due to statement timeout' } });
  const repo = createRepository({ client, sleep: async () => {} });
  await assert.rejects(repo.upsert([candidate()]), /57014.*persisted=0\/1/);
  assert.equal(client.calls.length, 3);
});
