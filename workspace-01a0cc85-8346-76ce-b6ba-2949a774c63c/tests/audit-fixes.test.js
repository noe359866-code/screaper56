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
import { looksLikeRutrackerCaptcha } from '../src/crawlers/rutracker.ts';
import { detectLanguages } from '../src/utils/language.ts';
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
