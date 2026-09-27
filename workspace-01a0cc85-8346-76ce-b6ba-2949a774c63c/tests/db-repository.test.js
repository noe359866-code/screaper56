import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PostgresTorrentRepository,
  buildPoolConfig,
  classifyDatabaseError,
  deriveCastType,
  describeConnection,
  explainConnectionError,
  introspectTable
} from '../src/services/postgres.ts';
import { sanitizeTorrentRecord, sanitizeAndDeduplicate, toLegacyRow, SANITIZED_COLUMNS } from '../src/services/sanitize.ts';
import { DryRunTorrentRepository, createTorrentRepository } from '../src/services/torrent-repository.ts';
import { loadConfig } from '../src/config/env.ts';
import { HASH, HASH2 } from './helpers.js';

const silent = { log() {}, warn() {}, error() {} };
const noSleep = async () => {};

/** Filas de information_schema.columns de una tabla "tipo Supabase": enum, varchar, sin hdr_format ni channels. */
const SCHEMA_ROWS = [
  ['id', 'integer', 'pg_catalog', 'int4', 'NO'],
  ['info_hash', 'character varying', 'pg_catalog', 'varchar', 'NO'],
  ['title', 'character varying', 'pg_catalog', 'varchar', 'NO', 60],
  ['type', 'USER-DEFINED', 'public', 'content_type', 'NO'],
  ['imdb_id', 'text', 'pg_catalog', 'text', 'YES'],
  ['tmdb_id', 'integer', 'pg_catalog', 'int4', 'YES'],
  ['season', 'integer', 'pg_catalog', 'int4', 'YES'],
  ['episode', 'integer', 'pg_catalog', 'int4', 'YES'],
  ['quality', 'text', 'pg_catalog', 'text', 'NO'],
  ['audio', 'ARRAY', 'pg_catalog', '_text', 'NO'],
  ['subtitles', 'ARRAY', 'pg_catalog', '_text', 'NO'],
  ['size_bytes', 'bigint', 'pg_catalog', 'int8', 'NO'],
  ['seeders', 'integer', 'pg_catalog', 'int4', 'NO'],
  ['leechers', 'integer', 'pg_catalog', 'int4', 'NO'],
  ['source_tracker', 'text', 'pg_catalog', 'text', 'YES'],
  ['created_at', 'timestamp with time zone', 'pg_catalog', 'timestamptz', 'NO'],
  ['updated_at', 'timestamp with time zone', 'pg_catalog', 'timestamptz', 'NO']
].map(([column_name, data_type, udt_schema, udt_name, is_nullable, character_maximum_length = null]) => ({ column_name, data_type, udt_schema, udt_name, is_nullable, character_maximum_length }));

function isIntrospection(text) {
  return text.includes('information_schema.columns');
}

/**
 * Pool falso: `handler(text, values)` devuelve el resultado o lanza. Registra todas las consultas.
 */
function fakePool(handler, schemaRows = SCHEMA_ROWS) {
  const queries = [];
  const pool = {
    queries,
    ended: false,
    connections: 0,
    async connect() {
      pool.connections++;
      return {
        async query(text, values) {
          queries.push({ text, values });
          if (isIntrospection(text)) return { rows: schemaRows, rowCount: schemaRows.length };
          return handler(text, values);
        },
        release() {}
      };
    },
    async end() { pool.ended = true; }
  };
  return pool;
}

const okHandler = (text) => {
  if (text.startsWith('UPDATE')) return { rows: [], rowCount: 1 };
  if (text.startsWith('INSERT')) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: null };
};

const record = (overrides = {}) => ({
  info_hash: HASH, title: 'Sample Castellano 1080p', type: 'movie', audio: ['es'], subtitles: [],
  quality: '1080p', seeders: 10, leechers: 1, size_bytes: 1234, source_tracker: 'test', ...overrides
});

function makeRepo(pool, options = {}) {
  return new PostgresTorrentRepository({
    connectionString: 'postgresql://user:secret@db.example.com:5432/app',
    table: 'public.torrents', logger: silent, sleep: noSleep, pool, ...options
  });
}

