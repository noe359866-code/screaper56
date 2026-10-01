import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSeenStore,
  discoverCatalogItems,
  normalizeTitleKey,
  rotateWatchlist,
  selectUniqueDbCandidates,
} from '../public/lib/watchlist.js';
import { parseWatchlist } from '../public/lib/parse.js';

function hash(n) {
  return n.toString(16).padStart(40, '0');
}

test('normalizeTitleKey normaliza acentos, años y etiquetas de episodio para no repetir nombres', () => {
  assert.equal(normalizeTitleKey('La hipótesis del amor (2026)'), 'la hipotesis del amor');
  assert.equal(normalizeTitleKey('La Hipótesis Del Amor'), 'la hipotesis del amor');
  assert.equal(normalizeTitleKey('Juego de Tronos S01E01 – Pilot'), 'juego de tronos');
  assert.equal(normalizeTitleKey('Juego de Tronos - Temporada 1'), 'juego de tronos');
  assert.equal(normalizeTitleKey('tt0111161'), null);
});

test('createSeenStore recuerda IDs, nombres y hashes de index.json y de Supabase', () => {
  const seen = createSeenStore();
  seen.addFromIndex({
    items: [
      {
        id: 'tt6933238',
        imdbId: 'tt6933238',
        type: 'movie',
        name: 'Unabomber',
        label: 'Unabomber (2026)',
        picks: [{ infoHash: hash(1), title: 'Unabomber 1080p Castellano' }],
      },
    ],
  });
  seen.addFromDatabaseRows([
    {
      imdb_id: 'tt22526100',
      type: 'movie',
      info_hash: hash(2),
      title: 'The Love Hypothesis (2026)',
    },
  ]);

  assert.equal(seen.hasItem({ imdbId: 'tt6933238' }), true);
  assert.equal(seen.hasItem({ imdbId: 'tt9999999', name: 'Unabomber (2026)' }), true);
  assert.equal(seen.hasItem({ imdbId: 'tt22526100' }), true);
  assert.equal(seen.hasHash(hash(1)), true);
  assert.equal(seen.hasHash(hash(2)), true);
  assert.equal(seen.hasItem({ imdbId: 'tt0111161', name: 'The Shawshank Redemption' }), false);
});

test('rotateWatchlist elimina las anteriores en cada Run y nunca repite títulos ni nombres', async () => {
  const seen = createSeenStore();
  const initialWatchlist = [
    'tt6933238 Unabomber (2026)',
    'tt22526100 The Love Hypothesis (2026)',
    'tt26657236 Backrooms (2026)',
  ].join('\n');

  // Run 1: elimina las 3 anteriores y carga 6 nuevas
  const run1 = await rotateWatchlist(initialWatchlist, {
    seen,
    fetchJSON: null,
    autoDiscover: true,
    replaceAll: true,
    batchSize: 6,
  });
  assert.equal(run1.removedCount, 3);
  assert.equal(run1.addedCount, 6);
  const items1 = parseWatchlist(run1.text);
  assert.equal(items1.length, 6);
  for (const oldId of ['tt6933238', 'tt22526100', 'tt26657236']) {
    assert.equal(items1.some(i => i.imdbId === oldId), false, `${oldId} debía eliminarse`);
  }

  // Run 2: al volver a pulsar Run, elimina las 6 del Run 1 y trae 6 totalmente distintas
  const run2 = await rotateWatchlist(run1.text, {
    seen,
    fetchJSON: null,
    autoDiscover: true,
    replaceAll: true,
    batchSize: 6,
  });
  assert.equal(run2.removedCount, 6);
  assert.equal(run2.addedCount, 6);
  const items2 = parseWatchlist(run2.text);
  assert.equal(items2.length, 6);

  const ids1 = new Set(items1.map(i => i.imdbId));
  const names1 = new Set(items1.map(i => normalizeTitleKey(i.label)));
  for (const item of items2) {
    assert.equal(ids1.has(item.imdbId), false, `No debe repetir el ID ${item.imdbId}`);
    assert.equal(names1.has(normalizeTitleKey(item.label)), false, `No debe repetir el nombre ${item.label}`);
  }
});

test('discoverCatalogItems consulta Cinemeta, descarta estrenos futuros y títulos ya vistos', async () => {
  const seen = createSeenStore({ imdbIds: ['tt0000001'] });
  const fetchJSON = async url => {
    if (url.includes('/catalog/movie/')) {
      return {
        metas: [
          { imdb_id: 'tt0000001', name: 'Already Seen Movie', type: 'movie', year: '2025' },
          { imdb_id: 'tt0000002', name: 'Future Movie', type: 'movie', year: '2099', released: '2099-12-01T00:00:00Z' },
          { imdb_id: 'tt0000003', name: 'Fresh Movie One', type: 'movie', year: '2026', released: '2026-05-01T00:00:00Z' },
          { imdb_id: 'tt0000004', name: 'Fresh Movie One', type: 'movie', year: '2026' }, // mismo nombre duplicado
          { imdb_id: 'tt0000005', name: 'Fresh Movie Two', type: 'movie', year: '2025' },
        ],
      };
    }
    return {
      metas: [
        { imdb_id: 'tt0000010', name: 'Fresh Series One', type: 'series', year: '2026–' },
      ],
    };
  };

  const discovered = await discoverCatalogItems(fetchJSON, {
    seen,
    count: 3,
    movieCount: 2,
    seriesCount: 1,
    now: Date.parse('2026-10-01T00:00:00Z'),
  });

  assert.deepEqual(
    discovered.map(d => `${d.imdbId}:${d.type}`),
    ['tt0000003:movie', 'tt0000005:movie', 'tt0000010:series']
  );
});

test('selectUniqueDbCandidates guarda solo los 2 picks por título y no repite hashes ni nombres', () => {
  const seen = createSeenStore({ hashes: [hash(10)] });
  const results = [
    {
      item: { id: 'tt0111161', imdbId: 'tt0111161', type: 'movie' },
      streams: [
        { infoHash: hash(10), title: 'Already In DB 1080p', pick: 'es' },
        { infoHash: hash(11), title: 'Fresh Pick EN 4K', pick: 'en' },
      ],
      // Aunque haya 50 candidatos brutos, solo se evalúan los 2 picks de `streams`.
      candidates: Array.from({ length: 50 }, (_, i) => ({ infoHash: hash(100 + i), title: `Candidate ${i}` })),
    },
    {
      item: { id: 'tt1375666', imdbId: 'tt1375666', type: 'movie' },
      streams: [
        { infoHash: hash(11), title: 'Duplicate Hash From Above', pick: 'es' },
        { infoHash: hash(12), title: 'Inception 1080p Dual', pick: 'en' },
        { infoHash: hash(13), title: 'Inception 1080p Dual', pick: 'es' }, // mismo título en el mismo item
      ],
    },
  ];

  const { dbCandidates, skippedSeen, skippedDuplicates } = selectUniqueDbCandidates(results, { seen });
  assert.equal(skippedSeen, 1);
  assert.equal(skippedDuplicates, 2);
  assert.deepEqual(dbCandidates.map(c => c.stream.infoHash), [hash(11), hash(12)]);
});
