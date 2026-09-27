#!/usr/bin/env node
// Diagnóstico de la base de datos configurada en DATABASE_URL.
// No escribe nada. Sirve para:
//   * ver cuánto ocupa la tabla en Supabase antes de decidir una migración,
//   * validar conexión/TLS/tabla/índice único en un servidor nuevo (Oracle, Cockroach...),
//   * comprobar qué columnas escribirá el crawler y con qué casts.
//
// Uso (desde la carpeta que contiene package.json):
//   DATABASE_URL=postgresql://... npm run db:check
//   npm run db:check -- --sample 5      # muestra 5 filas recientes (sin columnas largas)

import 'dotenv/config';
import pg from 'pg';
import {
  buildPoolConfig,
  describeConnection,
  explainConnectionError,
  introspectTable,
  qualifiedTable,
  splitTableName
} from '../src/services/postgres.ts';

const args = process.argv.slice(2);
const sampleIndex = args.indexOf('--sample');
const sampleRows = sampleIndex >= 0 ? Math.max(0, Number.parseInt(args[sampleIndex + 1] ?? '5', 10) || 5) : 0;

const connectionString = (process.env.DATABASE_URL || '').trim();
if (!connectionString) {
  console.error('DATABASE_URL is not set. Example: postgresql://user:password@host:5432/dbname');
  process.exit(2);
}
const table = (process.env.DB_TABLE || 'torrents').trim();

const pool = new pg.Pool({
  ...buildPoolConfig({
    connectionString,
    sslCa: process.env.DATABASE_SSL_CA || undefined,
    sslNoVerify: /^(true|1|yes)$/i.test(process.env.DATABASE_SSL_NO_VERIFY || ''),
    poolSize: 1
  })
});

