import test from 'node:test';
import assert from 'node:assert/strict';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { CrawlerDeadlineError } from '../src/crawlers/base.ts';
import { sameSite, sameSiteHttpUrl, resetRequestDelayCache } from '../src/crawlers/support.ts';
import { DonTorrentCrawler } from '../src/crawlers/dontorrent.ts';
import { EliteTorrentCrawler } from '../src/crawlers/elitetorrent.ts';
import { PelispandaCrawler } from '../src/crawlers/pelispanda.ts';
import { HASH, HASH2, MAGNET, mockHttp, torrent } from './helpers.js';

process.env.LOG_LEVEL = 'silent';
process.env.CRAWLER_REQUEST_DELAY_MS = '0';

// ============================================================================
// Shared same-site helper (replaces a dozen private copies)
// ============================================================================

test('sameSite: www/apex match, scheme/port/credential changes and other hosts do not', () => {
  assert.equal(sameSite('https://www.site.test/a', 'https://site.test/'), true);
  assert.equal(sameSite('https://site.test/a', 'https://WWW.site.test/'), true);
  assert.equal(sameSite('http://site.test/a', 'https://site.test/'), false, 'scheme downgrade');
  assert.equal(sameSite('https://site.test:8443/a', 'https://site.test/'), false, 'port change');
  assert.equal(sameSite('https://user:pw@site.test/a', 'https://site.test/'), false, 'credentials');
  assert.equal(sameSite('https://cdn.site.test/a', 'https://site.test/'), false, 'subdomain is another site');
  assert.equal(sameSite('https://other.test/a', 'https://site.test/'), false);
  assert.equal(sameSite('not a url', 'https://site.test/'), false);
});

test('sameSiteHttpUrl: resolves relative links and keeps only same-site http(s) results', () => {
  assert.equal(sameSiteHttpUrl('/files/a.torrent', 'https://site.test/p/1'), 'https://site.test/files/a.torrent');
  assert.equal(sameSiteHttpUrl('//www.site.test/x', 'https://site.test/p/1'), 'https://www.site.test/x');
  assert.equal(sameSiteHttpUrl('https://ads.test/x', 'https://site.test/p/1'), null);
  assert.equal(sameSiteHttpUrl('javascript:void(0)', 'https://site.test/p/1'), null);
  assert.equal(sameSiteHttpUrl('/x', 'https://site.test/p/1', 'https://other.test'), null, 'explicit site base wins');
  assert.equal(sameSiteHttpUrl(undefined, 'https://site.test/'), null);
});

// ============================================================================
// Budget-capped timeouts on the direct httpClient.request paths
// ============================================================================

test('LimeTorrents POST search uses the budget-capped timeout and stops after the deadline', async () => {
  const crawler = await CRAWLER_REGISTRY.limetorrents();
  crawler.cachedDeadline = { remainingMs: 321, expired: false };
  let postTimeout = null;
  crawler.httpClient = {
    get: async () => ({ status: 200, data: '<table class="table2"></table>' }),
    getBuffer: async () => { throw new Error('unexpected'); },
    request: async options => {
      if (options.method === 'POST') postTimeout = options.timeout;
      return { status: 200, data: '<table class="table2"></table>' };
    }
  };
  assert.equal(await crawler.searchHtml('https://lime.test', 'spanish'), '<table class="table2"></table>');
  assert.equal(postTimeout, 321, 'POST timeout is clamped to the remaining budget');

  crawler.cachedDeadline = { remainingMs: 0, expired: true };
  await assert.rejects(crawler.searchHtml('https://lime.test', 'spanish'), CrawlerDeadlineError);
});

test('DonTorrent POST search is budget-capped like every other request', async () => {
  const crawler = new DonTorrentCrawler();
  process.env.DONTORRENT_SEARCH = 'castellano';
  try {
    crawler.cachedDeadline = { remainingMs: 555, expired: false };
    let postTimeout = null;
    crawler.httpClient = {
      get: async () => ({ status: 200, data: '' }),
      getBuffer: async () => { throw new Error('unexpected'); },
      request: async options => { postTimeout = options.timeout; return { status: 200, data: '' }; }
    };
    await crawler.collectSearches('https://dontorrent.test', 1, new Map());
    assert.equal(postTimeout, 555);
  } finally {
    delete process.env.DONTORRENT_SEARCH;
  }
});

