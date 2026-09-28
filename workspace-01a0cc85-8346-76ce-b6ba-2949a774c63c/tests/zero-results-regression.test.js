import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { ResilientHttpClient } from '../src/utils/http.ts';
import { CloudflareBypassEngine } from '../src/utils/anti-cloudflare.ts';
import { BaseCrawler } from '../src/crawlers/base.ts';
import { resolveWorkingMirror, clearMirrorCache, htmlMarkerValidator } from '../src/crawlers/mirrors.ts';
import { diagnoseFailure } from '../src/crawlers/failure-diagnosis.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { TorrentGalaxyCrawler } from '../src/crawlers/torrentgalaxy.ts';
import { EztvCrawler } from '../src/crawlers/eztv.ts';
import { Leech1337xCrawler } from '../src/crawlers/leech1337x.ts';
import { T0rrentaCrawler } from '../src/crawlers/t0rrenta.ts';
import { DonTorrentCrawler } from '../src/crawlers/dontorrent.ts';
import { HASH, MAGNET, mockHttp } from './helpers.js';

const reply = (config, data = 'ok') => ({ config, status: 200, statusText: 'OK', headers: {}, data });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const code of ['ENOTFOUND', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_CANCELED']) {
  test(`HTTP permanent error ${code} is not retried`, async () => {
    let calls = 0;
    const expected = code === 'ERR_CANCELED' ? new axios.CanceledError() : new axios.AxiosError(code, code);
    const client = new ResilientHttpClient({ adapter: async () => { calls++; throw expected; } });
    await assert.rejects(client.get('https://permanent.test'), error => error === expected);
    assert.equal(calls, 1);
  });
}

test('HTTP plain 403/503 are not misidentified as Cloudflare', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  const original = engine.solveAndFetch;
  let solves = 0;
  engine.solveAndFetch = async () => { solves++; return null; };
  try {
    for (const status of [403, 503]) {
      const client = new ResilientHttpClient({ maxRetries: 0, adapter: async config => {
        throw new axios.AxiosError('refused', 'ERR_BAD_RESPONSE', config, {}, { ...reply(config), status });
      } });
      await assert.rejects(client.get('https://refused.test'), /refused/);
    }
    assert.equal(solves, 0);
  } finally { engine.solveAndFetch = original; }
});

test('HTTP transient 503 still retries without invoking a browser', async () => {
  let calls = 0;
  const client = new ResilientHttpClient({ baseDelayMs: 0, adapter: async config => {
    if (++calls === 1) throw new axios.AxiosError('unavailable', 'ERR_BAD_RESPONSE', config, {}, { ...reply(config), status: 503 });
    return reply(config);
  } });
  client.sleep = async () => {};
  assert.equal((await client.get('https://transient.test')).data, 'ok');
  assert.equal(calls, 2);
});

test('HTTP Retry-After date beginning with a day number is not parsed as seconds', () => {
  const date = new Date(Date.now() + 30_000).toUTCString().replace(/^\w+, /, '');
  const ms = ResilientHttpClient.retryAfterMs({ 'retry-after': date });
  assert.ok(ms > 28_000 && ms <= 30_000);
});

test('Browser HTML cannot satisfy a POST response or a JSON request', () => {
  const client = new ResilientHttpClient();
  const url = 'https://response.test/';
  const result = { html: '<html>Real page</html>', finalUrl: url, solved: true };
  assert.equal(client.buildBypassResponse(result, url, { method: 'POST', data: 'search=test' }), null);
  assert.equal(client.buildBypassResponse(result, url, { responseType: 'json' }), null);
});

test('Shared JSON helper explicitly requests JSON for EZTV, APiBay and Pelispanda', async () => {
  const crawler = new BaseCrawler();
  mockHttp(crawler, (_url, config) => {
    assert.equal(config.responseType, 'json');
    return { torrents: [] };
  });
  assert.deepEqual(await crawler.fetchJson('https://json.test/'), { torrents: [] });
});

