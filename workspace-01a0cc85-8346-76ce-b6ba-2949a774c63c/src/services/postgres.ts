import { readFileSync, existsSync } from 'node:fs';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import type { DbBackend, DbWritePolicy } from '../config/env.js';
import type { TorrentRecord } from '../types/torrent.js';
import {
  SANITIZED_COLUMNS,
  SanitizedColumn,
  SanitizedTorrentRecord,
  sanitizeAndDeduplicate,
  UNKNOWN_COUNTER_DEFAULT,
  UNKNOWN_QUALITY
} from './sanitize.js';
import { emptyStats, RepositoryWriteStats, TorrentRepository } from './torrent-repository.js';

// ---------------------------------------------------------------------------
// Abstracción mínima del pool para poder inyectar un doble en las pruebas.
// pg.Pool cumple esta interfaz tal cual.
// ---------------------------------------------------------------------------
export interface QueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface QueryableClient {
  query(text: string, values?: unknown[]): Promise<QueryResultLike>;
  release(err?: Error | boolean): void;
}

export interface PoolLike {
  connect(): Promise<QueryableClient>;
  end(): Promise<void>;
}

export interface PostgresRepositoryOptions {
  connectionString: string;
  /** `torrents` o `esquema.torrents`. */
  table?: string;
  writePolicy?: DbWritePolicy;
  /** CA PEM (contenido o ruta a fichero). */
  sslCa?: string;
  sslNoVerify?: boolean;
  batchSize?: number;
  poolSize?: number;
  maxRetries?: number;
  /** Pool inyectado (pruebas). Si se omite se crea un pg.Pool real. */
  pool?: PoolLike;
  /** Espera entre reintentos; inyectable para pruebas rápidas. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** Metadatos de una columna real de la tabla, obtenidos de information_schema. */
export interface ColumnMeta {
  name: string;
  /** Tipo SQL usado en los casts `$n::tipo` (ej. `text`, `int8`, `text[]`, `"public"."content_type"`). */
  castType: string;
  nullable: boolean;
  /** Longitud máxima de `varchar(n)`/`char(n)`; los textos más largos se recortan en vez de fallar el lote. */
  maxLength: number | null;
}

export interface TableMeta {
  schema: string | null;
  table: string;
  /** Columnas del crawler que existen en la tabla, en el orden de SANITIZED_COLUMNS. */
  columns: ColumnMeta[];
  hasUpdatedAt: boolean;
}

type ErrorKind = 'retry' | 'fatal' | 'missing-unique';

const COUNTER_COLUMNS: ReadonlySet<SanitizedColumn> = new Set(['seeders', 'leechers', 'size_bytes']);
const ARRAY_COLUMNS: ReadonlySet<SanitizedColumn> = new Set(['audio', 'subtitles']);
const REQUIRED_COLUMNS: readonly SanitizedColumn[] = ['info_hash', 'title'];
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Tipos por defecto si information_schema no informa `udt_name` (p. ej. algún proxy). */
const FALLBACK_CAST_TYPES: Record<SanitizedColumn, string> = {
  info_hash: 'text',
  title: 'text',
  type: 'text',
  imdb_id: 'text',
  tmdb_id: 'int8',
  kitsu_id: 'int8',
  anilist_id: 'int8',
  mal_id: 'int8',
  season: 'int8',
  episode: 'int8',
  absolute_episode: 'int8',
  file_index: 'int8',
  release_group: 'text',
  quality: 'text',
  codec: 'text',
  hdr_format: 'text',
  audio: 'text[]',
  subtitles: 'text[]',
  channels: 'text',
  size_bytes: 'int8',
  seeders: 'int8',
  leechers: 'int8',
  source_tracker: 'text'
};

// ---------------------------------------------------------------------------
// Utilidades exportadas (las reutiliza scripts/db-check.mjs)
// ---------------------------------------------------------------------------

export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid SQL identifier: "${name}"`);
  }
  return `"${name}"`;
}

export function splitTableName(table: string): { schema: string | null; table: string } {
  const parts = table.split('.');
  if (parts.length === 1) return { schema: null, table: parts[0] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  throw new Error(`Invalid table name "${table}". Use "torrents" or "schema.torrents".`);
}

export function qualifiedTable(table: string): string {
  const { schema, table: name } = splitTableName(table);
  return schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(name)}` : quoteIdentifier(name);
}

