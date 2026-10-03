import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceProgress,
  computeSeriesProgress,
  countInProgress,
  episodeKey,
  episodeTag,
  normalizeProgress,
  parseSeriesTarget,
  pendingEpisodes,
  pickActiveSeries,
  resumeKeepPredicate,
  resumeMissingItems,
} from '../public/lib/progress.js';
import { normalizeMeta } from '../public/lib/meta.js';

const SERIE = normalizeMeta({
  meta: {
    id: 'tt0903747', imdb_id: 'tt0903747', type: 'series', name: 'Breaking Bad', year: '2008–2013',
    videos: [
      { season: 1, episode: 1, name: 'Pilot', released: '2008-01-20' },
      { season: 1, episode: 2, name: 'Cat\'s in the Bag...', released: '2008-01-27' },
      { season: 2, episode: 1, name: 'Seven Thirty-Seven', released: '2009-03-08' },
      { season: 2, episode: 2, name: 'Grilled', released: '2009-03-15' },
      { season: 0, episode: 1, name: 'Especial', released: '2009-02-17' }, // fuera
    ],
  },
});

test('episodeKey/episodeTag: claves canónicas y etiquetas SxxExx', () => {
  assert.equal(episodeKey('TT0903747', 2, 3), 'tt0903747:s2:e3');
  assert.equal(episodeTag(2, 3), 'S02E03');
  assert.equal(episodeTag(12, 123), 'S12E123');
});

test('pendingEpisodes: lo emitido que falta según las claves ya ingeridas', () => {
  const done = new Set(['tt0903747:s1:e1', 'tt0903747:s1:e2']);
  assert.deepEqual(
    pendingEpisodes('tt0903747', SERIE, done).map(e => `${e.season}x${e.episode}`),
    ['2x1', '2x2'],
  );
  assert.equal(pendingEpisodes('tt0903747', SERIE, new Set()).length, 4);
  assert.deepEqual(pendingEpisodes('tt0903747', null, done), []);
});

test('computeSeriesProgress: último episodio, por dónde sigue y estado', () => {
  const done = new Set(['tt0903747:s1:e1', 'tt0903747:s1:e2', 'tt0903747:s2:e1']);
  const record = computeSeriesProgress({ imdbId: 'tt0903747', meta: SERIE, doneKeys: done, now: Date.parse('2026-10-01') });
  assert.deepEqual(
    [record.status, record.done, record.total],
    ['in-progress', 3, 4],
  );
  assert.deepEqual([record.lastSeason, record.lastEpisode], [2, 1]);
  assert.deepEqual([record.nextSeason, record.nextEpisode], [2, 2]);
  assert.equal(record.name, 'Breaking Bad');

  const all = new Set(['tt0903747:s1:e1', 'tt0903747:s1:e2', 'tt0903747:s2:e1', 'tt0903747:s2:e2']);
  const complete = computeSeriesProgress({ imdbId: 'tt0903747', meta: SERIE, doneKeys: all });
  assert.equal(complete.status, 'complete');
  assert.equal(complete.nextSeason, null);
  assert.equal(computeSeriesProgress({ imdbId: 'tt0903747', meta: { type: 'movie' }, doneKeys: all }), null);
});

test('normalizeProgress: conserva en progreso y acota el historial de completadas', () => {
  const raw = {
    series: {
      tta: { name: 'A', status: 'in-progress', done: 1, total: 2 },
      ttb: { name: 'B', status: 'complete', done: 2, total: 2, updatedAt: '2026-01-01' },
      ttc: { name: 'C', status: 'complete', done: 3, total: 3, updatedAt: '2026-02-01' },
      ttd: 'basura',
    },
  };
  const progress = normalizeProgress(raw, { keepComplete: 1 });
  assert.deepEqual(Object.keys(progress.series).sort(), ['tta', 'ttc']);
  assert.equal(progress.series.tta.status, 'in-progress');
  assert.equal(countInProgress(progress), 1);
  assert.deepEqual(Object.keys(normalizeProgress(null).series), []);
});

