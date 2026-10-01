#!/usr/bin/env node
/**
 * peerflix-static – fetch.mjs
 *
 * Aggregates streams from multiple Stremio addons (see public/lib/providers.js)
 * for every IMDb id listed in watchlist.txt, keeps only 2 torrents per
 * title/episode (the best with Spanish audio and the best with English audio,
 * each with just the best public trackers), writes per-item JSON files under
 * public/data/ (plus the Stremio mirror /stream/ and a watchlist catalog) and
 * UPSERTs the picks into the existing public.torrents table in Supabase.
 *
 * The processing core lives in public/lib/ and is shared with the static web
 * app, which can run the very same pipeline in the browser without any token.
 * No API key is needed: season expansion and titles come from Cinemeta
 * (TMDB_API_KEY is only an optional fallback) and Supabase is optional.
 *
 * Modes:
 *   default          query the addons live
 *   FIXTURE_MODE=1   fake addon/Cinemeta responses (no network) to test the flow
 *   REPROCESS=1      re-run the selection on the already published public/data
 *                    files (no network): useful after changing the criteria
 */

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepository } from './db.mjs';
import { describeDatabaseWrite } from '../public/lib/persistence.js';
import {
  allProviderManifestMetadata,
  requestedProviderSlugs,
  resolveEnabledProviders,
  resolveManifestOnlyProviders,
} from './providers.mjs';
import {
  buildMagnet,
  dedupeQueries,
  mergeStreams,
  normalizeLanguage,
  normalizeQuality,
  parseSize,
  parseStremioStream,
  parseWatchlist,
} from '../public/lib/parse.js';
import { BEST_TRACKERS_URL, DEFAULT_MAX_TRACKERS, PICK_LANGUAGES } from '../public/lib/select.js';
import { CINEMETA_URL, showLabel } from '../public/lib/meta.js';
import {
  PICK_META,
  createJsonFetcher,
  expandWatchlist,
  loadBestTrackers,
  candidateFromPublished,
  loadMetadata,
  runPipeline,
  toOutputStream,
} from '../public/lib/pipeline.js';

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
const CATALOG_DIR = join(PUBLIC, 'catalog');
const CATALOG_MOVIES = join(CATALOG_DIR, 'movie');
const CATALOG_SERIES = join(CATALOG_DIR, 'series');
const CATALOG_ID = 'peerflix-static-watchlist';

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.FETCH_CONCURRENCY || 4));
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const WATCHLIST_PATH = resolve(ROOT, process.env.WATCHLIST_PATH || 'watchlist.txt');
const FIXTURE_MODE = process.env.FIXTURE_MODE === '1';
const REPROCESS = process.env.REPROCESS === '1';
const DRY_RUN_DB = process.env.DRY_RUN === '1' || process.env.DRY_RUN_DB === '1';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PEERFLIX_BASE_URL = (process.env.PEERFLIX_BASE_URL || 'https://peerflix.mov').replace(/\/+$/, '');
// Trackers por magnet (solo los mejores). TRACKERS_URL vacío = usar la copia integrada.
const MAX_TRACKERS = Math.min(50, Math.max(1, Number.parseInt(process.env.MAX_TRACKERS || '', 10) || DEFAULT_MAX_TRACKERS));
const TRACKERS_URL = process.env.TRACKERS_URL ?? BEST_TRACKERS_URL;
// Metadatos sin API key (Cinemeta). CINEMETA=0 los desactiva.
const CINEMETA_ENABLED = process.env.CINEMETA !== '0';
const CINEMETA_BASE_URL = (process.env.CINEMETA_URL || CINEMETA_URL).replace(/\/+$/, '');
// Tras N errores seguidos de un addon para un tipo (movie/series) se deja de consultar.
const BREAKER_THRESHOLD = Math.max(1, Number.parseInt(process.env.BREAKER_THRESHOLD || '', 10) || 3);
const REQUESTED_PROVIDER_SLUGS = requestedProviderSlugs();
const ENABLED_PROVIDERS = resolveEnabledProviders().map(provider =>
  provider.slug === 'peerflix' ? { ...provider, baseUrl: PEERFLIX_BASE_URL } : provider
);
const MANIFEST_ONLY_PROVIDERS = resolveManifestOnlyProviders();

