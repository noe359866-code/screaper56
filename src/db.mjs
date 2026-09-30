/**
 * src/db.mjs — Supabase upsert layer for aggregated streams (optional).
 *
 * Without credentials nothing is written and the pipeline still publishes the
 * JSON files: Supabase is an extra, not a requirement.
 *
 * Robustness:
 *  - 42P10 (the table has no UNIQUE constraint on info_hash, so ON CONFLICT is
 *    impossible) → falls back to "select existing hashes + insert new rows +
 *    update existing rows". Adding the constraint re-enables the native UPSERT:
 *      ALTER TABLE public.torrents ADD CONSTRAINT torrents_info_hash_key UNIQUE (info_hash);
 *  - codec / hdr_format / channels are optional columns: if the table does not
 *    have them (or rejects the values) they are dropped and the write retried.
 */

import { createClient } from '@supabase/supabase-js';

const HEX_40_REGEX = /^[0-9a-f]{40}$/;
const IMDB_REGEX = /^tt\d{7,10}$/;
const DIGITS_ONLY_REGEX = /^\d+$/;
const MAX_TITLE_LENGTH = 500;
const TABLE = 'torrents';
const SELECT_CHUNK = 100;
const UPDATE_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 25000;
const RELEASE_FIELDS = ['codec', 'hdr_format', 'channels'];
// Missing column (PostgREST / Postgres) or values the column type/constraints reject.
const RELEASE_FIELD_ERRORS = new Set(['PGRST204', '42703', '22P02', '22003', '22001', '23514', '42804']);
const NO_UNIQUE_CONSTRAINT = '42P10';

function parseNonNegativeInt(val, defaultValue = null) {
  if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) return Math.floor(val);
  if (typeof val === 'string') {
    const t = val.trim();
    if (DIGITS_ONLY_REGEX.test(t)) {
      const n = Number.parseInt(t, 10);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  return defaultValue;
}

function safeString(val, maxLength, defaultValue = null) {
  if (typeof val !== 'string') return defaultValue;
  const t = val.trim();
  if (!t.length) return defaultValue;
  return t.substring(0, maxLength);
}

export function streamToTorrentRecord(item, stream) {
  if (!stream || typeof stream.infoHash !== 'string') return null;
  const infoHash = stream.infoHash.toLowerCase().trim();
  if (!HEX_40_REGEX.test(infoHash) || /^0{40}$/.test(infoHash)) return null;

  const title = typeof stream.title === 'string' ? stream.title.trim() : '';
  if (!title || title.includes('\0')) return null;

  let imdbId = null;
  if (typeof item.imdbId === 'string' && IMDB_REGEX.test(item.imdbId.trim())) imdbId = item.imdbId.trim();

  const type = item.type === 'series' ? 'series' : 'movie';

  const audio = Array.isArray(stream.audioLangs) && stream.audioLangs.length
    ? Array.from(new Set(stream.audioLangs.map(x => String(x).trim().toLowerCase()).filter(Boolean)))
    : [];

  // Subtitles parsed from "[ES-EN]" / "[Multi Subs]" in title
  const subtitles = [];
  const subTag = title.match(/\[(?:[A-Z]{2}-[A-Z]{2}|[^\]]*(?:Subs|SUB|Subtitulado)[^\]]*)\]/g) || [];
  for (const tag of subTag) {
    const m = tag.match(/\[([A-Z]{2})-([A-Z]{2})\]/);
    if (m) { subtitles.push(m[1].toLowerCase(), m[2].toLowerCase()); }
  }

  const providers = Array.isArray(stream.providers) ? stream.providers : (stream.provider ? [stream.provider] : []);
  const sourceTracker = providers.length ? providers.join('+') : 'stremio-agg';
  const release = stream.release || {};

  return {
    info_hash: infoHash,
    title: title.substring(0, MAX_TITLE_LENGTH),
    type,
    imdb_id: imdbId,
    tmdb_id: null,
    kitsu_id: null,
    anilist_id: null,
    mal_id: null,
    season: parseNonNegativeInt(item.season),
    episode: parseNonNegativeInt(item.episode),
    absolute_episode: null,
    file_index: parseNonNegativeInt(stream.fileIdx),
    release_group: stream.externalProviders && stream.externalProviders.length
      ? safeString(stream.externalProviders.join(','), 100)
      : null,
    quality: safeString(stream.quality, 20) ?? 'Unknown',
    // Parsed from the release name (public/lib/parse.js · parseReleaseInfo).
    codec: safeString(release.codec, 20),
    hdr_format: Array.isArray(release.hdr) && release.hdr.length ? safeString(release.hdr.join(','), 40) : null,
    audio,
    subtitles: Array.from(new Set(subtitles)),
    channels: safeString(release.channels, 10),
    size_bytes: stream.sizeBytes ?? undefined,
    seeders: stream.seeders ?? undefined,
    leechers: undefined,
    source_tracker: sourceTracker,
  };
}

