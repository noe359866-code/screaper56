import test from 'node:test';
import assert from 'node:assert/strict';
import { GranTorrentCrawler, isMovieCardPath } from '../src/crawlers/grantorrent.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { loadConfig } from '../src/config/env.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';

const base = 'https://grantorrent.test';
const hash = '0123456789abcdef0123456789abcdef01234567';
const list = `<a href="/icefall/"><img src="/wp-content/uploads/2026/05/poster.jpg">Icefall</a>
<a href="/icefall/"><img src="/wp-content/uploads/2026/05/poster.jpg"></a>
<a href="https://evil.example/film/"><img src="/wp-content/uploads/poster.jpg"></a>
<a href="/categoria/accion/"><img src="/wp-content/uploads/icon.png"></a>`;
const detail = `<h1>Icefall (2025)</h1><div>Formato:720p</div><table>
<tr><td><img alt="Español (Castellano)"></td><td>MP4</td><td>720p</td><td>1.4GB</td>
<td><a href="https://super-enlace.com/s.php?i=opaque">Descargar</a></td></tr></table>`;

async function withConfiguredMirror(fn) {
  const previous = process.env.GRANTORRENT_BASE_URL;
  process.env.GRANTORRENT_BASE_URL = base;
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env.GRANTORRENT_BASE_URL;
    else process.env.GRANTORRENT_BASE_URL = previous;
  }
}

