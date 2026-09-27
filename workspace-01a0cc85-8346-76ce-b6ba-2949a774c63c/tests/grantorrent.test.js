import test from 'node:test';
import assert from 'node:assert/strict';
import { GranTorrentCrawler } from '../src/crawlers/grantorrent.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { loadConfig } from '../src/config/env.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';

const base = 'https://grantorrent.foo';
const hash = '0123456789abcdef0123456789abcdef01234567';
const list = `<a href="/icefall/"><img src="/wp-content/uploads/2026/05/poster.jpg">Icefall</a>
<a href="/icefall/"><img src="/wp-content/uploads/2026/05/poster.jpg"></a>
<a href="https://evil.example/film/"><img src="/wp-content/uploads/poster.jpg"></a>
<a href="/categoria/accion/"><img src="/wp-content/uploads/icon.png"></a>`;
const detail = `<h1>Icefall (2025)</h1><div>Formato:720p</div><table>
<tr><td><img alt="Español (Castellano)"></td><td>MP4</td><td>720p</td><td>1.4GB</td>
<td><a href="https://super-enlace.com/s.php?i=opaque">Descargar</a></td></tr></table>`;

test('GranTorrent: discover movie cards, not ads or categories', () => {
  const crawler = new GranTorrentCrawler();
  assert.deepEqual(crawler.parseListing(list, base), [`${base}/icefall/`]);
  assert.equal(typeof CRAWLER_REGISTRY.grantorrent, 'function');
  const previous = process.env.DRY_RUN;
  process.env.DRY_RUN = 'true';
  try { assert.ok(loadConfig(true).targetCrawlers.includes('grantorrent')); }
  finally { if (previous === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = previous; }
});

test('GranTorrent: opaque shortener is gated, not a fake torrent record', async () => {
  const crawler = new GranTorrentCrawler();
  assert.deepEqual(crawler.parseDetail(detail, `${base}/icefall/`).downloads, []);
  assert.equal(crawler.parseDetail(detail, `${base}/icefall/`).gated, 1);
  clearMirrorCache('grantorrent');
  crawler.httpClient = { get: async url => ({ status: 200, data: url === `${base}/icefall/` ? detail : list }) };
  await assert.rejects(crawler.crawl(1), /No verified infohash: details=1, gated=1/);
  clearMirrorCache('grantorrent');
});

test('GranTorrent: accepts only validated direct magnet links', async () => {
  const crawler = new GranTorrentCrawler();
  clearMirrorCache('grantorrent');
  const magnet = `magnet:?xt=urn:btih:${hash}`;
  const page = detail.replace('https://super-enlace.com/s.php?i=opaque', magnet);
  crawler.httpClient = { get: async url => ({ status: 200, data: url === `${base}/icefall/` ? page : list }) };
  const records = await crawler.crawl(1);
  assert.equal(records.length, 1);
  assert.equal(records[0].info_hash, hash);
  assert.deepEqual(records[0].audio, ['Spanish']);
  assert.equal(records[0].source_url, `${base}/icefall/`);
  clearMirrorCache('grantorrent');
});
