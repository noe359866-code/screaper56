import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { literalDownloadCandidates, spanishReleaseHints } from '../src/crawlers/spanish-catalog.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { SinsitioCrawler } from '../src/crawlers/sinsitio.ts';
import { WolftorrentCrawler } from '../src/crawlers/wolftorrent.ts';
import { DonTorrentCrawler } from '../src/crawlers/dontorrent.ts';
import { EliteTorrentCrawler } from '../src/crawlers/elitetorrent.ts';
import { MejorTorrentCrawler } from '../src/crawlers/mejortorrent.ts';
import { HASH, mockHttp } from './helpers.js';
const magnet = `magnet:?xt=urn:btih:${HASH}`;

test('Spanish fields exclude navigation and recommendations; subtitle-only stays subtitle-only', () => {
  const $ = cheerio.load('<nav><p>Idioma: English</p></nav><div class="related"><p>Idioma: Latino</p></div><p>Subtítulos: Español</p><dl><dt>Calidad:</dt><dd>1080p</dd></dl>');
  assert.deepEqual(spanishReleaseHints($), ['Sub_ES', 'Calidad: 1080p']);
});
test('Literal download buttons support data-file and atob without executing JS', () => {
  const $ = cheerio.load(`<button data-file="/a.torrent" onclick="go(atob('${Buffer.from(magnet).toString('base64')}'))">T</button>`);
  const candidates = literalDownloadCandidates($('button'));
  assert.ok(candidates.includes('/a.torrent'));
  assert.ok(candidates.includes(magnet));
});
for (const Crawler of [SinsitioCrawler, WolftorrentCrawler, DonTorrentCrawler]) {
  test(`${Crawler.name}: download attributes and explicit release language preserved`, () => {
    const detail = new Crawler().parseDetail(`<h1>Sample</h1><p>Idioma: Castellano</p><p>Calidad: 1080p</p><div data-download="${magnet}"></div>`, 'https://example.test/pelicula/123/sample');
    assert.equal(detail.downloads.length, 1);
    assert.ok(detail.downloads[0].hints.includes('Idioma: Castellano'));
    assert.ok(detail.downloads[0].hints.includes('Calidad: 1080p'));
  });
}
test('Sinsitio: language from ficha survives full crawl and language filter', async () => {
  const crawler = new SinsitioCrawler();
  mockHttp(crawler, url => url.endsWith('.html')
    ? `<h1>Sample</h1><p>Subtítulos: Español</p><p>Calidad: 1080p</p><button data-magnet="${magnet}">T</button>`
    : '<a href="/123-sample.html">Sample</a>');
  const records = await crawler.crawl(1);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].audio, []);
  assert.deepEqual(records[0].subtitles, ['Sub_ES']);
  assert.equal(records[0].quality, '1080p');
  assert.equal(crawler.filterSpanishReleases(records).accepted.length, 1);
});
test('EliteTorrent: literal button download and language ficha', async () => {
  const crawler = new EliteTorrentCrawler();
  mockHttp(crawler, () => `<h1>Sample</h1><p>Idioma: Latino</p><button data-download="${magnet}">T</button>`);
  const record = await crawler.parseEliteTorrentDetail('https://example.test/peliculas/sample/', 'https://example.test');
  assert.equal(record.info_hash, HASH);
  assert.deepEqual(record.audio, ['Spanish (Latino)']);
});
test('MejorTorrent: magnet-only releases need no metainfo download', async () => {
  const crawler = new MejorTorrentCrawler();
  const calls = mockHttp(crawler, () => { throw new Error('must not fetch'); });
  const record = await crawler.downloadAndBuildRecord(magnet, 'https://example.test/serie/sample', 'Sample 1x02', 'series', ['Idioma: Latino', 'Calidad: 1080p']);
  assert.equal(record.info_hash, HASH);
  assert.equal(record.episode, 2);
  assert.equal(record.quality, '1080p');
  assert.deepEqual(record.audio, ['Spanish (Latino)']);
  assert.equal(record.torrent_file_url, null);
  assert.equal(calls.length, 0);
});
test('MejorTorrent: disabled WP API falls back to HTML and data-download', async () => {
  const crawler = new MejorTorrentCrawler();
  mockHttp(crawler, url => {
    if (url.includes('/wp-json/')) throw new Error('API disabled');
    if (url.includes('/pelicula/')) return `<h1>Sample</h1><p>Idioma: Castellano</p><button data-download="${magnet}">T</button>`;
    return '<link href="/wp-json/"><a href="/pelicula/sample">Sample</a>';
  });
  const records = await crawler.crawl(1);
  assert.equal(records.length, 1);
  assert.equal(records[0].info_hash, HASH);
});
test('DonTorrent: music and games in homepage are not mislabelled movies', () => {
  const records = new DonTorrentCrawler().parseListing('<a href="/musica/123/sample">Music</a><a href="/juego/124/sample">Game</a><a href="/pelicula/125/sample">Movie</a>', 'https://example.test');
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'movie');
});
for (const [name, create] of Object.entries(CRAWLER_REGISTRY)) {
  test(`${name}: invalid page budgets do not make network requests`, async () => {
    const crawler = await create();
    const calls = mockHttp(crawler, () => { throw new Error('must not fetch'); });
    for (const pages of [0, -1, NaN, 1.5]) assert.deepEqual(await crawler.crawl(pages), []);
    assert.equal(calls.length, 0);
  });
}
test('EliteTorrent: repeated first-page details do not hide the second page', async () => {
  const crawler = new EliteTorrentCrawler();
  const calls = mockHttp(crawler, url => {
    if (/\/series\/sample[12]\/$/.test(url)) {
      return `<h1>Sample Castellano</h1><a href="${url.includes('sample2') ? magnet.replace(HASH, 'a'.repeat(40)) : magnet}">T</a>`;
    }
    return `<a href="/series/sample${url.includes('/page/2/') ? 2 : 1}/">Sample</a>`;
  });
  const records = await crawler.crawl(2);
  assert.equal(records.length, 2);
  assert.ok(calls.some(url => url.endsWith('/series/page/2/')));
});
