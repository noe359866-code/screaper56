import test from 'node:test';
import assert from 'node:assert/strict';
import { PelispandaCrawler } from '../src/crawlers/pelispanda.ts';
import { Leech1337xCrawler } from '../src/crawlers/leech1337x.ts';
import { TorrentGalaxyCrawler } from '../src/crawlers/torrentgalaxy.ts';
import { YtsCrawler } from '../src/crawlers/yts.ts';
import { EztvCrawler } from '../src/crawlers/eztv.ts';
import { ThePirateBayCrawler } from '../src/crawlers/thepiratebay.ts';
import { MejorTorrentCrawler } from '../src/crawlers/mejortorrent.ts';
import { EliteTorrentCrawler } from '../src/crawlers/elitetorrent.ts';
import { LimeTorrentsCrawler } from '../src/crawlers/limetorrent.ts';
import { NyaaCrawler } from '../src/crawlers/nyaa.ts';
import { parseMagnetUri } from '../src/utils/magnet.ts';
import { mockHttp, torrent, HASH, HASH2, MAGNET } from './helpers.js';

test('Pelispanda: API episodes preserve season/episode/quality; no invented swarm counts', async () => {
  const crawler = new PelispandaCrawler();
  mockHttp(crawler, url => {
    if (url.includes('/serie/')) return {
      title: 'Sample', seasons: [{ season_number: 2, episodes: [{ episode_number: 3,
        downloads: [{ download_link: `magnet:?xt=urn:btih:${HASH}`, quality: '1080p', language: 'Castellano', subs: true }]
      }] }]
    };
    if (url.includes('/series?')) return { series: [{ slug: 'sample' }] };
    return [];
  });
  const [record] = await crawler.crawl(1);
  assert.equal(record.type, 'series'); assert.equal(record.season, 2); assert.equal(record.episode, 3);
  assert.equal(record.quality, '1080p'); assert.equal(record.seeders, null); assert.equal(record.leechers, null);
  assert.ok(record.subtitles.includes('Sub_ES'));
});
test('1337x: text-node language/category fields and deduplicated detail visits', async () => {
  const crawler = new Leech1337xCrawler();
  const detail = '/torrent/1/sample/';
  const listing = `<table class="table-list"><tbody><tr><td class="name"><a href="${detail}">Sample</a></td>
    <td class="seeds">1,234</td><td class="leeches">12</td><td class="size">1.5 GB <span>1234</span></td></tr></tbody></table>`;
  const calls = mockHttp(crawler, url => url.endsWith(detail)
    ? `<div class="torrent-category-detail"><ul><li><strong>Category</strong>Anime</li><li><strong>Language</strong>Spanish</li></ul></div><a href="${MAGNET}">Download</a>`
    : listing);
  const [record] = await crawler.crawl(2);
  assert.equal(record.type, 'anime'); assert.ok(record.audio.includes('Spanish'));
  assert.equal(record.seeders, 1234); assert.equal(record.size_bytes, 1610612736);
  assert.equal(calls.filter(url => url.endsWith(detail)).length, 1);
});
test('TGX: one title only, size by cell, no inferred Latino from Spanish search', () => {
  const crawler = new TorrentGalaxyCrawler();
  const html = `<div class="tgxtablerow"><div class="tgxtablecell"><a href="/torrent/1/Sample" title="Sample Castellano">Sample</a><a href="/torrent/1/Sample#comments">Comments</a></div>
  <div class="tgxtablecell">1.5 GiB</div><a href="${MAGNET}">M</a><span class="seeders">1,234</span><span class="leechers">5</span></div>`;
  const [record] = crawler.parseTorrentGalaxyHtml(html, 'https://tgx.example/torrents.php?search=spanish&cat=41', 'https://tgx.example');
  assert.equal(record.title, 'Sample Castellano'); assert.equal(record.type, 'movie');
  assert.equal(record.size_bytes, 1610612736); assert.equal(record.seeders, 1234);
  assert.deepEqual(record.audio, ['Spanish']);
});
test('YTS: API schema/hash validation, native es vs es-mx vs fr, actual audio channels', async () => {
  const crawler = new YtsCrawler();
  const movie = (language, hash) => ({ title: 'Sample', title_english: 'Sample', year:2026, language,
    torrents:[{ hash, quality:'1080p', type:'bluray', video_codec:'x265', audio_channels:'5.1' }] });
  mockHttp(crawler, () => ({status:'ok', data:{ movies: [movie('es', HASH), movie('es-mx', HASH2), movie('fr', 'b'.repeat(40)), movie('es','bad')] }}));
  const records = await crawler.crawl(1);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0].audio, ['Spanish']); assert.equal(records[0].channels, '5.1');
  assert.deepEqual(records[1].audio, ['Spanish (Latino)']);
  assert.deepEqual(records[2].audio, []);
});
test('YTS: parked HTML is not an API mirror', async () => {
  const crawler = new YtsCrawler(); mockHttp(crawler, () => '<html>domain for sale</html>');
  await assert.rejects(crawler.crawl(1), /No compatible mirror/);
});
test('EZTV: HTML fallback still works when API discovery fails', async () => {
  const crawler = new EztvCrawler();
  mockHttp(crawler, url => {
    if (url.includes('/api/')) throw new Error('API disabled');
    return `<table><tr class="forum_header_border"><td></td><td><a class="epinfo" href="/ep/1/sample">Sample S01E02 Castellano</a></td>
    <td><a class="magnet" href="${MAGNET}">M</a><a class="download_1" href="/files/sample.torrent">T</a></td><td>650 MiB</td><td></td><td><font>24</font></td></tr></table>`;
  });
  const [record] = await crawler.crawl(1);
  assert.equal(record.episode, 2); assert.equal(record.seeders, 24);
  assert.equal(record.torrent_file_url, 'https://eztv1.xyz/files/sample.torrent');
  assert.equal(record.size_bytes, 681574400);
});
test('EZTV: missing episode values stay null rather than becoming zero', () => {
  const crawler = new EztvCrawler();
  const record = crawler.mapApiTorrentToRecord({ hash: HASH, title:'Sample', imdb_id:'1234567' }, crawler.baseUrl);
  assert.equal(record.season, null); assert.equal(record.episode, null);
  assert.equal(record.imdb_id, 'tt1234567');
  assert.equal(crawler.mapApiTorrentToRecord({ hash: 'bad', title: 'Sample' }, crawler.baseUrl), null);
});
test('TPB: ignore non-video APiBay results and sentinel hashes; TV category is series', () => {
  const crawler = new ThePirateBayCrawler();
  const item = { id:'1', name:'Sample Castellano', info_hash:HASH, category:'208', seeders:'4', leechers:'1', size:'42' };
  assert.equal(crawler.mapApibayItem(item).type, 'series');
  assert.equal(crawler.mapApibayItem({ ...item, category:'300' }), null);
  assert.equal(crawler.mapApibayItem({ ...item, info_hash:'0'.repeat(40) }), null);
});
test('MejorTorrent: shared validated bencode, Referer, no hard-coded title exclusion or counts', async () => {
  const crawler = new MejorTorrentCrawler();
  const file = torrent('Sample Castellano 1x02');
  mockHttp(crawler, (_, options) => { assert.equal(options.headers.Referer, 'https://mejor.example/serie/sample'); return file.buffer; });
  const record = await crawler.downloadAndBuildRecord('https://mejor.example/a.torrent', 'https://mejor.example/serie/sample', 'Sample', 'series');
  assert.equal(record.info_hash, file.hash); assert.equal(record.episode, 2); assert.equal(record.seeders, null);
  assert.equal(record.size_bytes, 42);
});
test('EliteTorrent: Base32 magnets and quality/codec fields outside h1', async () => {
  const crawler = new EliteTorrentCrawler();
  const magnet = `magnet:?xt=urn:btih:${'B'.repeat(32)}`;
  mockHttp(crawler, () => `<h1>Descargar Sample 1x03 por torrent</h1><p class="descrip"><span>Tamaño: 1,5 GB</span><span>Idioma: Castellano</span><span>Calidad: 1080p</span><span>Formato: x265</span></p><a href="${magnet}">M</a>`);
  const record = await crawler.parseEliteTorrentDetail('https://elite.example/series/sample/', 'https://elite.example');
  assert.equal(record.info_hash, parseMagnetUri(magnet).infoHash);
  assert.equal(record.episode, 3); assert.equal(record.codec, 'HEVC/x265'); assert.equal(record.size_bytes, 1610612736);
});
test('EliteTorrent: relative .torrent with query is resolved against detail URL', async () => {
  const crawler = new EliteTorrentCrawler(); const file = torrent();
  const calls = mockHttp(crawler, url => url.includes('.torrent?') ? file.buffer : '<h1>Sample Castellano</h1><a href="../../files/a.torrent?token=abc">T</a>');
  const record = await crawler.parseEliteTorrentDetail('https://elite.example/peliculas/sample/', 'https://elite.example');
  assert.equal(record.info_hash, file.hash);
  assert.ok(calls.includes('https://elite.example/files/a.torrent?token=abc'));
});
test('LimeTorrents: age column does not shift size/seeders/leechers', async () => {
  const crawler = new LimeTorrentsCrawler();
  const list = '<table class="table2"><tr><th>Name</th></tr><tr><td><div class="tt-name"><a href="/sample.html">Sample Castellano</a></div></td><td>3 hours ago</td><td>1.5 GiB</td><td>123</td><td>7</td></tr></table>';
  mockHttp(crawler, url => url.endsWith('/sample.html') ? `<h1>Sample Castellano</h1><a href="${MAGNET}">M</a>` : list);
  const [record] = await crawler.crawl(1);
  assert.equal(record.size_bytes, 1610612736); assert.equal(record.seeders, 123); assert.equal(record.leechers, 7);
});
test('Nyaa: MultiSubs search does not manufacture Spanish audio; GiB size retained', async () => {
  const crawler = new NyaaCrawler();
  mockHttp(crawler, url => url.includes('q=multisub') ? `<table class="torrent-list"><tbody><tr><td></td><td><a class="comments" href="/view/1#comments">1</a><a href="/view/1">Sample Japanese MultiSubs</a></td><td><a href="${MAGNET}">M</a><a href="/download/1.torrent">T</a></td><td>1 GiB</td><td>date</td><td>5</td><td>2</td></tr></tbody></table>` : '<table class="torrent-list"><tbody></tbody></table>');
  const [record] = await crawler.crawl(1);
  assert.deepEqual(record.audio, []); assert.deepEqual(record.subtitles, ['Multi-Subs']);
  assert.equal(record.size_bytes, 1073741824); assert.equal(record.type, 'anime');
});