function loadCertificateAuthority(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN')) {
    // Los secretos de CI suelen aplanar los saltos de línea como "\n" literales.
    return trimmed.includes('\\n') && !trimmed.includes('\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
  }
  if (!existsSync(trimmed)) {
    throw new Error(`DATABASE_SSL_CA "${trimmed}" is neither a PEM certificate nor an existing file path.`);
  }
  return readFileSync(trimmed, 'utf8');
}

/**
 * Construye la configuración del pool a partir de la cadena de conexión y las
 * opciones TLS del entorno. Reglas:
 *  - Se respeta lo que diga la URL (`sslmode=disable|verify-full|no-verify`, `sslrootcert=`).
 *  - Sin indicación: hosts locales sin TLS; hosts remotos con TLS verificado.
 *  - DATABASE_SSL_CA añade la CA del proveedor (Supabase, Cockroach, tu propio servidor).
 *  - DATABASE_SSL_NO_VERIFY desactiva la verificación (cifra, pero no autentica el servidor).
 */
export function buildPoolConfig(options: Pick<PostgresRepositoryOptions, 'connectionString' | 'sslCa' | 'sslNoVerify' | 'poolSize'>): pg.PoolConfig {
  const parsed = parseConnectionString(options.connectionString);
  const { ssl: parsedSsl, sslmode: _sslmode, sslcert: _c, sslkey: _k, sslrootcert: _r, ...rest } = parsed as Record<string, unknown> & { ssl?: unknown };

  const host = typeof parsed.host === 'string' ? parsed.host : '';
  const isLocal = host.length === 0 || host.startsWith('/') || LOCAL_HOSTS.has(host);

  let ssl: boolean | TlsConnectionOptions;
  if (parsedSsl === undefined || parsedSsl === null) {
    ssl = isLocal ? false : {};
  } else if (typeof parsedSsl === 'boolean') {
    ssl = parsedSsl;
  } else {
    ssl = { ...(parsedSsl as TlsConnectionOptions) };
  }

  if (options.sslCa) {
    const base = typeof ssl === 'object' ? ssl : {};
    ssl = { ...base, ca: loadCertificateAuthority(options.sslCa), rejectUnauthorized: true };
  }
  if (options.sslNoVerify) {
    const base = typeof ssl === 'object' ? ssl : {};
    ssl = { ...base, rejectUnauthorized: false };
  }

  const poolConfig: pg.PoolConfig = {
    ...(rest as pg.PoolConfig),
    host: host || undefined,
    port: parsed.port ? Number.parseInt(String(parsed.port), 10) : undefined,
    ssl,
    max: options.poolSize ?? 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    application_name: 'torrent-indexer'
  };
  return poolConfig;
}

