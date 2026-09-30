#!/usr/bin/env node
/**
 * peerflix-static – fetch.mjs
 *
 * Aggregates streams from multiple Stremio addons (see src/providers.mjs)
 * for every IMDb id listed in watchlist.txt, normalizes them into
 * TorrentRecord-shaped objects, writes per-item JSON files under public/data/
 * (plus the Stremio mirror /stream/ endpoints), and UPSERTs the resulting
 * records into the existing public.torrents table in Supabase.
 *
 * Streams with the same infoHash across providers are merged (trackers
 * combined, providers listed, best seeders/title/quality kept).
 */

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepository } from './db.mjs';
import {
  PROVIDERS,
  allProviderManifestMetadata,
  requestedProviderSlugs,
  resolveEnabledProviders,
  resolveManifestOnlyProviders,
} from './providers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const PUBLIC = join(ROOT, 'public');
const DATA_DIR = join(PUBLIC, 'data');
const DATA_MOVIES = join(DATA_DIR, 'movies');
const DATA_SERIES = join(DATA_DIR, 'series');
const STREAM_DIR = join(PUBLIC, 'stream');
const STREAM_MOVIES = join(STREAM_DIR, 'movie');
const STREAM_SERIES = join(STREAM_DIR, 'series');

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const FETCH_CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 4);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const WATCHLIST_PATH = resolve(ROOT, process.env.WATCHLIST_PATH || 'watchlist.txt');
const FIXTURE_MODE = process.env.FIXTURE_MODE === '1';
const DRY_RUN_DB = process.env.DRY_RUN === '1' || process.env.DRY_RUN_DB === '1';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PEERFLIX_BASE_URL = (process.env.PEERFLIX_BASE_URL || 'https://peerflix.mov').replace(/\/+$/, '');
const REQUESTED_PROVIDER_SLUGS = requestedProviderSlugs();
const ENABLED_PROVIDERS = resolveEnabledProviders().map(provider =>
  provider.slug === 'peerflix' ? { ...provider, baseUrl: PEERFLIX_BASE_URL } : provider
);
const MANIFEST_ONLY_PROVIDERS = resolveManifestOnlyProviders();

const IMDB_LINE_RE = /^(tt\d{7,10})(?::s(\d{1,2})(?::e(\d{1,3}))?)?(?:\s+(.*))?$/i;

// ---------- helpers ----------

function buildMagnet(infoHash, title, trackers = []) {
  const params = [`xt=urn:btih:${infoHash}`];
  if (title) params.push(`dn=${encodeURIComponent(title)}`);
  const uniq = new Set();
  for (const t of trackers) {
    const clean = String(t).replace(/^tracker:/, '').trim();
    if (clean && !uniq.has(clean)) { uniq.add(clean); params.push(`tr=${encodeURIComponent(clean)}`); }
  }
  return `magnet:?${params.join('&')}`;
}

// Parse language flag emojis (🇪🇸 → es, 🇬🇧/🇺🇸 → en, etc.)
const FLAG_REGIONS = {
  ES: 'es', MX: 'es', AR: 'es', CL: 'es', CO: 'es', PE: 'es', VE: 'es',
  GB: 'en', US: 'en', CA: 'en', AU: 'en', IE: 'en',
  BR: 'pt', PT: 'pt',
  FR: 'fr', DE: 'de', IT: 'it', JP: 'ja', RU: 'ru', KR: 'ko', CN: 'zh',
};
const FLAG_RE = /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/g;
function regionPairToLang(pair) {
  // A flag is two regional indicator letters. Convert back to the ISO-3166 code.
  const c1 = pair.codePointAt(0) - 0x1F1E6 + 0x41;
  const c2 = pair.codePointAt(2) - 0x1F1E6 + 0x41;
  const code = String.fromCharCode(c1) + String.fromCharCode(c2);
  return FLAG_REGIONS[code] || null;
}

