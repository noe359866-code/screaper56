import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HttpError,
  createJsonFetcher,
  describeError,
  expandWatchlist,
  loadMetadata,
  picksFromPublishedItem,
  processWatchlist,
  runPipeline,
  toOutputStream,
} from '../public/lib/pipeline.js';
import { parseWatchlist } from '../public/lib/parse.js';

const noSleep = async () => {};

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('createJsonFetcher reintenta 503/429 (respetando Retry-After) pero no 403 ni 404', async () => {
  const waits = [];
  let calls = 0;
  const flaky = createJsonFetcher({
    retries: 2,
    sleep: async ms => { waits.push(ms); },
    fetchImpl: async () => (++calls < 3 ? response(calls === 1 ? 503 : 429, '', { 'retry-after': '2' }) : response(200, { ok: 1 })),
  });
  assert.deepEqual(await flaky('https://x/y.json'), { ok: 1 });
  assert.equal(calls, 3);
  assert.equal(waits[1], 2000);

  let forbiddenCalls = 0;
  const forbidden = createJsonFetcher({ sleep: noSleep, fetchImpl: async () => { forbiddenCalls++; return response(403, 'no'); } });
  await assert.rejects(forbidden('https://x'), err => err instanceof HttpError && err.status === 403);
  assert.equal(forbiddenCalls, 1);

  const html = createJsonFetcher({ sleep: noSleep, fetchImpl: async () => response(200, '<html>') });
  await assert.rejects(html('https://x'), err => describeError(err) === 'la respuesta no es JSON');
});

