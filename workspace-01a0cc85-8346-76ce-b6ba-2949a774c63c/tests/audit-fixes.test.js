// Regression tests for the 2026-09 audit fixes:
//   EZTV seeders column, RARBG size column, DonTorrent magnet validation,
//   EliteTorrent filtered-route pagination, RuTracker captcha detection,
//   anti-Cloudflare relaunch after shutdown and the "Audio en 5.1" English tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EztvCrawler } from '../src/crawlers/eztv.ts';
import { RarbgCrawler } from '../src/crawlers/rarbg.ts';
import { dontorrentDownloadUrl } from '../src/crawlers/dontorrent.ts';
import { EliteTorrentCrawler, eliteRoutePagePath } from '../src/crawlers/elitetorrent.ts';
import { looksLikeRutrackerCaptcha, RutrackerCrawler } from '../src/crawlers/rutracker.ts';
import { MagnetDlCrawler } from '../src/crawlers/magnetdl.ts';
import { ThePirateBayCrawler } from '../src/crawlers/thepiratebay.ts';
import { TorrentGalaxyCrawler } from '../src/crawlers/torrentgalaxy.ts';
import { LimeTorrentsCrawler } from '../src/crawlers/limetorrent.ts';
import { BlockedPageError } from '../src/crawlers/base.ts';
import { detectLanguages } from '../src/utils/language.ts';
import { parseCount } from '../src/crawlers/support.ts';
import { CloudflareBypassEngine } from '../src/utils/anti-cloudflare.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { mockHttp, MAGNET } from './helpers.js';

test('EZTV: the first counter after the size column is seeders, the second leechers', () => {
  const crawler = new EztvCrawler();
  const html = `<table><tr class="forum_header_border">
    <td><a class="epinfo" href="/ep/1">Show S01E02</a></td>
    <td><a class="magnet" href="${MAGNET}">M</a><a class="download_1" href="/files/s.torrent">T</a></td>
    <td>650 MiB</td>
    <td><font color="green">S: 1,234</font></td>
    <td><font color="red">56</font></td></tr></table>`;

  const sink = [];
  const { rows, added } = crawler.collectHtmlRows(html, 'https://eztv.test', new Set(), sink);
  assert.equal(rows, 1);
  assert.equal(added, 1);
  const record = sink[0];
  assert.equal(record.seeders, 1234, `seeders must not be the leechers cell: ${record.seeders}`);
  assert.equal(record.leechers, 56);
  assert.equal(record.size_bytes, 650 * 1024 * 1024);
});

test('EZTV: legacy single-counter rows still read their only number as seeders', () => {
  const crawler = new EztvCrawler();
  const html = `<table><tr class="forum_header_border">
    <td><a class="epinfo" href="/ep/1">Show S01E02</a></td>
    <td><a class="magnet" href="${MAGNET}">M</a></td>
    <td>650 MiB</td><td></td><td><font>24</font></td></tr></table>`;

  const sink = [];
  crawler.collectHtmlRows(html, 'https://eztv.test', new Set(), sink);
  assert.equal(sink[0].seeders, 24);
  assert.equal(sink[0].leechers, null);
});

test('RARBG: a numeric seeders cell is never taken for the size column', () => {
  const crawler = new RarbgCrawler();
  // The size cell is EMPTY: without a unit requirement the "847" seeders count
  // parsed as 847 bytes and shifted S/L one cell to the left.
  const listing = `<table>
    <tr><td><img></td><td><a href="/rarbgproxy_torrent/s.html">Sample Castellano</a></td>
      <td>Movies</td><td>2026-01-01</td><td></td><td>847</td><td>56</td><td>up</td></tr></table>`;

  const [row] = crawler.parseListing(listing, 'https://rarbg.test/movies/');
  assert.equal(row.sizeStr, '');
  assert.equal(row.seeders, 847, `seeders shifted: ${JSON.stringify(row)}`);
  assert.equal(row.leechers, 56);
});

test('RARBG: real size cells with units are still located by content', () => {
  const crawler = new RarbgCrawler();
  const listing = `<table>
    <tr><td><img></td><td><a href="/rarbgproxy_torrent/s.html">Sample Castellano 1080p</a></td>
      <td>Movies</td><td>2.1 GB</td><td>1,234</td><td>56</td><td>uploader</td></tr></table>`;

  const [row] = crawler.parseListing(listing, 'https://rarbg.test/movies/');
  assert.equal(row.sizeStr, '2.1 GB');
  assert.equal(row.seeders, 1234);
  assert.equal(row.leechers, 56);
});

