import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WolftorrentCrawler, wolfDownloadUrl } from '../src/crawlers/wolftorrent.ts';
import { SinsitioCrawler, decodeSinsitioDownload } from '../src/crawlers/sinsitio.ts';
import { loadConfig } from '../src/config/env.ts';
import { mockHttp, torrent, MAGNET, HASH } from './helpers.js';
const fixture = name => readFileSync(new URL(`fixtures/${name}.html`, import.meta.url), 'utf8');
const base = 'https://www.sinsitio.site/';
const wrapper = (target, name = 'Sample Castellano 1080p') => `/ddlUrl.php?url=${encodeURIComponent(Buffer.from(target).toString('base64'))}&name=${encodeURIComponent(name)}`;

test('Sinsitio: numbered posts, fragment dedup, pagination and no offsite/user links', () => {
  const crawler = new SinsitioCrawler();
  assert.deepEqual(crawler.parseListing(fixture('sinsitio-list'), base), [`${base}dvdrip-bdrip/35740-sample-castellano.html`]);
  assert.equal(crawler.nextPage(fixture('sinsitio-list'), base), `${base}page/2/`);
  assert.equal(
    crawler.nextPage('<div class="navigation"><a href="https://sinsitio.site/page/2/">Siguiente »</a></div>', base),
    'https://sinsitio.site/page/2/',
    'DLE www/apex pagination remains on the same site'
  );
  assert.equal(crawler.nextPage('<a rel="next" href="https://ads.example/page/2/">Next</a>', base), null);
  assert.equal(crawler.nextPage('<a rel="next" href="http://sinsitio.site/page/2/">Next</a>', base), null);
  assert.deepEqual(
    crawler.parseListing('<a href="https://user:pass@www.sinsitio.site/1234-sample.html">credential URL</a>', base),
    []
  );
});
test('Sinsitio: decode real ddlUrl.php shape with escaped base64, validate DLE attachment', () => {
  const target = `${base}index.php?do=download&id=69384`;
  assert.equal(decodeSinsitioDownload(wrapper(target), base), target);
  assert.equal(decodeSinsitioDownload('/engine/download.php?id=22', base), `${base}engine/download.php?id=22`);
  assert.equal(decodeSinsitioDownload(MAGNET, base), MAGNET);
  assert.equal(decodeSinsitioDownload('magnet:?xt=urn:btih:invalid', base), null);
  assert.equal(decodeSinsitioDownload(wrapper('magnet:?xt=urn:btih:invalid'), base), null);
  assert.equal(decodeSinsitioDownload('https://user:pass@www.sinsitio.site/index.php?do=download&id=22', base), null);
  for (const href of ['/index.php?do=register', '/ddlUrl.php?url=%%%!', wrapper('https://ads.example/index.php?do=download&id=1'), wrapper('javascript:alert(1)'), '/index.php?do=download&id=abc']) {
    assert.equal(decodeSinsitioDownload(href, base), null, href);
  }
});
test('Sinsitio: two attached qualities stay separate, comments excluded', () => {
  const crawler = new SinsitioCrawler();
  const detail = crawler.parseDetail(`<h1>Sample Castellano</h1><a href="${wrapper(`${base}index.php?do=download&id=1`)}">Download</a>
  <a href="${wrapper(`${base}index.php?do=download&id=2`, 'Sample Castellano 720p')}">Download</a>
  <div id="dle-comments-list"><a href="${MAGNET}">Other release</a></div>
  <aside class="sidebar"><a href="${wrapper(`${base}index.php?do=download&id=3`)}">Unrelated sidebar torrent</a></aside>
  <footer><a href="${MAGNET}">Footer magnet</a></footer>`, `${base}dvdrip-bdrip/123-sample.html`);
  assert.equal(detail.downloads.length, 2);
  assert.match(detail.downloads[0].title, /1080p/);
  assert.match(detail.downloads[1].title, /720p/);
});
test('Sinsitio: full crawl downloads metainfo with Referer, preserves variants, bounds pages', async () => {
  const crawler = new SinsitioCrawler();
  const file = torrent(); const file2 = torrent('Sample Castellano 720p');
  const calls = mockHttp(crawler, url => {
    if (url.endsWith('.html')) return `<h1>Sample Castellano</h1><a href="${wrapper(`${base}index.php?do=download&id=1`)}">1080p</a><a href="${wrapper(`${base}index.php?do=download&id=2`, 'Sample Castellano 720p')}">720p</a>`;
    return fixture('sinsitio-list');
  }, (url, options) => {
    assert.match(options.headers.Referer, /35740-sample/);
    return url.endsWith('id=1') ? file.buffer : file2.buffer;
  });
  const records = await crawler.crawl(1);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.quality), ['1080p', '720p']);
  assert.equal(records[0].info_hash, file.hash);
  assert.equal(records[0].seeders, null);
  assert.equal(crawler.filterSpanishReleases(records).accepted.length, 2);
  assert.equal(calls.filter(url => url.endsWith('.html')).length, 1);
  assert.ok(!calls.some(url => url.includes('/page/2/')));
});
test('Sinsitio: bad attachment does not drop a later valid one', async () => {
  const crawler = new SinsitioCrawler();
  mockHttp(crawler, url => url.endsWith('.html')
    ? `<h1>Sample Castellano</h1><a href="/index.php?do=download&id=1">Bad</a><a href="${MAGNET}">Good</a>`
    : fixture('sinsitio-list'), () => Buffer.from('<html>Login required</html>'));
  const records = await crawler.crawl(1);
  assert.equal(records.length, 1);
  assert.equal(records[0].info_hash, HASH);
});
test('Sinsitio: an unavailable site or changed layout is an error, not silent success', async () => {
  for (const get of [() => { throw new Error('offline'); }, () => '<html>parked domain</html>']) {
    const crawler = new SinsitioCrawler(); mockHttp(crawler, get);
    await assert.rejects(crawler.crawl(1), /No compatible mirror available/);
  }
});
test('Wolf: dedicated routes and real next links', () => {
  const crawler = new WolftorrentCrawler();
  assert.deepEqual(crawler.parseListing(fixture('wolftorrent-list'), crawler.baseUrl), [
    'https://wolftorrent.com/pelicula/abc123/Sample', 'https://wolftorrent.com/serie/def456/Serie-1-Temporada'
  ]);
  assert.equal(crawler.nextPage(fixture('wolftorrent-list'), 'https://wolftorrent.com/peliculas'), 'https://wolftorrent.com/peliculas?pagina=2');
  assert.equal(
    crawler.nextPage('<div class="pagination"><a href="https://www.wolftorrent.com/peliculas?pagina=2">2</a></div>', 'https://wolftorrent.com/peliculas'),
    'https://www.wolftorrent.com/peliculas?pagina=2',
    'the www/apex variation used by the site does not drop pagination'
  );
  assert.equal(
    crawler.nextPage('<div class="pagination"><a href="https://ads.example/peliculas?pagina=2">2</a></div>', 'https://wolftorrent.com/peliculas'),
    null,
    'off-site pagination links are not followed'
  );
});
test('Wolf: magnets, relative torrents, literal JS/atob and episode rows; never eval', () => {
  const crawler = new WolftorrentCrawler();
  const path = 'https://wolftorrent.com/serie/abc123/Sample';
  const detail = crawler.parseDetail(`<h1>Sample Castellano 1ª Temporada</h1><table><tr><td>1x02</td><td><button data-url="/files/ep2.torrent?token=ok">Descargar</button></td></tr></table>
  <a href="${MAGNET}">magnet</a><button onclick="location.href=atob('L2ZpbGVzL2VwMy50b3JyZW50')">Descargar</button>
  <div class="related"><a href="magnet:?xt=urn:btih:${'a'.repeat(40)}">Another release</a></div>
  <a href="https://ads.example/download/abc">Ad</a>`, path);
  assert.equal(detail.type, 'series');
  assert.equal(detail.downloads.length, 3);
  assert.match(detail.downloads[0].title, /1x02/);
  assert.equal(detail.downloads[2].url, 'https://wolftorrent.com/files/ep3.torrent');
  assert.equal(wolfDownloadUrl('javascript:alert(1)', path), null);
});
test('Wolf: full movie + episode crawl, duplicate listing URLs and pagination loops', async () => {
  const crawler = new WolftorrentCrawler();
  const file = torrent('Sample Castellano S01E02 1080p');
  const calls = mockHttp(crawler, url => {
    if (url.includes('/pelicula/')) return `<h1>Sample Castellano</h1><a href="${MAGNET}">Magnet</a>`;
    if (url.includes('/serie/')) return '<h1>Sample Castellano</h1><tr></tr><button data-url="/files/ep2.torrent">Descargar</button>';
    return fixture('wolftorrent-list');
  }, () => file.buffer);
  const records = await crawler.crawl(3);
  assert.equal(records.length, 2);
  assert.equal(records[1].type, 'series');
  assert.equal(records[1].episode, 2);
  assert.equal(calls.filter(url => url.includes('/serie/')).length, 1);
  assert.equal(await crawler.crawl(0).then(r => r.length), 0);
});
test('Wolf: browser-resolved buttons retain language hints from the rendered page', async () => {
  const previous = process.env.WOLFTORRENT_BROWSER;
  process.env.WOLFTORRENT_BROWSER = 'true';
  try {
    const crawler = new WolftorrentCrawler();
    const locator = {
      or() { return this; },
      count: async () => 1,
      nth() { return this; },
      getAttribute: async attr => attr === 'data-magnet' ? MAGNET : null,
      click: async () => { throw new Error('a literal magnet should not click'); }
    };
    const page = {
      goto: async () => {},
      content: async () => '<h1>Sample Castellano</h1><p>Idioma: Castellano</p>',
      getByRole: () => locator,
      waitForEvent: () => { throw new Error('literal magnet is not a browser download'); }
    };
    crawler.withBrowserPage = async task => task(page);

    const detail = await crawler.discoverDownloads(
      '<h1>Sample</h1>',
      'https://wolftorrent.com/serie/abc123/Sample'
    );
    assert.equal(detail.downloads.length, 1);
    assert.deepEqual(detail.downloads[0].hints, ['Idioma: Castellano']);
  } finally {
    if (previous === undefined) delete process.env.WOLFTORRENT_BROWSER;
    else process.env.WOLFTORRENT_BROWSER = previous;
  }
});

