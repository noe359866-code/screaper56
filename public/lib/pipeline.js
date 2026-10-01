/**
 * Orquestación de la ingesta: watchlist → metadatos (Cinemeta) → consultas a
 * los addons → fusión por infoHash → 2 picks por título (🇪🇸 + 🇬🇧) → streams
 * publicables con los mejores trackers.
 *
 * Lo usan tanto la GitHub Action (src/fetch.mjs) como la web, que ahora puede
 * procesar una lista directamente en el navegador, sin token. Todo lo que
 * depende del entorno (fetch, cabeceras, disco, BD) se inyecta.
 */

import {
  buildMagnet,
  dedupeQueries,
  formatBytes,
  mergeStreams,
  normalizeLanguage,
  normalizeQuality,
  parseReleaseInfo,
  parseStremioStream,
  parseWatchlist,
  releaseTags,
  stremioId,
} from './parse.js';
import {
  BEST_TRACKERS,
  BEST_TRACKERS_URL,
  DEFAULT_MAX_TRACKERS,
  PICK_LANGUAGES,
  parseTrackerList,
  pickBestTrackers,
  selectBestStreams,
} from './select.js';
import {
  CINEMETA_URL,
  episodesForSeason,
  fetchCinemeta,
  labelMismatch,
  metaLabel,
  showLabel,
} from './meta.js';

// ---------- HTTP ----------

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

function abortError() {
  const err = new Error('cancelado');
  err.name = 'AbortError';
  return err;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(10000, Math.max(0, ms)) : null;
}

function isRetryable(err) {
  if (err?.name === 'HttpError') return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
  if (err?.name === 'SyntaxError' || err?.name === 'AbortError') return false;
  return true; // red caída, timeout…
}

/** Mensaje corto y legible para el reporte. */
export function describeError(err) {
  if (!err) return 'error desconocido';
  if (err.name === 'HttpError' || err.name === 'TimeoutError' || err.name === 'AbortError') return err.message;
  if (err.name === 'SyntaxError') return 'la respuesta no es JSON';
  if (err.name === 'TypeError') {
    // Node: "fetch failed" + causa (ENOTFOUND…); navegador: "Failed to fetch" (red o CORS).
    const code = err.cause?.code || err.cause?.name;
    return code ? `red (${code})` : `red/CORS (${err.message})`;
  }
  return err.message || String(err);
}

/**
 * fetch → JSON con timeout, reintentos con backoff (red, 429, 5xx; respeta
 * Retry-After) y sin reintentar errores que no se arreglan solos (403, 400…).
 * En el navegador no hay que pasar cabeceras: cualquier cabecera extra
 * provoca un preflight CORS que algunos addons no contestan.
 */
export function createJsonFetcher({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15000,
  retries = 2,
  headers = null,
  signal = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  return async function fetchJSON(url, options = {}) {
    const timeout = options.timeout ?? timeoutMs;
    const maxRetries = options.retries ?? retries;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw abortError();
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const init = { signal: ctrl.signal };
        const extra = typeof headers === 'function' ? headers(attempt) : headers;
        if (extra) init.headers = extra;
        const res = await fetchImpl(url, init);
        if (!res.ok) {
          const err = new HttpError(res.status, url);
          err.retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
          throw err;
        }
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new SyntaxError('la respuesta no es JSON');
        }
      } catch (err) {
        if (signal?.aborted) throw abortError();
        lastErr = timedOut
          ? Object.assign(new Error(`timeout (${Math.round(timeout / 1000)}s)`), { name: 'TimeoutError' })
          : err;
        if (!isRetryable(lastErr) || attempt >= maxRetries) break;
        await sleep(lastErr.retryAfterMs ?? 700 * 2 ** attempt + Math.random() * 300);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    }
    throw lastErr;
  };
}

