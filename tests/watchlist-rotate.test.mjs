import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SEARCH_YEAR,
  MIN_SEARCH_YEAR,
  MOVIE_CATALOG_PATHS,
  SEARCH_YEARS,
  SERIES_CATALOG_PATHS,
  createSeenStore,
  discoverCatalogItems,
  discoverFromTmdb,
  formatWatchlistFile,
  formatWatchlistLine,
  normalizeTitleKey,
  rotateWatchlist,
  selectUniqueDbCandidates,
} from '../public/lib/watchlist.js';
import { enrichWithTmdbAndOmdb } from '../src/fetch.mjs';
import { streamToTorrentRecord } from '../src/db.mjs';
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
  // Las series descubiertas representan la serie COMPLETA (sin temporada ni
  // episodio): la ingesta expande todas las temporadas y episodios de una vez.
  const serie = discovered.find(d => d.type === 'series');
  assert.equal(serie.season, null);
  assert.equal(serie.episode, null);
  assert.equal(serie.label, 'Fresh Series One');
});

test('rotateWatchlist con keep: las series en progreso se conservan aunque estén en el historial', async () => {
  const seen = createSeenStore();
  // La serie ya fue procesada en corridas anteriores (está en el historial).
  seen.addKey('tt7777777');
  seen.addKey('tt7777777:s1:e1');
  seen.addImdbId('tt7777777');
  const text = ['tt7777777 Serie Larga', 'tt0111161 Película Vieja'].join('\n');

  // Sin keep: todo lo visto se elimina (comportamiento clásico).
  const classic = await rotateWatchlist(text, {
    seen: createSeenStore(seen.toJSON()), fetchJSON: null, autoDiscover: false, replaceAll: true, batchSize: 4,
  });
  assert.equal(classic.keptCount, 0);

  // Con keep (serie con episodios pendientes): se conserva y cuenta en el lote.
  const keep = item => item.imdbId === 'tt7777777' && item.season == null;
  const rotated = await rotateWatchlist(text, {
    seen: createSeenStore(seen.toJSON()), fetchJSON: null, autoDiscover: false, replaceAll: true, keep, batchSize: 4,
  });
  assert.equal(rotated.keptCount, 1);
  assert.equal(rotated.removedCount, 1);
  const items = parseWatchlist(rotated.text);
  assert.ok(items.some(i => i.imdbId === 'tt7777777'), 'la serie en progreso sigue en el watchlist');
  assert.ok(!items.some(i => i.imdbId === 'tt0111161'), 'la película completada se elimina');
});