test('createJsonFetcher corta por timeout y no envía cabeceras si no se piden (evita preflight CORS)', async () => {
  let seenInit = null;
  const fetchImpl = (url, init) => {
    seenInit = init;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const slow = createJsonFetcher({ fetchImpl, timeoutMs: 20, retries: 0, sleep: noSleep });
  await assert.rejects(slow('https://x'), err => err.name === 'TimeoutError' && /timeout/.test(describeError(err)));
  assert.equal('headers' in seenInit, false);
});

const PROVIDERS = [
  { slug: 'peerflix', name: 'Peerflix', baseUrl: 'https://peerflix.test' },
  { slug: 'ytztvio', name: 'Ytztvio', baseUrl: 'https://ytz.test' },
];

function hash(n) { return n.toString(16).padStart(40, '0'); }

test('runPipeline: 2 picks por título, estadísticas por addon y corte tras errores seguidos', async () => {
  const queries = [
    { kind: 'movie', imdbId: 'tt0111161', label: 'Cadena perpetua (1994)' },
    ...[1, 2, 3, 4, 5].map(e => ({ kind: 'series', imdbId: 'tt0944947', season: 1, episode: e, label: `GoT S01E0${e}` })),
  ];
  const calls = { peerflix: 0, ytztvio: 0 };
  const streamSource = async (provider, query) => {
    calls[provider.slug]++;
    if (provider.slug === 'ytztvio' && query.kind === 'series') throw new HttpError(403, 'x');
    const n = query.episode ?? 0;
    return {
      url: `${provider.baseUrl}/stream`,
      streams: [
        { infoHash: hash(100 + n), title: `${query.label} [1080p][Castellano]`, quality: '1080p', seeders: 20, sizeBytes: 2e9, trackers: [], languages: ['es'], provider: provider.slug, providerName: provider.name },
        { infoHash: hash(200 + n + (provider.slug === 'ytztvio' ? 50 : 0)), title: `${query.label} 2160p WEB-DL`, quality: '4K', seeders: 80, sizeBytes: 8e9, trackers: [], languages: [], provider: provider.slug, providerName: provider.name },
      ],
    };
  };
  const seen = [];
  const result = await runPipeline(queries, {
    providers: PROVIDERS, streamSource, concurrency: 1, breakerThreshold: 3,
    onItem: (_r, progress) => seen.push(progress.done),
  });
  assert.equal(result.results.length, 6);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  for (const { item, streams } of result.results) {
    assert.equal(streams.length, 2);
    assert.ok(result.results.find(r => r.item === item));
    assert.ok(result.results.find(r => r.item === item).candidates.length >= streams.length);
    assert.deepEqual(streams.map(s => s.pick), ['es', 'en']);
    assert.equal(item.picks.length, 2);
    assert.ok(item.picks[0].magnetUrl.startsWith('magnet:?xt=urn:btih:'));
  }
  // Ytztvio: 3 errores reales en series y el resto se omite sin pedirlo.
  assert.equal(calls.ytztvio, 1 + 3);
  const stats = result.perProvider.ytztvio;
  assert.deepEqual([stats.ok, stats.errors, stats.skipped], [1, 3, 2]);
  assert.equal(result.errors.filter(e => e.skipped).length, 2);
  assert.match(result.errors.find(e => e.skipped).error, /omitido tras 3 errores seguidos \(HTTP 403\)/);
  assert.equal(result.totals.picks.es, 6);
  assert.equal(result.totals.picks.en, 6);
});

test('expandWatchlist: temporadas completas con Cinemeta (sin API key) y avisos útiles', async () => {
  const items = parseWatchlist([
    'tt0944947:s1 Juego de Tronos – Temporada 1',
    'tt0944947:s1:e1 Juego de Tronos S01E01',
    'tt0903747 Breaking Bad',
    'tt0253474 El Padrino. Parte II (1974)',
    'tt9999999:s2 Sin metadatos',
  ].join('\n'));
  const metaById = new Map([
    ['tt0944947', { name: 'Game of Thrones', type: 'series', year: 2011, yearEnd: 2019, videos: [
      { season: 1, episode: 2, title: 'The Kingsroad', released: '2011-04-24' },
      { season: 1, episode: 1, title: 'Winter Is Coming', released: '2011-04-17' },
    ] }],
    ['tt0903747', { name: 'Breaking Bad', type: 'series', year: 2008, yearEnd: 2013, videos: [] }],
    ['tt0253474', { name: 'The Pianist', type: 'movie', year: 2003, yearEnd: 2003, videos: null }],
  ]);
  const warnings = [];
  const queries = await expandWatchlist(items, { metaById, onWarning: w => warnings.push(w) });
  assert.deepEqual(queries.map(q => q.kind === 'movie' ? q.imdbId : `${q.imdbId}:${q.season}:${q.episode}`), [
    'tt0944947:1:1', 'tt0944947:1:2', 'tt0253474',
  ]);
  assert.equal(queries[1].label, 'Juego de Tronos S01E02 – The Kingsroad');
  assert.deepEqual(queries[2].meta, { name: 'The Pianist', year: 2003, yearEnd: 2003, type: 'movie' });
  assert.equal(warnings.length, 3);
  // El ID de serie sin temporada intenta expandirse a serie completa; sin
  // episodios emitidos en Cinemeta, avisa y se omite.
  assert.match(warnings.join('\n'), /No se pudo expandir tt0903747 a serie completa/);
  assert.match(warnings.join('\n'), /The Pianist \(2003\)/);
  assert.match(warnings.join('\n'), /No se pudo expandir tt9999999:s2/);
});

test('expandWatchlist: una serie sin temporada expande TODAS las temporadas y episodios de una vez', async () => {
  const items = parseWatchlist('tt0944947 Juego de Tronos');
  const metaById = new Map([
    ['tt0944947', { name: 'Game of Thrones', type: 'series', year: 2011, yearEnd: 2019, videos: [
      { season: 2, episode: 1, title: 'The North Remembers', released: '2012-04-01' },
      { season: 1, episode: 2, title: 'The Kingsroad', released: '2011-04-24' },
      { season: 1, episode: 1, title: 'Winter Is Coming', released: '2011-04-17' },
      { season: 0, episode: 5, title: 'Especial', released: '2015-02-08' }, // temporada 0: fuera
      { season: 3, episode: 1, title: 'Valar Dohaeris', released: '2099-01-01' }, // sin emitir: fuera
    ] }],
  ]);
  const warnings = [];
  const queries = await expandWatchlist(items, { metaById, onWarning: w => warnings.push(w) });
  assert.deepEqual(queries.map(q => `${q.imdbId}:${q.season}:${q.episode}`), [
    'tt0944947:1:1', 'tt0944947:1:2', 'tt0944947:2:1',
  ]);
  assert.equal(queries[0].label, 'Juego de Tronos S01E01 – Winter Is Coming');
  assert.equal(queries[2].label, 'Juego de Tronos S02E01 – The North Remembers');
  assert.equal(queries[0].kind, 'series');
  // El ID venía escrito como película: avisa de que se expande la serie completa.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /se expande a serie completa \(2 temporadas, 3 episodios\)/);
});

test('expandWatchlist: serie completa + líneas explícitas no duplican episodios', async () => {
  const items = parseWatchlist([
    'tt0944947',
    'tt0944947:s1:e1 Juego de Tronos S01E01',
    'tt0944947:s2 Juego de Tronos – Temporada 2',
  ].join('\n'));
  const metaById = new Map([
    ['tt0944947', { name: 'Game of Thrones', type: 'series', year: 2011, yearEnd: 2019, videos: [
      { season: 1, episode: 1, title: 'Winter Is Coming', released: '2011-04-17' },
      { season: 1, episode: 2, title: 'The Kingsroad', released: '2011-04-24' },
      { season: 2, episode: 1, title: 'The North Remembers', released: '2012-04-01' },
    ] }],
  ]);
  const queries = await expandWatchlist(items, { metaById });
  assert.deepEqual(queries.map(q => `${q.imdbId}:${q.season}:${q.episode}`), [
    'tt0944947:1:1', 'tt0944947:1:2', 'tt0944947:2:1',
  ]);
});

test('expandWatchlist con doneKeys: reanuda la serie donde quedó (sin repetir episodios)', async () => {
  const metaById = new Map([
    ['tt0944947', { name: 'Game of Thrones', type: 'series', year: 2011, yearEnd: 2019, videos: [
      { season: 1, episode: 1, title: 'Winter Is Coming', released: '2011-04-17' },
      { season: 1, episode: 2, title: 'The Kingsroad', released: '2011-04-24' },
      { season: 2, episode: 1, title: 'The North Remembers', released: '2012-04-01' },
    ] }],
  ]);
  const doneKeys = new Set(['tt0944947:s1:e1', 'tt0944947:s1:e2']);
  const warnings = [];
  const queries = await expandWatchlist(parseWatchlist('tt0944947 Juego de Tronos'), {
    metaById, doneKeys, onWarning: w => warnings.push(w),
  });
  assert.deepEqual(queries.map(q => `${q.imdbId}:${q.season}:${q.episode}`), ['tt0944947:2:1']);
  assert.equal(warnings.length, 0, 'reanudar no avisa: es el comportamiento normal');

  // Serie ya completa: nada que consultar, con aviso claro.
  const all = new Set(['tt0944947:s1:e1', 'tt0944947:s1:e2', 'tt0944947:s2:e1']);
  const doneWarnings = [];
  const none = await expandWatchlist(parseWatchlist('tt0944947'), {
    metaById, doneKeys: all, onWarning: w => doneWarnings.push(w),
  });
  assert.equal(none.length, 0);
  assert.match(doneWarnings.join('\n'), /ya tiene todos sus episodios emitidos ingeridos/);

  // Las temporadas `:sN` también reanudan; los episodios escritos a mano, nunca se omiten.
  const mix = await expandWatchlist(parseWatchlist('tt0944947:s2\ntt0944947:s1:e1 Repetir este'), {
    metaById, doneKeys,
  });
  assert.deepEqual(mix.map(q => `${q.imdbId}:${q.season}:${q.episode}`), ['tt0944947:2:1', 'tt0944947:1:1']);
  assert.equal(mix[1].label, 'Repetir este');
});

test('expandWatchlist con maxEpisodeQueries: tope por corrida, repartido entre series', async () => {
  const videosA = [1, 2, 3].map(e => ({ season: 1, episode: e, title: `A${e}`, released: '2020-01-01' }));
  const videosB = [1, 2, 3].map(e => ({ season: 1, episode: e, title: `B${e}`, released: '2021-01-01' }));
  const metaById = new Map([
    ['tt0000001', { name: 'Serie A', type: 'series', year: 2020, videos: videosA }],
    ['tt0000002', { name: 'Serie B', type: 'series', year: 2021, videos: videosB }],
    ['tt0111161', { name: 'Movie', type: 'movie', year: 1994, videos: null }],
  ]);
  const items = parseWatchlist('tt0000001 Serie A\ntt0000002 Serie B\ntt0111161 Movie');
  const queries = await expandWatchlist(items, { metaById, maxEpisodeQueries: 4 });
  // 4 episodios repartidos (una de cada serie por ronda) + la película intacta.
  const episodes = queries.filter(q => q.kind === 'series');
  assert.equal(episodes.length, 4);
  assert.equal(episodes.filter(q => q.imdbId === 'tt0000001').length, 2);
  assert.equal(episodes.filter(q => q.imdbId === 'tt0000002').length, 2);
  assert.equal(queries.filter(q => q.kind === 'movie').length, 1);
  // Sin tope, salen todos.
  const all = await expandWatchlist(items, { metaById });
  assert.equal(all.filter(q => q.kind === 'series').length, 6);

  // Con singleSeries: concentra todas las consultas de episodios en UNA sola serie hasta terminarla.
  const focused = await expandWatchlist(items, { metaById, maxEpisodeQueries: 4, singleSeries: true });
  assert.deepEqual(
    focused.filter(q => q.kind === 'series').map(q => `${q.imdbId}:${q.season}:${q.episode}`),
    ['tt0000001:1:1', 'tt0000001:1:2', 'tt0000001:1:3'],
    'solo avanza en la primera serie sin mezclar la segunda',
  );
  // Con focusSeriesId: fuerza la serie elegida aunque esté en segunda posición.
  const byId = await expandWatchlist(items, { metaById, maxEpisodeQueries: 2, singleSeries: true, focusSeriesId: 'tt0000002' });
  assert.deepEqual(
    byId.filter(q => q.kind === 'series').map(q => `${q.imdbId}:${q.season}:${q.episode}`),
    ['tt0000002:1:1', 'tt0000002:1:2'],
  );
});

test('loadMetadata deja de consultar Cinemeta tras 3 fallos seguidos y sigue sin él', async () => {
  let calls = 0;
  const fetchJSON = async () => { calls++; throw new TypeError('fetch failed'); };
  const items = ['tt0000001', 'tt0000002', 'tt0000003', 'tt0000004', 'tt0000005'].map(imdbId => ({ imdbId, type: 'movie' }));
  const warnings = [];
  const { metaById, stats } = await loadMetadata(items, { fetchJSON, concurrency: 1, onWarning: w => warnings.push(w) });
  assert.equal(metaById.size, 0);
  assert.equal(stats.disabled, true);
  assert.equal(calls, 3);
  assert.equal(warnings.length, 1);
});

test('processWatchlist: de texto a picks en un paso (lo que usa la web sin token)', async () => {
  const fetchJSON = async url => {
    if (url.includes('cinemeta')) {
      if (url.includes('/meta/series/tt0944947')) {
        return { meta: { type: 'series', name: 'Game of Thrones', year: '2011–2019', videos: [
          { season: 1, episode: 1, name: 'Winter Is Coming', released: '2011-04-17' },
        ] } };
      }
      return { meta: {} };
    }
    const n = url.includes('series') ? 1 : 2;
    return { streams: [
      { name: 'Peerflix', description: 'X [1080p][Castellano]\n👤 5', infoHash: hash(n), language: 'es', seed: 5 },
      { name: 'Torrentio\n4k', title: 'X 2160p WEB-DL\n👤 50 💾 8 GB ⚙️ YTS', infoHash: hash(10 + n) },
    ] };
  };
  const result = await processWatchlist('tt0944947:s1 Juego de Tronos\ntt0111161 Cadena perpetua\nbasura', {
    providers: [{ slug: 'peerflix', name: 'Peerflix', baseUrl: 'https://p.test' }],
    fetchJSON,
    cinemetaUrl: 'https://cinemeta.test',
  });
  assert.equal(result.queries.length, 2);
  assert.equal(result.results[0].item.label, 'Juego de Tronos S01E01 – Winter Is Coming');
  assert.equal(result.results[0].streams.length, 2);
  assert.equal(result.metaStats.found, 1);
  assert.match(result.warnings[0], /Línea ignorada/);
});

test('toOutputStream añade behaviorHints (bingeGroup por idioma) y la ficha del release', () => {
  const out = toOutputStream({
    pick: 'en', score: 8, infoHash: hash(7), title: 'Movie.2019.2160p.WEB-DL.DDP5.1.HDR.x265', quality: '4K', seeders: 10,
    sizeBytes: 8 * 1024 ** 3, trackers: [], languages: [], providers: ['torrentio'], providerNames: ['Torrentio'],
    filename: 'Movie.2019.2160p.mkv', fileIdx: 0,
  });
  assert.deepEqual(out.behaviorHints, { bingeGroup: 'peerflix-static-en', filename: 'Movie.2019.2160p.mkv' });
  assert.equal(out.release.codec, 'HEVC');
  assert.match(out.description, /🎞️ WEB-DL · HEVC · HDR · DD\+ 5\.1/);
  assert.equal(out.sizeLabel, '8.0 GB');
});

test('picksFromPublishedItem convierte datos del formato antiguo (todos los streams) en 2 picks', () => {
  const item = { id: 'tt0111161', imdbId: 'tt0111161', type: 'movie', label: 'Cadena perpetua (1994)' };
  const data = { streams: [
    { infoHash: hash(1).toUpperCase(), title: 'Cadena Perpetua [MicroHD][1080 px][AC3 5.1-Castellano-Ingles+Subs]', quality: '1080p', seeders: 9, audioLangs: ['es', 'en'], providers: ['peerflix'], trackers: [] },
    { infoHash: hash(2), title: 'The Shawshank Redemption (1994) RM4K (1080p BluRay x265 HEVC 10bit AAC 5.1 afm72) [QxR]', quality: '4K', seeders: 118, audioLangs: [], providers: ['torrentio'] },
    { infoHash: hash(3), title: 'The Shawshank Redemption (1994) 2160p BRRip 5.1 10Bit x265 -YTS', quality: '4K', seeders: 100, audioLangs: [], providers: ['torrentio'] },
    { infoHash: 'bad', title: 'x' },
  ] };
  const upgraded = picksFromPublishedItem(item, data);
  assert.equal(upgraded.picks.length, 2);
  assert.equal(upgraded.picks[0].infoHash, hash(1));
  // "RM4K (1080p …)" se recalcula como 1080p: gana el 2160p real.
  assert.equal(upgraded.picks[1].infoHash, hash(3));
  assert.equal(upgraded.candidateCount, 3);
});