/** Limita cuántas promesas corren a la vez (cola FIFO). */
export function createLimiter(concurrency = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= Math.max(1, concurrency) || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ---------- trackers ----------

/**
 * La lista del día de ngosang/trackerslist. Cualquier fallo usa la copia
 * integrada, así que la ingesta nunca depende de ella.
 */
export async function loadBestTrackers({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = BEST_TRACKERS_URL,
  timeoutMs = 10000,
  headers = null,
} = {}) {
  const builtIn = { trackers: [...BEST_TRACKERS], source: 'lista integrada (ngosang/trackerslist)' };
  if (!url) return builtIn;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, ...(headers ? { headers } : {}) });
    if (!res.ok) throw new HttpError(res.status, url);
    const trackers = parseTrackerList(await res.text());
    if (trackers.length < 5) throw new Error(`solo ${trackers.length} trackers válidos`);
    return { trackers, source: url };
  } catch (err) {
    return { ...builtIn, warning: `No se pudo descargar la lista de trackers (${describeError(err)}); uso la integrada.` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- streams publicables ----------

export const PICK_META = Object.freeze({
  es: { flag: '🇪🇸', label: 'Español' },
  en: { flag: '🇬🇧', label: 'Inglés' },
});

/** Un stream publicado (JSON de datos + addon Stremio + candidato para la BD). */
export function toOutputStream(stream, bestTrackers = BEST_TRACKERS, maxTrackers = DEFAULT_MAX_TRACKERS) {
  const meta = PICK_META[stream.pick];
  const trackers = pickBestTrackers(stream.trackers, bestTrackers, maxTrackers);
  // The English pick may come without a flag (Torrentio does not flag English);
  // it was chosen as the English version, so record that audio explicitly.
  const audioLangs = [stream.pick, ...(stream.languages || []).filter(lang => lang !== stream.pick)];
  const sizeLabel = formatBytes(stream.sizeBytes);
  const release = parseReleaseInfo(stream.title, stream.filename);
  const tags = releaseTags(release);
  const providers = stream.providers || (stream.provider ? [stream.provider] : []);
  const providerNames = stream.providerNames || providers;
  return {
    name: `${meta.flag} ${meta.label}${stream.quality ? ' ' + stream.quality : ''}`,
    title: stream.title,
    description: [
      stream.title,
      tags && `🎞️ ${tags}`,
      [`👤 ${stream.seeders ?? '?'}`, sizeLabel && `💾 ${sizeLabel}`, `⚙️ ${providerNames.join('+')}`].filter(Boolean).join(' '),
    ].filter(Boolean).join('\n'),
    pick: stream.pick,
    score: stream.score,
    infoHash: stream.infoHash,
    fileIdx: stream.fileIdx ?? null,
    language: stream.pick,
    audioLangs,
    quality: stream.quality ?? null,
    seeders: stream.seeders ?? null,
    sizeBytes: stream.sizeBytes ?? null,
    sizeLabel,
    release,
    providers,
    providerNames,
    externalProviders: stream.externalProviders || [],
    filename: stream.filename ?? null,
    trackers,
    // Stremio reads the tracker list from `sources`.
    sources: [...trackers.map(tracker => `tracker:${tracker}`), `dht:${stream.infoHash}`],
    magnetUrl: buildMagnet(stream.infoHash, stream.title, trackers),
    // Stremio: el siguiente episodio elige el mismo hueco (🇪🇸 o 🇬🇧); el nombre
    // del archivo ayuda a los addons de subtítulos.
    behaviorHints: { bingeGroup: `peerflix-static-${stream.pick}`, ...(stream.filename ? { filename: stream.filename } : {}) },
  };
}

/** Lo que necesita el dashboard para pintar un pick (incluye el magnet). */
export function pickSummary(stream) {
  return {
    pick: stream.pick,
    name: stream.name,
    title: stream.title,
    quality: stream.quality,
    seeders: stream.seeders,
    sizeBytes: stream.sizeBytes,
    sizeLabel: stream.sizeLabel,
    audioLangs: stream.audioLangs,
    release: stream.release,
    providers: stream.providers,
    providerNames: stream.providerNames,
    infoHash: stream.infoHash,
    fileIdx: stream.fileIdx,
    score: stream.score,
    magnetUrl: stream.magnetUrl,
  };
}

/**
 * Stream ya publicado (public/data/…) → candidato para volver a elegir. Sirve
 * para REPROCESS=1 y para que la web entienda los datos del formato antiguo
 * (todos los streams, sin picks) calculando los 2 picks en el navegador.
 */
export function candidateFromPublished(stream) {
  const title = String(stream?.title || '').trim();
  const infoHash = String(stream?.infoHash || '').toLowerCase();
  if (!title || !/^[a-f0-9]{40}$/.test(infoHash)) return null;
  const filename = stream.filename ?? stream.behaviorHints?.filename ?? null;
  const providers = Array.isArray(stream.providers) && stream.providers.length ? stream.providers : ['published'];
  // audioLangs de un pick nuevo lleva el idioma del pick delante: no aporta info.
  const known = stream.pick ? (stream.audioLangs || []).slice(1) : (stream.audioLangs || []);
  return {
    infoHash,
    title,
    // Re-derived: an explicit resolution in the release name beats the stored value.
    quality: normalizeQuality('', title, stream.quality ?? null, filename),
    seeders: Number.isSafeInteger(stream.seeders) ? stream.seeders : null,
    sizeBytes: Number.isSafeInteger(stream.sizeBytes) ? stream.sizeBytes : null,
    trackers: Array.isArray(stream.trackers) ? stream.trackers : [],
    magnetUrl: null,
    languages: [...new Set([...known, ...normalizeLanguage(null, [title, filename].filter(Boolean).join('\n'))])],
    filename,
    fileIdx: stream.fileIdx ?? null,
    provider: providers[0],
    providerName: stream.providerNames?.[0] ?? providers[0],
    providers,
    providerNames: Array.isArray(stream.providerNames) && stream.providerNames.length ? stream.providerNames : providers,
    externalProviders: Array.isArray(stream.externalProviders) ? stream.externalProviders : [],
    externalProvider: null,
  };
}

/**
 * Fichero de un título en el formato antiguo (todos los streams) → los 2
 * picks del formato actual, con la misma selección que la Action.
 */
export function picksFromPublishedItem(item, data, { bestTrackers = BEST_TRACKERS, maxTrackers = DEFAULT_MAX_TRACKERS } = {}) {
  const candidates = (data?.streams || []).map(candidateFromPublished).filter(Boolean);
  const query = {
    kind: item.type === 'series' ? 'series' : 'movie',
    imdbId: item.imdbId,
    season: item.season,
    episode: item.episode,
    label: item.label,
    meta: item.name ? { name: item.name, year: item.year ?? null } : null,
    warnings: item.warnings || [],
  };
  const provider = { slug: 'published', name: 'Datos publicados' };
  return buildItem(query, [{ provider, url: null, streams: candidates }], [], { bestTrackers, maxTrackers }).item;
}

// ---------- metadatos + expansión del watchlist ----------

function slimMeta(meta) {
  return meta ? { name: meta.name, year: meta.year, yearEnd: meta.yearEnd, type: meta.type } : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function episodeLabel(show, season, episode, title) {
  return `${show} S${pad2(season)}E${pad2(episode)}${title ? ' – ' + title : ''}`;
}

/**
 * Metadatos de Cinemeta para cada IMDb ID distinto del watchlist (sin API key).
 * Si Cinemeta falla 3 veces seguidas se deja de consultar y se sigue sin él.
 */
export async function loadMetadata(items, { fetchJSON, baseUrl = CINEMETA_URL, concurrency = 4, onWarning = null } = {}) {
  const typeById = new Map();
  for (const item of items) {
    if (item.type === 'series') typeById.set(item.imdbId, 'series');
    else if (!typeById.has(item.imdbId)) typeById.set(item.imdbId, 'movie');
  }
  const metaById = new Map();
  const stats = { source: 'cinemeta', requested: typeById.size, found: 0, failures: 0, disabled: false, lastError: null };
  let consecutive = 0;
  const limit = createLimiter(concurrency);
  await Promise.all([...typeById].map(([imdbId, type]) => limit(async () => {
    if (stats.disabled) return;
    try {
      const meta = await fetchCinemeta(fetchJSON, imdbId, type, { baseUrl });
      consecutive = 0;
      if (meta) metaById.set(imdbId, meta);
    } catch (err) {
      stats.failures++;
      stats.lastError = describeError(err);
      if (++consecutive >= 3) stats.disabled = true;
    }
  })));
  stats.found = metaById.size;
  if (stats.failures) {
    onWarning?.(`Cinemeta: ${stats.failures} consulta(s) fallaron (${stats.lastError})${stats.disabled ? '; se dejó de consultar' : ''}. Esos títulos siguen sin metadatos.`);
  }
  return { metaById, stats };
}

/**
 * Líneas del watchlist → consultas (película o episodio). Las temporadas
 * `tt…:sN` se expanden con Cinemeta (sin API key) y, si falla, con
 * `seasonFallback` (TMDB en la Action cuando hay TMDB_API_KEY).
 */
export async function expandWatchlist(items, { metaById = new Map(), seasonFallback = null, now = Date.now(), onWarning = null } = {}) {
  const warn = message => onWarning?.(message);
  const queries = [];
  for (const it of items) {
    const meta = metaById.get(it.imdbId) || null;
    if (it.type === 'movie') {
      if (meta?.type === 'series') {
        warn(`${it.imdbId} es una serie (“${meta.name}”): escribe ${it.imdbId}:s1 para la temporada 1 o ${it.imdbId}:s1:e1 para un episodio. Se omite.`);
        continue;
      }
      const mismatch = labelMismatch(it.label, meta);
      if (mismatch) warn(`${it.imdbId}: ${mismatch}.`);
      queries.push({
        kind: 'movie', imdbId: it.imdbId,
        label: it.label || metaLabel(meta) || null,
        meta: slimMeta(meta),
        warnings: mismatch ? [mismatch] : [],
      });
      continue;
    }
    if (meta?.type === 'movie') {
      warn(`${it.imdbId} es una película (“${metaLabel(meta)}”), no una serie: quita “:s${it.season}${it.episode !== null ? ':e' + it.episode : ''}”. Se omite.`);
      continue;
    }
    const show = showLabel(it.label, meta) || it.imdbId;
    if (it.episode !== null) {
      const known = meta?.videos?.find(v => v.season === it.season && v.episode === it.episode);
      queries.push({
        kind: 'series', imdbId: it.imdbId, season: it.season, episode: it.episode,
        label: it.label || episodeLabel(show, it.season, it.episode, known?.title),
        meta: slimMeta(meta),
        warnings: [],
      });
      continue;
    }
    let episodes = episodesForSeason(meta, it.season, { now });
    if (!episodes?.length && seasonFallback) {
      const fallback = await seasonFallback(it);
      if (fallback?.length) episodes = fallback;
    }
    if (!episodes?.length) {
      warn(`No se pudo expandir ${it.imdbId}:s${it.season}: ${meta ? `Cinemeta no tiene episodios emitidos de la temporada ${it.season}` : 'sin metadatos (Cinemeta no respondió)'}. Se omite.`);
      continue;
    }
    for (const ep of episodes) {
      queries.push({
        kind: 'series', imdbId: it.imdbId, season: it.season, episode: ep.episode,
        label: episodeLabel(show, it.season, ep.episode, ep.title),
        meta: slimMeta(meta),
        warnings: [],
      });
    }
  }
  return dedupeQueries(queries);
}

// ---------- consultas a los addons ----------

export function streamUrl(provider, query) {
  return query.kind === 'movie'
    ? `${provider.baseUrl}/stream/movie/${query.imdbId}.json`
    : `${provider.baseUrl}/stream/series/${query.imdbId}:${query.season}:${query.episode}.json`;
}

export async function fetchProviderStreams(fetchJSON, provider, query) {
  const url = streamUrl(provider, query);
  let data;
  try {
    data = await fetchJSON(url);
  } catch (err) {
    if (err?.status === 404) return { url, streams: [] }; // el addon no tiene ese título
    throw err;
  }
  const streams = [];
  for (const raw of Array.isArray(data?.streams) ? data.streams : []) {
    const stream = parseStremioStream(raw, provider);
    if (stream) streams.push(stream);
  }
  return { url, streams };
}

/** Fusiona, elige los 2 picks y arma el resumen publicable de una consulta. */
export function buildItem(query, providerResults, errors = [], { bestTrackers = BEST_TRACKERS, maxTrackers = DEFAULT_MAX_TRACKERS } = {}) {
  const type = query.kind === 'movie' ? 'movie' : 'series';
  const merged = mergeStreams(providerResults);
  const picks = selectBestStreams(merged, {
    type,
    label: query.label || '',
    titles: query.meta?.name ? [query.meta.name] : [],
    year: type === 'movie' ? query.meta?.year ?? null : null,
    season: type === 'series' ? query.season : null,
    episode: type === 'series' ? query.episode : null,
  });
  const streams = picks.map(stream => toOutputStream(stream, bestTrackers, maxTrackers));
  const seeders = streams.map(s => s.seeders).filter(n => n != null);
  const item = {
    id: stremioId(query),
    imdbId: query.imdbId,
    type,
    season: type === 'series' ? query.season : null,
    episode: type === 'series' ? query.episode : null,
    label: query.label || query.imdbId,
    name: query.meta?.name ?? null,
    year: query.meta?.year ?? null,
    providerUrls: Object.fromEntries(providerResults.map(r => [r.provider.slug, r.url])),
    // Publicados (máx. 2) frente a todo lo que devolvieron los addons.
    streamCount: streams.length,
    candidateCount: merged.length,
    picks: streams.map(pickSummary),
    missing: PICK_LANGUAGES.filter(lang => !streams.some(s => s.pick === lang)),
    bestSeeders: seeders.length ? Math.max(...seeders) : null,
    qualities: [...new Set(streams.map(s => s.quality).filter(Boolean))].sort(),
    languages: [...new Set(streams.flatMap(s => s.audioLangs))].sort(),
    providers: [...new Set(streams.flatMap(s => s.providers))].sort(),
    warnings: query.warnings || [],
    errors: errors.map(({ provider, error }) => ({ provider, error })),
  };
  return { item, streams, candidates: merged, errors };
}

/**
 * Consulta cada (título × addon) con concurrencia limitada. Si un addon falla
 * `breakerThreshold` veces seguidas para un tipo (p. ej. Ytztvio da 403 en
 * series), se deja de consultar para ese tipo y se ahorra el resto de esperas.
 * `onItem` se llama en cuanto termina cada título (progreso en vivo).
 */
export async function runPipeline(queries, {
  providers,
  fetchJSON = null,
  streamSource = null,
  concurrency = 4,
  breakerThreshold = 3,
  bestTrackers = BEST_TRACKERS,
  maxTrackers = DEFAULT_MAX_TRACKERS,
  signal = null,
  onItem = null,
  now = () => Date.now(),
} = {}) {
  const source = streamSource || ((provider, query) => fetchProviderStreams(fetchJSON, provider, query));
  const perProvider = Object.fromEntries(providers.map(p => [p.slug, { requests: 0, ok: 0, errors: 0, skipped: 0, streams: 0, avgMs: null, totalMs: 0 }]));
  const breakers = new Map();
  const limit = createLimiter(concurrency);
  const results = new Array(queries.length);
  let done = 0;

  const fetchOne = (provider, query) => {
    const key = `${provider.slug}:${query.kind}`;
    if (!breakers.has(key)) breakers.set(key, { consecutive: 0, open: false, lastError: null });
    const breaker = breakers.get(key);
    const stats = perProvider[provider.slug];
    return limit(async () => {
      if (signal?.aborted) { stats.skipped++; return { ok: false, skipped: true, error: 'cancelado' }; }
      if (breaker.open) {
        stats.skipped++;
        return { ok: false, skipped: true, error: `omitido tras ${breakerThreshold} errores seguidos (${breaker.lastError})` };
      }
      stats.requests++;
      const started = now();
      try {
        const value = await source(provider, query);
        stats.ok++;
        stats.streams += value.streams.length;
        breaker.consecutive = 0;
        return { ok: true, value };
      } catch (err) {
        stats.errors++;
        const message = describeError(err);
        if (err?.name !== 'AbortError') {
          breaker.lastError = message;
          if (++breaker.consecutive >= breakerThreshold) breaker.open = true;
        }
        return { ok: false, error: message };
      } finally {
        stats.totalMs += now() - started;
      }
    });
  };

  await Promise.all(queries.map(async (query, index) => {
    const outcomes = await Promise.all(providers.map(provider =>
      fetchOne(provider, query).then(outcome => ({ provider, ...outcome }))
    ));
    const providerResults = outcomes.filter(o => o.ok).map(o => ({ provider: o.provider, url: o.value.url, streams: o.value.streams }));
    const errors = outcomes.filter(o => !o.ok).map(o => ({ provider: o.provider.slug, error: o.error, skipped: Boolean(o.skipped) }));
    results[index] = buildItem(query, providerResults, errors, { bestTrackers, maxTrackers });
    done++;
    onItem?.(results[index], { done, total: queries.length });
  }));

  for (const stats of Object.values(perProvider)) {
    const measured = stats.ok + stats.errors;
    stats.avgMs = measured ? Math.round(stats.totalMs / measured) : null;
    delete stats.totalMs;
  }
  const errors = results.flatMap(({ item, errors: itemErrors }) => itemErrors.map(e => ({
    id: item.id, provider: e.provider, label: item.label, error: e.error, ...(e.skipped ? { skipped: true } : {}),
  })));
  const totals = { candidates: 0, streams: 0, picks: { es: 0, en: 0 }, missing: { es: 0, en: 0 } };
  for (const { item, streams } of results) {
    totals.candidates += item.candidateCount;
    totals.streams += streams.length;
    for (const s of streams) totals.picks[s.pick]++;
    for (const lang of item.missing) totals.missing[lang]++;
  }
  return { results, errors, perProvider, totals };
}

/**
 * Atajo para la web: texto del watchlist → resultados, sin token. Devuelve
 * también las consultas expandidas, los avisos y el estado de Cinemeta.
 */
export async function processWatchlist(text, {
  providers,
  fetchJSON,
  metadata = true,
  cinemetaUrl = CINEMETA_URL,
  seasonFallback = null,
  onWarning = null,
  onQueries = null,
  ...runOptions
} = {}) {
  const warnings = [];
  const warn = message => { warnings.push(message); onWarning?.(message); };
  const items = parseWatchlist(text, { onWarning: warn });
  const { metaById, stats: metaStats } = metadata
    ? await loadMetadata(items, { fetchJSON, baseUrl: cinemetaUrl, onWarning: warn })
    : { metaById: new Map(), stats: { source: 'none', requested: 0, found: 0, failures: 0, disabled: true, lastError: null } };
  const queries = await expandWatchlist(items, { metaById, seasonFallback, onWarning: warn });
  onQueries?.(queries);
  const result = await runPipeline(queries, { providers, fetchJSON, ...runOptions });
  return { ...result, items, queries, warnings, metaStats };
}
