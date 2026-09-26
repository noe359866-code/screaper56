import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DonTorrentCrawler, dontorrentDownloadUrl, DONTORRENT_DEFAULT_MIRRORS } from '../src/crawlers/dontorrent.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { loadConfig } from '../src/config/env.ts';
import { mockHttp, torrent, MAGNET, HASH } from './helpers.js';

const fixture = name => readFileSync(new URL(`fixtures/${name}.html`, import.meta.url), 'utf8');
const base = 'https://dontorrent.moi';
const movie = `${base}/pelicula/31014/Poli-malo`;
const series = `${base}/serie/130189/130189/Like-a-Dragon-Yakuza-1-Temporada-4K`;

test('DonTorrent: catalogue rows give detail URLs, quality and category; noise is ignored', () => {
  const crawler = new DonTorrentCrawler();
  const items = crawler.parseListing(fixture('dontorrent-list'), `${base}/peliculas`);

  assert.deepEqual(items.map(item => item.url), [movie, series]);
  assert.deepEqual(items.map(item => item.type), ['movie', 'series']);
  assert.equal(items[0].quality, 'BluRay-1080p');
  assert.equal(items[0].category, 'Películas');
  assert.equal(items[1].quality, '4K');
  assert.ok(!items.some(item => item.url.includes('ads.example')));
});

test('DonTorrent: pagination follows the real ?p=N link on the same route only', () => {
  const crawler = new DonTorrentCrawler();
  const list = fixture('dontorrent-list');

  assert.equal(crawler.nextPage(list, `${base}/peliculas`), `${base}/peliculas?p=2`);
  // The "/series?p=2" link belongs to another route, and page 3 is not linked.
  assert.equal(crawler.nextPage(list, `${base}/peliculas?p=2`), null);
  assert.equal(crawler.nextPage('<a rel="next" href="https://ads.example/?p=2">Siguiente</a>', `${base}/peliculas`), null);
});

test('DonTorrent: only magnets, site/CDN .torrent files and same-site handlers are accepted', () => {
  const accepted = [
    [MAGNET, MAGNET],
    ['/descargar/31014', `${base}/descargar/31014`],
    ['/torrents/poli-malo.torrent', `${base}/torrents/poli-malo.torrent`],
    ['https://doncdn.com/torrents/poli-malo.torrent', 'https://doncdn.com/torrents/poli-malo.torrent'],
    ['https://dontorrent.wtf/files/poli-malo.torrent', 'https://dontorrent.wtf/files/poli-malo.torrent']
  ];
  for (const [input, expected] of accepted) {
    assert.equal(dontorrentDownloadUrl(input, movie), expected, input);
  }

  const rejected = [
    'javascript:validatePow()',
    'https://ads.example/poli-malo.torrent',
    'https://t.me/s/DonTorrent',
    'https://acortame.example/abc',
    '/aviso-legal',
    '#',
    ''
  ];
  for (const input of rejected) {
    assert.equal(dontorrentDownloadUrl(input, movie), null, input);
  }
});

test('DonTorrent: a proof-of-work page yields no fabricated link and is reported as gated', () => {
  const crawler = new DonTorrentCrawler();
  const detail = crawler.parseDetail(fixture('dontorrent-detail'), movie);

  assert.equal(detail.title, 'Poli malo');
  assert.equal(detail.format, 'BluRay-1080p');
  assert.equal(detail.year, 2025);
  assert.equal(detail.sizeBytes, Math.round(2.1 * 1024 ** 3));
  assert.deepEqual(detail.downloads, []);
  assert.equal(detail.gated, true);
});

test('DonTorrent: episode rows keep 1x02 labels and inline literals are read, never evaluated', () => {
  const crawler = new DonTorrentCrawler();
  const detail = crawler.parseDetail(`<h2>Like a Dragon Yakuza - 1ª Temporada [4K]</h2>
    <p><b>Formato:</b> 4K</p><p><b>Episodios:</b> 6</p>
    <table><tr><td>1x02</td><td><button data-url="/files/lad-1x02.torrent">Descargar</button></td></tr>
    <tr><td>1x03</td><td><button onclick="location.href=atob('L2ZpbGVzL2xhZC0xeDAzLnRvcnJlbnQ=')">Descargar</button></td></tr></table>
    <a href="https://ads.example/descargar.torrent">Publicidad</a>`, series);

  assert.equal(detail.type, 'series');
  assert.equal(detail.episodes, 6);
  assert.equal(detail.downloads.length, 2);
  assert.deepEqual(detail.downloads.map(d => [d.season, d.episode]), [[1, 2], [1, 3]]);
  assert.match(detail.downloads[0].title, /1x02/);
  assert.equal(detail.downloads[1].url, `${base}/files/lad-1x03.torrent`);
  assert.equal(detail.gated, false);
});