function normalizeLanguage(lang, extraText = '') {
  const out = new Set();
  const add = (raw) => {
    if (!raw) return;
    for (const tok of String(raw).split(/[,+\s/|]+/).filter(Boolean)) {
      const l = tok.toLowerCase().trim();
      if (['es','spa','castellano','latino','spanish'].includes(l)) out.add('es');
      else if (['en','eng','english','ingles','inglés'].includes(l)) out.add('en');
      else if (['pt','por','portuguese','português'].includes(l)) out.add('pt');
      else if (['fr','fra','fre','french','français'].includes(l)) out.add('fr');
      else if (['de','deu','ger','german'].includes(l)) out.add('de');
      else if (['it','ita','italian','italiano'].includes(l)) out.add('it');
      else if (['ja','jpn','japanese'].includes(l)) out.add('ja');
      else if (['ru','rus','russian'].includes(l)) out.add('ru');
      else if (['ko','kor','korean'].includes(l)) out.add('ko');
      else if (['zh','chi','zho','chinese'].includes(l)) out.add('zh');
      else if (l.length <= 3 && /^[a-z]{2,3}$/.test(l)) out.add(l);
    }
  };
  add(lang);
  // flag emojis in description / title / extraText
  const hay = (extraText || '') + ' ' + (lang || '');
  const flags = hay.match(FLAG_RE) || [];
  for (const f of flags) {
    const code = regionPairToLang(f);
    if (code) out.add(code);
  }
  // text language names in parentheses
  const textLangs = extraText.match(/(Spanish|English|French|German|Italian|Japanese|Russian|Portuguese|Castellano|Latino|Ingles|Inglés|Español|Frances|Francés|Aleman|Italiano|Japones|Portugu[ée]s)/gi);
  if (textLangs) for (const t of textLangs) add(t);
  return [...out];
}

function normalizeQuality(nameField, titleField, explicitQuality = null) {
  const blob = `${explicitQuality || ''}\n${nameField || ''}\n${titleField || ''}`.toLowerCase();
  // The database has four normalized buckets. Treat 1440p as the 4K bucket
  // instead of dropping it, while never inventing a quality when none exists.
  if (/(2160|4k|uhd|ultrahd)/.test(blob)) return '4K';
  if (/(1440p)/.test(blob)) return '4K';
  if (/(1080|fullhd|fhd|bluray-1080|bdrip-1080)/.test(blob)) return '1080p';
  if (/720/.test(blob)) return '720p';
  if (/480/.test(blob)) return '480p';
  return null;
}

function trackersFromMagnet(magnet) {
  if (typeof magnet !== 'string' || !magnet.toLowerCase().startsWith('magnet:?')) return [];
  const trackers = [];
  try {
    const params = new URLSearchParams(magnet.slice(magnet.indexOf('?') + 1));
    for (const tracker of params.getAll('tr')) {
      const clean = tracker.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (clean) trackers.push(clean);
    }
  } catch {
    // A malformed magnet must not make the whole provider response fail.
  }
  return trackers;
}

