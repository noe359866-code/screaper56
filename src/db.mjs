/**
 * src/db.mjs — Supabase upsert layer for aggregated streams.
 */

import { createClient } from '@supabase/supabase-js';

const HEX_40_REGEX = /^[0-9a-f]{40}$/;
const IMDB_REGEX = /^tt\d{7,10}$/;
const DIGITS_ONLY_REGEX = /^\d+$/;
const MAX_TITLE_LENGTH = 500;

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
    codec: null,
    hdr_format: null,
    audio,
    subtitles: Array.from(new Set(subtitles)),
    channels: null,
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

export function createRepository({ supabaseUrl, supabaseServiceRoleKey, dryRun = false } = {}) {
  let client = null;
  const hasCreds = !!supabaseUrl && !!supabaseServiceRoleKey;
  if (!dryRun && hasCreds) {
    client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return {
    get enabled() { return !dryRun && !!client; },
    get dryRun() { return dryRun || !client; },
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

      const groups = new Map();
      for (const rec of valid) {
        const k = Object.keys(rec).sort().join(',');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(rec);
      }
      let persisted = 0;
      const failures = [];
      for (const group of groups.values()) {
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { error, status } = await client
              .from('torrents')
              .upsert(group, { onConflict: 'info_hash', ignoreDuplicates: false, defaultToNull: false })
              .abortSignal(AbortSignal.timeout(25000));
            if (!error) { persisted += group.length; lastErr = null; break; }
            lastErr = `status=${status} code=${error.code || '?'} ${error.message || ''}`;
          } catch (e) { lastErr = e.message || String(e); }
          await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
        }
        if (lastErr) failures.push(lastErr);
      }
      if (failures.length) {
        throw new Error(`Supabase upsert failed: ${failures.join('; ')} (persisted=${persisted}/${valid.length})`);
      }
      return { inserted: persisted, rejected, dryRun: false };
    },
  };
}