const fmtBytes = n => {
  const value = Number(n);
  if (!Number.isFinite(value)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = value;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

let exitCode = 0;
const fail = message => { console.log(`  ✗ ${message}`); exitCode = 1; };
const ok = message => console.log(`  ✓ ${message}`);

console.log(`Database check for ${describeConnection(connectionString)} (table ${table})\n`);

let client;
try {
  client = await pool.connect();
} catch (error) {
  console.error(`✗ Connection failed: ${explainConnectionError(error)}`);
  await pool.end();
  process.exit(1);
}

try {
  const version = (await client.query('SELECT version() AS v')).rows[0].v;
  const isCockroach = /cockroach/i.test(version);
  ok(`Connected. Server: ${version.split(' on ')[0].slice(0, 80)}${isCockroach ? ' (CockroachDB dialect)' : ''}`);

  const tls = (await client.query(
    `SELECT COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl`
  ).catch(() => ({ rows: [{ ssl: null }] }))).rows[0].ssl;
  if (tls === null) console.log('  · TLS: unknown (pg_stat_ssl not available)');
  else console.log(`  · TLS: ${tls ? 'on' : 'off'}`);

  // Tabla y columnas
  let meta;
  try {
    meta = await introspectTable(client, table);
    ok(`Table found. ${meta.columns.length}/23 crawler columns present${meta.hasUpdatedAt ? ', updated_at present' : ', no updated_at column'}.`);
    const missing = ['info_hash', 'title', 'type', 'imdb_id', 'tmdb_id', 'kitsu_id', 'anilist_id', 'mal_id', 'season', 'episode', 'absolute_episode', 'file_index', 'release_group', 'quality', 'codec', 'hdr_format', 'audio', 'subtitles', 'channels', 'size_bytes', 'seeders', 'leechers', 'source_tracker']
      .filter(c => !meta.columns.some(col => col.name === c));
    if (missing.length) console.log(`  · Not present (will be skipped): ${missing.join(', ')}`);
    console.log(`  · Casts: ${meta.columns.map(c => `${c.name}:${c.castType}`).join(' ')}`);
  } catch (error) {
    fail(error.message);
  }

  if (meta) {
    const { schema, table: name } = splitTableName(table);
    const qualified = qualifiedTable(table);

    // Índice único en info_hash (clave del UPSERT)
    const indexes = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = COALESCE($1::text, current_schema()) AND tablename = $2::text`,
      [schema, name]
    ).catch(() => ({ rows: [] }));
    const uniqueOnHash = indexes.rows.find(r => /unique/i.test(r.indexdef) && /\(\s*"?info_hash"?\s*\)/i.test(r.indexdef));
    if (uniqueOnHash) ok(`UNIQUE index on info_hash: ${uniqueOnHash.indexname}`);
    else fail(`No UNIQUE index on info_hash. Run: CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique ON ${qualified} (info_hash);`);
    if (indexes.rows.length) console.log(`  · Indexes: ${indexes.rows.map(r => r.indexname).join(', ')}`);

    // Volumen
    const count = Number((await client.query(`SELECT count(*) AS n FROM ${qualified}`)).rows[0].n);
    console.log(`  · Rows: ${count.toLocaleString('en-US')}`);
    try {
      const size = (await client.query(
        `SELECT pg_total_relation_size($1::regclass) AS total, pg_relation_size($1::regclass) AS heap, pg_indexes_size($1::regclass) AS idx`,
        [qualified]
      )).rows[0];
      console.log(`  · Size: ${fmtBytes(size.total)} total (${fmtBytes(size.heap)} data + ${fmtBytes(size.idx)} indexes)` +
        (count > 0 ? `, ~${Math.round(Number(size.total) / count)} bytes/row` : ''));
      const dbSize = (await client.query('SELECT pg_database_size(current_database()) AS s')).rows[0].s;
      console.log(`  · Whole database: ${fmtBytes(dbSize)}`);
      if (!isCockroach) {
        const bloat = (await client.query(
          `SELECT n_live_tup, n_dead_tup, last_autovacuum, last_vacuum FROM pg_stat_user_tables WHERE schemaname = COALESCE($1::text, current_schema()) AND relname = $2::text`,
          [schema, name]
        )).rows[0];
        if (bloat) {
          const dead = Number(bloat.n_dead_tup), live = Number(bloat.n_live_tup);
          console.log(`  · Tuples: ${live.toLocaleString('en-US')} live, ${dead.toLocaleString('en-US')} dead` +
            (live > 0 && dead / live > 0.2 ? '  ⚠ >20% dead tuples: run VACUUM (ANALYZE) or wait for autovacuum' : '') +
            (bloat.last_autovacuum || bloat.last_vacuum ? `; last vacuum ${new Date(bloat.last_autovacuum || bloat.last_vacuum).toISOString()}` : ''));
        }
      }
    } catch {
      console.log('  · Size: n/a (size functions not available on this server)');
    }

    if (count > 0) {
      const dup = await client.query(`SELECT count(*) AS n FROM (SELECT info_hash FROM ${qualified} GROUP BY info_hash HAVING count(*) > 1) d`);
      const dups = Number(dup.rows[0].n);
      if (dups > 0) fail(`${dups} info_hash values are duplicated (deduplicate before creating the unique index; see supabase/migrations/001_fix_torrents_info_hash_unique.sql)`);
      else ok('No duplicated info_hash values');

      const bySource = await client.query(
        `SELECT COALESCE(source_tracker, '(null)') AS source, count(*) AS n FROM ${qualified} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`
      ).catch(() => ({ rows: [] }));
      if (bySource.rows.length) console.log(`  · By source: ${bySource.rows.map(r => `${r.source}=${r.n}`).join(', ')}`);

      if (meta.hasUpdatedAt) {
        const recent = await client.query(`SELECT max(updated_at) AS last, count(*) FILTER (WHERE updated_at > now() - interval '1 day') AS day FROM ${qualified}`).catch(() => null);
        if (recent) console.log(`  · Last update: ${recent.rows[0].last ? new Date(recent.rows[0].last).toISOString() : 'n/a'}; rows touched in 24h: ${recent.rows[0].day}`);
      }

      if (sampleRows > 0) {
        const cols = meta.columns.map(c => c.name).filter(c => !['audio', 'subtitles'].includes(c)).slice(0, 10);
        const order = meta.hasUpdatedAt ? 'ORDER BY updated_at DESC' : '';
        const sample = await client.query(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM ${qualified} ${order} LIMIT ${sampleRows}`);
        console.table(sample.rows.map(r => ({ ...r, title: String(r.title ?? '').slice(0, 40) })));
      }
    }
  }
} catch (error) {
  fail(explainConnectionError(error));
} finally {
  client.release();
  await pool.end();
}

console.log(exitCode === 0 ? '\nAll checks passed.' : '\nSome checks failed.');
process.exit(exitCode);
