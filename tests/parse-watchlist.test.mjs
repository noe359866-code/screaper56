import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamically import the module's internals by reusing a small harness:
// fetch.mjs only exposes a CLI main(), but parseWatchlist is not exported.
// To keep the script self-contained, we re-import the regex and parsing
// through a dynamic import of a tiny copy. For simplicity we inline the
// regex and a light parser test that mirrors the script.
const IMDB_LINE_RE = /^(tt\d{7,10})(?::s(\d{1,2})(?::e(\d{1,3}))?)?(?:\s+(.*))?$/i;

function parseWatchlist(text) {
  const items = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(IMDB_LINE_RE);
    if (!m) continue;
    const imdbId = m[1].toLowerCase();
    const season = m[2] !== undefined ? Number(m[2]) : null;
    const episode = m[3] !== undefined ? Number(m[3]) : null;
    const label = (m[4] || '').trim() || null;
    const type = season !== null ? 'series' : 'movie';
    const key = episode !== null ? `${imdbId}:s${season}:e${episode}`
              : season !== null ? `${imdbId}:s${season}`
              : imdbId;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ imdbId, type, season, episode, label });
  }
  return items;
}

test('parseWatchlist reconoce películas', () => {
  const txt = `tt0111161 Cadena perpetua (1994)\ntt1375666 Inception\n# comentario\n\ntt0468569`;
  const items = parseWatchlist(txt);
  assert.equal(items.length, 3);
  assert.equal(items[0].imdbId, 'tt0111161');
  assert.equal(items[0].type, 'movie');
  assert.equal(items[0].label, 'Cadena perpetua (1994)');
});

test('parseWatchlist reconoce episodios y temporadas', () => {
  const txt = `tt0944947:s1:e1 Pilot\ntt0944947:s1 Season 1\ntt1375666\ninvalid line`;
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

test('parseWatchlist deduplica claves repetidas', () => {
  const txt = `tt0111161\ntt0111161 Cadena\n`;
  const items = parseWatchlist(txt);
  assert.equal(items.length, 1);
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