test('advanceProgress: recalcula con el historial seen y conserva startedAt', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const before = normalizeProgress({
    series: { tt0903747: { name: 'Breaking Bad', status: 'in-progress', done: 1, total: 4, startedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' } },
  });
  const metaById = new Map([['tt0903747', SERIE]]);
  const done = new Set(['tt0903747:s1:e1', 'tt0903747:s1:e2']);
  const after = advanceProgress(before, { metaById, doneKeys: done, imdbIds: ['tt0903747'], now });
  assert.equal(after.series.tt0903747.done, 2);
  assert.equal(after.series.tt0903747.lastEpisode, 2);
  assert.equal(after.series.tt0903747.startedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(after.updatedAt, new Date(now).toISOString());
  // Una película procesada no crea registro.
  metaById.set('tt0111161', { type: 'movie', name: 'The Shawshank Redemption' });
  const same = advanceProgress(before, { metaById, doneKeys: done, imdbIds: ['tt0111161'], now });
  assert.equal(same.series.tt0111161, undefined);
});

test('resumeKeepPredicate/resumeMissingItems: el watchlist conserva lo que falta', () => {
  const progress = normalizeProgress({
    series: {
      tt7777777: { name: 'Serie Larga', status: 'in-progress', done: 4, total: 6 },
      tt8888888: { name: 'Serie Hecha', status: 'complete', done: 2, total: 2 },
    },
  });
  const keep = resumeKeepPredicate(progress);
  assert.equal(keep({ imdbId: 'tt7777777', season: null }), true);
  assert.equal(keep({ imdbId: 'tt8888888', season: null }), false);
  assert.equal(keep({ imdbId: 'tt7777777', season: 1 }), false, 'las líneas con temporada no usan el historial');
  // Con recuentos frescos manda el número de episodios pendientes.
  const keepFresh = resumeKeepPredicate(progress, { pendingById: new Map([['tt8888888', 3]]) });
  assert.equal(keepFresh({ imdbId: 'tt8888888', season: null }), true);

  const items = [{ imdbId: 'tt0111161', type: 'movie', season: null, episode: null }];
  const missing = resumeMissingItems(progress, items);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].imdbId, 'tt7777777');
  assert.equal(missing[0].label, 'Serie Larga');
  const withSeries = [...items, { imdbId: 'tt7777777', season: null }];
  assert.equal(resumeMissingItems(progress, withSeries).length, 0);
});

test('pickActiveSeries y activeSeries: sigue una sola serie hasta terminarla y pasa a la siguiente', () => {
  assert.deepEqual(parseSeriesTarget('TT0411008 Lost'), { imdbId: 'tt0411008', label: 'Lost' });
  assert.deepEqual(parseSeriesTarget('https://www.imdb.com/title/tt0411008/'), { imdbId: 'tt0411008', label: null });
  assert.equal(parseSeriesTarget('basura'), null);

  const progress = normalizeProgress({
    activeSeries: 'tt7777777',
    series: {
      tt6666666: { name: 'Serie Primera', status: 'in-progress', done: 1, total: 10 },
      tt7777777: { name: 'Serie Activa', status: 'in-progress', done: 3, total: 4 },
      tt8888888: { name: 'Serie En Cola', status: 'in-progress', done: 2, total: 8 },
    },
  });

  // Respeta activeSeries aunque haya otras en progreso antes.
  assert.equal(pickActiveSeries(progress, []), 'tt7777777');
  // Si el usuario pide una serie concreta en Run workflow, tiene prioridad.
  assert.equal(pickActiveSeries(progress, [], { preferredId: 'tt8888888' }), 'tt8888888');

  // Con activeSeriesId solo se conserva/reinyecta esa única serie en watchlist.txt.
  const keepOne = resumeKeepPredicate(progress, { activeSeriesId: 'tt7777777' });
  assert.equal(keepOne({ imdbId: 'tt7777777', season: null }), true);
  assert.equal(keepOne({ imdbId: 'tt6666666', season: null }), false);
  const missingOne = resumeMissingItems(progress, [], { activeSeriesId: 'tt7777777' });
  assert.deepEqual(missingOne.map(m => m.imdbId), ['tt7777777']);

  // Cuando la serie activa termina, advanceProgress pasa automáticamente a la siguiente en cola.
  const doneAll = new Set(['tt0903747:s1:e1', 'tt0903747:s1:e2', 'tt0903747:s2:e1', 'tt0903747:s2:e2']);
  const finishedState = advanceProgress(
    normalizeProgress({
      activeSeries: 'tt0903747',
      series: {
        tt0903747: { name: 'Breaking Bad', status: 'in-progress', done: 3, total: 4 },
        tt6666666: { name: 'Serie Siguiente', status: 'in-progress', done: 1, total: 10 },
      },
    }),
    { metaById: new Map([['tt0903747', SERIE]]), doneKeys: doneAll, imdbIds: ['tt0903747'], activeSeries: 'tt0903747' },
  );
  assert.equal(finishedState.series.tt0903747.status, 'complete');
  assert.equal(finishedState.activeSeries, 'tt6666666', 'al terminar la serie actual pasa a la siguiente en progreso');
});

