/**
 * Historial de progreso por serie: dónde quedó cada una (última temporada y
 * episodio ingeridos), cuántos episodios lleva y cuántos le faltan.
 *
 * Lo usa la Action para:
 *  - reanudar series largas donde se quedó la ejecución anterior (no vuelve a
 *    consultar episodios ya ingeridos),
 *  - conservar en watchlist.txt solo las series a las que todavía les faltan
 *    episodios (las completas se eliminan),
 *  - publicar el historial en `public/data/progress.json` (dashboard/resumen).
 *
 * La fuente de verdad de "qué episodios están hechos" es `seen.json`
 * (claves `tt…:sN:eN`); este módulo solo resume y muestra ese estado.
 * Compartido por la GitHub Action (Node) y la web (navegador).
 */

import { episodesForSeries } from './meta.js';

const IMDB_ID_RE = /^tt\d{7,10}$/i;

/** Clave canónica de episodio: `tt0944947:s1:e2`. */
export function episodeKey(imdbId, season, episode) {
  return `${String(imdbId).toLowerCase()}:s${Number(season)}:e${Number(episode)}`;
}

/** `S01E02` para mostrar. */
export function episodeTag(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/**
 * Interpreta un identificador de serie indicado por el usuario (p. ej. en
 * `Run workflow`): acepta `tt0411008`, `tt0411008 Lost`, `tt0411008:s1` o una
 * URL de IMDb `https://www.imdb.com/title/tt0411008/`.
 */
export function parseSeriesTarget(input) {
  if (!input) return null;
  if (typeof input === 'object' && input.imdbId) {
    const id = String(input.imdbId).toLowerCase().trim();
    if (!IMDB_ID_RE.test(id)) return null;
    const label = String(input.label || input.name || '').trim() || null;
    return { imdbId: id, label };
  }
  const text = String(input).trim();
  if (!text) return null;
  const urlMatch = text.match(/imdb\.com\/title\/(tt\d{7,10})/i);
  if (urlMatch) {
    return { imdbId: urlMatch[1].toLowerCase(), label: null };
  }
  const match = text.match(/^(tt\d{7,10})(?::s\d{1,2}(?::e\d{1,3})?)?(?:\s+(.*))?$/i);
  if (!match) return null;
  const imdbId = match[1].toLowerCase();
  const label = (match[2] || '').trim() || null;
  return { imdbId, label };
}

/**
 * Episodios ya emitidos de una serie que AÚN faltan por ingerir (no están en
 * `doneKeys`). Con `meta` sin episodios o sin ficha devuelve [].
 */
export function pendingEpisodes(imdbId, meta, doneKeys, { now = Date.now() } = {}) {
  const aired = episodesForSeries(meta, { now });
  if (!aired?.length) return [];
  return aired.filter(ep => !doneKeys?.has?.(episodeKey(imdbId, ep.season, ep.episode)));
}

/**
 * Calcula el registro de progreso de una serie a partir de sus episodios
 * emitidos y de las claves ya ingeridas. `null` si no hay ficha de serie.
 */
export function computeSeriesProgress({ imdbId, name = null, meta, doneKeys, now = Date.now() } = {}) {
  const aired = episodesForSeries(meta, { now });
  if (!aired) return null;
  const pending = [];
  const done = [];
  for (const ep of aired) {
    if (doneKeys?.has?.(episodeKey(imdbId, ep.season, ep.episode))) done.push(ep);
    else pending.push(ep);
  }
  const last = done.length ? done[done.length - 1] : null;
  const next = pending.length ? pending[0] : null;
  return {
    name: name || meta?.name || imdbId,
    status: aired.length > 0 && pending.length === 0 ? 'complete' : 'in-progress',
    done: done.length,
    total: aired.length,
    lastSeason: last?.season ?? null,
    lastEpisode: last?.episode ?? null,
    nextSeason: next?.season ?? null,
    nextEpisode: next?.episode ?? null,
    updatedAt: new Date(now).toISOString(),
  };
}

/** Número de serie con historial que aún tiene episodios pendientes. */
export function countInProgress(progress) {
  return Object.values(progress?.series || {}).filter(r => r.status === 'in-progress').length;
}

/**
 * Normaliza un `progress.json` leído del disco (o null). Conserva las series
 * en progreso, la serie activa (`activeSeries`) que se está siguiendo hasta
 * terminarla y solo las últimas `keepComplete` completadas (historial acotado).
 */
export function normalizeProgress(raw, { keepComplete = 50 } = {}) {
  const series = {};
  const completed = [];
  for (const [rawId, record] of Object.entries(raw?.series || {})) {
    if (!record || typeof record !== 'object') continue;
    const imdbId = String(rawId).toLowerCase().trim();
    const entry = {
      name: typeof record.name === 'string' ? record.name : imdbId,
      status: record.status === 'complete' ? 'complete' : 'in-progress',
      done: Number.isInteger(record.done) ? record.done : 0,
      total: Number.isInteger(record.total) ? record.total : 0,
      lastSeason: Number.isInteger(record.lastSeason) ? record.lastSeason : null,
      lastEpisode: Number.isInteger(record.lastEpisode) ? record.lastEpisode : null,
      nextSeason: Number.isInteger(record.nextSeason) ? record.nextSeason : null,
      nextEpisode: Number.isInteger(record.nextEpisode) ? record.nextEpisode : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      ...(typeof record.startedAt === 'string' ? { startedAt: record.startedAt } : {}),
    };
    if (entry.status === 'complete') completed.push([imdbId, entry]);
    else series[imdbId] = entry;
  }
  completed.sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
  for (const [imdbId, entry] of completed.slice(0, Math.max(0, keepComplete))) series[imdbId] = entry;
  const rawActive = typeof raw?.activeSeries === 'string' ? raw.activeSeries.toLowerCase().trim() : null;
  const activeSeries = rawActive && IMDB_ID_RE.test(rawActive) && series[rawActive]?.status !== 'complete'
    ? rawActive
    : null;
  return {
    version: 1,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    activeSeries,
    series,
  };
}

/**
 * Lista priorizada de series candidatas a seguir hasta terminarlas:
 *  1) `preferredId` (si se indicó explícitamente en `Run workflow`),
 *  2) `progress.activeSeries` (la serie que ya se estaba siguiendo),
 *  3) series del `watchlist.txt` actual que estén en progreso o sean nuevas,
 *  4) el resto de series `in-progress` guardadas en `progress.json`.
 */
export function candidateSeriesIds(progress, items = [], { preferredId = null } = {}) {
  const out = [];
  const added = new Set();
  const push = (imdbId, label, source) => {
    const id = String(imdbId || '').toLowerCase().trim();
    if (!IMDB_ID_RE.test(id) || added.has(id)) return;
    added.add(id);
    const name = label || progress?.series?.[id]?.name || id;
    out.push({ imdbId: id, label: name, source });
  };

  const preferred = parseSeriesTarget(preferredId);
  if (preferred) push(preferred.imdbId, preferred.label, 'preferred');

  if (progress?.activeSeries && progress?.series?.[progress.activeSeries]?.status !== 'complete') {
    push(progress.activeSeries, progress?.series?.[progress.activeSeries]?.name, 'active');
  }

  for (const item of items || []) {
    if (!item || item.season != null) continue;
    const id = String(item.imdbId || '').toLowerCase().trim();
    if (progress?.series?.[id]?.status === 'in-progress') {
      push(id, item.label || item.name, 'watchlist-in-progress');
    }
  }

  for (const item of items || []) {
    if (!item || item.season != null) continue;
    const id = String(item.imdbId || '').toLowerCase().trim();
    const isSeries = item.type === 'series' || item.typeHint === 'series';
    if (isSeries && progress?.series?.[id]?.status !== 'complete') {
      push(id, item.label || item.name, 'watchlist-series');
    }
  }

  for (const [imdbId, record] of Object.entries(progress?.series || {})) {
    if (record?.status === 'in-progress') {
      push(imdbId, record.name, 'progress');
    }
  }

  for (const item of items || []) {
    if (!item || item.season != null || item.typeHint === 'movie') continue;
    const id = String(item.imdbId || '').toLowerCase().trim();
    if (progress?.series?.[id]?.status !== 'complete') {
      push(id, item.label || item.name, 'watchlist-unknown');
    }
  }

  return out;
}

/**
 * Elige UNA única serie activa (`imdbId`) para seguir con ella hasta terminarla
 * antes de pasar a otra. Devuelve `null` si no hay ninguna serie pendiente.
 */
export function pickActiveSeries(progress, items = [], {
  preferredId = null,
  pendingById = null,
  seen = null,
} = {}) {
  const candidates = candidateSeriesIds(progress, items, { preferredId });
  for (const candidate of candidates) {
    const { imdbId, label, source } = candidate;
    if (pendingById && pendingById.has(imdbId)) {
      if (pendingById.get(imdbId) > 0) return imdbId;
      continue;
    }
    const rec = progress?.series?.[imdbId];
    if (rec) {
      if (rec.status === 'in-progress') return imdbId;
      continue;
    }
    if (source === 'preferred') return imdbId;
    if (source === 'watchlist-unknown') continue;
    if (seen?.hasItem?.({ imdbId, name: label })) continue;
    return imdbId;
  }
  return null;
}

/**
 * Actualiza el historial tras una ingesta: recalcula cada serie para la que
 * hay ficha de Cinemeta (entre las procesadas ahora o ya en el historial),
 * conserva `startedAt` de la primera vez que se vio y mantiene `activeSeries`
 * apuntando a la serie en curso (o pasa a la siguiente cuando se completa).
 */
export function advanceProgress(progress, {
  metaById,
  doneKeys,
  imdbIds,
  activeSeries = undefined,
  queuedSeries = [],
  now = Date.now(),
} = {}) {
  const next = normalizeProgress(progress);
  const nowIso = new Date(now).toISOString();
  const ids = new Set(imdbIds || []);
  for (const imdbId of Object.keys(next.series)) ids.add(imdbId);
  for (const imdbId of ids) {
    const meta = metaById?.get?.(imdbId);
    if (!meta || meta.type !== 'series') continue;
    const record = computeSeriesProgress({ imdbId, name: meta.name, meta, doneKeys, now });
    if (!record) continue;
    const previous = next.series[imdbId];
    next.series[imdbId] = {
      ...record,
      startedAt: previous?.startedAt || record.updatedAt,
    };
  }
  for (const queued of queuedSeries || []) {
    const parsed = parseSeriesTarget(queued);
    if (!parsed) continue;
    const { imdbId, label } = parsed;
    if (next.series[imdbId]) continue;
    next.series[imdbId] = {
      name: label || imdbId,
      status: 'in-progress',
      done: 0,
      total: 0,
      lastSeason: null,
      lastEpisode: null,
      nextSeason: 1,
      nextEpisode: 1,
      updatedAt: nowIso,
      startedAt: nowIso,
    };
  }
  const desiredActive = parseSeriesTarget(activeSeries !== undefined ? activeSeries : next.activeSeries)?.imdbId || null;
  if (desiredActive && next.series[desiredActive]?.status === 'in-progress') {
    next.activeSeries = desiredActive;
  } else {
    const fromRun = (imdbIds || [])
      .map(id => String(id || '').toLowerCase().trim())
      .find(id => next.series[id]?.status === 'in-progress');
    const fromQueue = Object.entries(next.series).find(([, r]) => r.status === 'in-progress')?.[0] || null;
    next.activeSeries = fromRun || fromQueue || null;
  }
  next.updatedAt = nowIso;
  return next;
}

/**
 * Qué líneas de series (sin temporada) hay que conservar en el watchlist:
 *  - Con `activeSeriesId` (modo seguir 1 sola serie hasta terminarla): conserva
 *    ÚNICAMENTE esa serie mientras le queden episodios pendientes.
 *  - Sin `activeSeriesId` (`undefined`): conserva todas las series a las que
 *    todavía les faltan episodios.
 */
export function resumeKeepPredicate(progress, { pendingById = null, activeSeriesId = undefined } = {}) {
  const singleTarget = activeSeriesId !== undefined
    ? (parseSeriesTarget(activeSeriesId)?.imdbId || null)
    : undefined;
  return item => {
    if (!item || item.season != null) return false;
    const id = String(item.imdbId || '').toLowerCase();
    if (singleTarget !== undefined) {
      if (!singleTarget || id !== singleTarget) return false;
      if (pendingById && pendingById.has(id)) return pendingById.get(id) > 0;
      return progress?.series?.[id]?.status !== 'complete';
    }
    if (pendingById) return (pendingById.get(id) ?? 0) > 0;
    return progress?.series?.[id]?.status === 'in-progress';
  };
}

/**
 * Series en progreso que faltan en el watchlist (p. ej. porque un Issue lo
 * reemplazó o porque estaban en cola en `progress.json`): se reinyectan para
 * seguir donde se quedó. Con `activeSeriesId` solo reinyecta la serie activa.
 */
export function resumeMissingItems(progress, items, {
  pendingById = null,
  activeSeriesId = undefined,
  preferredTarget = null,
} = {}) {
  const present = new Set((items || []).filter(i => i.season == null).map(i => String(i.imdbId || '').toLowerCase()));
  if (activeSeriesId !== undefined) {
    const targetId = parseSeriesTarget(activeSeriesId)?.imdbId || null;
    if (!targetId || present.has(targetId)) return [];
    const hasPending = pendingById && pendingById.has(targetId)
      ? pendingById.get(targetId) > 0
      : progress?.series?.[targetId]?.status !== 'complete';
    if (!hasPending) return [];
    const preferred = parseSeriesTarget(preferredTarget);
    const name = progress?.series?.[targetId]?.name
      || (preferred?.imdbId === targetId ? preferred.label : null)
      || targetId;
    return [{ imdbId: targetId, type: 'series', season: null, episode: null, name, label: name }];
  }
  const keep = resumeKeepPredicate(progress, { pendingById });
  const missing = [];
  for (const [imdbId, record] of Object.entries(progress?.series || {})) {
    if (record.status !== 'in-progress' || present.has(imdbId)) continue;
    const item = { imdbId, type: 'series', season: null, episode: null, name: record.name, label: record.name };
    if (keep(item)) missing.push(item);
  }
  return missing;
}