function pruneUnknown(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([key, v]) =>
      v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== '' &&
      !(key === 'quality' && v === 'Unknown')
    )
  );
}

function withoutReleaseFields(record) {
  const copy = { ...record };
  for (const field of RELEASE_FIELDS) delete copy[field];
  return copy;
}

class DbError extends Error {
  constructor(error, status) {
    super(`status=${status ?? '?'} code=${error?.code || '?'} ${error?.message || ''}`.trim());
    this.code = error?.code || null;
    this.status = status ?? null;
  }
}

function timeoutSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function run(builder) {
  const { data, error, status } = await builder.abortSignal(timeoutSignal());
  if (error) throw new DbError(error, status);
  return data;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function createRepository({
  supabaseUrl,
  supabaseServiceRoleKey,
  dryRun = false,
  client: injectedClient = null,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let client = injectedClient;
  const hasCreds = !!supabaseUrl && !!supabaseServiceRoleKey;
  if (!client && !dryRun && hasCreds) {
    client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  let mode = 'upsert';           // → 'insert+update' after 42P10
  let releaseFields = true;       // → false if the table lacks codec/hdr_format/channels

  async function upsertNative(group) {
    await run(client.from(TABLE).upsert(group, { onConflict: 'info_hash', ignoreDuplicates: false, defaultToNull: false }));
    return { created: null, updated: null };
  }

  async function insertOrUpdate(group) {
    const existing = new Set();
    for (const part of chunks(group.map(r => r.info_hash), SELECT_CHUNK)) {
      const rows = await run(client.from(TABLE).select('info_hash').in('info_hash', part));
      for (const row of rows || []) existing.add(String(row.info_hash).toLowerCase());
    }
    const fresh = group.filter(r => !existing.has(r.info_hash));
    const stale = group.filter(r => existing.has(r.info_hash));
    if (fresh.length) await run(client.from(TABLE).insert(fresh, { defaultToNull: false }));
    for (const part of chunks(stale, UPDATE_CONCURRENCY)) {
      await Promise.all(part.map(rec => {
        const { info_hash: hash, ...changes } = rec;
        return run(client.from(TABLE).update(changes).eq('info_hash', hash));
      }));
    }
    return { created: fresh.length, updated: stale.length };
  }

  async function writeGroup(group) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const records = releaseFields ? group : group.map(withoutReleaseFields);
      try {
        return mode === 'upsert' ? await upsertNative(records) : await insertOrUpdate(records);
      } catch (err) {
        lastErr = err;
        if (err.code === NO_UNIQUE_CONSTRAINT && mode === 'upsert') {
          mode = 'insert+update';
          attempt--; // not a transient failure: retry right away with the fallback
          continue;
        }
        if (RELEASE_FIELD_ERRORS.has(err.code) && releaseFields && group.some(r => RELEASE_FIELDS.some(f => f in r))) {
          releaseFields = false;
          attempt--;
          continue;
        }
        if (attempt < 2) await sleep(800 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }

  return {
    get enabled() { return !dryRun && !!client; },
    get dryRun() { return dryRun || !client; },
    get mode() { return mode; },
    async upsert(records) {
      const unique = new Map();
      let rejected = 0;
      for (const r of records) {
        const clean = streamToTorrentRecord(r.item, r.stream);
        if (!clean) { rejected++; continue; }
        const key = clean.info_hash;
        if (!unique.has(key)) unique.set(key, clean);
      }
      const valid = [...unique.values()].map(pruneUnknown);
      if (!valid.length) return { inserted: 0, rejected, dryRun: this.dryRun };
      if (this.dryRun || !client) return { inserted: valid.length, rejected, dryRun: true };

      // PostgREST bulk writes need the same keys in every row of a request.
      const groups = new Map();
      for (const rec of valid) {
        const k = Object.keys(rec).sort().join(',');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(rec);
      }
      let persisted = 0;
      let created = 0;
      let updated = 0;
      const failures = [];
      for (const group of groups.values()) {
        try {
          const res = await writeGroup(group);
          persisted += group.length;
          created += res.created ?? 0;
          updated += res.updated ?? 0;
        } catch (err) {
          failures.push(err.message || String(err));
        }
      }
      if (failures.length) {
        throw new Error(`Supabase upsert failed: ${failures.join('; ')} (persisted=${persisted}/${valid.length}, mode=${mode})`);
      }
      return {
        inserted: persisted,
        rejected,
        dryRun: false,
        mode,
        ...(mode === 'insert+update' ? { created, updated } : {}),
        ...(releaseFields ? {} : { skippedColumns: RELEASE_FIELDS }),
      };
    },
  };
}
