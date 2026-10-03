import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { groupWarnings, picksToRows, reportToMarkdown, toCSV, toMagnetList } from '../public/lib/format.js';
import { renderSummary } from '../src/summary.mjs';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const ITEMS = [
  {
    id: 'tt0111161', imdbId: 'tt0111161', type: 'movie', season: null, episode: null, label: 'Cadena perpetua (1994)',
    picks: [
      { pick: 'es', quality: '1080p', seeders: 9, sizeLabel: '5.0 GB', title: 'Cadena Perpetua [MicroHD], "remaster"', infoHash: H1, magnetUrl: `magnet:?xt=urn:btih:${H1}`, providers: ['peerflix'], release: { source: 'BluRay', codec: null, hdr: [], audio: ['AC3'], channels: '5.1' } },
      { pick: 'en', quality: '4K', seeders: 100, sizeLabel: '6.9 GB', title: '=HYPERLINK("x") 2160p', infoHash: H2, magnetUrl: `magnet:?xt=urn:btih:${H2}`, providers: ['torrentio', 'ytztvio'] },
    ],
  },
  { id: 'tt0944947:1:1', imdbId: 'tt0944947', type: 'series', season: 1, episode: 1, label: 'Juego de Tronos | S01E01', picks: [] },
];

test('CSV: una fila por pick, comillas correctas y sin fórmulas de Excel', () => {
  const rows = picksToRows(ITEMS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].idioma, 'Español');
  assert.equal(rows[0].ficha, 'BluRay · AC3 5.1');
  const csv = toCSV(rows);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('imdb_id,tipo,temporada'));
  assert.match(lines[1], /"Cadena Perpetua \[MicroHD\], ""remaster"""/);
  assert.match(lines[2], /"'=HYPERLINK\(""x""\) 2160p"/);
  assert.equal(toCSV([]), '');
});

test('lista de magnets con comentarios', () => {
  const text = toMagnetList(ITEMS);
  assert.match(text, /^# Cadena perpetua \(1994\) — 🇪🇸 1080p · 👤 9 · 5\.0 GB\nmagnet:\?xt=urn:btih:1{40}\n/);
  assert.equal(text.split('\n').filter(l => l.startsWith('magnet:')).length, 2);
});

const REPORT = {
  generatedAt: '2026-09-30T10:00:00.000Z', finishedAt: '2026-09-30T10:01:00.000Z', durationMs: 60000,
  movies: 1, episodes: 1, totalStreams: 2, totalCandidates: 150, picks: { es: 1, en: 1 },
  items: ITEMS, warnings: ['tt0253474: la etiqueta no cuadra'],
  errors: [
    { id: 'tt0944947:1:1', provider: 'ytztvio', error: 'HTTP 403' },
    { id: 'tt0944947:1:2', provider: 'ytztvio', error: 'HTTP 403' },
    { id: 'tt0944947:1:3', provider: 'ytztvio', error: 'omitido', skipped: true },
  ],
  perProviderStats: { peerflix: { ok: 2, errors: 0, skipped: 0, streams: 40, avgMs: 321 } },
  db: { inserted: 2, rejected: 0, failures: [], dryRun: false, mode: 'insert+update' },
};

test('reportToMarkdown: tabla por título, avisos y errores agrupados', () => {
  const md = reportToMarkdown(REPORT, { runUrl: 'https://run', pagesUrl: 'https://pages' });
  assert.match(md, /\*\*2 títulos\*\* \(1 películas · 1 episodios\) · \*\*2 elegidos\*\* \(🇪🇸 1 · 🇬🇧 1\) de 150 candidatos · 60\.0 s/);
  assert.match(md, /\| ✅ \| Cadena perpetua \(1994\) `tt0111161` \| 1080p · 👤 9 · 5\.0 GB \| 4K · 👤 100 · 6\.9 GB \|/);
  assert.match(md, /\| ⚠️ \| Juego de Tronos \\\| S01E01/);
  assert.match(md, /ytztvio: HTTP 403 \(×2\)/);
  assert.match(md, /1 consulta\(s\) omitidas/);
  assert.match(md, /insert \+ update/);
  assert.match(md, /\[Abrir el dashboard\]\(https:\/\/pages\) · \[Ver la ejecución\]\(https:\/\/run\)/);
  const short = reportToMarkdown(REPORT, { maxRows: 1 });
  assert.match(short, /… y 1 títulos más/);
});

test('reportToMarkdown: historial de progreso de series (dónde quedó cada una)', () => {
  const withProgress = {
    ...REPORT,
    watchlist: { autoUpdated: true, addedCount: 2, removedCount: 3, resumedCount: 1, totalSeen: 40 },
    progress: {
      version: 1,
      series: {
        tt7777777: { name: 'Serie Larga', status: 'in-progress', done: 4, total: 6, lastSeason: 2, lastEpisode: 1, nextSeason: 2, nextEpisode: 2 },
        tt8888888: { name: 'Serie Corta', status: 'complete', done: 3, total: 3, lastSeason: 1, lastEpisode: 3, nextSeason: null, nextEpisode: null },
      },
    },
  };
  const md = reportToMarkdown(withProgress);
  assert.match(md, /1 serie\(s\) en progreso continúan/);
  assert.match(md, /### 📺 Progreso de series/);
  assert.match(md, /⏳ \*\*Serie Larga\*\*: 4\/6 episodios · último S02E01 · sigue en \*\*S02E02\*\*/);
  assert.match(md, /✅ \*\*Serie Corta\*\*: completa \(3 episodios\)/);
  // Sin historial no aparece la sección.
  assert.doesNotMatch(reportToMarkdown(REPORT), /Progreso de series/);
});

test('renderSummary no reutiliza un report.json viejo si esta ejecución falló', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'summary-'));
  const reportPath = join(dir, 'report.json');
  await writeFile(reportPath, JSON.stringify(REPORT));
  assert.match(await renderSummary({ reportPath, startedAt: '2026-09-30T09:59:00Z' }), /2 elegidos/);
  assert.match(await renderSummary({ reportPath, startedAt: '2026-10-01T00:00:00Z', runUrl: 'https://run' }), /no generó un report\.json nuevo[\s\S]*https:\/\/run/);
  assert.match(await renderSummary({ reportPath: join(dir, 'nope.json') }), /no generó/);
});

test('los avisos que solo cambian de ID se agrupan y la tabla de addons muestra los picks', () => {
  const warnings = [
    'OMDb (tt0055892): HTTP 401', 'OMDb (tt0056592): HTTP 401', 'OMDb (tt0123179): HTTP 401',
    'Catálogo Cinemeta (/catalog/movie/top.json): timeout (10s)',
  ];
  assert.deepEqual(groupWarnings(warnings), [
    { text: 'OMDb (tt…): HTTP 401', count: 3 },
    { text: 'Catálogo Cinemeta (/catalog/movie/top.json): timeout (10s)', count: 1 },
  ]);
  const md = reportToMarkdown({
    items: [], warnings,
    perProviderStats: { torrentsdb: { ok: 90, errors: 4, rateLimited: 3, skipped: 0, streams: 900, picks: 40, uniquePicks: 5, avgMs: 210 } },
  });
  assert.match(md, /OMDb \(tt…\): HTTP 401 \(×3\)/);
  assert.match(md, /\| torrentsdb \| 90 \| 4 \(3× 429\) \| 0 \| 900 \| 40 \(5\) \| 210 ms \|/);
});
