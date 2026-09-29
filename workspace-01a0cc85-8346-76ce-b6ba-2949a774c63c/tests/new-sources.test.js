import test from 'node:test';
import assert from 'node:assert/strict';
import { RarbgCrawler } from '../src/crawlers/rarbg.ts';
import { MagnetDlCrawler } from '../src/crawlers/magnetdl.ts';
import { TokyoToshoCrawler } from '../src/crawlers/tokyotosho.ts';
import { T0rrentaCrawler } from '../src/crawlers/t0rrenta.ts';
import { EstrenosTorrentCrawler } from '../src/crawlers/estrenostorrent.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { BlockedPageError, rethrowIfBlockedOrRateLimited } from '../src/crawlers/base.ts';
import { mockHttp, HASH2, torrent } from './helpers.js';

const HASH = '5ac30f52edc636a18b3e28140dc90f7880fa9a1d';
const MAGNET = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&amp;dn=Carmen.and.Lola.2018.SPANISH.1080p&amp;tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`;

test('New sources are registered', () => {
  for (const key of ['rarbg', 'magnetdl', 'tokyotosho', 't0rrenta', 'estrenostorrent']) {
    assert.equal(typeof CRAWLER_REGISTRY[key], 'function');
  }
});

test('Blocking and HTTP 429 failures remain fatal across crawler-level catches', () => {
  const blocked = new BlockedPageError('https://t0rrenta.test/detail');
  assert.throws(() => rethrowIfBlockedOrRateLimited(blocked), error => error === blocked);
  const limited = Object.assign(new Error('too many requests'), { response: { status: 429 } });
  assert.throws(() => rethrowIfBlockedOrRateLimited(limited), error => error === limited);
  assert.doesNotThrow(() => rethrowIfBlockedOrRateLimited(Object.assign(new Error('not found'), { response: { status: 404 } })));
});

test('RARBG: listing skips XXX, detail yields magnet, language and peers', () => {
  const base = 'https://www.rarbgproxy.to';
  const listing = `<table class="lista2t">
    <tr class="lista2"><td><img></td><td><a href="/rarbgproxy_torrent/carmen-6719140.html" title="x torrent">Carmen.and.Lola.2018.SPANISH.1080p.BluRay.x264-HANDJOB</a></td>
      <td><a href="/movies/">Movies</a> <a>/HD</a></td><td>2026-09-12</td><td>8.2 GB</td><td>5</td><td>4</td><td>up</td></tr>
    <tr class="lista2"><td><img></td><td><a href="/rarbgproxy_torrent/muchasexo-1.html">Some SPANISH 1080p</a></td>
      <td><a href="/xxx/">XXX</a> /Video</td><td>2026</td><td>1.9 GB</td><td>9</td><td>44</td><td>u</td></tr></table>`;
  const crawler = new RarbgCrawler();
  const rows = crawler.parseListing(listing, `${base}/search/?search=spanish`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detailUrl, `${base}/rarbgproxy_torrent/carmen-6719140.html`);
  assert.equal(rows[0].seeders, 5);
  assert.equal(crawler.listingUrl(base, 'search:spanish', 2), `${base}/search/2/?search=spanish`);

  const detail = `<h1>Carmen.and.Lola.2018.SPANISH.1080p.BluRay.x264-HANDJOB</h1><table>
    <tr><td>Torrent:</td><td><a href="${MAGNET}"><img></a></td></tr>
    <tr><td>Category:</td><td>Movies /HD</td></tr><tr><td>Size:</td><td>8.2 GB</td></tr>
    <tr><td>Language:</td><td>Spanish</td></tr><tr><td>Peers:</td><td>Seeders : 5 , Leechers : 4</td></tr></table>`;
  const record = crawler.parseDetail(detail, rows[0]);
  assert.equal(record.info_hash, HASH);
  assert.equal(record.type, 'movie');
  assert.ok(record.audio.includes('Spanish'));
  assert.equal(record.leechers, 4);
  assert.ok(record.size_bytes > 8e9);

  const noMagnet = crawler.parseDetail(`<h1>Sample</h1>
    <a href="magnet:?xt=urn:btih:invalid">Bad magnet</a>
    <a href="magnet:?xt=urn:btih:${HASH2}">Good magnet</a>`, rows[0]);
  assert.equal(noMagnet.info_hash, HASH2, 'skip a malformed magnet and use the next valid one');

  const hashOnly = crawler.parseDetail(`<h1>Sample Castellano</h1><table>
    <tr><td>Info Hash:</td><td>${HASH2}</td></tr><tr><td>Category:</td><td>Movies</td></tr></table>`, rows[0]);
  assert.equal(hashOnly.info_hash, HASH2);
  assert.equal(hashOnly.source_tracker, null);
  assert.doesNotMatch(hashOnly.magnet_url, /[?&]tr=/, 'do not invent tracker metadata for hash-only details');
});

test('MagnetDL: listing rows, search path and /single/ magnet', () => {
  const base = 'https://magnetdl.co';
  const listing = `<table class="download"><tbody>
    <tr><td class="m"><a href="https://magnetdl.app/single/274364"><img></a></td><td class="n"><a href="/single/274364" title="Widows 2018 1080p Castellano">Widows 2018 1080p Castellano</a></td>
      <td>6 Years+</td><td class="t2">movies</td><td>3.36 GB</td><td class="s">4</td><td class="l">1</td></tr>
    <tr><td></td><td><a href="/single/9">Some Game</a></td><td>1</td><td>games</td><td>3 GB</td><td>1</td><td>1</td></tr></tbody></table>`;
  const crawler = new MagnetDlCrawler();
  const rows = crawler.parseListing(listing, `${base}/download/movies/`, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detailUrl, `${base}/single/274364`);
  assert.equal(rows[0].seeders, 4);
  assert.equal(rows[0].leechers, 1);
  assert.equal(MagnetDlCrawler.searchPath('Español Latino'), '/e/espanol-latino/');
  const detail = crawler.parseDetail(`<h1>Widows</h1><a href="${MAGNET}">Magnet</a>`, rows[0].title);
  assert.ok(detail.magnet.toLowerCase().includes(HASH));
});

test('t0rrenta: sitemap/listing details resolve real metainfo and TMDB metadata', async () => {
  const previousBase = process.env.T0RRENTA_BASE_URL;
  const base = 'https://t0rrenta.test';
  process.env.T0RRENTA_BASE_URL = base;
  clearMirrorCache('t0rrenta');
  const metainfo = torrent('Sample 1080p');
  try {
    const crawler = new T0rrentaCrawler();
    const listing = `<img src="/static/t0rrenta-logo2-white.png">
      <a href="/p/939243"><img alt="Sample Castellano"></a>`;
    const detail = `<h1>Sample Castellano</h1>
      <a href="https://www.themoviedb.org/movie/939243">TMDB</a>
      <a href="https://ads.example/ad.torrent">Ad</a>
      <a href="/download/939243/Sample-Castellano-1080p.torrent?e=123&amp;s=signed">torrent 1.5 GiB</a>`;
    const calls = mockHttp(crawler, url => {
      if (url === `${base}/` || url === `${base}/sitemap.xml`) return listing;
      if (url === `${base}/p/939243`) return detail;
      if (url.includes('.torrent')) return metainfo.buffer;
      throw new Error(`Unexpected URL: ${url}`);
    });

    const [record] = await crawler.crawl(1);
    assert.equal(record.info_hash, metainfo.hash);
    assert.equal(record.tmdb_id, 939243);
    assert.equal(record.type, 'movie');
    assert.equal(record.torrent_file_url, `${base}/download/939243/Sample-Castellano-1080p.torrent?e=123&s=signed`);
    assert.ok(record.audio.includes('Spanish'));
    assert.ok(calls.includes(`${base}/sitemap.xml`));
  } finally {
    if (previousBase === undefined) delete process.env.T0RRENTA_BASE_URL;
    else process.env.T0RRENTA_BASE_URL = previousBase;
    clearMirrorCache('t0rrenta');
  }
});

test('T0rrenta: HTTP 429 on metainfo aborts the run instead of becoming a skipped download', async () => {
  const previousBase = process.env.T0RRENTA_BASE_URL;
  const base = 'https://t0rrenta-rate.test';
  process.env.T0RRENTA_BASE_URL = base;
  clearMirrorCache('t0rrenta');
  const rateLimit = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
  try {
    const crawler = new T0rrentaCrawler();
    const listing = '<img src="/static/t0rrenta-logo2-white.png"><a href="/p/939243">Sample</a>';
    mockHttp(crawler, url => {
      if (url === `${base}/` || url === `${base}/sitemap.xml`) return listing;
      if (url === `${base}/p/939243`) return '<h1>Sample</h1><a href="/download/939243/Sample.torrent">Torrent</a>';
      if (url.endsWith('.torrent')) throw rateLimit;
      throw new Error(`Unexpected URL: ${url}`);
    });
    await assert.rejects(crawler.crawl(1), error => error === rateLimit);
  } finally {
    if (previousBase === undefined) delete process.env.T0RRENTA_BASE_URL;
    else process.env.T0RRENTA_BASE_URL = previousBase;
    clearMirrorCache('t0rrenta');
  }
});

test('EstrenosTorrent: movie/series detail links produce records from same-site .torrent files', async () => {
  const previousBase = process.env.ESTRENOSTORRENT_BASE_URL;
  const base = 'https://estrenostorrent.test';
  process.env.ESTRENOSTORRENT_BASE_URL = base;
  clearMirrorCache('estrenostorrent');
  const metainfo = torrent('Icefall HDTV 720p');
  try {
    const crawler = new EstrenosTorrentCrawler();
    const listing = `<a href="/online/icefall"><img alt="Icefall"><strong>Icefall</strong></a>`;
    const detail = `<h1>Icefall</h1><div>Tipo Película</div>
      <a href="https://ads.example/ad.torrent">Ad</a>
      <a href="/assets/u/t/temp/123/icefallhdtv-720p.torrent?md5=fixture&amp;expires=999">Descargar torrent</a>`;
    const calls = mockHttp(crawler, url => {
      if (url === `${base}/peliculas/`) return listing;
      if (url === `${base}/` || url === `${base}/series/`) return '<h1>Catálogo</h1>';
      if (url === `${base}/online/icefall`) return detail;
      if (url.includes('.torrent')) return metainfo.buffer;
      throw new Error(`Unexpected URL: ${url}`);
    });

    const [record] = await crawler.crawl(1);
    assert.equal(record.info_hash, metainfo.hash);
    assert.equal(record.title, 'Icefall HDTV 720p');
    assert.equal(record.type, 'movie');
    assert.equal(record.source_url, `${base}/online/icefall`);
    assert.ok(record.audio.includes('Spanish'));
    assert.ok(calls.some(url => url.includes('/assets/u/t/temp/123/icefallhdtv-720p.torrent')));

    const seriesRows = crawler.parseListing(
      '<a href="/series/4k-2160p/house-of-dragon"><img alt="House of Dragon"></a>',
      `${base}/series/`,
      'series'
    );
    assert.equal(seriesRows[0].detailUrl, `${base}/series/4k-2160p/house-of-dragon`);
    assert.equal(seriesRows[0].type, 'series');
    assert.equal(crawler.parseDetail('<h1>House of Dragon</h1><p>Tipo Serie</p>', seriesRows[0].detailUrl).type, 'series');
  } finally {
    if (previousBase === undefined) delete process.env.ESTRENOSTORRENT_BASE_URL;
    else process.env.ESTRENOSTORRENT_BASE_URL = previousBase;
    clearMirrorCache('estrenostorrent');
  }
});

test('EstrenosTorrent: a long single-page catalogue is processed in full, batch by batch', async () => {
  const previousBase = process.env.ESTRENOSTORRENT_BASE_URL;
  const base = 'https://estrenostorrent.test';
  process.env.ESTRENOSTORRENT_BASE_URL = base;
  clearMirrorCache('estrenostorrent');
  // Mirrors the real site: /peliculas/ is one long response (~100 items) with
  // no pager, so maxPages cannot bound the work and nothing may be truncated.
  const TOTAL = 75;
  const metainfos = new Map(Array.from({ length: TOTAL }, (_, i) => {
    const n = i + 1;
    return [n, torrent(`Pelicula ${n} Castellano 1080p`)];
  }));
  try {
    const crawler = new EstrenosTorrentCrawler();
    const listing = Array.from({ length: TOTAL }, (_, i) => {
      const n = i + 1;
      return `<a href="/online/pelicula-${n}"><img alt="Pelicula ${n}"><strong>Pelicula ${n}</strong></a>`;
    }).join('');
    const calls = mockHttp(crawler, url => {
      if (url === `${base}/peliculas/`) return `<div id="catalogo">${listing}</div>`;
      if (url === `${base}/` || url === `${base}/series/`) return '<h1>Catálogo</h1>';
      const detail = url.match(/\/online\/pelicula-(\d+)$/);
      if (detail) {
        const n = Number(detail[1]);
        return `<h1>Pelicula ${n}</h1><div>Tipo Película</div>` +
          `<a href="/assets/u/t/temp/${n}/${n}.torrent?token=fixture">Descargar torrent</a>`;
      }
      const file = url.match(/\/assets\/u\/t\/temp\/(\d+)\/\1\.torrent/);
      if (file) return metainfos.get(Number(file[1])).buffer;
      throw new Error(`Unexpected URL: ${url}`);
    });

    const records = await crawler.crawl(1);
    assert.equal(records.length, TOTAL, 'every item of the long listing must produce a record');
    assert.equal(new Set(records.map(r => r.title)).size, TOTAL, 'each record keeps its own release');
    const detailsFetched = calls.filter(url => url.includes('/online/pelicula-')).length;
    assert.equal(detailsFetched, TOTAL, 'all 75 detail pages were visited, not just the first maxPages*30');
  } finally {
    if (previousBase === undefined) delete process.env.ESTRENOSTORRENT_BASE_URL;
    else process.env.ESTRENOSTORRENT_BASE_URL = previousBase;
    clearMirrorCache('estrenostorrent');
  }
});

test('EstrenosTorrent: ESTRENOSTORRENT_MAX_DETAILS caps the batches; an invalid value means no cap', async () => {
  const previousBase = process.env.ESTRENOSTORRENT_BASE_URL;
  const previousCap = process.env.ESTRENOSTORRENT_MAX_DETAILS;
  const base = 'https://estrenostorrent.test';
  process.env.ESTRENOSTORRENT_BASE_URL = base;
  const TOTAL = 45;
  const listing = Array.from({ length: TOTAL }, (_, i) => {
    const n = i + 1;
    return `<a href="/online/pelicula-${n}"><img alt="Pelicula ${n}"><strong>Pelicula ${n}</strong></a>`;
  }).join('');
  const metainfos = new Map(Array.from({ length: TOTAL }, (_, i) => {
    const n = i + 1;
    return [n, torrent(`Pelicula ${n} Castellano 1080p`)];
  }));
  try {
    const buildCrawler = () => {
      const crawler = new EstrenosTorrentCrawler();
      mockHttp(crawler, url => {
        if (url === `${base}/peliculas/`) return `<div id="catalogo">${listing}</div>`;
        if (url === `${base}/` || url === `${base}/series/`) return '<h1>Catálogo</h1>';
        const detail = url.match(/\/online\/pelicula-(\d+)$/);
        if (detail) {
          const n = Number(detail[1]);
          return `<h1>Pelicula ${n}</h1><div>Tipo Película</div>` +
            `<a href="/assets/u/t/temp/${n}/${n}.torrent?token=fixture">Descargar torrent</a>`;
        }
        const file = url.match(/\/assets\/u\/t\/temp\/(\d+)\/\1\.torrent/);
        if (file) return metainfos.get(Number(file[1])).buffer;
        throw new Error(`Unexpected URL: ${url}`);
      });
      return crawler;
    };

    process.env.ESTRENOSTORRENT_MAX_DETAILS = '10';
    clearMirrorCache('estrenostorrent');
    const capped = await buildCrawler().crawl(1);
    assert.equal(capped.length, 10, 'the cap limits how many detail pages are processed');

    process.env.ESTRENOSTORRENT_MAX_DETAILS = 'not-a-number';
    clearMirrorCache('estrenostorrent');
    const uncapped = await buildCrawler().crawl(1);
    assert.equal(uncapped.length, TOTAL, 'an invalid cap means every discovered page is processed');
  } finally {
    if (previousBase === undefined) delete process.env.ESTRENOSTORRENT_BASE_URL;
    else process.env.ESTRENOSTORRENT_BASE_URL = previousBase;
    if (previousCap === undefined) delete process.env.ESTRENOSTORRENT_MAX_DETAILS;
    else process.env.ESTRENOSTORRENT_MAX_DETAILS = previousCap;
    clearMirrorCache('estrenostorrent');
  }
});

test('Tokyo Toshokan: two-row entries with magnet, size, stats and English subs', () => {
  const base = 'https://www.tokyotosho.info';
  const html = `<table class="listing">
   <tr class="category_0 shade"><td rowspan="2"><a href="/?cat=1"><span></span></a></td>
    <td class="desc-top"><a href="${MAGNET.replace('Carmen', 'Mushoku')}"><span class="sprite_magnet"></span></a>
     <a href="https://nyaa.si/view/2166905/torrent" type="application/x-bittorrent">[SubsPlease] Mushoku Tensei S3 - 14 (720p) [F1D816E0].mkv</a>
     <a href="https://www.tokyotosho.info/torrents/2117284.torrent">DL</a></td>
    <td class="web"><a href="https://subsplease.org/">Website</a> | <a href="details.php?id=2117284">Details</a></td></tr>
   <tr class="category_0 shade"><td class="desc-bot">Authorized: Yes Submitter: subsplease | Size: 703.73MB | Date: 2026-09-27 15:01 UTC | Comment: Released by SubsPlease.</td>
    <td class="stats">S: <span>692</span> L: <span>539</span> C: 1092 ID: 2117284</td></tr></table>`;
  const records = new TokyoToshoCrawler().parseListing(html, `${base}/?cat=1`, 'anime', ['sub_en']);
  assert.equal(records.length, 1);
  const [r] = records;
  assert.equal(r.info_hash, HASH);
  assert.equal(r.type, 'anime');
  assert.equal(r.seeders, 692);
  assert.equal(r.leechers, 539);
  assert.equal(r.source_url, `${base}/details.php?id=2117284`);
  // The HTML details page is NOT metainfo: only a real .torrent link is stored.
  assert.equal(r.torrent_file_url, 'https://www.tokyotosho.info/torrents/2117284.torrent');
  assert.ok(r.subtitles.includes('Sub_EN'));
  assert.deepEqual(r.audio, []);
  assert.ok(r.size_bytes > 7e8);
  // A trailing "[Website]" link must never replace the release title.
  assert.match(r.title, /Mushoku Tensei/);
});

test('Tokyo Toshokan: pagination is 1-based and page 1 is never requested twice', async () => {
  const base = 'https://www.tokyotosho.info';
  const previous = process.env.TOKYOTOSHO_SEARCH;
  process.env.TOKYOTOSHO_SEARCH = ''; // only the category routes
  try {
    const row = (id, hash) => `<tr class="category_1"><td class="desc-top"><a href="magnet:?xt=urn:btih:${hash}">M</a>
      <a href="details.php?id=${id}">Sample Castellano ${id}</a></td><td class="stats">S: 4 L: 2</td></tr>
      <tr><td class="desc-bot">Size: 1.2GB | Comment: SubsPlease</td></tr>`;

    const crawler = new TokyoToshoCrawler();
    const calls = mockHttp(crawler, url => `<table class="listing">${/\?cat=1&page=2/.test(url) ? row(2222222, HASH2) : row(1111111, HASH)}</table>`);
    const records = await crawler.crawl(2);

    assert.equal(records.length, 2, 'both pages must contribute records');
    // The first `/?cat=1` is the mirror probe, so duplicates are collapsed.
    assert.deepEqual(
      [...new Set(calls.filter(url => /\?cat=1(?:&|$)/.test(url)))],
      [`${base}/?cat=1`, `${base}/?cat=1&page=2`]
    );
    assert.ok(!calls.some(url => /page=1(?:&|$)/.test(url)), 'page 1 must not be requested as &page=1');
  } finally {
    if (previous === undefined) delete process.env.TOKYOTOSHO_SEARCH;
    else process.env.TOKYOTOSHO_SEARCH = previous;
  }
});