/** URL sin contraseña para los logs. */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    const user = url.username ? `${decodeURIComponent(url.username)}@` : '';
    return `${user}${url.hostname}${url.port ? `:${url.port}` : ''}/${database}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export function deriveCastType(column: SanitizedColumn, row: Record<string, unknown>): string {
  const dataType = String(row.data_type ?? '').toLowerCase();
  const udtName = String(row.udt_name ?? '').trim();
  const udtSchema = String(row.udt_schema ?? '').trim();

  if (dataType === 'array' && udtName.startsWith('_') && IDENTIFIER_REGEX.test(udtName.slice(1))) {
    return `${udtName.slice(1)}[]`;
  }
  if (dataType === 'user-defined' && IDENTIFIER_REGEX.test(udtName)) {
    const schema = udtSchema && IDENTIFIER_REGEX.test(udtSchema) ? udtSchema : 'public';
    return `${quoteIdentifier(schema)}.${quoteIdentifier(udtName)}`;
  }
  if (udtName && IDENTIFIER_REGEX.test(udtName) && !udtName.startsWith('_')) {
    return udtName;
  }
  return FALLBACK_CAST_TYPES[column];
}

/**
 * Lee las columnas reales de la tabla. Funciona en PostgreSQL, Supabase y
 * CockroachDB (todos exponen information_schema.columns).
 */
export async function introspectTable(client: Pick<QueryableClient, 'query'>, table: string): Promise<TableMeta> {
  const { schema, table: name } = splitTableName(table);
  quoteIdentifier(name);
  if (schema) quoteIdentifier(schema);

  const result = await client.query(
    `SELECT column_name, data_type, udt_schema, udt_name, is_nullable, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = COALESCE($1::text, current_schema())
        AND table_name = $2::text`,
    [schema, name]
  );

  if (result.rows.length === 0) {
    throw new Error(
      `[DB] Table "${table}" not found in ${schema ? `schema "${schema}"` : 'the default schema'}. ` +
      'Create it with sql/schema.sql (new database) or fix DB_TABLE.'
    );
  }

  const byName = new Map<string, Record<string, unknown>>();
  for (const row of result.rows) byName.set(String(row.column_name), row);

  const missingRequired = REQUIRED_COLUMNS.filter(column => !byName.has(column));
  if (missingRequired.length > 0) {
    throw new Error(`[DB] Table "${table}" is missing required column(s): ${missingRequired.join(', ')}.`);
  }

  const columns: ColumnMeta[] = [];
  for (const column of SANITIZED_COLUMNS) {
    const row = byName.get(column);
    if (!row) continue;
    const maxLengthRaw = Number(row.character_maximum_length);
    columns.push({
      name: column,
      castType: deriveCastType(column, row),
      nullable: String(row.is_nullable ?? 'YES').toUpperCase() !== 'NO',
      maxLength: Number.isInteger(maxLengthRaw) && maxLengthRaw > 0 ? maxLengthRaw : null
    });
  }

  return { schema, table: name, columns, hasUpdatedAt: byName.has('updated_at') };
}

export function classifyDatabaseError(error: unknown): ErrorKind {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (code === '42P10' || message.includes('no unique or exclusion constraint matching the on conflict')) {
    return 'missing-unique';
  }
  if (code === '40001' || code === '40P01') return 'retry'; // serialización (CockroachDB) / deadlock
  if (code.startsWith('22') || code.startsWith('23') || code.startsWith('42')) return 'fatal';
  if (code.startsWith('28') || code === '3D000') return 'fatal'; // credenciales / base de datos inexistente
  if (code.startsWith('08') || code.startsWith('57P') || code === '53300' || code === '53400') return 'retry';
  return 'retry'; // errores de red (ECONNRESET, ETIMEDOUT...) y desconocidos
}

/** Añade una pista accionable a los errores de conexión más habituales. */
export function explainConnectionError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code) ||
    lower.includes('self-signed certificate') || lower.includes('self signed certificate')
  ) {
    return `${message} → The server certificate is not trusted. Set DATABASE_SSL_CA to the provider CA (Supabase: Project Settings → Database → SSL certificate; CockroachDB: cluster CA), or as a last resort DATABASE_SSL_NO_VERIFY=true.`;
  }
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return `${message} → Network unreachable. Supabase direct hosts (db.<ref>.supabase.co) are IPv6-only; from GitHub Actions use the Session/Transaction pooler host (aws-0-<region>.pooler.supabase.com) with user postgres.<ref>.`;
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
    return `${message} → Check host/port in DATABASE_URL and that the server firewall (and OCI security list / iptables on Oracle Cloud) allows the connection.`;
  }
  if (code === 'ETIMEDOUT' || lower.includes('timeout')) {
    return `${message} → Connection timed out. Verify firewall rules and that the database accepts remote connections (listen_addresses, pg_hba.conf).`;
  }
  if (code === '28P01' || code === '28000') {
    return `${message} → Authentication failed. Check user/password in DATABASE_URL (Supabase pooler users look like postgres.<project-ref>).`;
  }
  if (code === '3D000') {
    return `${message} → Database does not exist. Check the database name in DATABASE_URL.`;
  }
  return message;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export class PostgresTorrentRepository implements TorrentRepository {
  public readonly backend: DbBackend = 'postgres';

  private readonly pool: PoolLike;
  private readonly table: string;
  private readonly writePolicy: DbWritePolicy;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly connectionLabel: string;

  private meta: TableMeta | null = null;
  private metaPromise: Promise<TableMeta> | null = null;
  /** Se activa al detectar que falta el índice único en info_hash (42P10). */
  private missingUniqueIndex = false;
  private readonly stats: RepositoryWriteStats = emptyStats();

  constructor(options: PostgresRepositoryOptions) {
    this.table = options.table ?? 'torrents';
    qualifiedTable(this.table); // valida el identificador de forma temprana
    this.writePolicy = options.writePolicy ?? 'preserve';
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 500));
    this.maxRetries = Math.max(1, options.maxRetries ?? 3);
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? console;
    this.connectionLabel = describeConnection(options.connectionString);
    this.pool = options.pool ?? new pg.Pool(buildPoolConfig(options));
  }

  describe(): string {
    return `postgres ${this.connectionLabel} table=${this.table} policy=${this.writePolicy}`;
  }

  getStats(): RepositoryWriteStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Metadatos de la tabla (se cargan una vez y se comparten entre crawlers concurrentes). */
  async getTableMeta(): Promise<TableMeta> {
    if (this.meta) return this.meta;
    if (!this.metaPromise) {
      this.metaPromise = this.withClient(client => introspectTable(client, this.table))
        .then(meta => {
          this.meta = meta;
          const skipped = SANITIZED_COLUMNS.filter(column => !meta.columns.some(c => c.name === column));
          this.logger.log(
            `[DB] Table ${this.table}: ${meta.columns.length} writable columns` +
            (meta.hasUpdatedAt ? ' (+updated_at)' : '') +
            (skipped.length > 0 ? `; not present, skipped: ${skipped.join(', ')}` : '')
          );
          return meta;
        })
        .catch(error => {
          this.metaPromise = null;
          throw error;
        });
    }
    return this.metaPromise;
  }

  /**
   * Persiste los registros. Cada lote va en una transacción:
   *   1) UPDATE de las filas existentes según la política de escritura (solo si algo cambia).
   *   2) INSERT de las filas nuevas con ON CONFLICT DO NOTHING (o NOT EXISTS si falta el índice único).
   */
  async upsertBatch(records: TorrentRecord[], batchSize = this.batchSize): Promise<number> {
    if (!Array.isArray(records) || records.length === 0) return 0;

    const validRecords = sanitizeAndDeduplicate(records);
    if (validRecords.length === 0) return 0;

    const meta = await this.getTableMeta();
    const size = Math.max(1, Math.min(batchSize, 500));
    const totalBatches = Math.ceil(validRecords.length / size);
    let persisted = 0;

    for (let i = 0; i < validRecords.length; i += size) {
      const chunk = validRecords.slice(i, i + size);
      const batchNumber = Math.floor(i / size) + 1;
      const outcome = await this.writeChunkWithRetries(chunk, meta, batchNumber, totalBatches);
      if (outcome) {
        persisted += chunk.length;
        this.stats.inserted += outcome.inserted;
        this.stats.updated += outcome.updated;
        this.stats.unchanged += outcome.unchanged;
        this.logger.log(
          `[DB] Batch ${batchNumber}/${totalBatches} ok: ${chunk.length} records ` +
          `(${outcome.inserted} new, ${outcome.updated} updated, ${outcome.unchanged} unchanged).`
        );
      } else {
        this.stats.failed += chunk.length;
      }
    }

    return persisted;
  }

  // --- Internos -----------------------------------------------------------

  private async withClient<T>(fn: (client: QueryableClient) => Promise<T>): Promise<T> {
    let client: QueryableClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      const wrapped = new Error(`[DB] Cannot connect to ${this.connectionLabel}: ${explainConnectionError(error)}`);
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string') Object.assign(wrapped, { code });
      throw wrapped;
    }
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async writeChunkWithRetries(
    chunk: SanitizedTorrentRecord[],
    meta: TableMeta,
    batchNumber: number,
    totalBatches: number
  ): Promise<{ inserted: number; updated: number; unchanged: number } | null> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.withClient(client => this.writeChunk(client, chunk, meta));
      } catch (error) {
        const kind = classifyDatabaseError(error);
        const message = explainConnectionError(error);

        if (kind === 'missing-unique') {
          if (!this.missingUniqueIndex) {
            this.missingUniqueIndex = true;
            this.logger.warn(`[DB] ⚠️  Table ${this.table} has no UNIQUE index on info_hash; falling back to INSERT ... WHERE NOT EXISTS for this run.`);
            this.logger.warn(`[DB]    Permanent fix: CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique ON ${qualifiedTable(this.table)} (info_hash);`);
          }
          continue; // mismo intento contado, pero con la variante sin ON CONFLICT
        }

        this.logger.error(`[DB] Batch ${batchNumber}/${totalBatches} (attempt ${attempt}/${this.maxRetries}) failed: ${message}`);

        if (kind === 'fatal') {
          this.logger.error(`[DB] Non-retriable error (code ${String((error as { code?: unknown })?.code ?? 'n/a')}). Skipping batch ${batchNumber}: ${chunk.length} records lost.`);
          return null;
        }
        if (attempt < this.maxRetries) {
          await this.sleep(1000 * Math.pow(2, attempt));
        }
      }
    }
    this.logger.error(`[DB] ❌ Batch ${batchNumber}/${totalBatches} permanently failed after ${this.maxRetries} attempts. ${chunk.length} records lost.`);
    return null;
  }

  private async writeChunk(
    client: QueryableClient,
    chunk: SanitizedTorrentRecord[],
    meta: TableMeta
  ): Promise<{ inserted: number; updated: number; unchanged: number }> {
    const update = this.buildUpdateStatement(chunk, meta);
    const insert = this.buildInsertStatement(chunk, meta, this.missingUniqueIndex);

    await client.query('BEGIN');
    try {
      const updateResult = await client.query(update.text, update.values);
      const insertResult = await client.query(insert.text, insert.values);
      await client.query('COMMIT');
      const updated = updateResult.rowCount ?? 0;
      const inserted = insertResult.rowCount ?? 0;
      return { inserted, updated, unchanged: Math.max(0, chunk.length - inserted - updated) };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* la conexión puede estar ya rota; el error original es el relevante */
      }
      throw error;
    }
  }

  /** `(VALUES ($1::t, ...), (...)) AS v("col", ...)` con los parámetros aplanados. */
  private buildValuesSource(chunk: SanitizedTorrentRecord[], meta: TableMeta): { sql: string; values: unknown[] } {
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const record of chunk) {
      const placeholders: string[] = [];
      for (const column of meta.columns) {
        let value: unknown = record[column.name as SanitizedColumn];
        if (typeof value === 'string' && column.maxLength !== null && value.length > column.maxLength) {
          value = value.slice(0, column.maxLength);
        }
        values.push(value);
        placeholders.push(`$${values.length}::${column.castType}`);
      }
      rows.push(`(${placeholders.join(', ')})`);
    }
    const aliasColumns = meta.columns.map(column => quoteIdentifier(column.name)).join(', ');
    return { sql: `(VALUES ${rows.join(', ')}) AS v(${aliasColumns})`, values };
  }

  /**
   * Expresión del valor final de una columna en una fila que ya existe.
   *  preserve : la BD gana; el crawler solo rellena huecos y refresca contadores conocidos.
   *  overwrite: el crawler gana cuando trae un valor; un desconocido nunca borra un dato.
   */
  private effectiveValueExpression(column: SanitizedColumn): string {
    const t = `t.${quoteIdentifier(column)}`;
    const v = `v.${quoteIdentifier(column)}`;

    if (column === 'size_bytes') return `COALESCE(NULLIF(${v}, 0), ${t})`;
    if (COUNTER_COLUMNS.has(column)) return `COALESCE(${v}, ${t})`;

    if (this.writePolicy === 'overwrite') {
      if (ARRAY_COLUMNS.has(column)) return `CASE WHEN ${v} IS NULL OR cardinality(${v}) = 0 THEN ${t} ELSE ${v} END`;
      if (column === 'quality') return `COALESCE(NULLIF(${v}, '${UNKNOWN_QUALITY}'), ${t}, ${v})`;
      return `COALESCE(${v}, ${t})`;
    }

    // preserve
    if (ARRAY_COLUMNS.has(column)) return `CASE WHEN ${t} IS NULL OR cardinality(${t}) = 0 THEN ${v} ELSE ${t} END`;
    if (column === 'quality') return `CASE WHEN ${t} IS NULL OR ${t} = '${UNKNOWN_QUALITY}' THEN ${v} ELSE ${t} END`;
    if (column === 'title') return `CASE WHEN ${t} IS NULL OR ${t} = '' THEN ${v} ELSE ${t} END`;
    return `COALESCE(${t}, ${v})`;
  }

  buildUpdateStatement(chunk: SanitizedTorrentRecord[], meta: TableMeta): { text: string; values: unknown[] } {
    const source = this.buildValuesSource(chunk, meta);
    const targetColumns = meta.columns.filter(column => column.name !== 'info_hash');

    const assignments = targetColumns.map(column =>
      `${quoteIdentifier(column.name)} = ${this.effectiveValueExpression(column.name as SanitizedColumn)}`
    );
    if (meta.hasUpdatedAt) assignments.push(`${quoteIdentifier('updated_at')} = now()`);

    const changeConditions = targetColumns.map(column =>
      `t.${quoteIdentifier(column.name)} IS DISTINCT FROM ${this.effectiveValueExpression(column.name as SanitizedColumn)}`
    );

    const text =
      `UPDATE ${qualifiedTable(this.table)} AS t SET ${assignments.join(', ')} ` +
      `FROM ${source.sql} ` +
      `WHERE t.${quoteIdentifier('info_hash')} = v.${quoteIdentifier('info_hash')}` +
      (changeConditions.length > 0 ? ` AND (${changeConditions.join(' OR ')})` : '');

    return { text, values: source.values };
  }

  buildInsertStatement(chunk: SanitizedTorrentRecord[], meta: TableMeta, withoutUniqueIndex: boolean): { text: string; values: unknown[] } {
    const source = this.buildValuesSource(chunk, meta);
    const columnList = meta.columns.map(column => quoteIdentifier(column.name)).join(', ');
    // Contadores desconocidos: en filas NUEVAS se persiste el default histórico (0),
    // porque los consumidores ordenan por seeders y un NULL se colaría primero en DESC.
    const selectList = meta.columns.map(column => {
      const v = `v.${quoteIdentifier(column.name)}`;
      return COUNTER_COLUMNS.has(column.name as SanitizedColumn) ? `COALESCE(${v}, ${UNKNOWN_COUNTER_DEFAULT})` : v;
    }).join(', ');

    const table = qualifiedTable(this.table);
    const hash = quoteIdentifier('info_hash');
    const text = withoutUniqueIndex
      ? `INSERT INTO ${table} (${columnList}) SELECT ${selectList} FROM ${source.sql} ` +
        `WHERE NOT EXISTS (SELECT 1 FROM ${table} AS t WHERE t.${hash} = v.${hash})`
      : `INSERT INTO ${table} (${columnList}) SELECT ${selectList} FROM ${source.sql} ` +
        `ON CONFLICT (${hash}) DO NOTHING`;

    return { text, values: source.values };
  }
}
