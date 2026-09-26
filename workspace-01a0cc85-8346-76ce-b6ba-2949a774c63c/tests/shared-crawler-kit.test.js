import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMirrorPool,
  clearMirrorCache,
  dedupeMirrors,
  extractBrandMirrors,
  getCachedMirror,
  htmlMarkerValidator,
  looksLikeBlockedPage,
  MirrorResolutionError,
  normalizeMirror,
  parseMirrorList,
  resolveWorkingMirror
} from '../src/crawlers/mirrors.ts';
import {
  buildTorrentRecord,
  Deadline,
  dedupeStrings,
  mapWithConcurrency,
  mergeRecords,
  parseCount,
  recordScore,
  absoluteHttpUrl,
  isBlockedTitle,
  sameOrigin
} from '../src/crawlers/support.ts';
import { HASH, HASH2 } from './helpers.js';

const httpFrom = handler => ({
  get: async (url, options) => ({ status: 200, data: await handler(url, options) })
});
const silentLogger = { debug() {}, info() {}, warn() {} };

test('Mirrors: normalisation, env precedence and deduplication of the candidate pool', () => {
  assert.equal(normalizeMirror('dontorrent.moi/'), 'https://dontorrent.moi');
  assert.equal(normalizeMirror(' https://Example.com/base/ '), 'https://example.com/base');
  for (const bad of ['', null, 'ftp://example.com', 'https://user:pass@example.com', 'localhost', 'not a url']) {
    assert.equal(normalizeMirror(bad), null, String(bad));
  }

  assert.deepEqual(parseMirrorList('a.com, https://b.com  c.com;a.com'), [
    'https://a.com', 'https://b.com', 'https://c.com'
  ]);
  assert.deepEqual(dedupeMirrors(['https://A.com', 'https://a.com/', null]), ['https://a.com']);

  const pool = buildMirrorPool({
    name: 'demo',
    envPrefix: 'DEMO',
    defaults: ['https://default.com', 'https://pinned.com'],
    extra: ['https://discovered.com'],
    env: { DEMO_BASE_URL: 'https://pinned.com', DEMO_MIRRORS: 'https://configured.com, https://pinned.com' }
  });
  // BASE_URL first, then _MIRRORS, then runtime discoveries, then shipped defaults.
  assert.deepEqual(pool, [
    'https://pinned.com', 'https://configured.com', 'https://discovered.com', 'https://default.com'
  ]);
});

test('Mirrors: parked, blocked and challenge pages never win a probe', async () => {
  clearMirrorCache();
  const validate = htmlMarkerValidator([/table-list/]);

  assert.equal(validate('<html><body>Just a moment... <div id="challenge-stage"></div></body></html>'), false);
  assert.equal(validate('<html>This domain is for sale, buy this domain</html>'), false);
  assert.equal(validate('<html><table class="table-list"></table></html>'), true);
  assert.equal(validate(''), false);
  assert.equal(validate({ table: 'list' }), false);
  assert.equal(looksLikeBlockedPage('<h1>Acceso bloqueado</h1>'), true);

  const probed = [];
  const mirror = await resolveWorkingMirror({
    name: 'demo',
    mirrors: ['https://parked.com', 'https://blocked.com', 'https://good.com', 'https://never.com'],
    logger: silentLogger,
    probes: [{ path: '/latest', validate }],
    http: httpFrom(url => {
      probed.push(url);
      if (url.startsWith('https://parked.com')) return '<html>Domain for sale</html>';
      if (url.startsWith('https://blocked.com')) throw new Error('ETIMEDOUT');
      return '<html><table class="table-list"><tr></tr></table></html>';
    })
  });

  assert.equal(mirror, 'https://good.com');
  assert.deepEqual(probed, ['https://parked.com/latest', 'https://blocked.com/latest', 'https://good.com/latest']);
  // The winner is cached for the rest of the process, so later runs start there.
  assert.equal(getCachedMirror('demo'), 'https://good.com');
  clearMirrorCache('demo');
  assert.equal(getCachedMirror('demo'), null);
});

test('Mirrors: total failure reports every reason, or returns the fallback when allowed', async () => {
  clearMirrorCache();
  const options = {
    name: 'demo',
    mirrors: ['https://one.com', 'https://two.com'],
    logger: silentLogger,
    probes: [{ path: '/', validate: () => false }],
    http: httpFrom(() => '<html>nope</html>'),
    useCache: false
  };

  const error = await resolveWorkingMirror(options).then(() => null, err => err);
  assert.ok(error instanceof MirrorResolutionError);
  assert.equal(error.attempts.length, 2);
  assert.match(error.message, /DEMO_BASE_URL or DEMO_MIRRORS/);

  const fallback = await resolveWorkingMirror({ ...options, fallback: 'https://last-resort.com/' });
  assert.equal(fallback, 'https://last-resort.com');
});