test('RuTracker: an expired budget inside a topic surfaces as the shared CrawlerDeadlineError', async () => {
  const crawler = await CRAWLER_REGISTRY.rutracker();
  crawler.cachedDeadline = { remainingMs: 0, expired: true };
  const topic = { topicId: '1', url: 'https://rutracker.test/forum/viewtopic.php?t=1', title: 'Sample', type: 'movie' };
  crawler.baseUrl = 'https://rutracker.test';
  mockHttp(crawler, () => { throw new Error('must not run'); });
  await assert.rejects(crawler.crawlTopic(topic), CrawlerDeadlineError);
});

// ============================================================================
// A pause must never turn an admitted request into a run abort
// ============================================================================

test('BaseCrawler: the budget is checked before the courtesy pause, not after it', async () => {
  process.env.CRAWLER_REQUEST_DELAY_MS = '30';
  resetRequestDelayCache();
  try {
    const crawler = await CRAWLER_REGISTRY.eztv();
    // 5 ms left: the old order paused ~30 ms first and then threw
    // CrawlerDeadlineError, which is terminal for the whole run.
    let remaining = 5;
    crawler.cachedDeadline = { get remainingMs() { return remaining; }, get expired() { return remaining <= 0; } };
    let seenTimeout = null;
    mockHttp(crawler, (_url, config) => { seenTimeout = config.timeout; remaining = 0; return 'ok'; });
    const started = Date.now();
    await crawler.fetchHtml('https://fixture.test/');
    assert.ok(Date.now() - started >= 25, 'the pause still happens for admitted requests');
    assert.ok(seenTimeout >= 1 && seenTimeout <= 5, `timeout ${seenTimeout} capped to the admitted budget`);

    remaining = 0;
    await assert.rejects(crawler.fetchHtml('https://fixture.test/'), CrawlerDeadlineError);
  } finally {
    process.env.CRAWLER_REQUEST_DELAY_MS = '0';
    resetRequestDelayCache();
  }
});

// ============================================================================
// Adapter-level fixes
// ============================================================================