test('DonTorrent: magnets without a valid BTIH are rejected, not fetched as URLs', () => {
  const base = 'https://dontorrent.moi';
  assert.equal(dontorrentDownloadUrl('magnet:?xt=urn:btih:invalid&dn=x', base), null);
  assert.equal(dontorrentDownloadUrl('magnet:?dn=no-hash-at-all', base), null);
  assert.equal(dontorrentDownloadUrl('magnet:?xt=urn:btih:0000000000000000000000000000000000000000', base), null);
  assert.equal(dontorrentDownloadUrl(MAGNET, base), MAGNET);
  // Base32 magnets stay valid.
  assert.equal(
    dontorrentDownloadUrl('magnet:?xt=urn:btih:YTOYSKZSCEU5WS6RJMBYaRVqRCFK5V4L&dn=x', base),
    'magnet:?xt=urn:btih:YTOYSKZSCEU5WS6RJMBYaRVqRCFK5V4L&dn=x'
  );
});

test('EliteTorrent: filtered routes paginate via their trailing number, sections via /page/N/', () => {
  assert.equal(eliteRoutePagePath('/idioma/castellano-17-1/', 2), '/idioma/castellano-17-2/');
  assert.equal(eliteRoutePagePath('/idioma/espanol-latino-11-1/', 3), '/idioma/espanol-latino-11-3/');
  assert.equal(eliteRoutePagePath('/calidad/1080p-10-1/', 2), '/calidad/1080p-10-2/');
  assert.equal(eliteRoutePagePath('/calidad/4k-uhd-23-1/', 5), '/calidad/4k-uhd-23-5/');
  assert.equal(eliteRoutePagePath('/series/', 2), '/series/page/2/');
  assert.equal(eliteRoutePagePath('/', 2), '/page/2/');
  assert.equal(eliteRoutePagePath('/peliculas/', 1), '/peliculas/');
});

test('EliteTorrent: MAX_PAGES reaches page 2 of a /idioma/ filter through its trailing number', async () => {
  const mirror = 'https://elite-audit.test';
  const previousBase = process.env.ELITETORRENT_BASE_URL;
  process.env.ELITETORRENT_BASE_URL = mirror;
  clearMirrorCache('elitetorrent');
  try {
    const crawler = new EliteTorrentCrawler();
    const listing = n =>
      `<a href="/peliculas/sample-${n}-a/" title="Sample Castellano ${n}">Sample Castellano ${n}</a>`;
    const calls = mockHttp(crawler, url => {
      const pageMatch = url.match(/(\d+)\/?$/);
      return listing(Number(pageMatch?.[1] ?? 1));
    });

    await crawler.crawl(2);

    assert.ok(
      calls.includes(`${mirror}/idioma/castellano-17-2/`),
      `page 2 of the /idioma/ route was never fetched. Calls: ${calls.join(', ')}`
    );
    assert.ok(
      !calls.includes(`${mirror}/idioma/castellano-17-1/page/2/`),
      'the invented /page/N/ URL must not be requested on filtered routes'
    );
  } finally {
    if (previousBase === undefined) delete process.env.ELITETORRENT_BASE_URL;
    else process.env.ELITETORRENT_BASE_URL = previousBase;
    clearMirrorCache('elitetorrent');
  }
});

test('RuTracker: the word "captcha" inside a post no longer aborts the run', () => {
  assert.equal(
    looksLikeRutrackerCaptcha('<html><h1>Topic</h1><p>el captcha de rutracker es molesto</p></html>'),
    false,
    'free text mentioning captcha must not look like a challenge'
  );
  assert.equal(
    looksLikeRutrackerCaptcha('<html><p>как обойти капчу на трекере</p></html>'),
    false
  );
  assert.equal(
    looksLikeRutrackerCaptcha('<html><form><img src="captcha.php"><input name="cap_code"></form></html>'),
    true,
    'a real captcha form is still detected'
  );
  assert.equal(looksLikeRutrackerCaptcha('<html>Введите код с картинки</html>'), true);
  assert.equal(
    looksLikeRutrackerCaptcha('<html><div class="g-recaptcha" data-sitekey="x"></div></html>'),
    true
  );
  assert.equal(
    looksLikeRutrackerCaptcha('<html>mentions captcha <a href="login.php?logout=1">out</a></html>'),
    false,
    'a logged-in page is never a challenge'
  );
  assert.equal(looksLikeRutrackerCaptcha(''), false);
  assert.equal(looksLikeRutrackerCaptcha(undefined), false);
});