function parseStremioStream(rawStream, provider) {
  if (!rawStream) return null;
  const infoHash = String(rawStream.infoHash || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return null;

  // Addons are not completely uniform: Peerflix uses `description`, while
  // Torrentio/TorrentsDB/TPB+ normally use `title`.
  const nameField = String(rawStream.name || '');
  const titleField = String(rawStream.title || rawStream.description || '');
  const metadataText = `${nameField}\n${titleField}`;
  const lines = titleField.split('\n').map(s => s.trim()).filter(Boolean);
  const releaseTitle = lines[0] || nameField.replace(/\n/g, ' ').trim() || infoHash;

  // Seed/size may be proper JSON fields (Peerflix) or footer badges in title.
  const seedMatch = metadataText.match(/👤\s*(\d+|\?)/);
  const sizeMatch = metadataText.match(/💾\s*([0-9.,]+\s*(?:GB|MB|KB|B|GiB|MiB))/i);
  const sourceMatch = metadataText.match(/(?:⚙️|🌐)\s*([^\s]+)/);
  const explicitSeeders = rawStream.seed ?? rawStream.seeders;
  const seeders = Number.isSafeInteger(explicitSeeders) && explicitSeeders >= 0
    ? explicitSeeders
    : seedMatch && /^\d+$/.test(seedMatch[1]) ? Number(seedMatch[1]) : null;
  const explicitSize = rawStream.sizebytes ?? rawStream.sizeBytes;
  const sizeBytes = Number.isSafeInteger(explicitSize) && explicitSize >= 0
    ? explicitSize
    : parseSize(sizeMatch ? sizeMatch[1] : null);

  const sourceTrackers = Array.isArray(rawStream.sources)
    ? rawStream.sources
      .map(x => String(x).replace(/^tracker:/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim())
      .filter(x => x && !/^dht:/i.test(x))
    : [];
  const magnetUrl = rawStream.magnet || rawStream.magnetUrl || null;
  const trackers = [...new Set([...sourceTrackers, ...trackersFromMagnet(magnetUrl)])];

  const quality = normalizeQuality(nameField, titleField, rawStream.quality || rawStream.tag);
  const languages = normalizeLanguage(rawStream.language, metadataText);
  const externalProvider = sourceMatch
    ? sourceMatch[1].replace(/[.,]+$/, '')
    : provider.slug === 'ytztvio' && nameField && !/(?:4k|2160p|1440p|1080p|720p|480p)/i.test(nameField)
      ? nameField.trim()
      : null;

  return {
    infoHash,
    title: releaseTitle,
    quality,
    seeders,
    sizeBytes,
    trackers,
    magnetUrl,
    languages,
    fileIdx: rawStream.fileIdx ?? null,
    provider: provider.slug,
    providerName: provider.name,
    externalProvider,
  };
}

function parseSize(label) {
  if (!label) return null;
  const m = label.toLowerCase().replace(',', '.').match(/([0-9.]+)\s*(gb|mb|kb|b|gib|mib)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  const mult = {
    b: 1,
    kb: 1024, kib: 1024,
    mb: 1024 * 1024, mib: 1024 * 1024,
    gb: 1024 * 1024 * 1024, gib: 1024 * 1024 * 1024,
  }[unit];
  if (!mult) return null;
  return Math.round(n * mult);
}

// ---------- HTTP ----------

async function fetchJSON(url, { timeout = FETCH_TIMEOUT_MS, retries = 2 } = {}) {
  const userAgents = [
    'peerflix-static-bot/2.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'user-agent': userAgents[attempt % userAgents.length],
          'accept': 'application/json,text/plain,*/*',
          'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
        },
      });
      clearTimeout(t);
      if (res.status === 404) return { streams: [] }; // provider doesn't have this title
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      clearTimeout(t);
      if (attempt < retries) await new Promise(r => setTimeout(r, 700 * Math.pow(2, attempt) + Math.random() * 300));
    }
  }
  throw lastErr;
}

// ---------- watchlist ----------

function parseWatchlist(text) {
  const items = [];
  const seen = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(IMDB_LINE_RE);
    if (!m) { console.warn(`⚠️  Línea ignorada (no reconozco el ID): ${rawLine.trim()}`); continue; }
    const imdbId = m[1].toLowerCase();
    const season = m[2] !== undefined ? Number(m[2]) : null;
    const episode = m[3] !== undefined ? Number(m[3]) : null;
    const label = (m[4] || '').trim() || null;
    const type = season !== null ? 'series' : 'movie';
    const key = episode !== null ? `${imdbId}:s${season}:e${episode}`
              : season !== null ? `${imdbId}:s${season}`
              : imdbId;
    if (seen.has(key)) {
      const existing = items[seen.get(key)];
      if (!existing.label && label) existing.label = label;
      continue;
    }
    seen.set(key, items.length);
    items.push({ imdbId, type, season, episode, label, raw: rawLine.trim() });
  }
  return items;
}

// A season request expands into individual episode requests. Deduplicate after
// expansion too, so an explicit episode plus a whole-season line is fetched
// and reported only once (e.g. tt0944947:s1:e1 + tt0944947:s1).
function dedupeQueries(queries) {
  const unique = new Map();
  for (const query of queries) {
    const imdbId = String(query.imdbId || '').toLowerCase();
    const key = query.kind === 'movie'
      ? `movie:${imdbId}`
      : `series:${imdbId}:s${Number(query.season)}:e${Number(query.episode)}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, query);
    } else if ((!existing.label || existing.label === existing.imdbId) && query.label) {
      // Keep a useful user-supplied/generated label when the first entry has none.
      unique.set(key, { ...existing, label: query.label });
    }
  }
  return [...unique.values()];
}

// ---------- TMDB ----------

async function tmdbFindByImdb(imdbId) {
  if (!TMDB_API_KEY) return null;
  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=es-ES`;
    const data = await fetchJSON(url, { timeout: 10000, retries: 1 });
    const movie = data.movie_results?.[0];
    const tv = data.tv_results?.[0];
    if (movie) return { kind: 'movie', title: movie.title, year: movie.release_date?.slice(0, 4), tmdbId: movie.id };
    if (tv) return { kind: 'tv', title: tv.name, year: tv.first_air_date?.slice(0, 4), tmdbId: tv.id };
    return null;
  } catch (err) {
    console.warn(`⚠️  TMDB lookup falló para ${imdbId}: ${err.message}`);
    return null;
  }
}

