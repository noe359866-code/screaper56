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
import { TokyoToshoCrawler } from '../src/crawlers/tokyotosho.ts';
import { parseMagnetUri } from '../src/utils/magnet.ts';
import { mockHttp, torrent, HASH, HASH2, MAGNET } from './helpers.js';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';

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
test('Pelispanda: missing episode numbers are not fabricated as S01E01', async () => {
  const crawler = new PelispandaCrawler();
  mockHttp(crawler, url => {
    if (url.includes('/serie/')) return {
      title: 'Unknown Episode',
      seasons: [{ episodes: [{ downloads: [{ download_link: MAGNET, quality: '1080p' }] }] }]
    };
    if (url.includes('/series?')) return [{ slug: 'unknown-episode' }];
    return [];
  });

  const [record] = await crawler.crawl(1);
  assert.equal(record.season, null);
  assert.equal(record.episode, null);
  assert.doesNotMatch(record.title, /S01E01/);
});


test('Pelispanda: rejects off-site, downgraded and alternate-port metainfo URLs before fetching', async () => {
  const crawler = new PelispandaCrawler();
  const calls = mockHttp(crawler, url => { throw new Error(`unexpected download request: ${url}`); });
  const sourceUrl = 'https://panda.test/wp-json/wpreact/v1/movie/sample';
  for (const download_link of [
    'https://ads.example/files/sample.torrent',
    'https://user:pass@panda.test/files/sample.torrent',
    'http://panda.test/files/sample.torrent',
    'https://panda.test:444/files/sample.torrent'
  ]) {
    const record = await crawler.buildRecord(
      { download_link }, sourceUrl, 'movie', 'Sample Castellano', null, null
    );
    assert.equal(record, null, download_link);
  }
  assert.deepEqual(calls, [], 'rejected URLs are never requested');
});

test('Pelispanda: same-site metainfo accepts query parameters and www/apex equivalence', async () => {
  const crawler = new PelispandaCrawler();
  const file = torrent('Sample Castellano 1080p');
  const expectedUrl = 'https://www.panda.test/files/sample.torrent?token=abc';
  const calls = mockHttp(crawler, url => {
    assert.equal(url, expectedUrl);
    return file.buffer;
  });
  const record = await crawler.buildRecord(
    { download_link: expectedUrl },
    'https://panda.test/wp-json/wpreact/v1/movie/sample',
    'movie', 'Sample Castellano', null, null
  );
  assert.equal(record.info_hash, file.hash);
  assert.equal(record.torrent_file_url, expectedUrl);
  assert.deepEqual(calls, [expectedUrl]);
});

test('Pelispanda: malformed catalog responses after a valid probe are reported', async () => {
  const previousBase = process.env.PELISPANDA_BASE_URL;
  const mirror = 'https://panda-shape.test';
  process.env.PELISPANDA_BASE_URL = mirror;
  clearMirrorCache('pelispanda');
  try {
    const crawler = new PelispandaCrawler();
    let probeCalls = 0;
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/wp-json/wpreact/v1/movies?page=1` && probeCalls++ === 0) return [];
      return { error: [] };
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
    assert.equal(calls.filter(url => url === `${mirror}/wp-json/wpreact/v1/movies?page=1`).length, 2);
  } finally {
    if (previousBase === undefined) delete process.env.PELISPANDA_BASE_URL;
    else process.env.PELISPANDA_BASE_URL = previousBase;
    clearMirrorCache('pelispanda');
  }
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
test('EliteTorrent: off-site .torrent links are not fetched', async () => {
  const crawler = new EliteTorrentCrawler();
  const calls = mockHttp(crawler, url => {
    if (url.includes('evil.example')) throw new Error('off-site torrent must not be requested');
    return '<h1>Sample Castellano</h1><a href="https://evil.example/ad.torrent">T</a>';
  });
  const record = await crawler.parseEliteTorrentDetail('https://elite.example/series/sample/', 'https://elite.example');
  assert.equal(record, null);
  assert.deepEqual(calls, ['https://elite.example/series/sample/']);
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
  assert.equal(record.source_tracker, null, 'a tracker absent from the source magnet is not fabricated');
});

test('1337x: duplicate listing pages do not hide later published pages', async () => {
  const previousBase = process.env.LEECH1337X_BASE_URL;
  const mirror = 'https://leech-pages.test';
  process.env.LEECH1337X_BASE_URL = mirror;
  clearMirrorCache('leech1337x');
  try {
    const crawler = new Leech1337xCrawler();
    const row = id => `<tr><td class="name"><a href="/torrent/${id}/sample">Sample ${id} Castellano 1080p</a></td>
      <td class="seeds">12</td><td class="leeches">3</td><td class="size">1.5 GB</td></tr>`;
    const listing = (rows = '', pager = '') => `<table class="table-list"><tbody>${rows}</tbody></table>${pager}`;
    const pageOne = `${mirror}/sort-search/spanish/seeders/desc/1/`;
    const pageTwo = `${mirror}/sort-search/spanish/seeders/desc/2/`;
    const pageThree = `${mirror}/sort-search/spanish/seeders/desc/3/`;
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/`) return listing(row('probe'));
      if (url.includes('/torrent/')) {
        const hash = url.includes('/torrent/2/') ? HASH2 : HASH;
        return `<h1>Sample Castellano 1080p</h1><a href="magnet:?xt=urn:btih:${hash}">Magnet</a>`;
      }
      if (url === pageOne) return listing(row('1'), '<div class="pagination"><a href="/sort-search/spanish/seeders/desc/2/">2</a></div>');
      if (url === pageTwo) return listing(row('1'), '<div class="pagination"><a href="/sort-search/spanish/seeders/desc/3/">3</a></div>');
      if (url === pageThree) return listing(row('2'));
      return listing();
    });

    const records = await crawler.crawl(3);
    assert.ok(calls.includes(pageThree), 'page three is followed despite page two having only duplicate releases');
    assert.equal(calls.filter(url => url === `${mirror}/torrent/1/sample`).length, 1);
    assert.equal(records.length, 2);
    assert.ok(records.some(record => record.info_hash === HASH2));
  } finally {
    if (previousBase === undefined) delete process.env.LEECH1337X_BASE_URL;
    else process.env.LEECH1337X_BASE_URL = previousBase;
    clearMirrorCache('leech1337x');
  }
});