test('formatWatchlistLine/File: las series completas se escriben sin :s1:e1', () => {
  assert.equal(
    formatWatchlistLine({ imdbId: 'tt0944947', type: 'series', season: null, episode: null, name: 'Game of Thrones', year: 2011 }),
    'tt0944947 Game of Thrones',
  );
  // Las temporadas y episodios explícitos se conservan igual que antes.
  assert.equal(
    formatWatchlistLine({ imdbId: 'tt0944947', type: 'series', season: 1, episode: 1, name: 'Game of Thrones' }),
    'tt0944947:s1:e1 Game of Thrones S01E01',
  );
  const text = formatWatchlistFile([
    { imdbId: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption', year: 1994, label: 'The Shawshank Redemption (1994)' },
    { imdbId: 'tt0944947', type: 'series', season: null, episode: null, name: 'Game of Thrones', label: 'Game of Thrones' },
  ], { date: new Date('2026-10-01T00:00:00Z') });
  assert.match(text, /^tt0944947 Game of Thrones$/m);
  assert.ok(!/tt0944947:s1/.test(text), 'la serie completa no lleva :s1:e1');
  assert.match(text, /si el ID resulta ser una serie/);
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

test('discoverFromTmdb y enrichWithTmdbAndOmdb usan TMDB_API_KEY y OMDB_API_KEY y rellenan tmdb_id para Supabase', async () => {
  const seen = createSeenStore();
  const fakeFetch = async url => {
    if (url.includes('/trending/movie/week')) {
      return { results: [{ id: 872585, title: 'Oppenheimer', release_date: '2023-07-19' }] };
    }
    if (url.includes('/movie/872585/external_ids')) {
      return { imdb_id: 'tt15398776' };
    }
    if (url.includes('/trending/tv/week')) {
      return { results: [{ id: 100088, name: 'The Last of Us', first_air_date: '2023-01-15' }] };
    }
    if (url.includes('/tv/100088/external_ids')) {
      return { imdb_id: 'tt3581920' };
    }
    if (url.includes('/find/tt15398776')) {
      return { movie_results: [{ id: 872585, title: 'Oppenheimer', release_date: '2023-07-19' }], tv_results: [] };
    }
    if (url.includes('omdbapi.com') && url.includes('tt15398776')) {
      return { Response: 'True', Title: 'Oppenheimer', Year: '2023', Type: 'movie', imdbRating: '8.3' };
    }
    return {};
  };

  const tmdbFound = await discoverFromTmdb(fakeFetch, {
    apiKey: 'tmdb-test-key',
    seen,
    movieCount: 1,
    seriesCount: 1,
    now: Date.parse('2026-10-01T00:00:00Z'),
  });
  assert.equal(tmdbFound.movies.length, 1);
  assert.equal(tmdbFound.movies[0].imdbId, 'tt15398776');
  assert.equal(tmdbFound.movies[0].tmdbId, 872585);
  assert.equal(tmdbFound.series.length, 1);
  assert.equal(tmdbFound.series[0].imdbId, 'tt3581920');
  assert.equal(tmdbFound.series[0].tmdbId, 100088);

  const metaById = new Map();
  const stats = await enrichWithTmdbAndOmdb([{ imdbId: 'tt15398776', type: 'movie' }], metaById, {
    fetchImpl: fakeFetch,
    tmdbApiKey: 'tmdb-test-key',
    omdbApiKey: 'omdb-test-key',
  });
  assert.equal(stats.tmdb.found, 1);
  assert.equal(stats.omdb.found, 1);
  const enriched = metaById.get('tt15398776');
  assert.equal(enriched.tmdbId, 872585);
  assert.equal(enriched.imdbRating, '8.3');

  const record = streamToTorrentRecord(
    { imdbId: 'tt15398776', tmdbId: enriched.tmdbId, type: 'movie' },
    { infoHash: hash(99), title: 'Oppenheimer 2023 1080p Castellano', quality: '1080p', audioLangs: ['es'] }
  );
  assert.equal(record.tmdb_id, 872585);
});

test('los catálogos y el descubrimiento cubren todos los años de 1935 a 2099 (no solo 2026/2025)', async () => {
  assert.equal(MIN_SEARCH_YEAR, 1935);
  assert.equal(MAX_SEARCH_YEAR, 2099);
  assert.equal(SEARCH_YEARS.length, 2099 - 1935 + 1);
  for (let year = 1935; year <= 2099; year++) {
    assert.ok(SEARCH_YEARS.includes(year), `SEARCH_YEARS debe incluir ${year}`);
    assert.ok(
      MOVIE_CATALOG_PATHS.includes(`/catalog/movie/year/genre=${year}.json`),
      `MOVIE_CATALOG_PATHS debe incluir ${year}`,
    );
    assert.ok(
      SERIES_CATALOG_PATHS.includes(`/catalog/series/year/genre=${year}.json`),
      `SERIES_CATALOG_PATHS debe incluir ${year}`,
    );
  }

  // Simula catálogos por año: debe repartir entre varias décadas (1935–2099)
  // y descartar años fuera de 1935–2099 (p. ej. 1920).
  const fetchJSON = async url => {
    const yearMatch = url.match(/genre=(\d{4})\.json$/);
    const kind = url.includes('/series/') ? 'series' : 'movie';
    if (yearMatch) {
      const y = Number(yearMatch[1]);
      return {
        metas: Array.from({ length: 10 }, (_, idx) => ({
          imdb_id: `tt${String(y * 1000 + idx + (kind === 'series' ? 500 : 1)).padStart(7, '0')}`,
          name: `${kind === 'series' ? 'Serie' : 'Película'} ${y} #${idx + 1}`,
          type: kind,
          year: String(y),
        })),
      };
    }
    return {
      metas: [
        { imdb_id: 'tt0010001', name: 'Silent Era Film', type: kind, year: '1920' }, // < 1935: fuera
        { imdb_id: 'tt0026029', name: 'The 39 Steps', type: kind, year: '1935' },
        { imdb_id: 'tt9999099', name: 'Future Sci-Fi', type: kind, year: '2099' },
      ],
    };
  };

  const discovered = await discoverCatalogItems(fetchJSON, {
    seen: createSeenStore(),
    count: 10,
    movieCount: 8,
    seriesCount: 2,
    now: Date.parse('2026-10-01T00:00:00Z'),
  });

  assert.equal(discovered.length, 10);
  assert.equal(discovered.some(d => d.imdbId === 'tt0010001'), false, 'descarta años anteriores a 1935');
  assert.ok(discovered.some(d => d.year === 1935), 'incluye títulos de 1935');
  assert.ok(discovered.some(d => d.year === 2099), 'admite años hasta 2099');
  const movieYears = new Set(discovered.filter(d => d.type === 'movie').map(d => d.year));
  assert.ok(movieYears.size >= 4, 'reparte las películas entre varios años/décadas en vez de un único año');
});

