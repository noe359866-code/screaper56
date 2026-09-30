import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeQueries, parseWatchlist } from '../src/fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('parseWatchlist reconoce películas', () => {
  const txt = `tt0111161 Cadena perpetua (1994)\ntt1375666 Inception\n# comentario\n\ntt0468569`;
  const items = parseWatchlist(txt);
  assert.equal(items.length, 3);
  assert.equal(items[0].imdbId, 'tt0111161');
  assert.equal(items[0].type, 'movie');
  assert.equal(items[0].label, 'Cadena perpetua (1994)');
});

test('parseWatchlist reconoce episodios y temporadas', () => {
  const txt = `tt0944947:s1:e1 Pilot\ntt0944947:s1 Season 1\ntt1375666`;
  const items = parseWatchlist(txt);
  assert.equal(items.length, 3);
  const ep = items[0];
  assert.equal(ep.type, 'series');
  assert.equal(ep.season, 1);
  assert.equal(ep.episode, 1);
  const season = items[1];
  assert.equal(season.season, 1);
  assert.equal(season.episode, null);
});

test('parseWatchlist deduplica IDs repetidos y normaliza mayúsculas/ceros', () => {
  const txt = `tt0111161\nTT0111161 Cadena\ntt0944947:s01:e001\ntt0944947:s1:e1 Pilot\n`;
  const items = parseWatchlist(txt);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Cadena', 'aprovecha una etiqueta útil de la línea duplicada');
  assert.equal(items[1].imdbId, 'tt0944947');
  assert.equal(items[1].season, 1);
  assert.equal(items[1].episode, 1);
});

test('dedupeQueries evita consultar episodios repetidos por línea de episodio y temporada completa', () => {
  const queries = dedupeQueries([
    { kind: 'series', imdbId: 'tt0944947', season: 1, episode: 1, label: 'Juego de Tronos S01E01' },
    { kind: 'series', imdbId: 'tt0944947', season: 1, episode: 1, label: 'Juego de Tronos S01E01 – Pilot' },
    { kind: 'series', imdbId: 'tt0944947', season: 1, episode: 2, label: 'Juego de Tronos S01E02' },
    { kind: 'movie', imdbId: 'tt0111161', label: 'Cadena perpetua' },
    { kind: 'movie', imdbId: 'tt0111161', label: 'Cadena perpetua (1994)' },
  ]);
  assert.equal(queries.length, 3);
  assert.equal(queries[0].label, 'Juego de Tronos S01E01');
  assert.equal(queries[2].kind, 'movie');
});

test('watchlist.txt del repo es parseable y contiene entradas válidas', async () => {
  const root = resolve(__dirname, '..');
  const txt = readFileSync(resolve(root, 'watchlist.txt'), 'utf8');
  const items = parseWatchlist(txt);
  assert.ok(items.length >= 5, 'debe haber al menos 5 entradas de ejemplo');
  const movies = items.filter(i => i.type === 'movie');
  const series = items.filter(i => i.type === 'series');
  assert.ok(movies.length >= 1);
  assert.ok(series.length >= 1);
});