test('Mirror stagger=0 really probes sequentially', async () => {
  let active = 0; let peak = 0;
  const mirror = await resolveWorkingMirror({ name: 'sequential', useCache: false, probeStaggerMs: 0,
    mirrors: ['https://first.test', 'https://second.test'], http: { get: async url => {
      active++; peak = Math.max(active, peak);
      await delay(20); active--;
      if (url.includes('first')) throw new Error('offline');
      return { status: 200, data: 'valid' };
    } } });
  assert.equal(mirror, 'https://second.test');
  assert.equal(peak, 1);
});

test('Mirror cache is reused only for an unchanged ordered configuration', async () => {
  const calls = [];
  const options = { name: 'configuration-test', probeStaggerMs: 0,
    mirrors: ['https://first.test', 'https://second.test'], http: { get: async url => {
      calls.push(url);
      if (url.includes('first')) throw new Error('offline');
      return { status: 200, data: 'valid' };
    } } };
  try {
    await resolveWorkingMirror(options);
    calls.length = 0;
    await resolveWorkingMirror(options);
    assert.deepEqual(calls, ['https://second.test/']);
    calls.length = 0;
    await resolveWorkingMirror({ ...options, mirrors: ['https://configured.test', ...options.mirrors] });
    assert.deepEqual(calls, ['https://configured.test/']);
  } finally { clearMirrorCache(options.name); }
});

test('An HTTP 200 block page remains a blocked diagnosis, not a layout error', async () => {
  await assert.rejects(resolveWorkingMirror({ name: 'blocked-test', useCache: false,
    mirrors: ['https://blocked.test'], probes: [{ validate: htmlMarkerValidator(['catalogue']) }],
    http: { get: async () => ({ status: 200, data: '<title>Access denied</title>' }) }
  }), error => diagnoseFailure('torrentgalaxy', error).kind === 'blocked');
});

test('TorrentGalaxy accepts reordered magnet parameters after an invalid link', () => {
  const html = `<div class="tgxtablerow"><a href="/torrent/1/sample">Sample Castellano 1080p</a>
    <a href="magnet:?xt=urn:btih:invalid">bad</a>
    <a href="magnet:?dn=Sample&amp;xt=urn:btih:${HASH}">valid</a></div>`;
  const records = new TorrentGalaxyCrawler().parseTorrentGalaxyHtml(html, 'https://tgx.test/', 'https://tgx.test');
  assert.equal(records.length, 1);
  assert.equal(records[0].info_hash, HASH);
});

test('EZTV does not require a cosmetic magnet CSS class', () => {
  const html = `<table><tr class="forum_header_border"><td><a class="epinfo" href="/ep/1">Sample S01E01 Castellano</a></td>
    <td><a href="${MAGNET}">M</a></td><td>1 GB</td></tr></table>`;
  const records = [];
  new EztvCrawler().collectHtmlRows(html, 'https://eztv.test', new Set(), records);
  assert.equal(records[0].info_hash, HASH);
});

test('1337x accepts absolute same-site detail links without following external ones', async () => {
  const crawler = new Leech1337xCrawler();
  // Never depend on environment mirrors.
  crawler.resolveMirror = async () => 'https://1337x.test';
  const calls = mockHttp(crawler, url => url.includes('/torrent/')
    ? `<h1>Sample Castellano</h1><a href="${MAGNET}">M</a>`
    : `<table class="table-list"><tbody>${['https://1337x.test/torrent/1/sample/', 'https://external.test/torrent/2/ad/', 'https://user:pass@1337x.test/torrent/3/ad/'].map(href =>
      `<tr><td class="name"><a href="${href}">Sample Castellano</a></td></tr>`).join('')}</tbody></table>`);
  const records = await crawler.crawl(1);
  assert.equal(records.length, 1);
  assert.equal(calls.filter(url => url.includes('/torrent/')).length, 1);
});