test('1337x: skips malformed magnets, preserves hash-only releases without fake trackers and validates torrent links', async () => {
  const previousBase = process.env.LEECH1337X_BASE_URL;
  const mirror = 'https://leech-details.test';
  process.env.LEECH1337X_BASE_URL = mirror;
  clearMirrorCache('leech1337x');
  try {
    const crawler = new Leech1337xCrawler();
    const row = (id, title) => `<tr><td class="name"><a href="/torrent/${id}/sample">${title}</a></td>
      <td class="seeds">4</td><td class="leeches">2</td><td class="size">700 MiB</td></tr>`;
    const listing = rows => `<table class="table-list"><tbody>${rows}</tbody></table>`;
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/`) return listing(row('probe', 'Probe Castellano'));
      if (url.endsWith('/torrent/1/sample')) return `<h1>Sample One Castellano</h1>
        <a href="magnet:?xt=urn:btih:invalid">bad</a>
        <a href="magnet:?xt=urn:btih:${HASH}">valid</a>
        <a href="https://ads.example/ad.torrent">advert</a>
        <a href="/downloads/one.torrent?token=abc">torrent</a>`;
      if (url.endsWith('/torrent/2/sample')) return `<h1>Sample Two Castellano</h1>
        <ul class="torrent-category-detail"><li><strong>Infohash:</strong><span>${HASH2}</span></li>
        <li><strong>Category:</strong><span>Movies</span></li></ul>`;
      if (url.endsWith('/torrent/3/sample')) return `<h1>Sample Three Spanish</h1>
        <ul class="torrent-category-detail"><li><strong>Category:</strong><span>Games</span></li></ul>
        <a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111">Magnet</a>`;
      if (url === `${mirror}/sort-search/spanish/seeders/desc/1/`) {
        return listing(row('1', 'Sample One Castellano') + row('2', 'Sample Two Castellano') + row('3', 'Sample Three Spanish'));
      }
      return listing();
    });

    const records = await crawler.crawl(1);
    const fromMagnet = records.find(record => record.info_hash === HASH);
    const fromHash = records.find(record => record.info_hash === HASH2);
    assert.equal(records.length, 2, 'game-category releases are not stored as movies');
    assert.ok(calls.includes(`${mirror}/torrent/3/sample`));
    assert.equal(fromMagnet.torrent_file_url, `${mirror}/downloads/one.torrent?token=abc`);
    assert.equal(fromMagnet.source_tracker, null);
    assert.equal(fromHash.source_tracker, null);
    assert.doesNotMatch(fromHash.magnet_url, /[?&]tr=/, 'hash-only pages do not get invented trackers');
    assert.ok(calls.includes(`${mirror}/torrent/1/sample`));
    assert.ok(calls.includes(`${mirror}/torrent/2/sample`));
    assert.ok(calls.every(url => !url.includes('ads.example')));
  } finally {
    if (previousBase === undefined) delete process.env.LEECH1337X_BASE_URL;
    else process.env.LEECH1337X_BASE_URL = previousBase;
    clearMirrorCache('leech1337x');
  }
});