test('Mirrors: official domain lists only contribute hosts of the same brand', () => {
  const html = `<a href="https://dontorrent.moi">Actual</a>
    <a href="https://dontorrent.wtf/peliculas">Censurado</a>
    <a href="https://dontorrent.moi/dominios">Repetido</a>
    <a href="https://t.me/s/DonTorrent">Telegram</a>
    <a href="https://ads.example/dontorrent">Anuncio</a>`;

  assert.deepEqual(extractBrandMirrors(html, /(^|\.)dontorrent\.[a-z]{2,}$/i, 10), [
    'https://dontorrent.moi', 'https://dontorrent.wtf'
  ]);
  assert.deepEqual(extractBrandMirrors('', /x/), []);
});

test('Support: records validate the hash and keep unknown swarm counters as null', () => {
  assert.equal(buildTorrentRecord({ title: 'x', type: 'movie', infoHash: '0'.repeat(40) }), null);
  assert.equal(buildTorrentRecord({ title: 'x', type: 'movie', infoHash: 'not-a-hash' }), null);
  assert.equal(buildTorrentRecord({ title: '   ', type: 'movie', infoHash: HASH }), null);

  const record = buildTorrentRecord({
    title: ' Sample Castellano 1080p ',
    type: 'movie',
    infoHash: HASH.toUpperCase(),
    trackers: ['udp://tracker.example/announce', 'udp://tracker.example/announce'],
    audio: ['Spanish', 'Spanish'],
    sizeBytes: -5,
    seeders: null
  });

  assert.equal(record.info_hash, HASH);
  assert.equal(record.title, 'Sample Castellano 1080p');
  assert.match(record.magnet_url, new RegExp(`^magnet:\\?xt=urn:btih:${HASH}`));
  assert.deepEqual(record.audio, ['Spanish']);
  assert.equal(record.source_tracker, 'udp://tracker.example/announce');
  assert.equal(record.size_bytes, null);
  assert.equal(record.seeders, null);
  assert.equal(record.leechers, null);
});

test('Support: duplicate merging prefers the richer record and fills its gaps', () => {
  const poor = buildTorrentRecord({ title: 'Sample', type: 'movie', infoHash: HASH, subtitles: ['Sub_ES'] });
  const rich = buildTorrentRecord({
    title: 'Sample Castellano 1080p', type: 'movie', infoHash: HASH,
    imdbId: 'tt1234567', sizeBytes: 1024, seeders: 12, quality: '1080p', audio: ['Spanish']
  });

  assert.ok(recordScore(rich) > recordScore(poor));
  const merged = mergeRecords(rich, poor);
  assert.equal(merged.imdb_id, 'tt1234567');
  assert.equal(merged.seeders, 12);
  assert.deepEqual(merged.audio, ['Spanish']);
  assert.deepEqual(merged.subtitles, ['Sub_ES']);
  assert.notEqual(merged.info_hash, HASH2);
});

test('Support: counters, URLs, titles and deadlines behave predictably', async () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1 234'), 1234);
  assert.equal(parseCount(42), 42);
  for (const bad of ['N/A', '', null, undefined, -3, '-7']) assert.equal(parseCount(bad), null, String(bad));

  assert.equal(absoluteHttpUrl('/a?b=1#frag', 'https://site.com/x/'), 'https://site.com/a?b=1');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '#top', '']) {
    assert.equal(absoluteHttpUrl(bad, 'https://site.com'), null, bad);
  }
  assert.equal(sameOrigin('https://site.com/a', 'https://site.com/b'), true);
  assert.equal(sameOrigin('https://site.com', 'https://other.com'), false);

  assert.equal(isBlockedTitle('Some XXX release'), true);
  assert.equal(isBlockedTitle('Poli malo 2025'), false);
  assert.deepEqual(dedupeStrings([' a ', 'A', null, '', 'b']), ['a', 'b']);

  assert.equal(new Deadline(0).enabled, false);
  assert.equal(new Deadline(0).expired, false);
  const deadline = new Deadline(20);
  assert.equal(deadline.enabled, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(deadline.expired, true);
  assert.equal(deadline.remainingMs, 0);
});

test('Support: bounded concurrency preserves order and never exceeds its limit', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 9 }, (_, index) => index);

  const results = await mapWithConcurrency(items, 3, async index => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return index * 2;
  });

  assert.deepEqual(results, items.map(index => index * 2));
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});