test('"Audio en 5.1" is a channel note, not English audio', () => {
  const channels = detectLanguages('Pelicula 2023 1080p Audio en 5.1', [], false);
  assert.deepEqual(channels.audio, [], `no language evidence at all: ${JSON.stringify(channels.audio)}`);

  // On a Spanish tracker the hint supplies Spanish; English must NOT be added.
  const spanish = detectLanguages('Pelicula 2023 1080p Audio en 5.1', ['dontorrent']);
  assert.deepEqual(spanish.audio, ['Spanish']);

  const dual = detectLanguages('Pelicula 2023 1080p Audio en 5.1 Dual', [], false);
  assert.deepEqual(dual.audio, []);

  assert.deepEqual(detectLanguages('Movie 2023 audio english', [], false).audio, ['English']);
  assert.deepEqual(detectLanguages('Audio en Español', [], false).audio, ['Spanish']);
});

// Keep last: shutdown() is terminal for the shared engine of this process.
test('Anti-Cloudflare: a shut-down engine never relaunches the browser', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  await engine.shutdown();
  await assert.rejects(() => engine.solve('https://shutdown-audit.test/page'), /shut down/);
  await assert.rejects(() => engine.withPage(async () => 'unused'), /shut down/);
  // Drop the poisoned singleton so any later test in this process starts fresh.
  CloudflareBypassEngine.resetInstance();
});

// ============================================================================
// Second round: high-risk findings
// ============================================================================

test('parseCount: abbreviated swarm counters (1.5K / 2,3M) parse; decimals stay invalid', () => {
  assert.equal(parseCount('1.5k'), 1500);
  assert.equal(parseCount('1.5K'), 1500);
  assert.equal(parseCount('2,3M'), 2_300_000);
  assert.equal(parseCount('10K'), 10_000);
  assert.equal(parseCount('12.5'), null);
  assert.equal(parseCount('1,5'), null);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('N/A'), null);
});

