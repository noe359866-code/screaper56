import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { CrawlerDeadlineError, BlockedPageError } from '../src/crawlers/base.ts';
import { parseCount, absoluteHttpUrl, describeError, mapWithConcurrency } from '../src/crawlers/support.ts';
import { HASH, HASH2, MAGNET, mockHttp, torrent } from './helpers.js';

process.env.LOG_LEVEL = 'silent';
process.env.CRAWLER_REQUEST_DELAY_MS = '0';

// A matrix over the actual registry prevents a new adapter being left untested.
for (const [name, factory] of Object.entries(CRAWLER_REGISTRY)) {
  test(`${name}: invalid page budgets do not reach network or browser`, async () => {
    const crawler = await factory();
    let requests = 0;
    mockHttp(crawler, () => { requests++; throw new Error('unexpected network'); });
    for (const limit of [0, -1, 1.5, NaN, Infinity]) assert.deepEqual(await crawler.crawl(limit), []);
    assert.equal(requests, 0);
    await crawler.close();
  });

  test(`${name}: unreachable mirrors cannot produce a successful empty run`, async () => {
    const previous = process.env.GRANTORRENT_BASE_URL;
    process.env.GRANTORRENT_BASE_URL = 'https://grantorrent.test';
    clearMirrorCache(name);
    const crawler = await factory();
    const calls = mockHttp(crawler, () => { throw new Error('ENOTFOUND offline fixture'); });
    try {
      await assert.rejects(crawler.crawl(1));
      assert.ok(calls.length > 0);
      // Dead probes must remain browser-free and bounded. TPB also tests APiBay.
      assert.ok(calls.length <= 40, `${calls.length} attempts`);
    } finally {
      if (previous === undefined) delete process.env.GRANTORRENT_BASE_URL;
      else process.env.GRANTORRENT_BASE_URL = previous;
      await crawler.close();
      clearMirrorCache(name);
    }
  });

  test(`${name}: shared fetch helpers start no I/O after deadline`, async () => {
    const crawler = await factory();
    crawler.cachedDeadline = { expired: true, remainingMs: 0 };
    const calls = mockHttp(crawler, () => { throw new Error('Must not start request'); }, () => { throw new Error('Must not download'); });
    const url = 'https://fixture.test/resource';
    for (const fn of [() => crawler.fetchHtml(url), () => crawler.fetchJson(url), () => crawler.fetchBytes(url),
      () => crawler.fetchTorrentMetainfo(url), () => crawler.fetchTorrentMetainfoViaGet(url),
      () => crawler.withBrowserPage(() => { throw new Error('Must not open browser'); })]) {
      await assert.rejects(fn(), CrawlerDeadlineError);
    }
    assert.equal(calls.length, 0);
  });
}

test('HTML block detection is the default even for adapters not passing rejectBlocked', async () => {
  const crawler = await CRAWLER_REGISTRY.mejortorrent();
  mockHttp(crawler, () => '<title>Access Denied</title>');
  await assert.rejects(crawler.fetchHtml('https://fixture.test/'), BlockedPageError);
});

test('remaining budget caps a new request timeout but is not claimed as hard cancellation', async () => {
  const crawler = await CRAWLER_REGISTRY.eztv();
  crawler.cachedDeadline = { remainingMs: 123, expired: false };
  mockHttp(crawler, (_url, config) => { assert.equal(config.timeout, 123); return 'valid'; });
  await crawler.fetchHtml('https://fixture.test/', { timeout: 8000 });
});

test('shared counters reject unsafe or fractional values instead of inventing peers', () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, '1,5', '12 34', '1,', Infinity]) assert.equal(parseCount(value), null, String(value));
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1.234'), 1234);
  assert.equal(parseCount(0), 0);
});

test('shared URL resolution rejects credentials, including those inherited from a base URL', () => {
  assert.equal(absoluteHttpUrl('https://user:secret@fixture.test/a', 'https://fixture.test'), null);
  assert.equal(absoluteHttpUrl('/a', 'https://user:secret@fixture.test'), null);
  assert.equal(absoluteHttpUrl('/a#fragment', 'https://fixture.test'), 'https://fixture.test/a');
});

test('nested error cycles cannot break logging or overflow the stack', () => {
  const a = {}; const b = { error: a }; a.error = b;
  assert.match(describeError(a), /circular/);
});

test('shared concurrency clamps accidental extreme limits', async () => {
  let active = 0; let peak = 0;
  const results = await mapWithConcurrency(Array.from({ length: 70 }, (_, i) => i), 1000000, async i => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; return i;
  });
  assert.ok(peak <= 32);
  assert.equal(results.length, 70);
});

test('YTS malformed optional language does not discard the entire API page', async () => {
  const crawler = await CRAWLER_REGISTRY.yts();
  const rows = crawler.mapMovie({ id: 1, title: 'Sample', language: 42, torrents: [{ hash: HASH }] }, 'https://yts.test');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].info_hash, HASH);
});