test('Wolf: a failed click does not leave an unhandled download-event rejection', async () => {
  const previous = process.env.WOLFTORRENT_BROWSER;
  process.env.WOLFTORRENT_BROWSER = 'true';
  try {
    const crawler = new WolftorrentCrawler();
    const locator = {
      or() { return this; },
      count: async () => 1,
      nth() { return this; },
      getAttribute: async () => null,
      click: async () => { throw new Error('button detached'); }
    };
    const page = {
      goto: async () => {},
      content: async () => '<h1>Sample Castellano</h1>',
      getByRole: () => locator,
      waitForEvent: () => new Promise((_, reject) => setTimeout(() => reject(new Error('download timeout')), 5))
    };
    crawler.withBrowserPage = async task => task(page);

    const detail = await crawler.discoverDownloads(
      '<h1>Sample Castellano</h1>',
      'https://wolftorrent.com/serie/abc123/Sample'
    );
    assert.deepEqual(detail.downloads, []);
    // Let the pending event timeout fire; its rejection must already be handled.
    await new Promise(resolve => setTimeout(resolve, 15));
  } finally {
    if (previous === undefined) delete process.env.WOLFTORRENT_BROWSER;
    else process.env.WOLFTORRENT_BROWSER = previous;
  }
});

test('New targets enabled by all, selectable individually and deduplicated', () => {
  const previous = { dry: process.env.DRY_RUN, targets: process.env.TARGET_CRAWLERS };
  try {
    process.env.DRY_RUN = 'true'; process.env.TARGET_CRAWLERS = 'all';
    assert.ok(loadConfig(true).targetCrawlers.includes('wolftorrent'));
    assert.ok(loadConfig().targetCrawlers.includes('sinsitio'));
    process.env.TARGET_CRAWLERS = 'priority';
    const priority = loadConfig(true).targetCrawlers;
    assert.ok(priority.includes('dontorrent'));
    assert.ok(priority.includes('leech1337x'));
    assert.ok(priority.includes('rutracker'));
    assert.ok(priority.includes('t0rrenta'));
    assert.ok(priority.includes('estrenostorrent'));
    assert.equal(priority.includes('grantorrent'), false, 'GranTorrent needs a verified host before it can run');
    assert.equal(priority.includes('rarbg'), false);
    assert.equal(priority.includes('tokyotosho'), false);
    process.env.TARGET_CRAWLERS = 'sinsitio,wolftorrent,sinsitio';
    assert.deepEqual(loadConfig(true).targetCrawlers, ['sinsitio', 'wolftorrent']);
    process.env.TARGET_CRAWLERS = 'sinistio';
    assert.throws(() => loadConfig(true), /Unknown TARGET/);
  } finally {
    for (const [key, value] of [['DRY_RUN', previous.dry], ['TARGET_CRAWLERS', previous.targets]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Wolf: browser fallback discards external downloads before reading or publishing them', async () => {
  const previous = process.env.WOLFTORRENT_BROWSER;
  process.env.WOLFTORRENT_BROWSER = 'true';
  try {
    const crawler = new WolftorrentCrawler();
    let clicked = false;
    let streamRead = false;
    let deleted = false;
    const download = {
      url: () => 'https://ads.example/files/redirected.torrent',
      createReadStream: async () => { streamRead = true; return null; },
      suggestedFilename: () => 'redirected.torrent',
      delete: async () => { deleted = true; }
    };
    const locator = {
      or() { return this; },
      count: async () => 1,
      nth() { return this; },
      getAttribute: async () => null,
      click: async () => { clicked = true; }
    };
    const page = {
      goto: async () => {},
      content: async () => '<h1>Sample Castellano</h1>',
      getByRole: () => locator,
      waitForEvent: async () => download
    };
    crawler.withBrowserPage = async task => task(page);

    const detail = await crawler.discoverDownloads(
      '<h1>Sample Castellano</h1>',
      'https://wolftorrent.com/serie/abc123/Sample'
    );
    assert.equal(clicked, true);
    assert.equal(streamRead, false, 'external payload bytes are not consumed');
    assert.equal(deleted, true, 'the rejected browser download is disposed');
    assert.deepEqual(detail.downloads, []);
  } finally {
    if (previous === undefined) delete process.env.WOLFTORRENT_BROWSER;
    else process.env.WOLFTORRENT_BROWSER = previous;
  }
});

test('Wolf: browser fallback never clicks a known off-site button target', async () => {
  const previous = process.env.WOLFTORRENT_BROWSER;
  process.env.WOLFTORRENT_BROWSER = 'true';
  try {
    const crawler = new WolftorrentCrawler();
    let clicked = false;
    const locator = {
      or() { return this; },
      count: async () => 1,
      nth() { return this; },
      getAttribute: async attr => attr === 'data-url' ? 'https://ads.example/shortener' : null,
      click: async () => { clicked = true; }
    };
    const page = {
      goto: async () => {},
      url: () => 'https://www.wolftorrent.com/serie/abc123/Sample',
      content: async () => '<h1>Sample Castellano</h1><button data-url="https://ads.example/shortener">Descargar</button>',
      getByRole: () => locator,
      waitForEvent: () => { throw new Error('off-site target must not be clicked'); }
    };
    crawler.withBrowserPage = async task => task(page);

    const detail = await crawler.discoverDownloads(
      '<h1>Sample Castellano</h1>',
      'https://wolftorrent.com/serie/abc123/Sample'
    );
    assert.equal(clicked, false);
    assert.deepEqual(detail.downloads, []);
  } finally {
    if (previous === undefined) delete process.env.WOLFTORRENT_BROWSER;
    else process.env.WOLFTORRENT_BROWSER = previous;
  }
});
