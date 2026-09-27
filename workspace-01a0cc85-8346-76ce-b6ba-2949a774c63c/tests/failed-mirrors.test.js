import test from 'node:test';
import assert from 'node:assert/strict';
import { PelispandaCrawler } from '../src/crawlers/pelispanda.ts';
import { MagnetDlCrawler } from '../src/crawlers/magnetdl.ts';
import { RarbgCrawler } from '../src/crawlers/rarbg.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';

for (const Crawler of [PelispandaCrawler, MagnetDlCrawler, RarbgCrawler]) {
  test(`${Crawler.name}: a dead mirror must not become a successful fallback`, async () => {
    const crawler = new Crawler();
    clearMirrorCache(crawler.name);
    crawler.httpClient = { get: async () => { throw new Error('Network unavailable'); } };
    await assert.rejects(crawler.crawl(1), error =>
      /No compatible mirror available/.test(error.message) &&
      /Network unavailable/.test(error.message));
    await crawler.close();
    clearMirrorCache(crawler.name);
  });
}

import { WolftorrentCrawler } from '../src/crawlers/wolftorrent.ts';
import { MirrorResolutionError } from '../src/crawlers/mirrors.ts';
import { diagnoseFailure } from '../src/crawlers/failure-diagnosis.ts';

test('Wolftorrent rejects an unverified mirror rather than retrying catalog pages', async () => {
  const crawler = new WolftorrentCrawler();
  clearMirrorCache(crawler.name);
  let calls = 0;
  crawler.httpClient = { get: async () => { calls++; throw new Error('TLS unavailable'); } };
  await assert.rejects(crawler.crawl(1), /No compatible mirror available/);
  assert.ok(calls <= WolftorrentCrawler.DEFAULT_MIRRORS.length + 1);
  clearMirrorCache(crawler.name);
});

test('diagnoses mirror failures without claiming DNS when errors are mixed', () => {
  const error = new MirrorResolutionError('dontorrent', [
    { mirror: 'https://a.invalid', reason: 'getaddrinfo ENOTFOUND a.invalid' },
    { mirror: 'https://b.invalid', reason: 'Client network socket disconnected' }
  ]);
  assert.equal(diagnoseFailure('dontorrent', error).kind, 'network');
  assert.match(diagnoseFailure('dontorrent', error).advice, /proof-of-work/);
  const dns = new MirrorResolutionError('magnetdl', [
    { mirror: 'https://a.invalid', reason: 'getaddrinfo ENOTFOUND a.invalid' }
  ]);
  assert.equal(diagnoseFailure('magnetdl', dns).kind, 'dns');
});