test('DonTorrent: full crawl resolves a mirror, sends Referer and never invents swarm counts', async () => {
  clearMirrorCache('dontorrent');
  const crawler = new DonTorrentCrawler();
  const file = torrent('Like a Dragon Yakuza S01E02 4K Castellano');
  const referers = [];

  const calls = mockHttp(crawler, (url, options) => {
    if (url.includes('/pelicula/')) {
      referers.push(options?.headers?.Referer);
      return `<h1>Descargar Poli malo Torrent</h1><p><b>Formato:</b> BluRay-1080p</p>
        <a href="${MAGNET}">Descargar</a><a href="https://ads.example/x.torrent">Anuncio</a>`;
    }
    if (url.includes('/serie/')) {
      referers.push(options?.headers?.Referer);
      return `<h2>Like a Dragon Yakuza - 1ª Temporada</h2><p><b>Formato:</b> 4K</p>
        <table><tr><td>1x02</td><td><a href="https://doncdn.com/torrents/lad-1x02.torrent">Descargar</a></td></tr></table>`;
    }
    if (url.endsWith('/dominios')) return '<html><body>Dominios oficiales</body></html>';
    return fixture('dontorrent-list');
  }, () => file.buffer);

  const records = await crawler.crawl(1);

  assert.equal(crawler.baseUrl, base);
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.seeders === null && record.leechers === null));
  assert.ok(referers.every(referer => typeof referer === 'string' && referer.startsWith('https://dontorrent.')));

  const film = records.find(record => record.info_hash === HASH);
  assert.equal(film.type, 'movie');
  assert.equal(film.quality, 'BluRay-1080p');
  assert.equal(film.source_url, movie);

  const episode = records.find(record => record.info_hash === file.hash);
  assert.equal(episode.type, 'series');
  assert.equal(episode.season, 1);
  assert.equal(episode.episode, 2);
  assert.equal(episode.torrent_file_url, 'https://doncdn.com/torrents/lad-1x02.torrent');
  assert.equal(crawler.filterSpanishReleases(records).accepted.length, 2);

  // Each detail page is visited once even though the catalogue links it twice.
  assert.equal(calls.filter(url => url.includes('/pelicula/')).length, 1);
  assert.equal(await crawler.crawl(0).then(result => result.length), 0);
});

test('DonTorrent: gated-only catalogue fails loudly instead of returning nothing', async () => {
  clearMirrorCache('dontorrent');
  const crawler = new DonTorrentCrawler();
  mockHttp(crawler, url => (url.includes('/pelicula/') || url.includes('/serie/'))
    ? fixture('dontorrent-detail')
    : fixture('dontorrent-list'));

  await assert.rejects(crawler.crawl(1), /proof-of-work/);
});

test('DonTorrent: an unreachable domain pool is an explicit error, not silent success', async () => {
  clearMirrorCache('dontorrent');
  const crawler = new DonTorrentCrawler();
  mockHttp(crawler, () => '<html><body>This domain is for sale</body></html>');

  await assert.rejects(crawler.crawl(1), /No compatible mirror/);
  assert.ok(DONTORRENT_DEFAULT_MIRRORS.length >= 10);
  assert.equal(DONTORRENT_DEFAULT_MIRRORS[0], base);
});

test('DonTorrent: registered as a selectable target alongside the existing sources', () => {
  const previous = { dry: process.env.DRY_RUN, targets: process.env.TARGET_CRAWLERS };
  try {
    process.env.DRY_RUN = 'true';
    process.env.TARGET_CRAWLERS = 'all';
    assert.ok(loadConfig(true).targetCrawlers.includes('dontorrent'));
    process.env.TARGET_CRAWLERS = 'dontorrent';
    assert.deepEqual(loadConfig(true).targetCrawlers, ['dontorrent']);
  } finally {
    for (const [key, value] of [['DRY_RUN', previous.dry], ['TARGET_CRAWLERS', previous.targets]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