test('GranTorrent: discover movie cards, not ads or categories', () => {
  const crawler = new GranTorrentCrawler();
  assert.deepEqual(crawler.parseListing(list, base), [`${base}/icefall/`]);
  assert.equal(typeof CRAWLER_REGISTRY.grantorrent, 'function');
  const previousDryRun = process.env.DRY_RUN;
  const previousTargets = process.env.TARGET_CRAWLERS;
  process.env.DRY_RUN = 'true';
  process.env.TARGET_CRAWLERS = 'all';
  try { assert.ok(loadConfig(true).targetCrawlers.includes('grantorrent')); }
  finally {
    if (previousTargets === undefined) delete process.env.TARGET_CRAWLERS;
    else process.env.TARGET_CRAWLERS = previousTargets;
    // Rebuild the cached config without requiring database credentials.
    process.env.DRY_RUN = 'true';
    loadConfig(true);
    if (previousDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previousDryRun;
  }
});

test('GranTorrent: reserved segments anywhere in a path are not movie permalinks', () => {
  for (const path of ['/page/2/', '/icefall/page/', '/icefall/category/', '/film/genero/']) {
    assert.equal(isMovieCardPath(path), false, path);
  }
  assert.equal(isMovieCardPath('/peliculas/icefall/'), true);
});

test('GranTorrent: off-site and downgraded .torrent links are not downloaded', () => {
  const crawler = new GranTorrentCrawler();
  const page = detail.replace('https://super-enlace.com/s.php?i=opaque', 'https://ads.example/file.torrent');
  const parsed = crawler.parseDetail(page, `${base}/icefall/`);
  assert.deepEqual(parsed.downloads, []);
  assert.equal(parsed.gated, 1);

  const downgraded = detail.replace('https://super-enlace.com/s.php?i=opaque', 'http://grantorrent.test/file.torrent');
  assert.deepEqual(crawler.parseDetail(downgraded, `${base}/icefall/`).downloads, []);

  const credentialed = detail.replace('https://super-enlace.com/s.php?i=opaque', 'https://user:pass@grantorrent.test/file.torrent');
  assert.deepEqual(crawler.parseDetail(credentialed, `${base}/icefall/`).downloads, []);
});

test('GranTorrent: no fake domain is tried without an explicit mirror', async () => {
  const previousBase = process.env.GRANTORRENT_BASE_URL;
  const previousMirrors = process.env.GRANTORRENT_MIRRORS;
  delete process.env.GRANTORRENT_BASE_URL;
  delete process.env.GRANTORRENT_MIRRORS;
  clearMirrorCache('grantorrent');
  try {
    const crawler = new GranTorrentCrawler();
    crawler.httpClient = { get: async () => { throw new Error('network must not be touched'); } };
    await assert.rejects(crawler.crawl(1), /No verified default domain is configured/);
  } finally {
    if (previousBase === undefined) delete process.env.GRANTORRENT_BASE_URL;
    else process.env.GRANTORRENT_BASE_URL = previousBase;
    if (previousMirrors === undefined) delete process.env.GRANTORRENT_MIRRORS;
    else process.env.GRANTORRENT_MIRRORS = previousMirrors;
    clearMirrorCache('grantorrent');
  }
});

test('GranTorrent: opaque shortener is gated, not a fake torrent record', async () => {
  const crawler = new GranTorrentCrawler();
  assert.deepEqual(crawler.parseDetail(detail, `${base}/icefall/`).downloads, []);
  assert.equal(crawler.parseDetail(detail, `${base}/icefall/`).gated, 1);
  clearMirrorCache('grantorrent');
  crawler.httpClient = { get: async url => ({ status: 200, data: url === `${base}/icefall/` ? detail : list }) };
  await withConfiguredMirror(async () => {
    await assert.rejects(crawler.crawl(1), /No verified infohash: details=1, gated=1/);
  });
  clearMirrorCache('grantorrent');
});

test('GranTorrent: accepts only validated direct magnet links', async () => {
  const crawler = new GranTorrentCrawler();
  clearMirrorCache('grantorrent');
  const magnet = `magnet:?xt=urn:btih:${hash}`;
  const page = detail.replace('https://super-enlace.com/s.php?i=opaque', magnet);
  crawler.httpClient = { get: async url => ({ status: 200, data: url === `${base}/icefall/` ? page : list }) };
  await withConfiguredMirror(async () => {
    const records = await crawler.crawl(1);
    assert.equal(records.length, 1);
    assert.equal(records[0].info_hash, hash);
    assert.deepEqual(records[0].audio, ['Spanish']);
    assert.equal(records[0].source_url, `${base}/icefall/`);
  });
  clearMirrorCache('grantorrent');
});

test('GranTorrent: language parsing retains Latino and dual-audio evidence', () => {
  const crawler = new GranTorrentCrawler();
  const bilingual = detail
    .replace('Español (Castellano)', 'Español Latino / Inglés')
    .replace('https://super-enlace.com/s.php?i=opaque', `MAGNET:?xt=urn:btih:${hash}`);
  const parsed = crawler.parseDetail(bilingual, `${base}/icefall/`);
  assert.equal(parsed.downloads.length, 1);
  assert.ok(parsed.downloads[0].audio.includes('Spanish (Latino)'));
  assert.ok(parsed.downloads[0].audio.includes('English'));
});

test('GranTorrent: later catalogue pages are fetched when a page only repeats known cards', async () => {
  const card = name => `<a href="/${name}/"><img src="/wp-content/uploads/${name}.jpg"></a>`;
  const first = `${card('first')}${card('second')}`;
  const second = card('second');
  const third = card('third');
  const movie = (name, infoHash) => `<h1>${name} (2025)</h1><table><tr>
    <td><img alt="Español (Castellano)"></td><td><a href="magnet:?xt=urn:btih:${infoHash}">Magnet</a></td>
    </tr></table>`;
  const previousMirrors = process.env.GRANTORRENT_MIRRORS;
  delete process.env.GRANTORRENT_MIRRORS;
  clearMirrorCache('grantorrent');
  try {
    const crawler = new GranTorrentCrawler();
    const calls = [];
    crawler.httpClient = {
      get: async url => {
        calls.push(url);
        let data;
        if (url === `${base}/` || url === base) data = first;
        else if (url === `${base}/page/2/`) data = second;
        else if (url === `${base}/page/3/`) data = third;
        else if (url === `${base}/first/`) data = movie('First', hash);
        else if (url === `${base}/second/`) data = movie('Second', 'abcdef0123456789abcdef0123456789abcdef01');
        else if (url === `${base}/third/`) data = movie('Third', 'fedcba9876543210fedcba9876543210fedcba98');
        else data = '<html></html>';
        return { status: 200, data };
      }
    };

    await withConfiguredMirror(async () => {
      const records = await crawler.crawl(3);
      assert.ok(calls.includes(`${base}/page/3/`));
      assert.equal(records.length, 3);
    });
  } finally {
    if (previousMirrors === undefined) delete process.env.GRANTORRENT_MIRRORS;
    else process.env.GRANTORRENT_MIRRORS = previousMirrors;
    clearMirrorCache('grantorrent');
  }
});

test('GranTorrent: blocked catalogue after a passing probe is not an empty success', async () => {
  const previousMirrors = process.env.GRANTORRENT_MIRRORS;
  delete process.env.GRANTORRENT_MIRRORS;
  clearMirrorCache('grantorrent');
  try {
    const crawler = new GranTorrentCrawler();
    let probeServed = false;
    crawler.httpClient = {
      get: async url => {
        if (url === `${base}/` && !probeServed) {
          probeServed = true;
          return { status: 200, data: list };
        }
        return { status: 200, data: '<title>Access Denied</title>' };
      }
    };

    await withConfiguredMirror(async () => {
      await assert.rejects(crawler.crawl(1), /No verified infohash/);
    });
  } finally {
    if (previousMirrors === undefined) delete process.env.GRANTORRENT_MIRRORS;
    else process.env.GRANTORRENT_MIRRORS = previousMirrors;
    clearMirrorCache('grantorrent');
  }
});