async function tmdbEpisodesForSeason(tmdbId, seasonNumber) {
  if (!TMDB_API_KEY || !tmdbId || !seasonNumber) return null;
  try {
    const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}&language=es-ES`;
    const data = await fetchJSON(url, { timeout: 10000, retries: 1 });
    return (data.episodes || []).map(e => ({ episode: e.episode_number, title: e.name, airDate: e.air_date || null }));
  } catch (err) {
    console.warn(`⚠️  TMDB season fetch falló (tv=${tmdbId} s${seasonNumber}): ${err.message}`);
    return null;
  }
}

async function expandItems(items) {
  const queries = [];
  for (const it of items) {
    if (it.type === 'movie') { queries.push({ kind: 'movie', imdbId: it.imdbId, label: it.label }); continue; }
    if (it.episode !== null) { queries.push({ kind: 'series', imdbId: it.imdbId, season: it.season, episode: it.episode, label: it.label }); continue; }
    const meta = await tmdbFindByImdb(it.imdbId);
    const tmdbId = meta?.kind === 'tv' ? meta.tmdbId : null;
    const tvTitle = (meta?.kind === 'tv' ? meta.title : null) || it.label || it.imdbId;
    if (!tmdbId) { console.warn(`⚠️  No se puede expandir ${it.imdbId}:s${it.season} sin TMDB_API_KEY. Se omite.`); continue; }
    const episodes = await tmdbEpisodesForSeason(tmdbId, it.season);
    if (!episodes?.length) { console.warn(`⚠️  TMDB no devolvió episodios para ${it.imdbId} s${it.season}.`); continue; }
    for (const ep of episodes) {
      queries.push({
        kind: 'series', imdbId: it.imdbId, season: it.season, episode: ep.episode,
        label: `${tvTitle} S${String(it.season).padStart(2,'0')}E${String(ep.episode).padStart(2,'0')}${ep.title ? ' – ' + ep.title : ''}`.trim(),
      });
    }
  }
  return dedupeQueries(queries);
}

// ---------- multi-provider fetch ----------

function fakeHash(seed) {
  // fnv-1a + mix → 40 hex; fixture only.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = (h + ((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))) >>> 0; }
  let out = '';
  for (let i = 0; i < 10; i++) { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h = h >>> 0; out += (h>>>0).toString(16).padStart(8,'0'); }
  return out.slice(0, 40);
}

function fixtureStream(item, providerSlug, q, i, seeds, size, lang, extProv) {
  const id = stremioId(item);
  const infoHash = fakeHash(id + '|' + providerSlug + '|' + q + '|' + i);
  const title = `${item.label || id} [${q}][${lang === 'es' ? 'Castellano' : 'Ingles'}+Subs]`;
  const trackers = ['udp://tracker.opentrackr.org:1337/announce'];
  return {
    infoHash, title, quality: q, seeders: seeds, sizeBytes: size,
    trackers, languages: [lang], fileIdx: 0,
    provider: providerSlug, providerName: PROVIDERS[providerSlug].name,
    externalProvider: extProv,
  };
}

async function fetchFromProvider(provider, query) {
  const stremioUrl = query.kind === 'movie'
    ? `${provider.baseUrl}/stream/movie/${query.imdbId}.json`
    : `${provider.baseUrl}/stream/series/${query.imdbId}:${query.season}:${query.episode}.json`;
  if (FIXTURE_MODE) {
    // Fake a few streams per provider
    const base = [
      ['4K', 40, 12_000_000_000, 'es', provider.slug],
      ['1080p', 80, 2_800_000_000, 'es', 'YTS'],
      ['1080p', 30, 1_900_000_000, 'en', provider.slug],
      ['720p', 10, 950_000_000, 'es', null],
    ];
    const streams = base.map((b, i) => fixtureStream(query, provider.slug, b[0], i, b[1], b[2], b[3], b[4]));
    return { provider, url: stremioUrl + ' [fixture]', streams };
  }
  const data = await fetchJSON(stremioUrl);
  const streams = [];
  for (const raw of Array.isArray(data.streams) ? data.streams : []) {
    const s = parseStremioStream(raw, provider);
    if (s) streams.push(s);
  }
  return { provider, url: stremioUrl, streams };
}

function mergeStreams(results) {
  // Merge by infoHash: combine trackers + providers; keep highest seeders.
  const map = new Map();
  for (const r of results) {
    for (const s of r.streams) {
      const existing = map.get(s.infoHash);
      if (!existing) {
        map.set(s.infoHash, {
          ...s,
          providers: [s.provider],
          providerNames: [s.providerName],
          externalProviders: s.externalProvider ? [s.externalProvider] : [],
          trackers: [...s.trackers],
          magnetUrl: s.magnetUrl || null,
        });
        continue;
      }
      // merge trackers
      const tset = new Set(existing.trackers);
      for (const t of s.trackers) tset.add(t);
      existing.trackers = [...tset];
      if (!existing.magnetUrl && s.magnetUrl) existing.magnetUrl = s.magnetUrl;
      // merge providers
      if (!existing.providers.includes(s.provider)) { existing.providers.push(s.provider); existing.providerNames.push(s.providerName); }
      if (s.externalProvider && !existing.externalProviders.includes(s.externalProvider)) existing.externalProviders.push(s.externalProvider);
      // choose best seeders/title/quality
      if ((s.seeders ?? -1) > (existing.seeders ?? -1)) {
        existing.seeders = s.seeders;
        existing.title = s.title;
        existing.quality = s.quality || existing.quality;
        existing.sizeBytes = s.sizeBytes ?? existing.sizeBytes;
        existing.magnetUrl = s.magnetUrl || existing.magnetUrl;
        existing.languages = [...new Set([...existing.languages, ...s.languages])];
      } else if (s.quality && !existing.quality) {
        existing.quality = s.quality;
      } else {
        existing.languages = [...new Set([...existing.languages, ...s.languages])];
      }
    }
  }
  return [...map.values()];
}

async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length || 1) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = { ok: true, value: await tasks[i]() }; }
      catch (err) { results[i] = { ok: false, error: err }; }
    }
  });
  await Promise.all(workers);
  return results;
}

function stremioId(query) {
  if (query.kind === 'movie') return query.imdbId;
  return `${query.imdbId}:${query.season}:${query.episode}`;
}

async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function cleanDir(dir) {
  if (!existsSync(dir)) return;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile()) await unlink(join(dir, e.name));
  }
}

// ---------- main ----------

async function main() {
  console.log(`📂 peerflix-static – multi-provider fetch & ingest`);
  console.log(`   watchlist   : ${WATCHLIST_PATH}`);
  console.log(`   concurrency : ${FETCH_CONCURRENCY}`);
  console.log(`   providers   : ${ENABLED_PROVIDERS.map(p => `${p.name}(${p.slug})`).join(', ') || 'ninguno'}${FIXTURE_MODE ? '  [FIXTURE]' : ''}`);
  if (MANIFEST_ONLY_PROVIDERS.length) {
    console.log(`   manifest    : ${MANIFEST_ONLY_PROVIDERS.map(p => `${p.name} (${p.manifestUrl})`).join(', ')} [solo catálogo, no compatible con IMDb]`);
  }
  console.log(`   TMDB key    : ${TMDB_API_KEY ? 'configurada ✅' : 'no configurada'}`);
  console.log(`   Supabase    : ${SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? (DRY_RUN_DB ? 'configurada (DRY RUN)' : 'configurada ✅') : 'sin credenciales (JSON local)'}`);
  console.log();

  await mkdir(DATA_MOVIES, { recursive: true });
  await mkdir(DATA_SERIES, { recursive: true });
  await mkdir(STREAM_MOVIES, { recursive: true });
  await mkdir(STREAM_SERIES, { recursive: true });
  await cleanDir(DATA_MOVIES);
  await cleanDir(DATA_SERIES);
  await cleanDir(STREAM_MOVIES);
  await cleanDir(STREAM_SERIES);

  const watchText = await readFile(WATCHLIST_PATH, 'utf8');
  const parsed = parseWatchlist(watchText);
  console.log(`🔎 Watchlist: ${parsed.length} líneas.`);
  const queries = await expandItems(parsed);
  console.log(`📋 Consultas: ${queries.length} títulos/episodios × ${ENABLED_PROVIDERS.length} proveedores = ${queries.length * ENABLED_PROVIDERS.length} requests.`);
  if (!queries.length) { console.error('❌ No hay nada que consultar.'); process.exitCode = 1; return; }
  console.log();

  const startedAt = new Date().toISOString();
  const repo = createRepository({ supabaseUrl: SUPABASE_URL, supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY, dryRun: DRY_RUN_DB });

  // Build one task per (query, provider) pair so we can run them concurrently.
  const tasks = [];
  const taskMeta = []; // {queryIdx, providerSlug}
  for (let qi = 0; qi < queries.length; qi++) {
    for (const provider of ENABLED_PROVIDERS) {
      tasks.push(() => fetchFromProvider(provider, queries[qi]));
      taskMeta.push({ qi, providerSlug: provider.slug });
    }
  }
  const rawResults = await pool(tasks, FETCH_CONCURRENCY);

  // Group results back per query
  const perQuery = queries.map(q => ({ query: q, providerResults: [], errors: [] }));
  for (let i = 0; i < rawResults.length; i++) {
    const meta = taskMeta[i];
    const r = rawResults[i];
    const slot = perQuery[meta.qi];
    if (!r.ok) { slot.errors.push({ provider: meta.providerSlug, error: String(r.error.message || r.error) }); continue; }
    slot.providerResults.push(r.value);
  }

  const index = {
    generatedAt: startedAt,
    finishedAt: null,
    providers: allProviderManifestMetadata(),
    enabledProviders: ENABLED_PROVIDERS.map(p => p.slug),
    requestedProviders: REQUESTED_PROVIDER_SLUGS,
    manifestOnlyProviders: MANIFEST_ONLY_PROVIDERS.map(p => ({ slug: p.slug, name: p.name, manifestUrl: p.manifestUrl, note: p.note })),
    fixture: FIXTURE_MODE,
    dryRunDb: repo.dryRun,
    total: queries.length,
    movies: 0,
    episodes: 0,
    totalStreams: 0,
    items: [],
    errors: [],
    perProviderStats: Object.fromEntries(ENABLED_PROVIDERS.map(p => [p.slug, { streams: 0, errors: 0 }])),
    db: { inserted: 0, rejected: 0, failures: [] },
  };

  const dbCandidates = [];

  for (const slot of perQuery) {
    const q = slot.query;
    const merged = mergeStreams(slot.providerResults);
    for (const pr of slot.providerResults) {
      index.perProviderStats[pr.provider.slug].streams += pr.streams.length;
    }
    for (const err of slot.errors) {
      index.perProviderStats[err.provider].errors++;
      index.errors.push({ id: stremioId(q), provider: err.provider, label: q.label || null, error: err.error });
    }
    const item = {
      id: stremioId(q), imdbId: q.imdbId,
      type: q.kind === 'movie' ? 'movie' : 'series',
      season: q.kind === 'series' ? q.season : null,
      episode: q.kind === 'series' ? q.episode : null,
      label: q.label || q.imdbId,
      providerUrls: Object.fromEntries(slot.providerResults.map(r => [r.provider.slug, r.url])),
      streamCount: merged.length,
      bestSeeders: merged.reduce((m,s)=>Math.max(m, s.seeders ?? -1), -1) === -1 ? null : merged.reduce((m,s)=>Math.max(m, s.seeders ?? -1), -1),
      qualities: [...new Set(merged.map(s => s.quality).filter(Boolean))].sort(),
      languages: [...new Set(merged.flatMap(s => s.languages))].sort(),
      providers: [...new Set(merged.flatMap(s => s.providers))].sort(),
    };
    index.items.push(item);
    index.totalStreams += merged.length;

    // Build output streams (with magnetUrl) for JSON files
    const outputStreams = merged.map(s => ({
      name: s.providerNames.join('+') + (s.quality ? ' ' + s.quality : ''),
      title: s.title,
      infoHash: s.infoHash,
      fileIdx: s.fileIdx,
      language: s.languages[0] || null,
      audioLangs: s.languages,
      quality: s.quality,
      seeders: s.seeders,
      sizeBytes: s.sizeBytes,
      sizeLabel: null,
      providers: s.providers,
      providerNames: s.providerNames,
      externalProviders: s.externalProviders,
      trackers: s.trackers,
      magnetUrl: s.magnetUrl || buildMagnet(s.infoHash, s.title, s.trackers),
    }));

    if (q.kind === 'movie') {
      index.movies++;
      await writeJSON(join(DATA_MOVIES, `${q.imdbId}.json`), { ...item, streams: outputStreams });
      await writeJSON(join(STREAM_MOVIES, `${q.imdbId}.json`), { streams: outputStreams });
    } else {
      index.episodes++;
      const fname = `${q.imdbId}-s${q.season}e${q.episode}.json`;
      const sname = `${q.imdbId}:${q.season}:${q.episode}.json`;
      await writeJSON(join(DATA_SERIES, fname), { ...item, streams: outputStreams });
      await writeJSON(join(STREAM_SERIES, sname), { streams: outputStreams });
    }
    for (const s of outputStreams) dbCandidates.push({ item, stream: s });

    const icon = merged.length ? '✅' : '⚠️ ';
    console.log(`  ${icon} ${item.id.padEnd(22)} ${String(merged.length).padStart(3)} streams  ${item.providers.join(',').padEnd(28)} ${item.label}`);
  }

  if (dbCandidates.length) {
    try {
      const dbRes = await repo.upsert(dbCandidates);
      index.db.inserted = dbRes.inserted;
      index.db.rejected = dbRes.rejected;
      index.db.dryRun = dbRes.dryRun;
      console.log(`\n🗄  BD: ${dbRes.dryRun ? '[DRY RUN] ' : ''}${dbRes.inserted} registros (${dbRes.rejected} inválidos).`);
    } catch (err) {
      index.db.failures.push(err.message || String(err));
      console.log(`\n🗄  BD: ERROR – ${err.message}`);
    }
  }

  const finishedAt = new Date().toISOString();
  index.finishedAt = finishedAt;
  index.durationMs = new Date(finishedAt) - new Date(startedAt);

  await writeJSON(join(DATA_DIR, 'index.json'), index);
  await writeJSON(join(DATA_DIR, 'report.json'), index);

  const manifest = {
    id: 'com.example.peerflix-static',
    version: '1.1.0',
    name: 'Peerflix Static (personal, aggregated)',
    description: `Agregador personal con ${ENABLED_PROVIDERS.map(p=>p.name).join(', ')}. Responde solo a los IMDb IDs de tu watchlist.`,
    catalogs: [],
    resources: [{ name: 'stream', types: ['movie','series'], idPrefixes: ['tt'] }],
    types: ['movie','series'],
    behaviorHints: { configurable: false, configurationRequired: false },
    // Informational metadata for the dashboard; Stremio ignores unknown keys.
    sourceManifests: allProviderManifestMetadata(),
  };
  await writeJSON(join(PUBLIC, 'manifest.json'), manifest);

  console.log(`\n📊 Resumen:`);
  console.log(`   películas : ${index.movies}`);
  console.log(`   episodios : ${index.episodes}`);
  console.log(`   streams   : ${index.totalStreams} (fusionados de ${ENABLED_PROVIDERS.length} proveedores)`);
  for (const p of ENABLED_PROVIDERS) console.log(`     · ${p.name.padEnd(14)} ${index.perProviderStats[p.slug].streams} streams, ${index.perProviderStats[p.slug].errors} errores`);
  console.log(`   errores   : ${index.errors.length} (errores parciales por proveedor)`);
  console.log(`   duración  : ${(index.durationMs/1000).toFixed(1)}s`);
  console.log(`   salida    : ${PUBLIC}`);

  if (index.totalStreams === 0 && index.errors.length > 0) process.exitCode = 2;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isCli) main().catch(err => { console.error('💥 Fatal:', err); process.exit(1); });

export {
  buildMagnet,
  dedupeQueries,
  normalizeQuality,
  parseSize,
  parseStremioStream,
  parseWatchlist,
};