test('MejorTorrent: a catalogue that never answers is a failure, not a successful empty run', async () => {
  const crawler = await CRAWLER_REGISTRY.mejortorrent();
  clearMirrorCache('mejortorrent');
  process.env.MEJORTORRENT_BASE_URL = 'https://mt.test';
  try {
    mockHttp(crawler, url => {
      // Probe and template detection succeed; every catalogue route fails.
      if (url === 'https://mt.test/' || url === 'https://mt.test') return '<a href="/pelicula/x/">x</a>';
      throw new Error('ECONNRESET');
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    delete process.env.MEJORTORRENT_BASE_URL;
    clearMirrorCache('mejortorrent');
  }
});

test('EliteTorrent: a synthetic magnet carries the metainfo trackers, never fabricated defaults', async () => {
  const crawler = new EliteTorrentCrawler();
  const file = torrent('Sample Castellano 1080p');
  mockHttp(
    crawler,
    url => (url.endsWith('.torrent')
      ? file.buffer
      : '<h1>Sample</h1><p class="descrip"><span>Idioma: Castellano</span></p><a href="/descargar/sample.torrent">Descargar</a>'),
    () => file.buffer
  );
  const record = await crawler.parseEliteTorrentDetail('https://elite.test/peliculas/sample/', 'https://elite.test');
  assert.equal(record.info_hash, file.hash);
  assert.match(record.magnet_url, /tr=udp%3A%2F%2Ftracker\.example%2Fannounce/);
  assert.doesNotMatch(record.magnet_url, /opentrackr|openbittorrent|coppersurfer/i, 'no public default trackers injected');
});

test('DonTorrent nextPage: rel="next nofollow" is recognised and a bad current URL returns null', () => {
  const crawler = new DonTorrentCrawler();
  const html = '<a rel="next nofollow" href="/peliculas?p=2">Ir</a>';
  assert.equal(crawler.nextPage(html, 'https://dontorrent.test/peliculas'), 'https://dontorrent.test/peliculas?p=2');
  assert.equal(crawler.nextPage(html, 'not a url'), null);
});

test('Pelispanda: downloads inside one ficha are resolved in parallel and all records survive', async () => {
  process.env.PELISPANDA_BASE_URL = 'https://panda.test';
  clearMirrorCache('pelispanda');
  const crawler = new PelispandaCrawler();
  let inFlight = 0;
  let peak = 0;
  const files = [torrent('Ep 1'), torrent('Ep 2'), torrent('Ep 3')];
  mockHttp(
    crawler,
    async url => {
      if (url.includes('/serie/')) return {
        title: 'Sample',
        seasons: [{ season_number: 1, episodes: files.map((_file, index) => ({
          episode_number: index + 1,
          downloads: [{ download_link: `https://panda.test/files/ep${index + 1}.torrent`, quality: '1080p', language: 'Castellano' }]
        })) }]
      };
      if (url.includes('/series?')) return [{ slug: 'sample' }];
      return [];
    },
    async url => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 15));
      inFlight--;
      const index = Number(url.match(/ep(\d)\.torrent/)[1]) - 1;
      return { data: files[index].buffer };
    }
  );
  // fetchTorrentMetainfoViaGet goes through httpClient.get; route it to the buffer mock.
  const buffers = crawler.httpClient.getBuffer;
  const jsonGet = crawler.httpClient.get;
  crawler.httpClient.get = async (url, options) => (url.endsWith('.torrent') ? buffers(url, options) : jsonGet(url, options));

  let records;
  try {
    records = await crawler.crawl(1);
  } finally {
    delete process.env.PELISPANDA_BASE_URL;
    clearMirrorCache('pelispanda');
  }
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.episode).sort(), [1, 2, 3]);
  assert.deepEqual(records.map(record => record.info_hash).sort(), files.map(file => file.hash).sort());
  assert.ok(peak >= 2, `downloads overlapped (peak=${peak})`);
});

test('Nyaa/TokyoTosho/LimeTorrents keep rejecting off-site metainfo links through the shared helper', async () => {
  const nyaa = await CRAWLER_REGISTRY.nyaa();
  const row = `<tr><td><a href="/?c=1_2">c</a></td><td><a href="/view/1">Sample 1080p</a></td>
    <td><a href="magnet:?xt=urn:btih:${HASH}">M</a><a href="https://evil.test/download/1.torrent">T</a></td>
    <td>1 GiB</td><td>2026</td><td>5</td><td>1</td></tr>`;
  const [record] = nyaa.parseRows(`<table class="torrent-list"><tbody>${row}</tbody></table>`, 'https://nyaa.test/', 'https://nyaa.test');
  assert.equal(record.torrent_file_url, null);

  const tokyo = await CRAWLER_REGISTRY.tokyotosho();
  const html = `<table><tr><td class="desc-top"><a href="magnet:?xt=urn:btih:${HASH2}">M</a><a href="https://evil.test/x.torrent">T</a>
    <a href="/details.php?id=1">Sample</a></td></tr><tr><td class="desc-bot">Size: 1GB</td></tr></table>`;
  const [tokyoRecord] = tokyo.parseListing(html, 'https://tokyo.test/?cat=1', 'anime', [], 'https://tokyo.test');
  assert.equal(tokyoRecord.torrent_file_url, null);
  assert.equal(tokyoRecord.source_url, 'https://tokyo.test/details.php?id=1');
});

test('A soft-404 detail page is a missing page, not a block that aborts the run', async () => {
  const { looksLikeBlockedPage } = await import('../src/crawlers/mirrors.ts');
  assert.equal(looksLikeBlockedPage('<html><title>Página no encontrada</title><body>404</body></html>'), false);
  assert.equal(looksLikeBlockedPage('<html><title>Just a moment...</title><body></body></html>'), true);
});