test('APiBay malformed optional title is ignored without throwing', async () => {
  const crawler = await CRAWLER_REGISTRY.thepiratebay();
  assert.equal(crawler.mapApibayItem({ info_hash: HASH, name: 42, category: 200 }), null);
});

test('Nyaa uses row category for subtitle evidence even on a generic search', async () => {
  const crawler = await CRAWLER_REGISTRY.nyaa();
  const row = (category, hash) => `<tr><td><a href="/?c=${category}">category</a></td>
    <td><a href="/view/1">Sample 1080p</a></td><td><a href="magnet:?xt=urn:btih:${hash}">M</a></td>
    <td>1 GiB</td><td>2026</td><td>5</td><td>1</td></tr>`;
  const html = `<table class="torrent-list"><tbody>${row('1_2', HASH)}${row('1_4', HASH2)}</tbody></table>`;
  const records = crawler.parseRows(html, 'https://nyaa.test/', 'https://nyaa.test', '/?c=0_0&q=spanish');
  assert.ok(records[0].subtitles.includes('Sub_EN'));
  assert.deepEqual(records[1].subtitles, []);
  const categoryRecords = crawler.parseRows(html, 'https://nyaa.test/', 'https://nyaa.test', '/?c=1_2');
  assert.deepEqual(categoryRecords[1].subtitles, [], 'a raw row overrides the category endpoint hint');
});

test('TokyoTosho missing bottom row never borrows the next release metadata', async () => {
  const crawler = await CRAWLER_REGISTRY.tokyotosho();
  const html = `<table><tr><td class="desc-top"><a href="/details.php?id=1">Sample One</a><a href="magnet:?xt=urn:btih:${HASH}">M</a></td></tr>
    <tr><td class="desc-top"><a href="/details.php?id=2">Sample Two</a><a href="magnet:?xt=urn:btih:${HASH2}">M</a><a href="/files/two.torrent">Download</a></td><td class="stats">S: 999 L: 8</td></tr>
    <tr><td class="desc-bot">Size: 2 GB Comment: Castellano</td></tr></table>`;
  const records = crawler.parseListing(html, 'https://tokyo.test/', 'anime', [], 'https://tokyo.test');
  assert.equal(records.length, 2);
  assert.equal(records[0].seeders, null);
  assert.equal(records[0].torrent_file_url, null);
  assert.equal(records[1].seeders, 999);
});

test('Wolf blob downloads sharing a bencode header keep distinct identities and records', async () => {
  const crawler = await CRAWLER_REGISTRY.wolftorrent();
  const buffers = [torrent('First Castellano').buffer, torrent('Second Castellano').buffer];
  assert.deepEqual(buffers[0].subarray(0, 8), buffers[1].subarray(0, 8));
  const old = process.env.WOLFTORRENT_BROWSER;
  process.env.WOLFTORRENT_BROWSER = 'true';
  let index = 0;
  const locator = { or() { return this; }, count: async () => 2, nth() { return this; }, getAttribute: async () => null, click: async () => {} };
  crawler.withBrowserPage = async task => task({
    goto: async () => {}, content: async () => '<h1>Sample Castellano</h1>', getByRole: () => locator,
    waitForEvent: async () => {
      const buffer = buffers[index++];
      return { url: () => 'blob:https://wolftorrent.com/temp', suggestedFilename: () => 'sample.torrent',
        createReadStream: async () => Readable.from([buffer]), delete: async () => {} };
    }
  });
  mockHttp(crawler, () => '<h1>Sample Castellano</h1>');
  try {
    const records = await crawler.crawlDetail('https://wolftorrent.com/pelicula/123/sample');
    assert.equal(records.length, 2);
    assert.notEqual(records[0].info_hash, records[1].info_hash);
    assert.ok(records.every(record => record.torrent_file_url === null));
  } finally {
    if (old === undefined) delete process.env.WOLFTORRENT_BROWSER; else process.env.WOLFTORRENT_BROWSER = old;
  }
});

test('GranTorrent downloads duplicate metainfo only once and retains its tracker and size', async () => {
  const crawler = await CRAWLER_REGISTRY.grantorrent();
  const old = process.env.GRANTORRENT_BASE_URL;
  process.env.GRANTORRENT_BASE_URL = 'https://grantorrent.test';
  crawler.resolveMirror = async () => 'https://grantorrent.test';
  const metainfo = torrent('Sample Castellano');
  const calls = mockHttp(crawler, url => url.includes('.torrent') ? metainfo.buffer : url.endsWith('/sample/')
    ? '<h1>Sample Castellano</h1><table><tr><td>Castellano</td><td><a href="/file.torrent#download">Descargar</a><a href="/file.torrent">icon</a></td></tr></table>'
    : '<a href="/sample/"><img src="/wp-content/uploads/poster.jpg"></a>');
  try {
    const [record] = await crawler.crawl(1);
    assert.equal(calls.filter(url => url.includes('.torrent')).length, 1);
    assert.equal(record.size_bytes, 42);
    assert.equal(record.source_tracker, 'udp://tracker.example/announce');
    assert.match(record.magnet_url, /tracker.example/);
  } finally {
    if (old === undefined) delete process.env.GRANTORRENT_BASE_URL; else process.env.GRANTORRENT_BASE_URL = old;
  }
});