const USER_AGENTS = [
  'peerflix-static-bot/2.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const fetchJSON = createJsonFetcher({
  timeoutMs: FETCH_TIMEOUT_MS,
  retries: 2,
  headers: attempt => ({
    'user-agent': USER_AGENTS[attempt % USER_AGENTS.length],
    accept: 'application/json,text/plain,*/*',
    'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  }),
});

// ---------- TMDB (opcional: respaldo si Cinemeta no tiene la temporada) ----------

async function tmdbEpisodes(item) {
  if (!TMDB_API_KEY) return null;
  try {
    const find = await fetchJSON(`https://api.themoviedb.org/3/find/${item.imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=es-ES`, { timeout: 10000, retries: 1 });
    const tv = find.tv_results?.[0];
    if (!tv?.id) return null;
    const season = await fetchJSON(`https://api.themoviedb.org/3/tv/${tv.id}/season/${item.season}?api_key=${TMDB_API_KEY}&language=es-ES`, { timeout: 10000, retries: 1 });
    return (season.episodes || []).map(e => ({ episode: e.episode_number, title: e.name || null, released: e.air_date || null }));
  } catch (err) {
    console.warn(`⚠️  TMDB falló para ${item.imdbId}:s${item.season}: ${err.message}`);
    return null;
  }
}

// ---------- FIXTURE_MODE: respuestas falsas, sin red ----------

function fakeHash(seed) {
  // fnv-1a + mix → 40 hex; fixture only.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = (h + ((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))) >>> 0; }
  let out = '';
  for (let i = 0; i < 10; i++) { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h = h >>> 0; out += (h>>>0).toString(16).padStart(8,'0'); }
  return out.slice(0, 40);
}

function createFixtureFetch(seriesIds, labelsById) {
  const providerBySlug = new Map(ENABLED_PROVIDERS.map(p => [p.slug, p]));
  return async function fixtureFetchJSON(url) {
    const meta = url.match(/\/meta\/(movie|series)\/(tt\d+)\.json$/);
    if (meta) {
      const [, type, id] = meta;
      if (type !== 'series' || !seriesIds.has(id)) return { meta: {} };
      const videos = [1, 2].flatMap(season => [1, 2, 3].map(episode => ({
        season, episode, name: `Episodio ficticio ${episode}`, released: '2011-04-17T00:00:00.000Z',
      })));
      return { meta: { id, imdb_id: id, type: 'series', name: 'Serie ficticia', year: '2011–2019', videos } };
    }
    const stream = url.match(/\/stream\/(movie|series)\/(tt\d+)(?::(\d+):(\d+))?\.json$/);
    const provider = [...providerBySlug.values()].find(p => url.startsWith(p.baseUrl));
    if (!stream || !provider) return { streams: [] };
    const [, , imdbId, season, episode] = stream;
    const id = season ? `${imdbId}:${season}:${episode}` : imdbId;
    const label = labelsById.get(id) || id;
    const base = [
      ['4K', 40, '11.2 GB', 'es', provider.name],
      ['1080p', 80, '2.6 GB', 'es', 'YTS'],
      ['1080p', 30, '1.8 GB', 'en', provider.name],
      ['720p', 10, '905 MB', 'es', null],
    ];
    return {
      streams: base.map(([q, seeds, size, lang, ext], i) => ({
        name: `${provider.name}\n${q}`,
        title: `${label} [${q}][${lang === 'es' ? 'Castellano' : 'Ingles'}+Subs]\n👤 ${seeds} 💾 ${size}${ext ? ` ⚙️ ${ext}` : ''}`,
        infoHash: fakeHash(`${id}|${provider.slug}|${q}|${i}`),
        fileIdx: 0,
        sources: ['tracker:udp://tracker.opentrackr.org:1337/announce'],
      })),
    };
  };
}

// ---------- REPROCESS=1: re-selección sobre los datos ya publicados ----------

const PUBLISHED_PROVIDER = Object.freeze({ slug: 'published', name: 'Datos publicados', baseUrl: 'public/data' });

async function loadPublishedSnapshot() {
  const indexPath = join(DATA_DIR, 'index.json');
  if (!existsSync(indexPath)) throw new Error('REPROCESS=1 necesita public/data/index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const queries = [];
  const streamsById = new Map();
  for (const item of index.items || []) {
    const isSeries = item.type === 'series';
    const file = isSeries
      ? join(DATA_SERIES, `${item.imdbId}-s${item.season}e${item.episode}.json`)
      : join(DATA_MOVIES, `${item.imdbId}.json`);
    const data = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { streams: [] };
    streamsById.set(item.id, (data.streams || []).map(candidateFromPublished).filter(Boolean));
    queries.push({
      kind: isSeries ? 'series' : 'movie',
      imdbId: item.imdbId,
      season: isSeries ? item.season : undefined,
      episode: isSeries ? item.episode : undefined,
      label: item.label || null,
      meta: item.name ? { name: item.name, year: item.year ?? null, yearEnd: null, type: item.type } : null,
      warnings: item.warnings || [],
    });
  }
  return { generatedAt: index.generatedAt || null, queries: dedupeQueries(queries), streamsById };
}

// ---------- ficheros ----------

async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function cleanDir(dir) {
  await mkdir(dir, { recursive: true });
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile()) await unlink(join(dir, e.name));
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// owner/repo y rama: la web los usa para funcionar sin configurar nada.
function repositoryInfo() {
  let slug = process.env.GITHUB_REPOSITORY || null;
  if (!slug) {
    const m = (git(['config', '--get', 'remote.origin.url']) || '').match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
    if (m) slug = `${m[1]}/${m[2]}`;
  }
  if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) return null;
  const [owner, name] = slug.split('/');
  const branch = process.env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  return {
    slug,
    owner,
    name,
    branch,
    url: `https://github.com/${slug}`,
    pagesUrl: process.env.PAGES_URL || `https://${owner.toLowerCase()}.github.io/${name}/`,
  };
}

function formatPickForLog(stream) {
  if (!stream) return '—'.padEnd(16);
  return `${PICK_META[stream.pick].flag} ${(stream.quality || '?').padEnd(5)} 👤${String(stream.seeders ?? '?').padEnd(5)}`;
}

function catalogName(item) {
  return item.type === 'series'
    ? showLabel(item.label, { name: item.name }) || item.name || item.imdbId
    : String(item.label || item.name || item.imdbId).replace(/\s*\(\s*\d{4}\s*\)\s*$/, '').trim();
}

function buildCatalogs(results) {
  const movies = new Map();
  const series = new Map();
  for (const { item } of results) {
    if (!item.streamCount) continue;
    const target = item.type === 'series' ? series : movies;
    if (target.has(item.imdbId)) continue;
    target.set(item.imdbId, {
      id: item.imdbId,
      type: item.type,
      name: catalogName(item),
      poster: `https://images.metahub.space/poster/medium/${item.imdbId}/img`,
      ...(item.year ? { releaseInfo: String(item.year) } : {}),
    });
  }
  return { movies: [...movies.values()], series: [...series.values()] };
}

// ---------- main ----------

async function main() {
  const mode = FIXTURE_MODE ? 'fixture' : REPROCESS ? 'reprocess' : 'live';
  const repository = repositoryInfo();
  const repo = createRepository({ supabaseUrl: SUPABASE_URL, supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY, dryRun: DRY_RUN_DB || mode !== 'live' });
  console.log(`📂 peerflix-static – multi-provider fetch & ingest${mode !== 'live' ? `  [${mode.toUpperCase()}]` : ''}`);
  console.log(`   watchlist   : ${REPROCESS ? join(DATA_DIR, 'index.json') + ' (datos publicados)' : WATCHLIST_PATH}`);
  console.log(`   concurrency : ${FETCH_CONCURRENCY} · corte tras ${BREAKER_THRESHOLD} errores seguidos por addon`);
  console.log(`   providers   : ${REPROCESS ? 'ninguno (sin red)' : ENABLED_PROVIDERS.map(p => `${p.name}(${p.slug})`).join(', ') || 'ninguno'}`);
  if (MANIFEST_ONLY_PROVIDERS.length) {
    console.log(`   manifest    : ${MANIFEST_ONLY_PROVIDERS.map(p => `${p.name} (${p.manifestUrl})`).join(', ')} [solo catálogo, no compatible con IMDb]`);
  }
  console.log(`   metadatos   : ${REPROCESS ? 'los ya publicados' : CINEMETA_ENABLED ? `Cinemeta (sin API key)${TMDB_API_KEY ? ' + TMDB de respaldo' : ''}` : TMDB_API_KEY ? 'solo TMDB' : 'desactivados'}`);
  console.log(`   Supabase    : ${repo.enabled ? 'configurada ✅' : repo.skipReason === 'missing-credentials' ? `sin credenciales (faltan ${repo.missingCredentials.join(' y ')}; solo JSON)` : 'DRY RUN (solo JSON; no escribe en la BD)'}`);
  console.log(`   selección   : 2 por título → 🇪🇸 mejor en español + 🇬🇧 mejor en inglés`);
  const bestTrackers = FIXTURE_MODE || REPROCESS
    ? await loadBestTrackers({ url: '' })
    : await loadBestTrackers({ url: TRACKERS_URL, timeoutMs: Math.min(FETCH_TIMEOUT_MS, 10000), headers: { 'user-agent': USER_AGENTS[0] } });
  if (bestTrackers.warning) console.warn(`⚠️  ${bestTrackers.warning}`);
  console.log(`   trackers    : los ${Math.min(MAX_TRACKERS, bestTrackers.trackers.length)} mejores de ${bestTrackers.source}`);
  console.log();

  const warnings = [];
  const warn = message => { warnings.push(message); console.warn(`⚠️  ${message}`); };
  if (bestTrackers.warning) warnings.push(bestTrackers.warning);
  if (repo.skipReason === 'missing-credentials') {
    warn(`No se guardará en Supabase: faltan ${repo.missingCredentials.join(' y ')} en los Secrets de GitHub Actions. Solo se publicarán los JSON.`);
  }

  // 1. Consultas: del watchlist (con Cinemeta) o de los datos ya publicados.
  let queries;
  let providers = ENABLED_PROVIDERS;
  let streamSource = null;
  let pipelineFetch = fetchJSON;
  let metaStats = { source: 'none', requested: 0, found: 0, failures: 0, disabled: true, lastError: null };
  let reprocessedFrom = null;
  if (REPROCESS) {
    const snapshot = await loadPublishedSnapshot();
    queries = snapshot.queries;
    reprocessedFrom = snapshot.generatedAt;
    providers = [PUBLISHED_PROVIDER];
    streamSource = async (_provider, query) => ({
      url: query.kind === 'movie' ? `data/movies/${query.imdbId}.json` : `data/series/${query.imdbId}-s${query.season}e${query.episode}.json`,
      streams: snapshot.streamsById.get(query.kind === 'movie' ? query.imdbId : `${query.imdbId}:${query.season}:${query.episode}`) || [],
    });
    console.log(`♻️  Reprocesando ${queries.length} títulos publicados el ${reprocessedFrom || '?'} (sin red).`);
  } else {
    const watchText = await readFile(WATCHLIST_PATH, 'utf8');
    const items = parseWatchlist(watchText, { onWarning: warn });
    console.log(`🔎 Watchlist: ${items.length} líneas.`);
    const labelsById = new Map();
    if (FIXTURE_MODE) pipelineFetch = createFixtureFetch(new Set(items.filter(i => i.type === 'series').map(i => i.imdbId)), labelsById);
    let metaById = new Map();
    if (CINEMETA_ENABLED) {
      const meta = await loadMetadata(items, { fetchJSON: pipelineFetch, baseUrl: CINEMETA_BASE_URL, concurrency: FETCH_CONCURRENCY, onWarning: warn });
      metaById = meta.metaById;
      metaStats = meta.stats;
      console.log(`🎞️  Cinemeta: ${metaStats.found}/${metaStats.requested} fichas${metaStats.failures ? ` (${metaStats.failures} errores)` : ''}.`);
    }
    queries = await expandWatchlist(items, { metaById, seasonFallback: TMDB_API_KEY && !FIXTURE_MODE ? tmdbEpisodes : null, onWarning: warn });
    for (const q of queries) labelsById.set(q.kind === 'movie' ? q.imdbId : `${q.imdbId}:${q.season}:${q.episode}`, q.label || q.imdbId);
  }
  console.log(`📋 Consultas: ${queries.length} títulos/episodios × ${providers.length} fuentes = ${queries.length * providers.length} requests.`);
  if (!queries.length) { console.error('❌ No hay nada que consultar.'); process.exitCode = 1; return; }
  console.log();

  // 2. Salidas limpias (tras leer los datos publicados si se reprocesa).
  for (const dir of [DATA_MOVIES, DATA_SERIES, STREAM_MOVIES, STREAM_SERIES, CATALOG_MOVIES, CATALOG_SERIES]) await cleanDir(dir);

  const startedAt = new Date().toISOString();

  // 3. Consultar, fusionar y elegir 2 por título (se loguea cada título al terminar).
  const pipeline = await runPipeline(queries, {
    providers,
    fetchJSON: pipelineFetch,
    streamSource,
    concurrency: FETCH_CONCURRENCY,
    breakerThreshold: BREAKER_THRESHOLD,
    bestTrackers: bestTrackers.trackers,
    maxTrackers: MAX_TRACKERS,
    onItem: ({ item, streams }, { done, total }) => {
      const icon = streams.length === PICK_LANGUAGES.length ? '✅' : streams.length ? '🟡' : '⚠️ ';
      const es = streams.find(s => s.pick === 'es');
      const en = streams.find(s => s.pick === 'en');
      const progress = `[${String(done).padStart(String(total).length)}/${total}]`;
      console.log(`  ${icon} ${progress} ${item.id.padEnd(22)} ${String(streams.length)}/${String(item.candidateCount).padEnd(4)} ${formatPickForLog(es)} ${formatPickForLog(en)} ${item.label}`);
    },
  });

  const index = {
    generatedAt: startedAt,
    finishedAt: null,
    mode,
    ...(reprocessedFrom ? { reprocessedFrom } : {}),
    repository,
    providers: allProviderManifestMetadata(),
    enabledProviders: providers.map(p => p.slug),
    requestedProviders: REQUESTED_PROVIDER_SLUGS,
    manifestOnlyProviders: MANIFEST_ONLY_PROVIDERS.map(p => ({ slug: p.slug, name: p.name, manifestUrl: p.manifestUrl, note: p.note })),
    fixture: FIXTURE_MODE,
    dryRunDb: repo.dryRun,
    total: queries.length,
    movies: 0,
    episodes: 0,
    // Published streams (at most 2 per title) vs. everything the addons returned.
    totalStreams: pipeline.totals.streams,
    totalCandidates: pipeline.totals.candidates,
    picks: pipeline.totals.picks,
    missing: pipeline.totals.missing,
    selection: {
      perTitle: PICK_LANGUAGES.length,
      languages: [...PICK_LANGUAGES],
      maxTrackers: MAX_TRACKERS,
      trackersSource: bestTrackers.source,
      trackers: bestTrackers.trackers.slice(0, MAX_TRACKERS),
    },
    meta: metaStats,
    items: [],
    warnings,
    errors: pipeline.errors,
    perProviderStats: pipeline.perProvider,
    db: {
      inserted: 0, prepared: 0, rejected: 0, failures: [], dryRun: repo.dryRun,
      ...(repo.skipReason ? { skipReason: repo.skipReason } : {}),
      ...(repo.skipReason === 'missing-credentials' ? { missingCredentials: repo.missingCredentials } : {}),
    },
  };

  // 4. Ficheros por título: data/ (web) + stream/ (addon Stremio).
  const dbCandidates = [];
  for (const { item, streams, candidates = [] } of pipeline.results) {
    index.items.push(item);
    if (item.type === 'movie') {
      index.movies++;
      await writeJSON(join(DATA_MOVIES, `${item.imdbId}.json`), { ...item, streams });
      await writeJSON(join(STREAM_MOVIES, `${item.imdbId}.json`), { streams });
    } else {
      index.episodes++;
      await writeJSON(join(DATA_SERIES, `${item.imdbId}-s${item.season}e${item.episode}.json`), { ...item, streams });
      await writeJSON(join(STREAM_SERIES, `${item.imdbId}:${item.season}:${item.episode}.json`), { streams });
    }
    // Publicamos solo los picks, pero persistimos TODOS los candidatos válidos para
    // poder re-ranquear en el futuro sin volver a consultar los proveedores.
    for (const stream of candidates) dbCandidates.push({ item, stream });
  }

  // 5. Supabase (opcional).
  if (dbCandidates.length) {
    try {
      const dbRes = await repo.upsert(dbCandidates);
      Object.assign(index.db, dbRes);
      console.log(`\n🗄  BD: ${describeDatabaseWrite(index).message} (${dbRes.rejected} inválidos)`);
    } catch (err) {
      if (err.result) Object.assign(index.db, err.result);
      index.db.failures.push(err.message || String(err));
      console.log(`\n🗄  BD: ERROR – ${err.message}`);
    }
  }

  const finishedAt = new Date().toISOString();
  index.finishedAt = finishedAt;
  index.durationMs = new Date(finishedAt) - new Date(startedAt);

  await writeJSON(join(DATA_DIR, 'index.json'), index);
  await writeJSON(join(DATA_DIR, 'report.json'), index);

  // 6. Addon Stremio: streams + catálogo "Mi watchlist" con pósters.
  const catalogs = buildCatalogs(pipeline.results);
  await writeJSON(join(CATALOG_MOVIES, `${CATALOG_ID}.json`), { metas: catalogs.movies });
  await writeJSON(join(CATALOG_SERIES, `${CATALOG_ID}.json`), { metas: catalogs.series });
  const manifest = {
    id: 'com.example.peerflix-static',
    version: '1.3.0',
    name: 'Peerflix Static (personal, aggregated)',
    description: `Agregador personal con ${ENABLED_PROVIDERS.map(p=>p.name).join(', ')}. Solo 2 torrents por título: el mejor en español y el mejor en inglés. Responde solo a los IMDb IDs de tu watchlist.`,
    catalogs: [
      { type: 'movie', id: CATALOG_ID, name: 'Mi watchlist · ES + EN' },
      { type: 'series', id: CATALOG_ID, name: 'Mi watchlist · ES + EN' },
    ],
    resources: ['catalog', { name: 'stream', types: ['movie','series'], idPrefixes: ['tt'] }],
    types: ['movie','series'],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: false, configurationRequired: false },
    // Informational metadata for the dashboard; Stremio ignores unknown keys.
    sourceManifests: allProviderManifestMetadata(),
  };
  await writeJSON(join(PUBLIC, 'manifest.json'), manifest);

  console.log(`\n📊 Resumen:`);
  console.log(`   películas : ${index.movies}`);
  console.log(`   episodios : ${index.episodes}`);
  console.log(`   streams   : ${index.totalStreams} elegidos (🇪🇸 ${index.picks.es} · 🇬🇧 ${index.picks.en}) de ${index.totalCandidates} candidatos fusionados de ${providers.length} fuentes`);
  for (const p of providers) {
    const s = index.perProviderStats[p.slug];
    console.log(`     · ${p.name.padEnd(16)} ${String(s.streams).padStart(5)} streams · ${s.ok} ok · ${s.errors} errores · ${s.skipped} omitidas${s.avgMs != null ? ` · ${s.avgMs} ms de media` : ''}`);
  }
  if (index.missing.es || index.missing.en) console.log(`   sin pick  : ${index.missing.es} sin español · ${index.missing.en} sin inglés`);
  console.log(`   trackers  : ${index.selection.trackers.length} por magnet (${index.selection.trackersSource})`);
  console.log(`   catálogo  : ${catalogs.movies.length} películas · ${catalogs.series.length} series (addon Stremio)`);
  console.log(`   avisos    : ${warnings.length}`);
  console.log(`   errores   : ${index.errors.length} (${index.errors.filter(e => e.skipped).length} omitidas por el corte de errores)`);
  console.log(`   duración  : ${(index.durationMs/1000).toFixed(1)}s`);
  console.log(`   salida    : ${PUBLIC}`);

  // Fail only when the addons returned nothing at all (not when no ES/EN pick exists).
  if (index.totalCandidates === 0 && index.errors.length > 0) process.exitCode = 2;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isCli) main().catch(err => { console.error('💥 Fatal:', err); process.exit(1); });

export {
  buildMagnet,
  candidateFromPublished,
  dedupeQueries,
  mergeStreams,
  normalizeLanguage,
  normalizeQuality,
  parseSize,
  parseStremioStream,
  parseWatchlist,
  toOutputStream,
};