test('nextPaginationLink: "Siguiente »" wording wins over numeric ordering on 0-based pagers', async () => {
  const { nextPaginationLink } = await import('../src/crawlers/support.ts');
  const html = '<div class="pagination"><a href="?page=0">1</a><a href="?page=1">2</a><a href="?page=1">Siguiente »</a></div>';
  assert.equal(nextPaginationLink(html, 'https://site.test/torrents.php'), 'https://site.test/torrents.php?page=1');
  assert.equal(
    nextPaginationLink('<div class="pagination"><a href="/movies/3/">→ Next</a></div>', 'https://site.test/movies/2/'),
    'https://site.test/movies/3/'
  );
});

test('RuTracker cookie jar: accepts Cookie-Editor, Playwright storageState, cookies.txt and header formats', async () => {
  const { parseCookieJar } = await import('../src/crawlers/rutracker.ts');
  const now = Date.now();
  const future = Math.floor(now / 1000) + 3600;
  const past = Math.floor(now / 1000) - 3600;

  const editor = JSON.stringify([
    { domain: '.rutracker.org', name: 'bb_session', value: 's1', expirationDate: future },
    { domain: '.rutracker.org', name: 'bb_data', value: 'd1', expirationDate: future * 1000 },
    { domain: '.rutracker.org', name: 'old', value: 'x', expirationDate: past },
    { domain: '.google.com', name: 'NID', value: 'leak' }
  ]);
  const diagnostics = { format: 'empty', kept: [], expired: 0, foreignDomain: 0, unsafe: 0, domains: [] };
  assert.deepEqual(parseCookieJar(editor, now, diagnostics), [['bb_session', 's1'], ['bb_data', 'd1']]);
  assert.equal(diagnostics.format, 'json');
  assert.equal(diagnostics.expired, 1);
  assert.equal(diagnostics.foreignDomain, 1);
  assert.deepEqual(diagnostics.domains, ['rutracker.org']);

  const playwright = JSON.stringify({ cookies: [
    { domain: '.rutracker.org', name: 'bb_session', value: 's2', expires: -1 },
    { domain: '.rutracker.org', name: 'gone', value: 'x', expires: past }
  ], origins: [] });
  assert.deepEqual(parseCookieJar(playwright, now), [['bb_session', 's2']]);

  const netscape = [
    '# Netscape HTTP Cookie File',
    `.rutracker.org\tTRUE\t/forum/\tTRUE\t${future}\tbb_guid\tguid`,
    `#HttpOnly_.rutracker.org\tTRUE\t/forum/\tTRUE\t${future}\tbb_session\ts3`,
    `.evil.test\tTRUE\t/\tTRUE\t${future}\tbb_session\tleak`
  ].join('\n');
  assert.deepEqual(parseCookieJar(netscape, now), [['bb_guid', 'guid'], ['bb_session', 's3']]);

  assert.deepEqual(parseCookieJar('Cookie: bb_guid=g; bb_session=s4', now), [['bb_guid', 'g'], ['bb_session', 's4']]);

  const broken = { format: 'empty', kept: [], expired: 0, foreignDomain: 0, unsafe: 0, domains: [] };
  assert.deepEqual(parseCookieJar('[{"name": "bb_session", value: broken', now, broken), []);
  assert.equal(broken.format, 'invalid-json');
});

test('RuTracker prefers the mirror the configured cookies were issued for', async () => {
  const { RutrackerCrawler } = await import('../src/crawlers/rutracker.ts');
  const previous = process.env.RUTRACKER_COOKIE_JSON;
  process.env.RUTRACKER_COOKIE_JSON = JSON.stringify([{ domain: '.rutracker.net', name: 'bb_session', value: 's' }]);
  try {
    const crawler = new RutrackerCrawler();
    const mirrors = crawler.preferredMirrors();
    assert.equal(mirrors[0], 'https://rutracker.net');
    assert.equal(new Set(mirrors).size, 5);
  } finally {
    if (previous === undefined) delete process.env.RUTRACKER_COOKIE_JSON;
    else process.env.RUTRACKER_COOKIE_JSON = previous;
  }
});
