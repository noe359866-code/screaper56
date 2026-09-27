import test from 'node:test';
import assert from 'node:assert/strict';
import { RarbgCrawler } from '../src/crawlers/rarbg.ts';
import { MagnetDlCrawler } from '../src/crawlers/magnetdl.ts';
import { TokyoToshoCrawler } from '../src/crawlers/tokyotosho.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';

const HASH = '5ac30f52edc636a18b3e28140dc90f7880fa9a1d';
const MAGNET = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&amp;dn=Carmen.and.Lola.2018.SPANISH.1080p&amp;tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`;

test('New sources are registered', () => {
  for (const key of ['rarbg', 'magnetdl', 'tokyotosho']) assert.equal(typeof CRAWLER_REGISTRY[key], 'function');
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

test('Tokyo Toshokan: two-row entries with magnet, size, stats and English subs', () => {
  const base = 'https://www.tokyotosho.info';
  const html = `<table class="listing">
   <tr class="category_0 shade"><td rowspan="2"><a href="/?cat=1"><span></span></a></td>
    <td class="desc-top"><a href="${MAGNET.replace('Carmen', 'Mushoku')}"><span class="sprite_magnet"></span></a>
     <a href="https://nyaa.si/view/2166905/torrent" type="application/x-bittorrent">[SubsPlease] Mushoku Tensei S3 - 14 (720p) [F1D816E0].mkv</a></td>
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
  assert.equal(r.torrent_file_url, 'https://nyaa.si/view/2166905/torrent');
  assert.ok(r.subtitles.includes('Sub_EN'));
  assert.deepEqual(r.audio, []);
  assert.ok(r.size_bytes > 7e8);
});