// RuTracker has its own authenticated captcha/rate-limit handling, covered in
// rutracker.test.js; Sinsitio/Wolf use the shared HtmlCatalogCrawler pipeline.
for (const name of ['dontorrent', 'elitetorrent', 'estrenostorrent', 'eztv', 'grantorrent', 'leech1337x', 'limetorrents', 'magnetdl', 'mejortorrent', 'nyaa', 'pelispanda', 'rarbg', 'sinsitio', 't0rrenta', 'thepiratebay', 'tokyotosho', 'torrentgalaxy', 'wolftorrent', 'yts']) {
  test(`${name}: rate-limit after mirror selection aborts rather than moving to another route`, async () => {
    const old = process.env.GRANTORRENT_BASE_URL;
    process.env.GRANTORRENT_BASE_URL = 'https://grantorrent.test';
    const crawler = await CRAWLER_REGISTRY[name]();
    crawler.resolveMirror = async () => { crawler.baseUrl = 'https://fixture.test'; return crawler.baseUrl; };
    const rate = Object.assign(new Error('rate limit fixture'), { response: { status: 429 } });
    const calls = mockHttp(crawler, () => { throw rate; });
    try {
      await assert.rejects(crawler.crawl(1), error => error === rate);
      // Parallel listing routes already started may finish; none should schedule new work.
      assert.ok(calls.length <= 6, `${name}: ${calls.length} calls after rate-limit`);
    } finally {
      if (old === undefined) delete process.env.GRANTORRENT_BASE_URL; else process.env.GRANTORRENT_BASE_URL = old;
    }
  });
}

test('Nyaa category IDs exclude non-video rows even when icons have no title', async () => {
  const crawler = await CRAWLER_REGISTRY.nyaa();
  const row = (category, hash, title) => `<tr><td><a href="/?c=${category}"><img></a></td><td><a href="/view/1">${title}</a></td>
    <td><a href="magnet:?xt=urn:btih:${hash}">M</a></td><td>1 GiB</td><td>2026</td><td>2</td><td>1</td></tr>`;
  const html = `<table class="torrent-list"><tbody>${row('2_1', HASH, 'Music Spanish')}${row('4_1', HASH2, 'Drama S01E02')}</tbody></table>`;
  const records = crawler.parseRows(html, 'https://nyaa.test/', 'https://nyaa.test', '/?c=0_0');
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'series');
  assert.ok(records[0].subtitles.includes('Sub_EN'));
});

test('TokyoTosho explicit category takes precedence over a generic category_0 CSS class', async () => {
  const crawler = await CRAWLER_REGISTRY.tokyotosho();
  const row = (category, hash) => `<tr class="category_0"><td><a href="/?cat=${category}">Category</a></td>
    <td class="desc-top"><a href="/details.php?id=1">Sample 1080p</a><a href="magnet:?xt=urn:btih:${hash}">M</a></td></tr>`;
  const records = crawler.parseListing(`<table>${row(2, HASH)}${row(1, HASH2)}</table>`, 'https://tokyo.test/', 'anime', [], 'https://tokyo.test');
  assert.equal(records.length, 1);
  assert.equal(records[0].info_hash, HASH2);
  assert.ok(records[0].subtitles.includes('Sub_EN'));
  const nonEnglish = crawler.parseListing(`<table>${row(10, HASH)}</table>`, 'https://tokyo.test/', 'anime', ['sub_en'], 'https://tokyo.test');
  assert.deepEqual(nonEnglish[0].subtitles, []);
});

test('MejorTorrent refuses credential-bearing published download URLs', async () => {
  const { isMejortorrentDownload } = await import('../src/crawlers/mejortorrent.ts');
  const link = 'https://user:secret@mejor.test/file.torrent';
  assert.equal(isMejortorrentDownload(link, link, 'https://mejor.test/pelicula/1'), false);
});


test('GranTorrent duplicate links merge language evidence and are not counted as gated', async () => {
  const crawler = await CRAWLER_REGISTRY.grantorrent();
  const detail = crawler.parseDetail(`<h1>Sample</h1><table>
    <tr><td>Castellano</td><td><a href="/file.torrent">Descargar</a></td></tr>
    <tr><td>English</td><td>1 GB <a href="/file.torrent">Descargar</a></td></tr></table>`, 'https://grantorrent.test/sample');
  assert.equal(detail.downloads.length, 1);
  assert.ok(detail.downloads[0].audio.includes('Spanish'));
  assert.ok(detail.downloads[0].audio.includes('English'));
  assert.ok(detail.downloads[0].size > 0);
  assert.equal(detail.gated, 0);
});
