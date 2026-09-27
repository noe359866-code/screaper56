/**
 * Regression tests for the hardening pass over the crawlers, the shared
 * transport and the anti-Cloudflare engine. Everything here runs offline: the
 * stealth browser is never launched, only its session cache is exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.DRY_RUN = 'true';

import { CloudflareBypassEngine } from '../src/utils/anti-cloudflare.ts';
import {
  deriveClientHints,
  getHeadersForUserAgent,
  ResilientHttpClient,
  toProfile
} from '../src/utils/http.ts';
import { looksLikeBlockedPage, resolveWorkingMirror } from '../src/crawlers/mirrors.ts';
import { buildTorrentRecord, describeError, mapWithConcurrency } from '../src/crawlers/support.ts';
import { canonicalAudioTag, canonicalSubtitleTag, detectLanguages } from '../src/utils/language.ts';
import { normalizeSource, parseTorrentTitle } from '../src/utils/regex.ts';
import { pageNumberIn } from '../src/crawlers/html-catalog.ts';
import { pelispandaHasSubtitles } from '../src/crawlers/pelispanda.ts';
import { isMejortorrentDownload } from '../src/crawlers/mejortorrent.ts';
import { EztvCrawler } from '../src/crawlers/eztv.ts';
import { YtsCrawler } from '../src/crawlers/yts.ts';
import { ThePirateBayCrawler } from '../src/crawlers/thepiratebay.ts';
import { LimeTorrentsCrawler } from '../src/crawlers/limetorrent.ts';
import { NyaaCrawler } from '../src/crawlers/nyaa.ts';
import { SupabaseTorrentRepository } from '../src/services/supabase.ts';
import { HASH, MAGNET, mockHttp } from './helpers.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const silentLogger = { debug() {}, info() {}, warn() {} };

// ---------------------------------------------------------------------------
// Anti-Cloudflare
// ---------------------------------------------------------------------------

test('Anti-Cloudflare: a cached cf_clearance short-circuits without launching a browser', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  engine.rememberSession('cached.test', {
    cookieHeader: 'cf_clearance=abc123; __cf_bm=xyz',
    userAgent: 'Mozilla/5.0 StealthChromium',
    acceptLanguage: 'es-ES,es;q=0.9',
    solvedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hasClearance: true,
    hostname: 'cached.test'
  });

  const session = engine.getCachedSession('https://cached.test/some/deep/path');
  assert.ok(session);
  assert.equal(session.hasClearance, true);

  // solve() must return the cached clearance instead of spinning up Chromium.
  const started = Date.now();
  const result = await engine.solve('https://cached.test/other');
  assert.equal(result.elapsedMs, 0);
  assert.equal(result.solved, true);
  assert.match(result.cookies, /cf_clearance=abc123/);
  assert.equal(result.userAgent, 'Mozilla/5.0 StealthChromium');
  assert.ok(Date.now() - started < 500, 'a browser was launched for a cached session');
});

test('Anti-Cloudflare: expired sessions are dropped and invalid URLs are rejected', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  engine.rememberSession('stale.test', {
    cookieHeader: 'cf_clearance=old',
    userAgent: 'UA',
    acceptLanguage: 'es-ES',
    solvedAt: Date.now() - 10_000,
    expiresAt: Date.now() - 1,
    hasClearance: true,
    hostname: 'stale.test'
  });

  assert.equal(engine.getCachedSession('https://stale.test/'), null);
  await assert.rejects(engine.solve('not a url'), /Invalid URL/);
});

test('Anti-Cloudflare: the session cache is bounded (no unbounded host growth)', () => {
  const engine = CloudflareBypassEngine.getInstance();
  for (let index = 0; index < 200; index++) {
    engine.rememberSession(`host-${index}.test`, {
      cookieHeader: `cf_clearance=${index}`,
      userAgent: 'UA',
      acceptLanguage: 'es-ES',
      solvedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      hasClearance: true,
      hostname: `host-${index}.test`
    });
  }
  assert.ok(engine.cachedSessionCount <= 48, `cache held ${engine.cachedSessionCount} sessions`);
});

test('Anti-Cloudflare: invalidateSession forgets a clearance the server refused', () => {
  const engine = CloudflareBypassEngine.getInstance();
  engine.rememberSession('refused.test', {
    cookieHeader: 'cf_clearance=refused',
    userAgent: 'UA',
    acceptLanguage: 'es-ES',
    solvedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hasClearance: true,
    hostname: 'refused.test'
  });
  assert.ok(engine.getCachedSession('https://refused.test/latest'));
  engine.invalidateSession('https://refused.test/latest');
  assert.equal(engine.getCachedSession('https://refused.test/latest'), null);
});

test('Anti-Cloudflare: solve(force:true) never reuses a cached clearance', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  engine.rememberSession('forced.test', {
    cookieHeader: 'cf_clearance=forced',
    userAgent: 'UA',
    acceptLanguage: 'es-ES',
    solvedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hasClearance: true,
    hostname: 'forced.test'
  });
  const cached = await engine.solve('https://forced.test/');
  assert.equal(cached.elapsedMs, 0);
  // Forced solves must reach the browser stage; in sandboxes without Chromium
  // this fails at launch, in CI with Chromium installed it fails at DNS
  // navigation (ERR_NAME_NOT_RESOLVED). Both prove the cached session was not
  // reused.
  try {
    await engine.solve('https://forced.test/', { force: true });
    assert.fail('Expected forced solve to throw because it must bypass the cache');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(!message.includes('cf_clearance=forced'), 'cached session was reused despite force:true');
    assert.match(message, /Chromium|browser|launch|ERR_NAME_NOT_RESOLVED|net::|forced\.test|navigation/i);
  }
});

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

test('HTTP: client hints are derived from the UA, never hand-written', () => {
  const chrome = deriveClientHints('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36');
  assert.match(chrome.secChUa, /Chromium";v="133/);
  assert.equal(chrome.secChUaPlatform, '"Windows"');
  assert.equal(chrome.secChUaMobile, '?0');

  const mac = deriveClientHints('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0');
  assert.equal(mac.secChUaPlatform, '"macOS"');

  const edge = deriveClientHints('Mozilla/5.0 Chrome/131.0.0.0 Edg/131.0.0.0');
  assert.match(edge.secChUa, /Microsoft Edge";v="131/);

  // Firefox does not implement Client Hints; sending them is itself a tell.
  assert.equal(deriveClientHints('Mozilla/5.0 (Windows NT 10.0; rv:132.0) Gecko/20100101 Firefox/132.0'), null);

  const headers = getHeadersForUserAgent(toProfile('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0'));
  assert.equal(headers['Sec-Ch-Ua-Platform'], '"Linux"');
  // zstd cannot be decoded by the axios/node transport, so it must not be offered.
  assert.ok(!headers['Accept-Encoding'].includes('zstd'));
});

test('HTTP: the harvested clearance cookies and UA are replayed on the retry', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  const original = engine.solveAndFetch;
  const seen = [];
  engine.solveAndFetch = async () => ({
    html: '',
    cookies: 'cf_clearance=harvested; __cf_bm=bm1',
    userAgent: 'Mozilla/5.0 StealthChromium/999',
    acceptLanguage: 'es-ES,es;q=0.9',
    solved: true,
    finalUrl: 'https://blocked.test/list'
  });

  try {
    const client = new ResilientHttpClient({
      maxRetries: 1,
      baseDelayMs: 0,
      adapter: async config => {
        seen.push({
          cookie: config.headers.Cookie ?? config.headers.cookie,
          userAgent: config.headers['User-Agent'] ?? config.headers['user-agent'],
          acceptLanguage: config.headers['Accept-Language'] ?? config.headers['accept-language']
        });
        const data = seen.length === 1 ? '<title>Just a moment...</title>' : '<article>Real content</article>';
        return { config, status: 200, statusText: 'OK', headers: {}, data };
      }
    });

    const result = await client.get('https://blocked.test/list');
    assert.match(result.data, /Real content/);
    assert.equal(seen.length, 2);

    // The bug being fixed: the bypass result used to be discarded entirely and
    // the retry went out with a fresh random UA and no cookies at all.
    assert.equal(seen[0].cookie, undefined);
    assert.match(seen[1].cookie, /cf_clearance=harvested/);
    assert.equal(seen[1].userAgent, 'Mozilla/5.0 StealthChromium/999');
    assert.match(seen[1].acceptLanguage, /^es-ES/);
  } finally {
    engine.solveAndFetch = original;
  }
});

test('HTTP: solved HTML for the same URL is served without a second request', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  const original = engine.solveAndFetch;
  let calls = 0;
  engine.solveAndFetch = async () => ({
    html: '<html><body><article>Rendered by the browser</article></body></html>',
    cookies: '',
    userAgent: 'UA',
    solved: true,
    finalUrl: 'https://blocked.test/page'
  });

  try {
    const client = new ResilientHttpClient({
      maxRetries: 2,
      baseDelayMs: 0,
      adapter: async config => {
        calls++;
        return { config, status: 200, statusText: 'OK', headers: {}, data: '<title>Just a moment...</title>' };
      }
    });

    const result = await client.get('https://blocked.test/page');
    assert.equal(calls, 1, 'the browser already had the document; axios must not re-request it');
    assert.match(result.data, /Rendered by the browser/);
  } finally {
    engine.solveAndFetch = original;
  }
});

test('HTTP: per-request overrides keep mirror probing fast and browser-free', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  const original = engine.solveAndFetch;
  let solves = 0;
  engine.solveAndFetch = async () => { solves++; return { cookies: 'x', userAgent: 'UA' }; };

  try {
    let attempts = 0;
    const client = new ResilientHttpClient({
      baseDelayMs: 0,
      adapter: async config => {
        attempts++;
        const error = new axios.AxiosError('blocked', 'ERR_BAD_REQUEST', config, {}, {
          status: 403, statusText: 'Forbidden', data: '', headers: {}, config
        });
        throw error;
      }
    });

    await assert.rejects(
      client.get('https://probe.test/', { autoSolveCloudflare: false, maxRetries: 0 }),
      /blocked/
    );
    assert.equal(attempts, 1, 'maxRetries:0 must mean exactly one request');
    assert.equal(solves, 0, 'probing must never launch the stealth browser');
  } finally {
    engine.solveAndFetch = original;
  }
});

test('HTTP: binary payloads are never scanned for challenge markers', async () => {
  const client = new ResilientHttpClient({
    maxRetries: 0,
    adapter: async config => ({
      config, status: 200, statusText: 'OK', headers: {},
      data: Buffer.from('<title>Just a moment...</title>challenge-stage')
    })
  });
  const buffer = await client.getBuffer('https://cdn.test/file.torrent');
  assert.ok(Buffer.isBuffer(buffer));
});

test('HTTP: 429 honours Retry-After instead of the exponential backoff', async () => {
  let calls = 0;
  const client = new ResilientHttpClient({
    maxRetries: 1,
    baseDelayMs: 30_000,
    adapter: async config => {
      calls++;
      if (calls === 1) {
        throw new axios.AxiosError('rate limited', 'ERR_BAD_REQUEST', config, {}, {
          status: 429, statusText: 'Too Many Requests', data: '', headers: { 'retry-after': '0' }, config
        });
      }
      return { config, status: 200, statusText: 'OK', headers: {}, data: 'ok' };
    }
  });

  const started = Date.now();
  assert.equal((await client.get('https://rate.test/')).data, 'ok');
  assert.ok(Date.now() - started < 5_000, 'a 30 s backoff was applied despite Retry-After: 0');
});

// ---------------------------------------------------------------------------
// Mirror resolution
// ---------------------------------------------------------------------------

test('Mirrors: hedged probing does not serialise dead domains and prefers priority', async () => {
  const probed = [];
  const validate = data => typeof data === 'string' && data.includes('table-list');
  const http = {
    get: async url => {
      probed.push(url);
      if (url.startsWith('https://dead.test')) throw new Error('ETIMEDOUT');
      if (url.startsWith('https://slow.test')) { await delay(160); return { status: 200, data: '<table class="table-list"></table>' }; }
      return { status: 200, data: '<table class="table-list"></table>' };
    }
  };

  const started = Date.now();
  const mirror = await resolveWorkingMirror({
    name: 'hedged',
    mirrors: ['https://dead.test', 'https://slow.test', 'https://fast.test'],
    probes: [{ path: '/', validate, timeoutMs: 2_000 }],
    probeStaggerMs: 25,
    logger: silentLogger,
    useCache: false,
    http
  });

  // The higher-priority (lower-index) mirror still wins even when it answers last.
  assert.equal(mirror, 'https://slow.test');
  assert.deepEqual(probed, ['https://dead.test/', 'https://slow.test/', 'https://fast.test/']);
  assert.ok(Date.now() - started < 1_500);
});

test('Mirrors: probes ask for no retries and no Cloudflare escalation', async () => {
  const seen = [];
  await resolveWorkingMirror({
    name: 'probe-flags',
    mirrors: ['https://only.test'],
    probes: [{ path: '/latest100', validate: () => true }],
    logger: silentLogger,
    useCache: false,
    http: { get: async (url, options) => { seen.push(options); return { status: 200, data: 'ok' }; } }
  });

  assert.equal(seen[0].maxRetries, 0);
  assert.equal(seen[0].autoSolveCloudflare, false);
});

test('Mirrors: more WAF/parked markers are recognised', () => {
  for (const html of [
    '<html>Access denied</html>',
    '<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page"></script></html>',
    '<html>DDoS-Guard</html>',
    '<html>Verify you are human</html>',
    '<html>Website is under maintenance</html>'
  ]) {
    assert.equal(looksLikeBlockedPage(html), true, html);
  }
  assert.equal(looksLikeBlockedPage('<html><table class="table-list"><tr><td>Sample</td></tr></table></html>'), false);
});

// ---------------------------------------------------------------------------
// Shared kit
// ---------------------------------------------------------------------------

test('Support: language tags are canonicalised so one language is one tag', () => {
  assert.equal(canonicalAudioTag(' Castellano '), 'Spanish');
  assert.equal(canonicalAudioTag('español'), 'Spanish');
  assert.equal(canonicalAudioTag('Latino'), 'Spanish (Latino)');
  assert.equal(canonicalAudioTag('Spanish ( Latino )'), 'Spanish (Latino)');
  assert.equal(canonicalAudioTag('Inglés'), 'English');
  // Unknown languages are preserved, never silently rewritten.
  assert.equal(canonicalAudioTag('French'), 'French');
  assert.equal(canonicalAudioTag(''), null);

  assert.equal(canonicalSubtitleTag('sub_es'), 'Sub_ES');
  assert.equal(canonicalSubtitleTag('Subtítulos: Español'), 'Sub_ES');
  assert.equal(canonicalSubtitleTag('MultiSubs'), 'Multi-Subs');
  assert.equal(canonicalSubtitleTag('Sub_EN'), 'Sub_EN');

  const record = buildTorrentRecord({
    title: 'Sample', type: 'movie', infoHash: HASH,
    audio: ['Castellano', 'Spanish', 'español'],
    subtitles: ['sub_es', 'Sub_ES']
  });
  assert.deepEqual(record.audio, ['Spanish']);
  assert.deepEqual(record.subtitles, ['Sub_ES']);
});

test('Support: episodic fields reject nonsense, sizes reject zero/negatives', () => {
  const record = buildTorrentRecord({
    title: 'Sample', type: 'movie', infoHash: HASH,
    season: -1, episode: Number.NaN, sizeBytes: 0
  });
  assert.equal(record.season, null);
  assert.equal(record.episode, null);
  assert.equal(record.size_bytes, null);

  const specials = buildTorrentRecord({ title: 'Sample', type: 'series', infoHash: HASH, season: 0, episode: 1 });
  assert.equal(specials.season, 0, 'season 0 (specials) is a real value');
});

test('Support: mapWithConcurrency stops handing out work but never orphans it', async () => {
  let finished = 0;
  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async item => {
      await delay(10);
      finished++;
      if (item === 1) throw new Error('boom');
      return item;
    }),
    /boom/
  );
  // Exactly the two initially in-flight items ran; the queue was not drained
  // after the failure, and nothing kept mutating state after the rejection.
  assert.equal(finished, 2);
});

// ---------------------------------------------------------------------------
// Title parsing
// ---------------------------------------------------------------------------

test('Regex: a year after a dash is not an absolute episode (and not anime)', () => {
  const parsed = parseTorrentTitle('Some Movie - 2020 1080p');
  assert.equal(parsed.absoluteEpisode, null);
  assert.notEqual(parsed.type, 'anime');

  const anime = parseTorrentTitle('[Group] Title - 05 [1080p]');
  assert.equal(anime.absoluteEpisode, 5);
  assert.equal(anime.type, 'anime');
});

test('Regex: an explicit movie hint cannot hide an episodic release', () => {
  assert.equal(parseTorrentTitle('Sample S01E02 1080p', 'movie').type, 'series');
  assert.equal(parseTorrentTitle('Sample 1x02', 'movie').type, 'series');
  assert.equal(parseTorrentTitle('Sample 1080p', 'movie').type, 'movie');
  assert.equal(parseTorrentTitle('Sample 1920x1080 WEB-DL', 'movie').type, 'movie');
});

test('Regex: media sources are normalised instead of upper-cased verbatim', () => {
  assert.equal(normalizeSource('webdl'), 'WEB-DL');
  assert.equal(normalizeSource('WEB-DL'), 'WEB-DL');
  assert.equal(normalizeSource('bdrip'), 'BluRay');
  assert.equal(parseTorrentTitle('Sample WEBDL 1080p').source, 'WEB-DL');
});

// ---------------------------------------------------------------------------
// Crawler-specific regressions
// ---------------------------------------------------------------------------

test('EZTV: HTML pagination advances instead of re-reading /home', async () => {
  const crawler = new EztvCrawler();
  let counter = 0;
  const calls = mockHttp(crawler, url => {
    if (url.includes('/api/')) throw new Error('API disabled');
    counter++;
    const hash = String(counter).padStart(40, '0');
    const label = url.endsWith('/home') ? 'home' : url.split('/').pop();
    return `<table><tr class="forum_header_border"><td></td><td><a class="epinfo" href="/ep/${counter}">Sample ${label}</a></td>
      <td><a class="magnet" href="magnet:?xt=urn:btih:${hash}">M</a></td>
      <td>100 MiB</td><td></td><td><font>3</font></td></tr></table>`;
  });

  const records = await crawler.crawl(3);
  assert.equal(records.length, 3);
  // /home == /page_1, so page 2 must be /page_2 (the old code re-read /page_1).
  assert.ok(calls.some(url => url.endsWith('/page_2')), calls.join(' '));
  assert.ok(calls.some(url => url.endsWith('/page_3')), calls.join(' '));
  assert.ok(!calls.some(url => url.endsWith('/page_1')), '/home and /page_1 are the same listing');
});

test('EZTV: the API season/episode beat title heuristics, and specials survive', () => {
  const crawler = new EztvCrawler();
  const record = crawler.mapApiTorrentToRecord(
    { hash: HASH, title: 'Sample S05E09', season: '1', episode: '2' },
    crawler.baseUrl
  );
  assert.equal(record.season, 1);
  assert.equal(record.episode, 2);

  const specials = crawler.mapApiTorrentToRecord(
    { hash: HASH, title: 'Sample S01E01', season: '0', episode: '3' },
    crawler.baseUrl
  );
  assert.equal(specials.season, 0);

  // A missing id must not produce a dangling `/ep/` URL.
  const noId = crawler.mapApiTorrentToRecord({ hash: HASH, title: 'Sample' }, crawler.baseUrl);
  assert.equal(noId.source_url, null);
});

test('YTS: relative download URLs are stored as absolute', async () => {
  const crawler = new YtsCrawler();
  const movie = {
    id: 1, slug: 'sample', title: 'Sample', year: 2026, language: 'es',
    torrents: [{ hash: HASH, quality: '1080p', type: 'bluray', url: '/download/start/HASH' }]
  };
  mockHttp(crawler, () => ({ status: 'ok', data: { movies: [movie] } }));
  const records = await crawler.crawl(1);
  assert.equal(records[0].torrent_file_url, 'https://yts.mx/download/start/HASH');
});

test('TPB: source URLs never point at the parked thepiratebay.org', () => {
  const crawler = new ThePirateBayCrawler();
  assert.notEqual(crawler.baseUrl, 'https://thepiratebay.org');
  const record = crawler.mapApibayItem({
    id: '42', name: 'Sample Castellano', info_hash: HASH, category: '201',
    seeders: '5', leechers: '1', size: '1000'
  });
  assert.ok(record.source_url.startsWith(ThePirateBayCrawler.DEFAULT_MIRRORS[0]), record.source_url);
  // The "no results" sentinel is filtered regardless of casing/whitespace.
  assert.equal(crawler.mapApibayItem({
    id: '1', name: ' No results returned ', info_hash: HASH,
    category: '201', seeders: '1', leechers: '0', size: '1'
  }), null);
});

test('LimeTorrents: mixed-category feeds are no longer forced to "movie"', async () => {
  const crawler = new LimeTorrentsCrawler();
  // `/latest100` and `/top100` mix movies, TV and anime; forcing 'movie' on
  // every row mislabelled all of them.
  const list = `<table class="table2"><tr><th>Name</th></tr>
    <tr><td><a href="/show-temporada.html">Some Show Temporada 1</a></td><td>1 hour ago</td><td>1.5 GiB</td><td>10</td><td>2</td></tr></table>`;
  mockHttp(crawler, url => url.endsWith('.html')
    ? `<h1>Some Show Temporada 1</h1><a href="${MAGNET}">M</a>`
    : list);
  const records = await crawler.crawl(1);
  assert.equal(records[0].type, 'series');
});

test('Nyaa: a multisub search keeps its subtitle evidence', async () => {
  const crawler = new NyaaCrawler();
  mockHttp(crawler, url => url.includes('q=multisub')
    ? `<table class="torrent-list"><tbody><tr><td></td><td><a href="/view/1#comments">1</a><a href="/view/1" title="Sample Japanese MultiSubs">Sample Japanese MultiSubs</a></td>
       <td><a href="${MAGNET}">M</a></td><td>1 GiB</td><td>date</td><td>5</td><td>2</td></tr></tbody></table>`
    : '<table class="torrent-list"><tbody></tbody></table>');
  const records = await crawler.crawl(1);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'Sample Japanese MultiSubs');
  assert.deepEqual(records[0].subtitles, ['Multi-Subs']);
  assert.deepEqual(records[0].audio, []);
});

test('Pelispanda: falsy subtitle values are not read as "has subtitles"', () => {
  assert.equal(pelispandaHasSubtitles(true), true);
  assert.equal(pelispandaHasSubtitles(2), true);
  assert.equal(pelispandaHasSubtitles('es'), true);
  for (const value of [false, 0, '0', 'no', 'false', '', null, undefined]) {
    assert.equal(pelispandaHasSubtitles(value), false, String(value));
  }
});

test('MejorTorrent: only the site origin or a magnet/.torrent literal is downloaded', () => {
  const page = 'https://mejortorrent.example/pelicula/sample';
  assert.equal(isMejortorrentDownload(MAGNET, MAGNET, page), true);
  assert.equal(isMejortorrentDownload('/files/a.torrent', 'https://mejortorrent.example/files/a.torrent', page), true);
  assert.equal(isMejortorrentDownload('/torrents/1', 'https://mejortorrent.example/torrents/1', page), true);
  assert.equal(isMejortorrentDownload('https://ads.example/x.torrent', 'https://ads.example/x.torrent', page), true);
  // Raw-HTML scans are origin-restricted; link attributes keep their own rules.
  assert.equal(isMejortorrentDownload('/aviso-legal', 'https://mejortorrent.example/aviso-legal', page), false);
  assert.equal(isMejortorrentDownload('javascript:x', 'javascript:x', page), false);
});

test('html-catalog: page numbers are read from query, /page/N/ and trailing /N/', () => {
  assert.equal(pageNumberIn(new URL('https://x.test/peliculas?p=3')), 3);
  assert.equal(pageNumberIn(new URL('https://x.test/peliculas?pagina=2')), 2);
  assert.equal(pageNumberIn(new URL('https://x.test/page/4/')), 4);
  assert.equal(pageNumberIn(new URL('https://x.test/series/2/')), 2);
  assert.equal(pageNumberIn(new URL('https://x.test/peliculas')), null);
  assert.equal(pageNumberIn(new URL('https://x.test/dvdrip/35740-sample.html')), null);
});

test('Supabase: unknown swarm counters are omitted, not zero-filled', () => {
  const repository = new SupabaseTorrentRepository();

  const sanitized = repository.sanitizeRecord({
    type: 'movie', title: 'Sample Castellano', info_hash: HASH,
    audio: ['Spanish'], subtitles: [],
    seeders: null, leechers: null, size_bytes: null
  });
  assert.ok(sanitized);
  // `undefined` keys are dropped by JSON.stringify, so PostgreSQL keeps the
  // column default on INSERT and the stored value on UPDATE.
  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)).seeders, undefined);
  assert.ok(!('seeders' in JSON.parse(JSON.stringify(sanitized))));

  const withCounters = repository.sanitizeRecord({
    type: 'series', title: 'Sample', info_hash: HASH, audio: [], subtitles: [],
    seeders: 12, leechers: 3, size_bytes: 4096
  });
  assert.equal(JSON.parse(JSON.stringify(withCounters)).seeders, 12);
  assert.equal(JSON.parse(JSON.stringify(withCounters)).size_bytes, 4096);
});

test('Language: a bare VOSE tag is subtitle evidence, not a pronoun false positive', () => {
  assert.deepEqual(detectLanguages('Sample VOSE 1080p', [], false).subtitles, ['Sub_ES']);
  assert.deepEqual(detectLanguages('Vosotros Sample', [], false).subtitles, []);
});

test('Support: describeError survives non-Error throwables', () => {
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError('plain string'), 'plain string');
  assert.equal(describeError({ message: 'duck typed' }), 'duck typed');
  assert.equal(describeError({ error: { message: 'nested' } }), 'nested');
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(undefined), 'undefined');
  const circular = { message: '' };
  circular.error = circular;
  assert.ok(describeError(circular).length > 0, 'circular throwables must not hang');
  assert.ok(!describeError({}).includes('[object Object]'));
});