test('DB: introspección adapta columnas y casts al esquema real (enum, varchar, arrays, columnas ausentes)', async () => {
  const pool = fakePool(okHandler);
  const repo = makeRepo(pool);
  const meta = await repo.getTableMeta();
  const casts = Object.fromEntries(meta.columns.map(c => [c.name, c.castType]));
  assert.equal(casts.type, '"public"."content_type"');
  assert.equal(casts.info_hash, 'varchar');
  assert.equal(meta.columns.find(c => c.name === 'title').maxLength, 60);
  assert.equal(meta.columns.find(c => c.name === 'info_hash').maxLength, null);
  assert.equal(casts.audio, 'text[]');
  assert.equal(casts.size_bytes, 'int8');
  assert.equal(casts.hdr_format, undefined, 'columna inexistente no se escribe');
  assert.equal(meta.hasUpdatedAt, true);
  assert.deepEqual(meta.columns.map(c => c.name), SANITIZED_COLUMNS.filter(c => casts[c]));
  // segunda llamada usa caché: no repite la consulta
  await repo.getTableMeta();
  assert.equal(pool.queries.filter(q => isIntrospection(q.text)).length, 1);
  assert.equal(repo.describe(), 'postgres user@db.example.com:5432/app table=public.torrents policy=preserve');
  await repo.close();
  assert.equal(pool.ended, true);
});

