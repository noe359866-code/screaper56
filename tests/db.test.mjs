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

test('fetchSeen pagina filas de Supabase y respeta el límite solicitado', async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ imdb_id: `tt${String(1000000 + i)}`, info_hash: String(i) }));
  const ranges = [];
  const client = {
    from(name) {
      assert.equal(name, 'torrents');
      return {
        select(columns) {
          assert.equal(columns, 'imdb_id, type, season, episode, info_hash, title');
          const builder = {
            order(column, options) {
              assert.equal(column, 'info_hash');
              assert.deepEqual(options, { ascending: true });
              return this;
            },
            range(from, to) {
              ranges.push([from, to]);
              return {
                abortSignal: async () => ({ data: rows.slice(from, to + 1), error: null, status: 200 }),
              };
            },
          };
          return builder;
        },
      };
    },
  };
  const repo = createRepository({ client });
  const seen = await repo.fetchSeen({ limit: 1500 });
  assert.equal(seen.length, 1200);
  assert.deepEqual(ranges, [[0, 999], [1000, 1499]]);
});

test('dry-run deduplica por info_hash y cuenta rechazos', async () => {
  const repo = createRepository({ dryRun: true });
  const result = await repo.upsert([
    candidate(),
    candidate({ title: 'same hash, richer title' }),
    { item: candidate().item, stream: { ...candidate().stream, infoHash: 'bad' } },
  ]);
  assert.deepEqual(result, { inserted: 0, prepared: 1, rejected: 1, dryRun: true, skipReason: 'dry-run' });
});

// Cliente Supabase simulado: registra las llamadas y contesta como PostgREST.
function fakeSupabase({ upsertError = null, insertError = null, updateError = null, existing = [] } = {}) {
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
              const error = typeof updateError === 'function' ? updateError(value) : updateError;
              if (error) return reply({ error, status: 403 });
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
  assert.deepEqual(result, { inserted: 2, prepared: 2, rejected: 0, dryRun: false, mode: 'insert+update', created: 1, updated: 1 });
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
  assert.deepEqual(result, { inserted: 1, prepared: 1, rejected: 0, dryRun: false, mode: 'upsert' });
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


test('sin credenciales no simula inserciones y explica qué Secrets faltan', async () => {
  const repo = createRepository();
  assert.equal(repo.enabled, false);
  assert.equal(repo.skipReason, 'missing-credentials');
  assert.deepEqual(await repo.upsert([candidate(), candidate()]), {
    inserted: 0, prepared: 1, rejected: 0, dryRun: true,
    skipReason: 'missing-credentials',
    missingCredentials: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
});

test('credenciales incompletas o en blanco: identifica solo las que faltan', async () => {
  for (const config of [
    { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: '   ', missing: ['SUPABASE_SERVICE_ROLE_KEY'] },
    { supabaseUrl: '   ', supabaseServiceRoleKey: 'test-key', missing: ['SUPABASE_URL'] },
  ]) {
    const repo = createRepository(config);
    const result = await repo.upsert([]);
    assert.deepEqual(result.missingCredentials, config.missing);
    assert.equal(result.inserted, 0);
    assert.equal(result.prepared, 0);
    assert.equal(result.skipReason, 'missing-credentials');
  }
});

test('dry-run explícito no llama a Supabase aunque haya un cliente configurado', async () => {
  const client = fakeSupabase();
  const repo = createRepository({ client, dryRun: true });
  assert.equal(repo.enabled, false);
  assert.deepEqual(await repo.upsert([candidate()]), {
    inserted: 0, prepared: 1, rejected: 0, dryRun: true, skipReason: 'dry-run',
  });
  assert.deepEqual(client.calls, []);
});

test('sin candidatos válidos también devuelve el estado real de escritura', async () => {
  const client = fakeSupabase();
  const repo = createRepository({ client });
  assert.deepEqual(await repo.upsert([candidate({ infoHash: 'bad' })]), {
    inserted: 0, prepared: 0, rejected: 1, dryRun: false, mode: 'upsert',
  });
  assert.deepEqual(client.calls, []);
});

test('un fallo parcial conserva el número de filas realmente escritas', async () => {
  const client = fakeSupabase({
    upsertError: rows => rows.some(r => r.info_hash === HASH2)
      ? { code: '42501', message: 'permission denied for table torrents' } : null,
  });
  const repo = createRepository({ client, sleep: async () => {} });
  // Sin seeders → otro grupo de columnas; el primero se guarda y el segundo falla.
  await assert.rejects(repo.upsert([candidate(), candidate({ infoHash: HASH2, seeders: null })]), error => {
    assert.match(error.message, /persisted=1\/2/);
    assert.deepEqual(error.result, { inserted: 1, prepared: 2, rejected: 0, dryRun: false, mode: 'upsert' });
    return true;
  });
  assert.equal(client.table.has(HASH), true);
  assert.equal(client.table.has(HASH2), false);
});


test('fallback: cuenta los inserts confirmados aunque después falle un update', async () => {
  const client = fakeSupabase({
    upsertError: { code: '42P10', message: 'no unique constraint' },
    updateError: { code: '42501', message: 'update denied' },
    existing: [HASH],
  });
  const repo = createRepository({ client, sleep: async () => {} });
  await assert.rejects(repo.upsert([candidate(), candidate({ infoHash: HASH2 })]), error => {
    assert.deepEqual(error.result, {
      inserted: 1, prepared: 2, rejected: 0, dryRun: false,
      mode: 'insert+update', created: 1, updated: 0,
    });
    return true;
  });
  assert.equal(client.table.has(HASH2), true);
  assert.equal(client.calls.filter(c => c.op === 'insert').length, 1);
});

test('fallback: los reintentos no duplican el conteo ni convierten inserts en updates', async () => {
  let failuresLeft = 1;
  const client = fakeSupabase({
    upsertError: { code: '42P10', message: 'no unique constraint' },
    updateError: () => failuresLeft-- > 0 ? { code: '57014', message: 'statement timeout' } : null,
    existing: [HASH],
  });
  const repo = createRepository({ client, sleep: async () => {} });
  assert.deepEqual(await repo.upsert([candidate(), candidate({ infoHash: HASH2 })]), {
    inserted: 2, prepared: 2, rejected: 0, dryRun: false,
    mode: 'insert+update', created: 1, updated: 1,
  });
});