test('t0rrenta preserves same-named files on different paths and ignores rotated signatures', () => {
  const detail = new T0rrentaCrawler().parseDetail(`<h1>Sample</h1>
    <a href="/download/1/Sample.torrent?s=first">one</a>
    <a href="/download/1/Sample.torrent?s=second">duplicate</a>
    <a href="/download/2/Sample.torrent?s=third">two</a>`, 'https://t0rrenta.test/p/1');
  assert.equal(detail.downloads.length, 2);
});

test('t0rrenta image-only cards with whitespace retain the alt title', () => {
  const items = new T0rrentaCrawler().parseListing('<a href="/p/1">\n <img alt="Sample Castellano"> </a>', 'https://t0rrenta.test/');
  assert.equal(items[0].title, 'Sample Castellano');
});

test('DonTorrent follows overlapping pages until the published pager ends', async () => {
  const crawler = new DonTorrentCrawler();
  Object.defineProperty(crawler, 'sections', { get: () => [{ path: '/peliculas', label: 'movies', type: 'movie' }] });
  const base = 'https://dontorrent.test';
  const sink = new Map([[`${base}/pelicula/2/known`, { url: `${base}/pelicula/2/known` }]]);
  const calls = mockHttp(crawler, url => {
    const page = Number(new URL(url).searchParams.get('p') || 1);
    return `<a href="/pelicula/${page}/${page === 2 ? 'known' : 'sample'}">Sample Castellano</a>` +
      (page < 3 ? `<a rel="next" href="/peliculas?p=${page + 1}">Siguiente</a>` : '');
  });
  await crawler.collectCatalogues(base, 3, sink);
  assert.ok(calls.includes(`${base}/peliculas?p=3`));
  assert.equal(sink.size, 3);
});

// The shared transport/mirror changes apply to all eleven adapters. Verify their
// cheap input guard without network, browser, Supabase or tracker credentials.
for (const name of ['torrentgalaxy', 'dontorrent', 'thepiratebay', 'elitetorrent', 'magnetdl', 'rutracker', 'leech1337x', 'pelispanda', 'wolftorrent', 't0rrenta', 'eztv']) {
  test(`${name}: invalid page budgets never start network I/O`, async () => {
    const crawler = await CRAWLER_REGISTRY[name]();
    mockHttp(crawler, () => { throw new Error('Must not make a request'); });
    for (const budget of [0, -1, NaN, Infinity, 1.5]) assert.deepEqual(await crawler.crawl(budget), []);
  });
}


test('ThePirateBay accepts reordered magnets after malformed links', async () => {
  const crawler = await CRAWLER_REGISTRY.thepiratebay();
  const sink = [];
  crawler.collectHtmlRows(`<table id="searchResult"><tr><td>Movies</td>
    <td><a class="detLink" href="/torrent/1/sample">Sample Castellano</a>
    <a href="magnet:?xt=urn:btih:invalid">bad</a>
    <a href="magnet:?dn=Sample&amp;xt=urn:btih:${HASH}">valid</a></td><td>4</td><td>1</td></tr></table>`,
    'https://tpb.test', new Set(), sink);
  assert.equal(sink.length, 1);
  assert.equal(sink[0].info_hash, HASH);
});

test('Pelispanda skips malformed nested entries without losing valid episodes', async () => {
  const crawler = await CRAWLER_REGISTRY.pelispanda();
  mockHttp(crawler, () => ({ title: 'Sample', downloads: { invalid: true }, seasons: [null,
    { season_number: 1, episodes: [null, { episode_number: 2, downloads: [null,
      { download_link: 123 }, { download_link: MAGNET }] }] }
  ] }));
  const records = await crawler.crawlDetail('series', 'sample', 'https://panda.test');
  assert.equal(records.length, 1);
  assert.equal(records[0].info_hash, HASH);
  assert.equal(records[0].season, 1);
  assert.equal(records[0].episode, 2);
});