test('1337x: catalog failures after a successful probe are surfaced', async () => {
  const previousBase = process.env.LEECH1337X_BASE_URL;
  const mirror = 'https://leech-flaky.test';
  process.env.LEECH1337X_BASE_URL = mirror;
  clearMirrorCache('leech1337x');
  try {
    const crawler = new Leech1337xCrawler();
    mockHttp(crawler, url => {
      if (url === `${mirror}/`) return '<table class="table-list"><tr><td><a href="/torrent/probe/sample">probe</a></td></tr></table>';
      return '<title>Access Denied</title>';
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.LEECH1337X_BASE_URL;
    else process.env.LEECH1337X_BASE_URL = previousBase;
    clearMirrorCache('leech1337x');
  }
});

test('Nyaa: search terms do not invent audio and source/download links stay on the mirror', () => {
  const crawler = new NyaaCrawler();
  const mirror = 'https://nyaa.test';
  const row = (id, title, hash, viewHref, downloadHref, extraMagnets = '') => `<tr>
    <td><img title="Anime - English-translated"></td>
    <td><a href="${viewHref}">${title}</a></td>
    <td>${extraMagnets}<a href="magnet:?xt=urn:btih:${hash}">M</a><a href="${downloadHref}">T</a></td>
    <td>1.5 GiB</td><td>date</td><td>5</td><td>2</td></tr>`;
  const html = `<table class="torrent-list"><tbody>
    ${row('1', '[Subs ESP] Sample Japanese', HASH, 'https://www.nyaa.test/view/1',
      'https://www.nyaa.test/download/1.torrent?token=abc', '<a href="magnet:?xt=urn:btih:invalid">bad</a>')}
    ${row('2', 'Sample Japanese 2', HASH2, 'https://ads.example/view/2', 'https://ads.example/download/2.torrent')}
    ${row('3', 'Sample Japanese 3', 'cccccccccccccccccccccccccccccccccccccccc', 'http://nyaa.test/view/3', 'http://nyaa.test/download/3.torrent')}
  </tbody></table>`;

  const records = crawler.parseRows(html, `${mirror}/?f=0&c=0_0&q=spanish`, mirror, '/?f=0&c=0_0&q=spanish');
  assert.equal(records.length, 3);
  const spanishSearch = records.find(record => record.info_hash === HASH);
  assert.deepEqual(spanishSearch.audio, [], 'q=spanish is not evidence of Spanish audio');
  assert.ok(spanishSearch.subtitles.includes('Sub_ES'));
  assert.equal(spanishSearch.source_url, 'https://www.nyaa.test/view/1');
  assert.equal(spanishSearch.torrent_file_url, 'https://www.nyaa.test/download/1.torrent?token=abc');
  const offSite = records.find(record => record.info_hash === HASH2);
  assert.equal(offSite.source_url, `${mirror}/?f=0&c=0_0&q=spanish`);
  assert.equal(offSite.torrent_file_url, null);
  const downgraded = records.find(record => record.info_hash.startsWith('c'.repeat(40)));
  assert.equal(downgraded.source_url, `${mirror}/?f=0&c=0_0&q=spanish`);
  assert.equal(downgraded.torrent_file_url, null);
});

test('Nyaa: full raw pages continue even when all rows are filtered out', async () => {
  const crawler = new NyaaCrawler();
  const mirror = 'https://nyaa-pages.test';
  const row = (category, title, hash) => `<tr><td><img title="${category}"></td>
    <td><a href="/view/${hash}">${title}</a></td>
    <td><a href="magnet:?xt=urn:btih:${hash}">M</a></td><td>1 GiB</td><td>date</td><td>1</td><td>0</td></tr>`;
  const fullFilteredPage = `<table class="torrent-list"><tbody>${Array.from({ length: 75 }, (_, index) =>
    row('Audio - Lossless', `Album ${index}`, (index + 1).toString(16).padStart(40, 'a').slice(-40))
  ).join('')}</tbody></table>`;
  const laterRelease = `<table class="torrent-list"><tbody>${row('Anime - Raw', 'Sample Japanese', HASH)}</tbody></table>`;
  const firstCategory = `${mirror}/?f=0&c=1_2&p=1`;
  const secondPage = `${mirror}/?f=0&c=1_2&p=2`;
  const previousBase = process.env.NYAA_BASE_URL;
  process.env.NYAA_BASE_URL = mirror;
  clearMirrorCache('nyaa');
  try {
    const calls = mockHttp(crawler, url => {
      if (url === firstCategory) return fullFilteredPage;
      if (url === secondPage) return laterRelease;
      return '<table class="torrent-list"><tbody></tbody></table>';
    });
    const records = await crawler.crawl(2);
    assert.ok(calls.includes(secondPage), 'raw row count, not parsed video count, determines whether page 2 is needed');
    assert.equal(records.length, 1);
    assert.equal(records[0].info_hash, HASH);
  } finally {
    if (previousBase === undefined) delete process.env.NYAA_BASE_URL;
    else process.env.NYAA_BASE_URL = previousBase;
    clearMirrorCache('nyaa');
  }
});

test('Nyaa: blocked catalog pages after a successful probe are reported', async () => {
  const previousBase = process.env.NYAA_BASE_URL;
  const mirror = 'https://nyaa-flaky.test';
  process.env.NYAA_BASE_URL = mirror;
  clearMirrorCache('nyaa');
  try {
    const crawler = new NyaaCrawler();
    let probeCalls = 0;
    mockHttp(crawler, url => {
      if (url === `${mirror}/?f=0&c=1_2&p=1` && probeCalls++ === 0) {
        return '<table class="torrent-list"><tbody></tbody></table>';
      }
      return '<title>Access Denied</title>';
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.NYAA_BASE_URL;
    else process.env.NYAA_BASE_URL = previousBase;
    clearMirrorCache('nyaa');
  }
});

test('LimeTorrents: skips off-site detail links and infers types from mixed-feed category labels', () => {
  const crawler = new LimeTorrentsCrawler();
  const mirror = 'https://lime-audit.test';
  const html = `<table class="table2"><tbody>
    <tr><td><img title="Anime"><div class="tt-name">
      <a href="https://ads.example/ad.html">Advertisement</a>
      <a href="/anime-release.html" title="Sample release">Sample release</a></div></td>
      <td>today</td><td>1.5 GB</td><td>10</td><td>2</td></tr>
    <tr><td><img title="Music"><div class="tt-name"><a href="/album.html">Album</a></div></td>
      <td>today</td><td>1.5 GB</td><td>10</td><td>2</td></tr>
  </tbody></table>`;
  const sink = new Map();
  const parsed = crawler.collectRows(html, `${mirror}/latest100`, mirror, null, sink);
  assert.equal(parsed, 1);
  assert.equal(sink.size, 1);
  const [candidate] = sink.values();
  assert.equal(candidate.detailUrl, `${mirror}/anime-release.html`);
  assert.equal(candidate.type, 'anime');
});

test('LimeTorrents: finds later valid magnets and same-site torrent files without inventing trackers', async () => {
  const crawler = new LimeTorrentsCrawler();
  const mirror = 'https://lime-detail.test';
  const detailUrl = `${mirror}/release.html`;
  const calls = mockHttp(crawler, url => {
    if (url === detailUrl) return `<h1>Sample Castellano 1080p</h1>
      <a href="magnet:?xt=urn:btih:invalid">bad</a>
      <a href="magnet:?xt=urn:btih:${HASH}">good</a>
      <a href="https://ads.example/ad.torrent">advert</a>
      <a href="/download/sample.torrent?token=abc">torrent</a>`;
    return `<h1>Hash only sample</h1><table><tr><td>Hash:</td><td>${HASH2}</td></tr></table>`;
  });
  const item = { title: 'Sample Castellano', detailUrl, type: 'movie' };
  const magnetRecord = await crawler.parseLimeDetail(item, mirror);
  assert.equal(magnetRecord.info_hash, HASH);
  assert.equal(magnetRecord.torrent_file_url, `${mirror}/download/sample.torrent?token=abc`);
  assert.equal(magnetRecord.source_tracker, null);
  assert.doesNotMatch(magnetRecord.magnet_url, /[?&]tr=/);

  const hashRecord = await crawler.parseLimeDetail(
    { title: 'Hash only Castellano', detailUrl: `${mirror}/hash-only.html`, type: 'movie' }, mirror
  );
  assert.equal(hashRecord.info_hash, HASH2);
  assert.equal(hashRecord.source_tracker, null);
  assert.doesNotMatch(hashRecord.magnet_url, /[?&]tr=/, 'a hash-only detail does not get fabricated trackers');
  assert.deepEqual(calls, [detailUrl, `${mirror}/hash-only.html`]);
});

test('LimeTorrents: duplicate catalogue pages do not hide later published releases', async () => {
  const previousBase = process.env.LIMETORRENTS_BASE_URL;
  const previousSearch = process.env.LIMETORRENTS_SEARCH;
  const mirror = 'https://lime-pages.test';
  process.env.LIMETORRENTS_BASE_URL = mirror;
  process.env.LIMETORRENTS_SEARCH = ' ';
  clearMirrorCache('limetorrents');
  try {
    const crawler = new LimeTorrentsCrawler();
    const row = (id, title) => `<tr><td><div class="tt-name"><a href="/${id}.html">${title}</a></div></td>
      <td>today</td><td>1.5 GB</td><td>8</td><td>1</td></tr>`;
    const listing = (rows = '', pager = '') => `<table class="table2"><tr><th>Name</th></tr>${rows}</table>${pager}`;
    const pageOne = `${mirror}/browse-torrents/Movies/`;
    const pageTwo = `${mirror}/browse-torrents/Movies/2/`;
    const pageThree = `${mirror}/browse-torrents/Movies/3/`;
    const calls = mockHttp(crawler, url => {
      if (url.endsWith('.html')) {
        const hash = url.endsWith('/2.html') ? HASH2 : HASH;
        return `<h1>Sample Castellano 1080p</h1><a href="magnet:?xt=urn:btih:${hash}">Magnet</a>`;
      }
      if (url === pageOne) return listing(row('1', 'First Castellano 1080p'),
        '<div class="pagination"><a href="/browse-torrents/Movies/2/">2</a></div>');
      if (url === pageTwo) return listing(row('1', 'First Castellano 1080p'),
        '<div class="pagination"><a href="/browse-torrents/Movies/3/">3</a></div>');
      if (url === pageThree) return listing(row('2', 'Second Castellano 720p'));
      return listing();
    });

    const records = await crawler.crawl(3);
    assert.ok(calls.includes(pageThree));
    assert.equal(records.length, 2);
    assert.ok(records.some(record => record.info_hash === HASH2));
  } finally {
    if (previousBase === undefined) delete process.env.LIMETORRENTS_BASE_URL;
    else process.env.LIMETORRENTS_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.LIMETORRENTS_SEARCH;
    else process.env.LIMETORRENTS_SEARCH = previousSearch;
    clearMirrorCache('limetorrents');
  }
});

test('LimeTorrents: blocked catalogs after a passing mirror probe are surfaced', async () => {
  const previousBase = process.env.LIMETORRENTS_BASE_URL;
  const previousSearch = process.env.LIMETORRENTS_SEARCH;
  const mirror = 'https://lime-flaky.test';
  process.env.LIMETORRENTS_BASE_URL = mirror;
  process.env.LIMETORRENTS_SEARCH = ' ';
  clearMirrorCache('limetorrents');
  try {
    const crawler = new LimeTorrentsCrawler();
    let probeCalls = 0;
    mockHttp(crawler, url => {
      if (url === `${mirror}/latest100` && probeCalls++ === 0) return '<table class="table2"></table>';
      return '<title>Access Denied</title>';
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.LIMETORRENTS_BASE_URL;
    else process.env.LIMETORRENTS_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.LIMETORRENTS_SEARCH;
    else process.env.LIMETORRENTS_SEARCH = previousSearch;
    clearMirrorCache('limetorrents');
  }
});

test('Tokyo Toshokan: malformed magnets and off-site links do not corrupt the row', () => {
  const crawler = new TokyoToshoCrawler();
  const mirror = 'https://tokyo-parse.test';
  const html = `<table><tr class="category_8">
    <td><a href="/?cat=8">Drama</a></td>
    <td class="desc-top">
      <a href="magnet:?xt=urn:btih:invalid">bad magnet</a>
      <a href="magnet:?xt=urn:btih:${HASH}">valid magnet</a>
      <a href="https://ads.example/details.php?id=1">Details</a>
      <a href="https://ads.example/torrents/ad.torrent">Ad</a>
      <a href="/release-title.html">Tokyo Drama Sample S01E02</a>
      <a href="/torrents/1.torrent?token=abc">Torrent</a>
    </td><td class="stats">S: <span>7</span> L: <span>2</span></td>
  </tr><tr class="category_8"><td class="desc-bot">Size: 1.2 GiB | Comment: Spanish subtitles</td></tr></table>`;
  const records = crawler.parseListing(html, `${mirror}/?cat=8`, 'anime', [], mirror);
  assert.equal(records.length, 1);
  assert.equal(records[0].info_hash, HASH);
  assert.equal(records[0].title, 'Tokyo Drama Sample S01E02');
  assert.equal(records[0].type, 'series', 'the published Drama category overrides the route default');
  assert.equal(records[0].source_url, `${mirror}/?cat=8`, 'off-site detail links fall back to the listing page');
  assert.equal(records[0].torrent_file_url, `${mirror}/torrents/1.torrent?token=abc`);
  assert.equal(records[0].seeders, 7);
  assert.equal(records[0].leechers, 2);
});

test('Tokyo Toshokan: duplicate pages do not prevent collecting later numbered pages', async () => {
  const previousBase = process.env.TOKYOTOSHO_BASE_URL;
  const previousSearch = process.env.TOKYOTOSHO_SEARCH;
  const mirror = 'https://tokyo-pages.test';
  process.env.TOKYOTOSHO_BASE_URL = mirror;
  process.env.TOKYOTOSHO_SEARCH = ' ';
  clearMirrorCache('tokyotosho');
  try {
    const crawler = new TokyoToshoCrawler();
    const row = (id, hash, title) => `<table><tr class="category_1">
      <td rowspan="2"><a href="/?cat=1"><img></a></td>
      <td class="desc-top"><a href="magnet:?xt=urn:btih:${hash}">M</a>
        <a href="/details.php?id=${id}">${title}</a></td><td class="stats">S: 3 L: 1</td></tr>
      <tr class="category_1"><td class="desc-bot">Size: 1 GiB</td></tr></table>`;
    const pageOne = `${mirror}/?cat=1`;
    const pageTwo = `${mirror}/?cat=1&page=2`;
    const pageThree = `${mirror}/?cat=1&page=3`;
    const calls = mockHttp(crawler, url => {
      if (url === pageOne) return row('1', HASH, 'Sample Anime 1080p');
      if (url === pageTwo) return row('1', HASH, 'Sample Anime 1080p');
      if (url === pageThree) return row('2', HASH2, 'Another Anime 720p');
      return '<table class="listing"></table>';
    });

    const records = await crawler.crawl(3);
    assert.ok(calls.includes(pageThree));
    assert.equal(records.length, 2);
    assert.ok(records.some(record => record.info_hash === HASH2));
  } finally {
    if (previousBase === undefined) delete process.env.TOKYOTOSHO_BASE_URL;
    else process.env.TOKYOTOSHO_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.TOKYOTOSHO_SEARCH;
    else process.env.TOKYOTOSHO_SEARCH = previousSearch;
    clearMirrorCache('tokyotosho');
  }
});

test('Tokyo Toshokan: blocked catalog responses after a passing probe are errors', async () => {
  const previousBase = process.env.TOKYOTOSHO_BASE_URL;
  const previousSearch = process.env.TOKYOTOSHO_SEARCH;
  const mirror = 'https://tokyo-blocked.test';
  process.env.TOKYOTOSHO_BASE_URL = mirror;
  process.env.TOKYOTOSHO_SEARCH = ' ';
  clearMirrorCache('tokyotosho');
  try {
    const crawler = new TokyoToshoCrawler();
    let probeCalls = 0;
    mockHttp(crawler, url => {
      if (url === `${mirror}/?cat=1` && probeCalls++ === 0) return '<td class="desc-top">Probe</td>';
      return '<title>Access Denied</title>';
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.TOKYOTOSHO_BASE_URL;
    else process.env.TOKYOTOSHO_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.TOKYOTOSHO_SEARCH;
    else process.env.TOKYOTOSHO_SEARCH = previousSearch;
    clearMirrorCache('tokyotosho');
  }
});

test('Tokyo Toshokan: an unverified mirror is not used as fallback', async () => {
  const previousBase = process.env.TOKYOTOSHO_BASE_URL;
  const previousSearch = process.env.TOKYOTOSHO_SEARCH;
  process.env.TOKYOTOSHO_BASE_URL = 'https://tokyo-offline.test';
  process.env.TOKYOTOSHO_SEARCH = ' ';
  clearMirrorCache('tokyotosho');
  try {
    const crawler = new TokyoToshoCrawler();
    mockHttp(crawler, () => { throw new Error('simulated network outage'); });
    await assert.rejects(crawler.crawl(1), /No compatible mirror available/);
  } finally {
    if (previousBase === undefined) delete process.env.TOKYOTOSHO_BASE_URL;
    else process.env.TOKYOTOSHO_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.TOKYOTOSHO_SEARCH;
    else process.env.TOKYOTOSHO_SEARCH = previousSearch;
    clearMirrorCache('tokyotosho');
  }
});

test('EliteTorrent: malformed magnets are skipped until a valid published magnet is found', async () => {
  const crawler = new EliteTorrentCrawler();
  mockHttp(crawler, () => `<h1>Sample Castellano 1080p</h1>
    <a href="magnet:?xt=urn:btih:invalid">broken</a>
    <a href="MAGNET:?xt=urn:btih:${HASH}">valid</a>`);

  const record = await crawler.parseEliteTorrentDetail(
    'https://elite.example/peliculas/sample/',
    'https://elite.example'
  );
  assert.ok(record);
  assert.equal(record.info_hash, HASH);
});

test('EliteTorrent: detail parsing rejects credential-bearing or off-site URLs before fetching', async () => {
  const crawler = new EliteTorrentCrawler();
  const calls = mockHttp(crawler, () => { throw new Error('unexpected detail request'); });

  assert.equal(await crawler.parseEliteTorrentDetail(
    'https://user:pass@elite.example/series/sample/', 'https://elite.example'
  ), null);
  assert.equal(await crawler.parseEliteTorrentDetail(
    'https://ads.example/series/sample/', 'https://elite.example'
  ), null);
  assert.deepEqual(calls, []);
});

test('EliteTorrent: blocked catalog responses after a passing mirror probe are errors', async () => {
  const previousBase = process.env.ELITETORRENT_BASE_URL;
  const mirror = 'https://elite-blocked.test';
  process.env.ELITETORRENT_BASE_URL = mirror;
  clearMirrorCache('elitetorrent');
  try {
    const crawler = new EliteTorrentCrawler();
    let probeServed = false;
    mockHttp(crawler, url => {
      if (url === `${mirror}/` && !probeServed) {
        probeServed = true;
        return '<a href="/series/sample/">Sample</a>';
      }
      return '<title>Access Denied</title>';
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.ELITETORRENT_BASE_URL;
    else process.env.ELITETORRENT_BASE_URL = previousBase;
    clearMirrorCache('elitetorrent');
  }
});

test('EZTV: invalid magnets and off-site links are skipped without inventing trackers', () => {
  const crawler = new EztvCrawler();
  const html = `<table><tr class="forum_header_border">
    <td><a class="epinfo" href="https://ads.example/ep/1">Sample S01E02 Castellano</a></td>
    <td><a class="magnet" href="magnet:?xt=urn:btih:invalid">broken</a>
      <a class="magnet" href="${MAGNET}">valid</a>
      <a class="download_1" href="https://ads.example/files/ad.torrent">ad</a>
      <a class="download_1" href="https://user:pass@eztv.test/files/private.torrent">private</a></td>
    <td>650 MiB</td><td></td><td><font>24</font></td></tr></table>`;
  const sink = [];
  crawler.collectHtmlRows(html, 'https://www.eztv.test', new Set(), sink);

  assert.equal(sink.length, 1);
  assert.equal(sink[0].info_hash, HASH);
  assert.equal(sink[0].source_url, null, 'off-site episode links are not stored');
  assert.equal(sink[0].torrent_file_url, null, 'off-site and credential-bearing torrent URLs are rejected');
  assert.equal(sink[0].source_tracker, null);
  assert.doesNotMatch(sink[0].magnet_url, /[?&]tr=/, 'tracker URLs absent from the source are not fabricated');
});

test('EZTV: API pagination continues after a full page of filtered rows', async () => {
  const previousBase = process.env.EZTV_BASE_URL;
  const mirror = 'https://eztv-api-pages.test';
  process.env.EZTV_BASE_URL = mirror;
  clearMirrorCache('eztv');
  try {
    const crawler = new EztvCrawler();
    const invalidPage = Array.from({ length: 50 }, (_, id) => ({ hash: `invalid-${id}`, title: '' }));
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/api/get-torrents?limit=1`) return { torrents: [] };
      if (url === `${mirror}/api/get-torrents?limit=50&page=1`) return { torrents: invalidPage };
      if (url === `${mirror}/api/get-torrents?limit=50&page=2`) {
        return { torrents: [{ hash: HASH, filename: 'Valid Release Castellano S01E02' }] };
      }
      return { torrents: [] };
    });

    const records = await crawler.crawl(2);
    assert.ok(calls.includes(`${mirror}/api/get-torrents?limit=50&page=2`));
    assert.equal(records.length, 1);
    assert.equal(records[0].info_hash, HASH);
    assert.doesNotMatch(records[0].magnet_url, /[?&]tr=/);
    assert.equal(records[0].source_tracker, null);
  } finally {
    if (previousBase === undefined) delete process.env.EZTV_BASE_URL;
    else process.env.EZTV_BASE_URL = previousBase;
    clearMirrorCache('eztv');
  }
});

test('EZTV: API URLs stay on the selected mirror and mismatched magnets are rebuilt without trackers', () => {
  const crawler = new EztvCrawler();
  const record = crawler.mapApiTorrentToRecord({
    id: 42,
    hash: HASH,
    title: 'Sample Castellano',
    magnet_url: `magnet:?xt=urn:btih:${HASH2}&tr=udp://tracker.invalid:80/announce`,
    torrent_url: 'https://ads.example/sample.torrent',
    episode_url: 'https://ads.example/ep/42'
  }, 'https://www.eztv.test');

  assert.ok(record);
  assert.equal(record.torrent_file_url, null);
  assert.equal(record.source_url, 'https://www.eztv.test/ep/42');
  assert.equal(record.source_tracker, null);
  assert.equal(record.magnet_url, `magnet:?xt=urn:btih:${HASH}&dn=Sample%20Castellano`);
});

test('EZTV: blocked API and HTML catalogues after a passing mirror probe are errors', async () => {
  const previousBase = process.env.EZTV_BASE_URL;
  const mirror = 'https://eztv-blocked.test';
  process.env.EZTV_BASE_URL = mirror;
  clearMirrorCache('eztv');
  try {
    const crawler = new EztvCrawler();
    let apiProbeServed = false;
    mockHttp(crawler, url => {
      if (url === `${mirror}/api/get-torrents?limit=1` && !apiProbeServed) {
        apiProbeServed = true;
        return { torrents: [] };
      }
      if (url.includes('/api/')) throw new Error('API unavailable after the probe');
      return '<title>Access Denied</title>';
    });

    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.EZTV_BASE_URL;
    else process.env.EZTV_BASE_URL = previousBase;
    clearMirrorCache('eztv');
  }
});

test('EZTV: HTML pagination continues past a duplicate-only page with different rows', async () => {
  const previousBase = process.env.EZTV_BASE_URL;
  const mirror = 'https://eztv-html-pages.test';
  process.env.EZTV_BASE_URL = mirror;
  clearMirrorCache('eztv');
  try {
    const crawler = new EztvCrawler();
    const row = (id, hash, name) => `<tr class="forum_header_border"><td></td>
      <td><a class="epinfo" href="/ep/${id}/${name}">${name} Castellano S01E0${id}</a></td>
      <td><a class="magnet" href="magnet:?xt=urn:btih:${hash}">M</a></td>
      <td>650 MiB</td><td></td><td><font>24</font></td></tr>`;
    const page = rows => `<table>${rows}</table>`;
    const calls = mockHttp(crawler, url => {
      if (url.includes('/api/')) throw new Error('API disabled');
      if (url === `${mirror}/home`) return page(row(1, HASH, 'First') + row(2, HASH2, 'Second'));
      if (url === `${mirror}/page_2`) return page(row(2, HASH2, 'Second'));
      if (url === `${mirror}/page_3`) return page(row(3, '2'.repeat(40), 'Third'));
      return page('');
    });

    const records = await crawler.crawl(3);
    assert.ok(calls.includes(`${mirror}/page_3`));
    assert.equal(records.length, 3);
  } finally {
    if (previousBase === undefined) delete process.env.EZTV_BASE_URL;
    else process.env.EZTV_BASE_URL = previousBase;
    clearMirrorCache('eztv');
  }
});

test('YTS: API URLs stay on the verified mirror and generated magnets invent no trackers', () => {
  const crawler = new YtsCrawler();
  const mirror = 'https://www.yts.test';
  const [record] = crawler.mapMovie({
    id: 42,
    title: 'Sample Movie',
    slug: 'sample-movie-2025',
    url: 'https://ads.example/movie/sample-movie',
    language: 'en',
    torrents: [{
      hash: HASH,
      quality: '1080p',
      type: 'bluray',
      video_codec: 'x265',
      bit_depth: 10,
      url: 'https://user:pass@yts.test/files/sample.torrent'
    }]
  }, mirror);

  assert.ok(record);
  assert.equal(record.source_url, `${mirror}/movies/sample-movie-2025`, 'off-site movie URLs use a safe mirror-local slug fallback');
  assert.equal(record.torrent_file_url, null, 'credential-bearing download URLs are rejected');
  assert.equal(record.source_tracker, null);
  assert.match(record.codec, /x265 10-bit/, 'numeric bit-depth values are retained');
  assert.doesNotMatch(record.magnet_url, /[?&]tr=/, 'the API publishes hashes, not tracker URLs');

  const [sameSiteRecord] = crawler.mapMovie({
    id: 43,
    title: 'Another Movie',
    url: 'https://yts.test/movies/another-movie',
    torrents: [{ hash: HASH2, url: '/torrent/download/43' }]
  }, mirror);
  assert.equal(sameSiteRecord.source_url, 'https://yts.test/movies/another-movie', 'www/apex links are equivalent');
  assert.equal(sameSiteRecord.torrent_file_url, `${mirror}/torrent/download/43`);
});

test('YTS: repeated API pages stop instead of spending the page budget on duplicates', async () => {
  const previousBase = process.env.YTS_BASE_URL;
  const mirror = 'https://yts-pages.test';
  process.env.YTS_BASE_URL = mirror;
  clearMirrorCache('yts');
  try {
    const crawler = new YtsCrawler();
    const movies = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      slug: `sample-${index + 1}`,
      title: `Sample Movie ${index + 1}`,
      language: 'es',
      torrents: [{ hash: (index + 1).toString(16).padStart(40, '0'), quality: '720p', type: 'bluray' }]
    }));
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/api/v2/list_movies.json?limit=1`) {
        return { status: 'ok', data: { movie_count: 1, movies: [movies[0]] } };
      }
      if (url.includes('sort_by=download_count')) return { status: 'ok', data: { movie_count: 50, movies } };
      return { status: 'ok', data: { movie_count: 0, movies: [] } };
    });

    const records = await crawler.crawl(3);
    const popularPageThree = `${mirror}/api/v2/list_movies.json?sort_by=download_count&order_by=desc&limit=50&page=3`;
    assert.ok(calls.includes(`${mirror}/api/v2/list_movies.json?sort_by=download_count&order_by=desc&limit=50&page=2`));
    assert.ok(!calls.includes(popularPageThree));
    assert.equal(records.length, 50);
  } finally {
    if (previousBase === undefined) delete process.env.YTS_BASE_URL;
    else process.env.YTS_BASE_URL = previousBase;
    clearMirrorCache('yts');
  }
});

test('YTS: malformed catalogues after a passing API probe are reported', async () => {
  const previousBase = process.env.YTS_BASE_URL;
  const mirror = 'https://yts-flaky.test';
  process.env.YTS_BASE_URL = mirror;
  clearMirrorCache('yts');
  try {
    const crawler = new YtsCrawler();
    mockHttp(crawler, url => {
      if (url === `${mirror}/api/v2/list_movies.json?limit=1`) {
        return { status: 'ok', data: { movie_count: 0, movies: [] } };
      }
      return { status: 'ok', data: { unexpected: true } };
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.YTS_BASE_URL;
    else process.env.YTS_BASE_URL = previousBase;
    clearMirrorCache('yts');
  }
});