test('DB: política preserve genera UPDATE que rellena huecos, refresca contadores y solo toca filas que cambian', async () => {
  const pool = fakePool(okHandler);
  const repo = makeRepo(pool);
  const persisted = await repo.upsertBatch([record(), record({ info_hash: HASH2, seeders: null, size_bytes: null, type: 'series' })]);
  assert.equal(persisted, 2);

  const texts = pool.queries.map(q => q.text);
  assert.deepEqual(texts.filter(t => !isIntrospection(t)).map(t => t.split(' ')[0]), ['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);

  const update = pool.queries.find(q => q.text.startsWith('UPDATE'));
  assert.match(update.text, /^UPDATE "public"\."torrents" AS t SET /);
  assert.ok(update.text.includes('"imdb_id" = COALESCE(t."imdb_id", v."imdb_id")'), 'metadatos: la BD gana');
  assert.ok(update.text.includes('"seeders" = COALESCE(v."seeders", t."seeders")'), 'contadores: el crawler gana si los conoce');
  assert.ok(update.text.includes('"size_bytes" = COALESCE(NULLIF(v."size_bytes", 0), t."size_bytes")'));
  assert.ok(update.text.includes(`"quality" = CASE WHEN t."quality" IS NULL OR t."quality" = 'Unknown' THEN v."quality" ELSE t."quality" END`));
  assert.ok(update.text.includes('"audio" = CASE WHEN t."audio" IS NULL OR cardinality(t."audio") = 0 THEN v."audio" ELSE t."audio" END'));
  assert.ok(update.text.includes(`"title" = CASE WHEN t."title" IS NULL OR t."title" = '' THEN v."title" ELSE t."title" END`));
  assert.ok(update.text.includes('"updated_at" = now()'));
  assert.ok(update.text.includes('WHERE t."info_hash" = v."info_hash" AND (t."title" IS DISTINCT FROM'), 'solo filas con cambios reales');
  assert.ok(update.text.includes('$3::"public"."content_type"'), 'cast al enum real');
  assert.ok(update.text.includes('::text[]'));
  assert.ok(update.text.includes('(VALUES ($1::varchar'), 'dos filas de VALUES');
  assert.equal(update.values.length, 2 * 14);
  assert.equal(update.values[0], HASH);
  assert.equal(update.values[1], 'Sample Castellano 1080p');
  assert.equal(update.values[14 + 11], null, 'seeders desconocidos viajan como NULL (segunda fila)');

  const insert = pool.queries.find(q => q.text.startsWith('INSERT'));
  assert.match(insert.text, /^INSERT INTO "public"\."torrents" \("info_hash", "title", "type", "imdb_id"/);
  assert.ok(insert.text.includes('COALESCE(v."seeders", 0)'), 'filas nuevas: contador desconocido = 0');
  assert.ok(insert.text.endsWith('ON CONFLICT ("info_hash") DO NOTHING'));
  assert.ok(!insert.text.includes('"updated_at"'), 'updated_at usa el DEFAULT en inserciones');

  assert.deepEqual(repo.getStats(), { inserted: 1, updated: 1, unchanged: 0, failed: 0 });
});

test('DB: los textos más largos que varchar(n) se recortan en lugar de tumbar el lote', async () => {
  const pool = fakePool(okHandler);
  const repo = makeRepo(pool);
  await repo.upsertBatch([record({ title: 'T'.repeat(200) })]);
  const update = pool.queries.find(q => q.text.startsWith('UPDATE'));
  assert.equal(update.values[1].length, 60);
  const insert = pool.queries.find(q => q.text.startsWith('INSERT'));
  assert.equal(insert.values[1].length, 60);
});

test('DB: política overwrite: el crawler gana cuando trae valor, un desconocido no borra', async () => {
  const pool = fakePool(okHandler);
  const repo = makeRepo(pool, { writePolicy: 'overwrite' });
  await repo.upsertBatch([record()]);
  const update = pool.queries.find(q => q.text.startsWith('UPDATE'));
  assert.ok(update.text.includes('"imdb_id" = COALESCE(v."imdb_id", t."imdb_id")'));
  assert.ok(update.text.includes('"title" = COALESCE(v."title", t."title")'));
  assert.ok(update.text.includes(`"quality" = COALESCE(NULLIF(v."quality", 'Unknown'), t."quality", v."quality")`));
  assert.ok(update.text.includes('"audio" = CASE WHEN v."audio" IS NULL OR cardinality(v."audio") = 0 THEN t."audio" ELSE v."audio" END'));
  assert.ok(update.text.includes('"seeders" = COALESCE(v."seeders", t."seeders")'));
});

test('DB: sin índice único (42P10) cae a INSERT ... WHERE NOT EXISTS y avisa una sola vez', async () => {
  const warnings = [];
  let onConflictAttempts = 0;
  const pool = fakePool((text) => {
    if (text.startsWith('INSERT') && text.includes('ON CONFLICT')) {
      onConflictAttempts++;
      const err = new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification');
      err.code = '42P10';
      throw err;
    }
    if (text.startsWith('UPDATE')) return { rows: [], rowCount: 0 };
    return okHandler(text);
  });
  const repo = makeRepo(pool, { logger: { ...silent, warn: m => warnings.push(m) } });
  const persisted = await repo.upsertBatch([record(), record({ info_hash: HASH2 })], 1);
  assert.equal(persisted, 2);
  assert.equal(onConflictAttempts, 1, 'el segundo lote ya no prueba ON CONFLICT');
  const fallbackInserts = pool.queries.filter(q => q.text.startsWith('INSERT') && q.text.includes('WHERE NOT EXISTS (SELECT 1 FROM "public"."torrents" AS t WHERE t."info_hash" = v."info_hash")'));
  assert.equal(fallbackInserts.length, 2);
  assert.equal(pool.queries.filter(q => q.text === 'ROLLBACK').length, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique ON "public"\."torrents" \(info_hash\)/);
  assert.deepEqual(repo.getStats(), { inserted: 2, updated: 0, unchanged: 0, failed: 0 });
});

test('DB: error de serialización 40001 (CockroachDB) hace ROLLBACK, espera y reintenta el lote completo', async () => {
  const sleeps = [];
  let updates = 0;
  const pool = fakePool((text) => {
    if (text.startsWith('UPDATE') && ++updates === 1) {
      const err = new Error('restart transaction: TransactionRetryWithProtoRefreshError');
      err.code = '40001';
      throw err;
    }
    return okHandler(text);
  });
  const repo = makeRepo(pool, { sleep: async ms => { sleeps.push(ms); } });
  const persisted = await repo.upsertBatch([record()]);
  assert.equal(persisted, 1);
  assert.deepEqual(sleeps, [2000]);
  const kinds = pool.queries.filter(q => !isIntrospection(q.text)).map(q => q.text.split(' ')[0]);
  assert.deepEqual(kinds, ['BEGIN', 'UPDATE', 'ROLLBACK', 'BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
  assert.equal(pool.connections, 3, 'introspección + intento fallido + reintento');
});

test('DB: errores de datos/esquema (23xxx, 42xxx) no se reintentan y el resto de lotes continúa', async () => {
  const errors = [];
  const pool = fakePool((text, values) => {
    if (text.startsWith('INSERT') && values.includes(HASH)) {
      const err = new Error('null value in column "quality" violates not-null constraint');
      err.code = '23502';
      throw err;
    }
    return okHandler(text);
  });
  const repo = makeRepo(pool, { logger: { ...silent, error: m => errors.push(m) } });
  const persisted = await repo.upsertBatch([record(), record({ info_hash: HASH2 })], 1);
  assert.equal(persisted, 1);
  assert.equal(pool.queries.filter(q => q.text.startsWith('INSERT')).length, 2, 'sin reintentos del lote fatal');
  assert.deepEqual(repo.getStats(), { inserted: 1, updated: 1, unchanged: 0, failed: 1 });
  assert.ok(errors.some(m => m.includes('Non-retriable error (code 23502)')));
});

test('DB: errores de red se reintentan hasta agotar intentos y el lote se marca perdido', async () => {
  const pool = fakePool(() => { const err = new Error('read ECONNRESET'); err.code = 'ECONNRESET'; throw err; });
  const repo = makeRepo(pool, { maxRetries: 2 });
  const persisted = await repo.upsertBatch([record()]);
  assert.equal(persisted, 0);
  assert.deepEqual(repo.getStats(), { inserted: 0, updated: 0, unchanged: 0, failed: 1 });
  assert.equal(pool.queries.filter(q => q.text === 'BEGIN').length, 2);
});

test('DB: tabla inexistente o sin columnas obligatorias falla con mensaje accionable', async () => {
  const empty = fakePool(okHandler, []);
  await assert.rejects(makeRepo(empty).upsertBatch([record()]), /Table "public\.torrents" not found in schema "public".*sql\/schema\.sql/);
  const noTitle = fakePool(okHandler, SCHEMA_ROWS.filter(r => r.column_name !== 'title'));
  await assert.rejects(introspectTable({ query: async () => ({ rows: SCHEMA_ROWS.filter(r => r.column_name !== 'title'), rowCount: 1 }) }, 'torrents'), /missing required column\(s\): title/);
  await noTitle.end();
  assert.throws(() => new PostgresTorrentRepository({ connectionString: 'postgresql://u@h/db', table: 'torrents; drop table x', pool: empty }), /Invalid/);
});

test('DB: deriveCastType cubre arrays, enums, tipos básicos y fallback', () => {
  assert.equal(deriveCastType('audio', { data_type: 'ARRAY', udt_name: '_text' }), 'text[]');
  assert.equal(deriveCastType('type', { data_type: 'USER-DEFINED', udt_schema: 'public', udt_name: 'content_type' }), '"public"."content_type"');
  assert.equal(deriveCastType('seeders', { data_type: 'integer', udt_name: 'int4' }), 'int4');
  assert.equal(deriveCastType('seeders', { data_type: 'integer' }), 'int8');
  assert.equal(deriveCastType('audio', {}), 'text[]');
});

test('DB: classifyDatabaseError y pistas de conexión', () => {
  assert.equal(classifyDatabaseError({ code: '42P10' }), 'missing-unique');
  assert.equal(classifyDatabaseError({ code: '40001' }), 'retry');
  assert.equal(classifyDatabaseError({ code: '23505' }), 'fatal');
  assert.equal(classifyDatabaseError({ code: '42703' }), 'fatal');
  assert.equal(classifyDatabaseError({ code: '28P01' }), 'fatal');
  assert.equal(classifyDatabaseError({ code: '08006' }), 'retry');
  assert.equal(classifyDatabaseError({ code: '57P01' }), 'retry');
  assert.equal(classifyDatabaseError(new Error('socket hang up')), 'retry');
  assert.match(explainConnectionError(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), /DATABASE_SSL_CA/);
  assert.match(explainConnectionError(Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' })), /IPv6-only.*pooler/);
  assert.match(explainConnectionError(Object.assign(new Error('password authentication failed'), { code: '28P01' })), /postgres\.<project-ref>/);
  assert.equal(explainConnectionError(new Error('whatever')), 'whatever');
});

test('DB: buildPoolConfig aplica TLS según host, URL y variables de entorno', () => {
  const local = buildPoolConfig({ connectionString: 'postgresql://postgres:pw@localhost:5432/torrents' });
  assert.equal(local.ssl, false);
  assert.equal(local.host, 'localhost');
  assert.equal(local.port, 5432);
  assert.equal(local.database, 'torrents');
  assert.equal(local.application_name, 'torrent-indexer');

  const remote = buildPoolConfig({ connectionString: 'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres', poolSize: 3 });
  assert.deepEqual(remote.ssl, {}, 'remoto sin indicación: TLS verificado con las CA del sistema');
  assert.equal(remote.max, 3);
  assert.equal(remote.user, 'postgres.abc');

  const cockroach = buildPoolConfig({ connectionString: 'postgresql://u:pw@free-tier.gcp-us-central1.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full&options=--cluster%3Dmy-cluster-123' });
  assert.deepEqual(cockroach.ssl, {});
  assert.equal(cockroach.options, '--cluster=my-cluster-123');

  assert.equal(buildPoolConfig({ connectionString: 'postgresql://u:pw@10.0.0.5:5432/db?sslmode=disable' }).ssl, false);
  assert.deepEqual(buildPoolConfig({ connectionString: 'postgresql://u:pw@db.example.com/db?sslmode=no-verify' }).ssl, { rejectUnauthorized: false });

  const pem = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
  const withCa = buildPoolConfig({ connectionString: 'postgresql://u:pw@db.example.com/db', sslCa: pem });
  assert.deepEqual(withCa.ssl, { ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', rejectUnauthorized: true });
  assert.throws(() => buildPoolConfig({ connectionString: 'postgresql://u:pw@db.example.com/db', sslCa: '/nonexistent/ca.crt' }), /neither a PEM certificate nor an existing file/);

  const noVerify = buildPoolConfig({ connectionString: 'postgresql://u:pw@db.example.com/db', sslNoVerify: true });
  assert.deepEqual(noVerify.ssl, { rejectUnauthorized: false });

  assert.equal(describeConnection('postgresql://user:hunter2@db.example.com:5432/app'), 'user@db.example.com:5432/app');
  assert.ok(!describeConnection('postgresql://user:hunter2@db.example.com:5432/app').includes('hunter2'));
});

test('DB: sanitize conserva contadores desconocidos como null y el backend legado los convierte a 0', () => {
  const clean = sanitizeTorrentRecord({ info_hash: HASH.toUpperCase(), title: ' Sample ', type: 'documentary', audio: ['es', ' es ', ''], subtitles: null, seeders: '15', leechers: 'n/a', size_bytes: undefined, imdb_id: 'tt123', quality: '' });
  assert.equal(clean.info_hash, HASH);
  assert.equal(clean.title, 'Sample');
  assert.equal(clean.type, 'movie', 'documentary se persiste como movie');
  assert.deepEqual(clean.audio, ['es']);
  assert.deepEqual(clean.subtitles, []);
  assert.equal(clean.seeders, 15);
  assert.equal(clean.leechers, null);
  assert.equal(clean.size_bytes, null);
  assert.equal(clean.quality, 'Unknown');
  assert.equal(clean.imdb_id, 'tt123');
  const legacy = toLegacyRow(clean);
  assert.equal(legacy.leechers, 0);
  assert.equal(legacy.size_bytes, 0);
  assert.equal(sanitizeTorrentRecord({ info_hash: 'nope', title: 'x', type: 'movie', audio: [], subtitles: [] }), null);
  assert.equal(sanitizeTorrentRecord({ info_hash: HASH, title: '  ', type: 'movie', audio: [], subtitles: [] }), null);
  const deduped = sanitizeAndDeduplicate([{ info_hash: HASH, title: 'a', type: 'movie', audio: [], subtitles: [] }, { info_hash: HASH.toUpperCase(), title: 'b', type: 'movie', audio: [], subtitles: [] }]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].title, 'b', 'gana el último registro visto');
});

test('DB: selección de backend por entorno y validación de DATABASE_URL', async () => {
  const keys = ['DRY_RUN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DB_WRITE_POLICY', 'DB_TABLE', 'DB_BATCH_SIZE'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const reset = () => { for (const k of keys) delete process.env[k]; };
  try {
    reset(); process.env.DRY_RUN = 'true'; process.env.DATABASE_URL = 'postgresql://u:p@db.example.com/x';
    assert.equal(loadConfig(true).dbBackend, 'dry-run', 'DRY_RUN manda aunque haya credenciales');
    const dry = await createTorrentRepository();
    assert.ok(dry instanceof DryRunTorrentRepository);
    assert.equal(await dry.upsertBatch([record(), { info_hash: 'bad', title: 'x', type: 'movie', audio: [], subtitles: [] }]), 1);
    assert.deepEqual(dry.getStats(), { inserted: 0, updated: 0, unchanged: 1, failed: 0 });

    reset(); process.env.DATABASE_URL = 'postgresql://u:p@db.example.com:5432/x'; process.env.DB_WRITE_POLICY = 'OVERWRITE'; process.env.DB_TABLE = 'public.torrents'; process.env.DB_BATCH_SIZE = '9999';
    const cfg = loadConfig(true);
    assert.equal(cfg.dbBackend, 'postgres');
    assert.equal(cfg.dbWritePolicy, 'overwrite');
    assert.equal(cfg.dbBatchSize, 500, 'el tamaño de lote se acota a 500');
    // La factoría hace una comprobación previa de conexión: con un host inexistente debe fallar rápido y con pista.
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/x';
    loadConfig(true);
    await assert.rejects(createTorrentRepository(), /Cannot connect to u@127\.0\.0\.1:1\/x: .*ECONNREFUSED.*Check host\/port/);
    const direct = new PostgresTorrentRepository({ connectionString: 'postgresql://u:p@db.example.com:5432/x', table: 'public.torrents', writePolicy: 'overwrite', pool: fakePool(okHandler) });
    assert.equal(direct.backend, 'postgres');
    assert.match(direct.describe(), /^postgres u@db\.example\.com:5432\/x table=public\.torrents policy=overwrite$/);
    await direct.close();

    reset(); process.env.SUPABASE_URL = 'https://abc.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'key';
    assert.equal(loadConfig(true).dbBackend, 'supabase');

    reset(); process.env.DATABASE_URL = 'mysql://u:p@h/x';
    assert.throws(() => loadConfig(true), /not a valid PostgreSQL connection string/);
    reset(); process.env.DATABASE_URL = 'postgresql://u:p@h/x'; process.env.DB_WRITE_POLICY = 'merge';
    assert.throws(() => loadConfig(true), /DB_WRITE_POLICY "merge" is invalid/);
    reset(); process.env.DATABASE_URL = 'postgresql://u:p@h/x'; process.env.DB_TABLE = 'torrents;--';
    assert.throws(() => loadConfig(true), /DB_TABLE/);
    reset(); process.env.SUPABASE_URL = 'https://abc.supabase.co';
    assert.throws(() => loadConfig(true), /SUPABASE_SERVICE_ROLE_KEY must both be set/);
    reset();
    assert.throws(() => loadConfig(true), /No database configured.*DATABASE_URL/);
  } finally {
    reset();
    for (const [k, v] of Object.entries(previous)) if (v !== undefined) process.env[k] = v;
    try { loadConfig(true); } catch { /* el entorno de pruebas puede no tener BD configurada */ }
  }
});
