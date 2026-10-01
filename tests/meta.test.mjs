import test from 'node:test';
import assert from 'node:assert/strict';

import {
  episodesForSeason,
  episodesForSeries,
  fetchCinemeta,
  labelMismatch,
  labelYear,
  normalizeMeta,
  posterUrl,
  showLabel,
} from '../public/lib/meta.js';

// Formato real de https://v3-cinemeta.strem.io/meta/series/tt0903747.json (recortado):
// los vídeos NO vienen ordenados.
const BREAKING_BAD = {
  meta: {
    id: 'tt0903747', imdb_id: 'tt0903747', type: 'series', name: 'Breaking Bad', year: '2008–2013',
    videos: [
      { name: 'Pilot', season: 1, number: 1, episode: 1, released: '2008-01-20T12:00:00.000Z', id: 'tt0903747:1:1' },
      { name: 'Crazy Handful of Nothin\'', season: 1, number: 6, episode: 6, released: '2008-03-02T12:00:00.000Z' },
      { name: 'A No-Rough-Stuff-Type Deal', season: 1, number: 7, episode: 7, released: '2008-03-09T12:00:00.000Z' },
      { name: 'Cat\'s in the Bag...', season: 1, number: 2, episode: 2, firstAired: '2008-01-27T12:00:00.000Z' },
      { name: 'Pilot (duplicado)', season: 1, number: 1, episode: 1, released: '2008-01-20T12:00:00.000Z' },
      { name: 'Especial', season: 0, number: 1, episode: 1, released: '2009-02-17T12:00:00.000Z' },
      { name: 'Seven Thirty-Seven', season: 2, number: 1, episode: 1, released: '2009-03-08T12:00:00.000Z' },
    ],
  },
};

test('normalizeMeta: nombre, años de emisión y vídeos de Cinemeta', () => {
  const meta = normalizeMeta(BREAKING_BAD);
  assert.equal(meta.name, 'Breaking Bad');
  assert.equal(meta.type, 'series');
  assert.equal(meta.year, 2008);
  assert.equal(meta.yearEnd, 2013);
  assert.equal(meta.videos.length, 7);
  assert.equal(normalizeMeta({ meta: {} }), null);
  assert.equal(normalizeMeta(null), null);
  const movie = normalizeMeta({ meta: { id: 'tt0253474', type: 'movie', name: 'The Pianist', year: '2003' } });
  assert.deepEqual([movie.year, movie.yearEnd, movie.videos], [2003, 2003, null]);
  const airing = normalizeMeta({ meta: { type: 'series', name: 'X', year: '2011–' } });
  assert.equal(airing.yearEnd, null);
});

test('episodesForSeason: ordena, deduplica y descarta los episodios aún no emitidos', () => {
  const meta = normalizeMeta(BREAKING_BAD);
  assert.deepEqual(episodesForSeason(meta, 1).map(e => e.episode), [1, 2, 6, 7]);
  assert.equal(episodesForSeason(meta, 1)[0].title, 'Pilot');
  assert.deepEqual(episodesForSeason(meta, 3), []);
  const future = normalizeMeta({ meta: { type: 'series', name: 'X', videos: [
    { season: 1, episode: 1, released: '2026-01-01T00:00:00Z' },
    { season: 1, episode: 2, released: '2099-01-01T00:00:00Z' },
    { season: 1, episode: 3 },
  ] } });
  assert.deepEqual(episodesForSeason(future, 1, { now: Date.parse('2026-09-30') }).map(e => e.episode), [1, 3]);
  assert.equal(episodesForSeason({ videos: null }, 1), null);
});

test('episodesForSeries: todas las temporadas de una vez, sin especiales ni episodios futuros', () => {
  const meta = normalizeMeta(BREAKING_BAD);
  // S01E1 (duplicado descartado), S01E2, S01E6, S01E7 y S02E1; el especial de
  // la temporada 0 queda fuera.
  assert.deepEqual(
    episodesForSeries(meta).map(e => `${e.season}x${e.episode}`),
    ['1x1', '1x2', '1x6', '1x7', '2x1'],
  );
  assert.equal(episodesForSeries(meta)[0].title, 'Pilot');
  const future = normalizeMeta({ meta: { type: 'series', name: 'X', videos: [
    { season: 1, episode: 1, released: '2026-01-01T00:00:00Z' },
    { season: 1, episode: 2, released: '2099-01-01T00:00:00Z' },
    { season: 2, episode: 1 },
  ] } });
  assert.deepEqual(
    episodesForSeries(future, { now: Date.parse('2026-09-30') }).map(e => `${e.season}x${e.episode}`),
    ['1x1', '2x1'],
  );
  assert.equal(episodesForSeries({ videos: null }), null);
  assert.deepEqual(episodesForSeries({ videos: [{ season: 0, episode: 1, released: '2020-01-01' }] }), []);
});

test('labelMismatch avisa cuando la etiqueta del watchlist no es la película del ID', () => {
  const pianist = normalizeMeta({ meta: { type: 'movie', name: 'The Pianist', year: '2003' } });
  assert.match(labelMismatch('El Padrino. Parte II (1974)', pianist), /The Pianist \(2003\)/);
  assert.equal(labelMismatch('El pianista (2002)', pianist), null); // ±1 año
  assert.equal(labelMismatch('El pianista', pianist), null); // sin año no se puede juzgar
  const got = normalizeMeta({ meta: { type: 'series', name: 'Game of Thrones', year: '2011–2019' } });
  assert.equal(labelMismatch('Juego de Tronos (2015)', got), null);
  assert.equal(labelYear('Cadena perpetua (1994)'), 1994);
  assert.equal(labelYear('Blade Runner 2049 (2017)'), 2017);
  assert.equal(labelYear('Sin año'), null);
});

test('showLabel quita la parte de temporada y posterUrl no necesita API key', () => {
  assert.equal(showLabel('Juego de Tronos – Temporada 1 completa'), 'Juego de Tronos');
  assert.equal(showLabel('Breaking Bad S01'), 'Breaking Bad');
  assert.equal(showLabel('Juego de Tronos S01E01'), 'Juego de Tronos');
  assert.equal(showLabel('Breaking Bad 1x01'), 'Breaking Bad');
  assert.equal(showLabel('Juego de Tronos – Temporada completa'), 'Juego de Tronos');
  assert.equal(showLabel('The Seasons Change'), 'The Seasons Change'); // "season" sin número no corta
  assert.equal(showLabel('', { name: 'Game of Thrones' }), 'Game of Thrones');
  assert.equal(posterUrl('tt0111161'), 'https://images.metahub.space/poster/small/tt0111161/img');
  assert.equal(posterUrl('nope'), null);
});

test('fetchCinemeta prueba el otro tipo si no hay ficha (película ↔ serie)', async () => {
  const calls = [];
  const fetchJSON = async url => {
    calls.push(url);
    if (url.includes('/meta/movie/')) return { meta: {} };
    return BREAKING_BAD;
  };
  const meta = await fetchCinemeta(fetchJSON, 'tt0903747', 'movie');
  assert.equal(meta.type, 'series');
  assert.equal(calls.length, 2);
  const notFound = async () => { const err = new Error('HTTP 404'); err.status = 404; throw err; };
  assert.equal(await fetchCinemeta(notFound, 'tt0000001', 'movie'), null);
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(fetchCinemeta(down, 'tt0000001', 'movie'), /fetch failed/);
});