test('MagnetDL: rows without a type column survive; a non-video category still drops the row', () => {
  const crawler = new MagnetDlCrawler();
  // Six cells (no `type` column): the old tds.eq(3) read "1.5 GB" as the
  // category and silently dropped EVERY row of such mirrors.
  const listing = `<table><tbody>
    <tr><td class="m"><a href="/single/274364"><img></a></td>
      <td class="n"><a href="/single/274364" title="Widows 2018 1080p Castellano">Widows 2018 1080p Castellano</a></td>
      <td>6 Years+</td><td>1.5 GB</td><td>4</td><td>1</td></tr>
    <tr><td></td><td><a href="/single/9">Some Game</a></td>
      <td>1 Days</td><td>games</td><td>3 GB</td><td>9</td></tr></tbody></table>`;

  const rows = crawler.parseListing(listing, 'https://magnetdl.test/download/movies/', null);
  assert.equal(rows.length, 1, `only the video row survives: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].detailUrl, 'https://magnetdl.test/single/274364');
  assert.equal(rows[0].seeders, 4);
  assert.equal(rows[0].leechers, 1);
});

test('TPB: trailing non-numeric cells no longer blank the swarm counters', () => {
  const crawler = new ThePirateBayCrawler();
  const html = `<table id="searchResult"><tr class="header"><td>c</td></tr>
    <tr><td class="vertTh"><a href="/browse/208">TV shows</a></td>
    <td><div class="detName"><a href="/description.php?id=9">Sample S01E02 Castellano</a></div>
    <a href="${MAGNET}">M</a>
    <font class="detDesc">Uploaded 01-01, Size 1.5 GiB, ULed by x</font></td>
    <td>10</td><td>2</td><td>mod</td><td>report</td></tr></table>`;

  const sink = [];
  const { added } = crawler.collectHtmlRows(html, 'https://tpb.test', new Set(), sink);
  assert.equal(added, 1);
  assert.equal(sink[0].seeders, 10, 'seeders are the last two numeric cells, not the last two tds');
  assert.equal(sink[0].leechers, 2);
});

test('fetchJson: a WAF interstitial with HTTP 200 raises BlockedPageError, not a schema error', async () => {
  const crawler = new ThePirateBayCrawler();
  const blockPage = '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>';
  mockHttp(crawler, () => blockPage);
  await assert.rejects(
    () => crawler.crawl(1),
    error => error instanceof BlockedPageError,
    'the old code parsed the interstitial as an empty API response'
  );
});

test('LimeTorrents: a blocked search degrades to no results instead of aborting the run', async () => {
  const mirror = 'https://lime-audit.test';
  const previousBase = process.env.LIMETORRENTS_BASE_URL;
  process.env.LIMETORRENTS_BASE_URL = mirror;
  clearMirrorCache('limetorrents');
  try {
    const crawler = new LimeTorrentsCrawler();
    const blockPage = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
    const list = '<table class="table2"><tr><th>Name</th></tr><tr><td><div class="tt-name"><a href="/sample.html">Sample Castellano</a></div></td><td>3 hours ago</td><td>1.5 GiB</td><td>123</td><td>7</td></tr></table>';
    mockHttp(crawler, url => {
      if (url === `${mirror}/search`) return blockPage;               // POST search
      if (url.includes('/search/all/')) return blockPage;             // GET fallback
      if (url.endsWith('/sample.html')) return `<h1>Sample Castellano</h1><a href="${MAGNET}">M</a>`;
      return list;                                                    // catalogues
    });

    const records = await crawler.crawl(1);
    assert.equal(records.length, 1, 'the catalogue records survive a blocked search phase');
    assert.equal(records[0].seeders, 123);
  } finally {
    if (previousBase === undefined) delete process.env.LIMETORRENTS_BASE_URL;
    else process.env.LIMETORRENTS_BASE_URL = previousBase;
    clearMirrorCache('limetorrents');
  }
});

test('RuTracker: an implausible quoted count is not stored; a normal one still parses', () => {
  const crawler = new RutrackerCrawler();
  const url = 'https://rutracker.org/forum/viewtopic.php?t=6466319';

  const quoted = crawler.parseTopic(
    `<h1>El Camino Castellano</h1><a href="${MAGNET}">M</a>
     <div class="post_body">alguien dijo que los Seeders: 98765432112345 eran falsos</div>`,
    url
  );
  assert.equal(quoted.seeders, null, 'a quoted impossible count must not become swarm data');

  const clean = crawler.parseTopic(
    `<h1>El Camino Castellano</h1><a href="${MAGNET}">M</a>
     <div class="post_body">Seeders: 42</div>`,
    url
  );
  assert.equal(clean.seeders, 42);
});

test('TGX: rows without seed/leech markup fall back to the last numeric cells', () => {
  const crawler = new TorrentGalaxyCrawler();
  const html = `<table><tr class="tgxtablerow">
    <td class="tgxtablecell"><a href="/torrent/1/Sample" title="Sample Castellano">Sample</a></td>
    <td class="tgxtablecell">1.5 GiB</td>
    <td><a href="${MAGNET}">M</a></td>
    <td>0</td><td>12</td><td>3</td></tr></table>`;

  const [record] = crawler.parseTorrentGalaxyHtml(html, 'https://tgx.test/torrents.php', 'https://tgx.test');
  assert.ok(record, 'the row produces a record');
  assert.equal(record.seeders, 12);
  assert.equal(record.leechers, 3);
  assert.equal(record.size_bytes, 1610612736);
});

test('EZTV: abbreviated 1.5K seeders are parsed instead of lost', () => {
  const crawler = new EztvCrawler();
  const html = `<table><tr class="forum_header_border">
    <td><a class="epinfo" href="/ep/1">Show S01E02</a></td>
    <td><a class="magnet" href="${MAGNET}">M</a></td>
    <td>650 MiB</td><td></td><td><font>1.5K</font></td><td><font>120</font></td></tr></table>`;

  const sink = [];
  crawler.collectHtmlRows(html, 'https://eztv.test', new Set(), sink);
  assert.equal(sink[0].seeders, 1500);
  assert.equal(sink[0].leechers, 120);
});
