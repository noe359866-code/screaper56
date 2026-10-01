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

/** Clave canónica de episodio: `tt0944947:s1:e2`. */
export function episodeKey(imdbId, season, episode) {
  return `${String(imdbId).toLowerCase()}:s${Number(season)}:e${Number(episode)}`;
}

/** `S01E02` para mostrar. */
export function episodeTag(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
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
 * en progreso y solo las últimas `keepComplete` completadas (historial acotado).
 */
export function normalizeProgress(raw, { keepComplete = 50 } = {}) {
  const series = {};
  const completed = [];
  for (const [imdbId, record] of Object.entries(raw?.series || {})) {
    if (!record || typeof record !== 'object') continue;
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
  return {
    version: 1,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    series,
  };
}

/**
 * Actualiza el historial tras una ingesta: recalcula cada serie para la que
 * hay ficha de Cinemeta (entre las procesadas ahora o ya en el historial) y
 * conserva `startedAt` de la primera vez que se vio.
 */
export function advanceProgress(progress, { metaById, doneKeys, imdbIds, now = Date.now() } = {}) {
  const next = normalizeProgress(progress);
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
  next.updatedAt = new Date(now).toISOString();
  return next;
}

/**
 * Qué líneas de series (sin temporada) hay que conservar en el watchlist:
 * las que todavía tienen episodios pendientes. Con `pendingById` (recuento
 * fresco contra Cinemeta) manda ese recuento; si no, el estado del historial.
 */
export function resumeKeepPredicate(progress, { pendingById = null } = {}) {
  return item => {
    if (!item || item.season != null) return false;
    const id = String(item.imdbId || '').toLowerCase();
    if (pendingById) return (pendingById.get(id) ?? 0) > 0;
    return progress?.series?.[id]?.status === 'in-progress';
  };
}

/**
 * Series en progreso que faltan en el watchlist (p. ej. porque un Issue lo
 * reemplazó): se reinyectan para seguir donde se quedó.
 */
export function resumeMissingItems(progress, items, { pendingById = null } = {}) {
  const present = new Set((items || []).map(i => String(i.imdbId || '').toLowerCase()));
  const keep = resumeKeepPredicate(progress, { pendingById });
  const missing = [];
  for (const [imdbId, record] of Object.entries(progress?.series || {})) {
    if (record.status !== 'in-progress' || present.has(imdbId)) continue;
    const item = { imdbId, type: 'series', season: null, episode: null, name: record.name, label: record.name };
    if (keep(item)) missing.push(item);
  }
  return missing;
}
