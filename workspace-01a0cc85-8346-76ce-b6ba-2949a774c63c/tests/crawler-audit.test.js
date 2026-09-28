import test from 'node:test';
import assert from 'node:assert/strict';

import { nextPaginationLink, sameHost } from '../src/crawlers/support.ts';
import { RarbgCrawler } from '../src/crawlers/rarbg.ts';
import { MagnetDlCrawler } from '../src/crawlers/magnetdl.ts';
import { LimeTorrentsCrawler } from '../src/crawlers/limetorrent.ts';
import { ThePirateBayCrawler } from '../src/crawlers/thepiratebay.ts';
import { Leech1337xCrawler } from '../src/crawlers/leech1337x.ts';
import { EztvCrawler } from '../src/crawlers/eztv.ts';
import { YtsCrawler, ytsLanguageHints } from '../src/crawlers/yts.ts';
import { NyaaCrawler } from '../src/crawlers/nyaa.ts';
import { TorrentGalaxyCrawler } from '../src/crawlers/torrentgalaxy.ts';
import { PelispandaCrawler, isPelispandaTorrentLink } from '../src/crawlers/pelispanda.ts';
import { MejorTorrentCrawler } from '../src/crawlers/mejortorrent.ts';
import { GranTorrentCrawler, isMovieCardPath } from '../src/crawlers/grantorrent.ts';
import { SinsitioCrawler, decodeSinsitioDownload } from '../src/crawlers/sinsitio.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';

import { mockHttp, HASH, HASH2, MAGNET } from './helpers.js';

const MIRROR = 'https://mirror.test';

// ============================================================================
// Shared pagination helper
// ============================================================================

test('nextPaginationLink: follows rel=next, then wording, then numbers', () => {
  const base = 'https://site.test/movies/';

  assert.equal(
    nextPaginationLink(`<a rel="next" href="/movies/page/4/">Next</a>`, base),
    'https://site.test/movies/page/4/',
    'rel=next wins over everything else'
  );

  assert.equal(
    nextPaginationLink(`<div class="pagination"><a href="/movies/2/">Next &#187;</a></div>`, base),
    'https://site.test/movies/2/',
    'a "Next" link is followed even without rel=next'
  );

  assert.equal(
    nextPaginationLink(`<a href="?page=3">3</a><a href="?page=4">4</a>`, `${base}?page=3`),
    'https://site.test/movies/?page=4',
    'the smallest page that moves forward wins'
  );

  assert.equal(
    nextPaginationLink(`<a href="/forum/viewforum.php?f=22&amp;start=50">50</a>`, 'https://site.test/forum/viewforum.php?f=22'),
    'https://site.test/forum/viewforum.php?f=22&start=50',
    'published offsets are followed'
  );
});

test('nextPaginationLink: never invents a page and never walks backwards', () => {
  assert.equal(nextPaginationLink('<div>no pager here</div>', 'https://site.test/movies/'), null);
  assert.equal(
    nextPaginationLink('<a href="/movies/1/">1</a>', 'https://site.test/movies/3/'),
    null,
    'a link to an earlier page is not a next page'
  );
  assert.equal(
    nextPaginationLink('<a href="https://other.test/movies/2/">2</a>', 'https://site.test/movies/'),
    null,
    'a pager pointing off-site is ignored'
  );
  assert.equal(
    nextPaginationLink('<a href="/games/2/">2</a>', 'https://site.test/movies/'),
    null,
    'a different section is not the same pagination'
  );
});

test('sameHost: www and apex are the same site, different domains are not', () => {
  assert.equal(sameHost('https://www.sinsitio.site/1-a.html', 'https://sinsitio.site/'), true);
  assert.equal(sameHost('https://sinsitio.site/1-a.html', 'https://www.sinsitio.site/'), true);
  assert.equal(sameHost('https://evil.example/1-a.html', 'https://sinsitio.site/'), false);
  assert.equal(sameHost('not a url', 'https://sinsitio.site/'), false);
});

// ============================================================================
// RARBG
// ============================================================================

const rarbgListing = rows => `<table><tr><td>i</td><td>t</td><td>c</td><td>d</td><td>s</td><td>S</td><td>L</td><td>u</td></tr>
${rows.map(r => `<tr><td><img></td><td><a href="/${r.id}-a_torrent/sample.html">${r.title}</a></td>
<td>Movies</td><td>2026-01-01</td><td>${r.size}</td><td>${r.seeders}</td><td>${r.leechers}</td><td>uploader</td></tr>`).join('')}
</table>`;

test('RARBG: size/seeders/leechers are located by content, not by fixed columns', () => {
  const crawler = new RarbgCrawler();
  // The date column is dropped: a fixed index would read the date as the size.
  const html = `<table><tr><td><img></td><td><a href="/1-a_torrent/sample.html">Sample Castellano 1080p</a></td>
    <td>Movies</td><td>2.1 GB</td><td>1,234</td><td>56</td><td>uploader</td></tr></table>`;

  const [row] = crawler.parseListing(html, `${MIRROR}/movies/`);
  assert.equal(row.title, 'Sample Castellano 1080p');
  assert.equal(row.sizeStr, '2.1 GB');
  assert.equal(row.seeders, 1234);
  assert.equal(row.leechers, 56);
});

test('RARBG: pagination follows the published pager, never a guessed number', async () => {
  const crawler = new RarbgCrawler();
  clearMirrorCache('rarbg');

  const detail = id => `<h1>Sample ${id} Castellano 1080p</h1>
    <a href="magnet:?xt=urn:btih:${id === 0 ? HASH : HASH2}">magnet</a>
    <a href="/download/${id}/sample.torrent">torrent</a>`;

  const calls = mockHttp(crawler, url => {
    if (url.includes('_torrent/')) return detail(url.includes('/0-') ? 0 : 1);
    if (url.endsWith('/movies/')) {
      return rarbgListing([{ id: 0, title: 'Sample Castellano 1080p', size: '2.1 GB', seeders: '10', leechers: '1' }])
        + '<div class="pagination"><a href="/movies/2/">2</a></div>';
    }
    if (url.endsWith('/movies/2/')) {
      return rarbgListing([{ id: 1, title: 'Otra Castellano 720p', size: '1.1 GB', seeders: '5', leechers: '0' }]);
    }
    return rarbgListing([]);
  });

  const records = await crawler.crawl(3);
  clearMirrorCache('rarbg');

  assert.ok(calls.some(url => url.endsWith('/movies/2/')), 'the pager the page publishes is followed');
  assert.ok(!calls.some(url => /\/movies\/3\//.test(url)), 'no page number is guessed beyond the published pager');
  assert.equal(records.length, 2, `expected both listing pages, got ${records.length}`);
  const withFile = records.find(record => (record.torrent_file_url ?? '').endsWith('/download/0/sample.torrent'));
  assert.ok(withFile, 'the metainfo link of the detail page is stored');
});

// ============================================================================
// MagnetDL
// ============================================================================

test('MagnetDL: nextPage follows the pager of the route, not only numbered links', () => {
  const crawler = new MagnetDlCrawler();

  assert.equal(
    crawler.nextPage(
      `<div class="pagination"><a href="/movies/2/">Next &#187;</a><a href="/movies/7/">7</a></div>`,
      'https://magnetdl.test/movies',
      '/movies',
      1
    ),
    'https://magnetdl.test/movies/2/'
  );

  assert.equal(
    crawler.nextPage(
      `<div class="pagination"><a href="/games/2/">Next</a></div>`,
      'https://magnetdl.test/movies',
      '/movies',
      1
    ),
    null,
    'a pager that leaves the route is not followed'
  );

  assert.equal(crawler.nextPage('<div class="pagination"></div>', 'https://magnetdl.test/movies', '/movies', 1), null);
});

test('MagnetDL: the metainfo link of the /single page is stored only for the site itself', () => {
  const crawler = new MagnetDlCrawler();
  const { torrentFileUrl } = crawler.parseDetail(
    `<h1>Sample</h1><a href="${MAGNET}">magnet</a><a href="https://ad.example/file.torrent">ad</a>`,
    'Sample...'
  );
  assert.equal(torrentFileUrl, null, 'third-party download buttons are not this source\'s file');
});

// ============================================================================
// LimeTorrents
// ============================================================================

const limeRow = (id, title) => `<tr><td><div class="tt-name"><a href="/${id}.html">${title}</a></div></td>
  <td>2026-01-01</td><td>2.1 GB</td><td>1,234</td><td>56</td></tr>`;

const limeListing = (rows, pager = '') =>
  `<table class="table2"><tr><th>Name</th><th>Added</th><th>Size</th><th>Seeders</th><th>Leechers</th></tr>${rows}</table>${pager}`;

test('LimeTorrents: catalogue pagination stops on the last published page', async () => {
  const crawler = new LimeTorrentsCrawler();
  clearMirrorCache('limetorrents');

  const hashes = [HASH, HASH2, 'b'.repeat(40)];
  const detail = id => `<h1>Sample ${id} Castellano 1080p</h1>
    <a href="magnet:?xt=urn:btih:${hashes[id % hashes.length]}">magnet</a>
    <a href="https://imdb.com/title/tt1234567">imdb</a>`;

  const calls = mockHttp(crawler, url => {
    if (/\/(\d+)\.html$/.test(url)) return detail(Number(url.match(/\/(\d+)\.html$/)[1]));
    if (/\/browse-torrents\/Movies\/$/.test(url)) {
      return limeListing(limeRow(1, 'Sample Castellano 1080p'), '<div class="pagination"><a href="/browse-torrents/Movies/2/">2</a></div>');
    }
    if (/\/browse-torrents\/Movies\/2\/$/.test(url)) {
      return limeListing(limeRow(2, 'Otra Castellano 720p'));
    }
    if (url.includes('/search')) return limeListing(limeRow(3, 'Busqueda Castellano'));
    return limeListing('');
  });

  const records = await crawler.crawl(4);
  clearMirrorCache('limetorrents');

  assert.ok(calls.some(url => /\/browse-torrents\/Movies\/2\/$/.test(url)));
  assert.ok(!calls.some(url => /\/browse-torrents\/Movies\/3\/$/.test(url)), 'no page beyond the published pager');
  assert.equal(records.length, 3, `expected the rows of both pages, got ${records.length}`);
  assert.ok(records.every(record => record.imdb_id === 'tt1234567'));
});

// ============================================================================
// The Pirate Bay
// ============================================================================

test('TPB: the type comes from the category cell of the row', () => {
  const crawler = new ThePirateBayCrawler();
  assert.equal(crawler.typeFromCategory('TV shows'), 'series');
  assert.equal(crawler.typeFromCategory('HD - Movies'), 'movie');
  assert.equal(crawler.typeFromCategory('Anime'), 'anime');
  assert.equal(crawler.typeFromCategory('Documentaries'), 'documentary');
  assert.equal(crawler.typeFromCategory('Audio'), undefined);
  assert.equal(crawler.typeFromCategory(''), undefined);
});

test('TPB: detail page yields the IMDb id and only same-site metainfo links', () => {
  const crawler = new ThePirateBayCrawler();
  const url = 'https://tpb.test/description.php?id=1';

  const good = crawler.parseDetail(
    `<div><a href="https://www.imdb.com/title/tt7654321/">imdb</a>
     <a href="/download/1/Sample.torrent">Download</a></div>`,
    url
  );
  assert.equal(good.imdbId, 'tt7654321');
  assert.equal(good.torrentFileUrl, 'https://tpb.test/download/1/Sample.torrent');

  const bad = crawler.parseDetail(
    `<a href="https://ad.example/1/Sample.torrent">Download</a>`,
    url
  );
  assert.equal(bad.torrentFileUrl, null, 'an ad host is never stored as the torrent file');
  assert.equal(bad.imdbId, null);
});

test('TPB: HTML rows keep the download link of the row and the row-category type', () => {
  const crawler = new ThePirateBayCrawler();
  const html = `<table id="searchResult"><tr class="header"><td>c</td></tr>
    <tr><td class="vertTh"><a href="/browse/208">TV shows</a></td>
    <td><div class="detName"><a href="/description.php?id=9">Sample S01E02 Castellano</a></div>
    <a href="${MAGNET}">M</a><a href="/download/9/Sample.torrent">DL</a>
    <font class="detDesc">Uploaded 01-01, Size 1.5 GiB, ULed by x</font></td>
    <td>10</td><td>2</td></tr></table>`;

  const sink = [];
  const { added } = crawler.collectHtmlRows(html, 'https://tpb.test', new Set(), sink);
  assert.equal(added, 1);
  assert.equal(sink[0].type, 'series', 'the row is an episode, not a movie');
  assert.equal(sink[0].torrent_file_url, 'https://tpb.test/download/9/Sample.torrent');
  assert.equal(sink[0].seeders, 10);
  assert.equal(sink[0].leechers, 2);
});

// ============================================================================
// Nyaa / TorrentGalaxy
// ============================================================================

test('Nyaa: audio, books, software and pictures rows are not indexed as video', () => {
  const crawler = new NyaaCrawler();
  const row = (category, title, hash) => `<tr><td><img title="${category}"></td>
    <td><a href="/view/1">${title}</a></td>
    <td><a href="magnet:?xt=urn:btih:${hash}">M</a><a href="/download/1.torrent">T</a></td>
    <td>1.5 GiB</td><td>2026-01-01</td><td>10</td><td>2</td></tr>`;

  const html = `<table class="torrent-list"><tbody>
    ${row('Audio - Lossless', 'Some Album', HASH)}
    ${row('Literature - Manga', 'Some Book', HASH2)}
    ${row('Live Action - English-translated', 'Sample Castellano 1080p', 'abcdef1234567890abcdef1234567890abcdef12')}
  </tbody></table>`;

  const records = crawler.parseRows(html, 'https://nyaa.test', 'https://nyaa.test');
  assert.equal(records.length, 1, 'only the video row survives');
  assert.equal(records[0].type, 'movie');
});

test('TorrentGalaxy: peers come from the seed/leech cells and the file link must match the hash', () => {
  const crawler = new TorrentGalaxyCrawler();
  const mirror = 'https://tgx.test';

  const row = (hash, fileHash) => `<div class="tgxtablerow">
    <a href="/torrent/1/sample">Sample Castellano 1080p</a>
    <a href="magnet:?xt=urn:btih:${hash}">M</a>
    <a href="/torrent/${fileHash}/sample.torrent">iTorrents</a>
    <span class="badge">2.1 GB</span>
    <span class="tgxtablecell seeders">1,234</span>
    <span class="tgxtablecell leechers">56</span>
  </div>`;

  const [record] = crawler.parseTorrentGalaxyHtml(row(HASH, HASH), `${mirror}/torrents`, mirror);
  assert.equal(record.seeders, 1234);
  assert.equal(record.leechers, 56);
  assert.equal(record.torrent_file_url, `${mirror}/torrent/${HASH}/sample.torrent`);

  const [mismatch] = crawler.parseTorrentGalaxyHtml(row(HASH, HASH2), `${mirror}/torrents`, mirror);
  assert.equal(mismatch.torrent_file_url, null, 'a file link for another hash is not stored');
});

// ============================================================================
// 1337x / EZTV / YTS
// ============================================================================

test('1337x: a published pager replaces the guessed /N/ URL', async () => {
  const crawler = new Leech1337xCrawler();
  clearMirrorCache('leech1337x');

  const listing = (href, pager = '') => `<table class="table-list"><tbody>
    <tr><td class="name"><a href="${href}">Sample</a></td>
    <td class="seeds">10</td><td class="leeches">2</td><td class="size">1.5 GB</td></tr></tbody></table>${pager}`;

  const detail = (title, magnet) => `<div class="box-info-heading"><h1>${title}</h1></div>
    <a href="${magnet}">magnet</a><a href="/download/sample.torrent">torrent</a>`;

  const calls = mockHttp(crawler, url => {
    if (url.includes('/torrent/2/')) return detail('Otra Castellano 720p', `magnet:?xt=urn:btih:${HASH2}`);
    if (url.includes('/torrent/')) return detail('Sample Castellano 1080p', MAGNET);
    if (/\/sort-search\/spanish\/seeders\/desc\/1\/$/.test(url)) {
      return listing('/torrent/1/sample/', '<div class="pagination"><a href="/sort-search/spanish/seeders/desc/2/">&#187;</a></div>');
    }
    if (/\/sort-search\/spanish\/seeders\/desc\/2\/$/.test(url)) return listing('/torrent/2/otra/');
    return listing('');
  });

  const records = await crawler.crawl(3);
  clearMirrorCache('leech1337x');

  assert.ok(calls.some(url => /\/sort-search\/spanish\/seeders\/desc\/2\/$/.test(url)));
  assert.equal(records.length, 2);
  assert.equal(records[0].torrent_file_url, 'https://1337x.la/download/sample.torrent');
});

test('EZTV: the IMDb id of a row is read from that row only', () => {
  const crawler = new EztvCrawler();
  const html = `<table><tr class="forum_header_border">
    <td><a class="epinfo" href="/ep/1/sample">Sample S01E02 Castellano</a>
        <a href="https://imdb.com/title/tt1111111">imdb</a></td>
    <td><a class="magnet" href="${MAGNET}">M</a><a class="download_1" href="/files/sample.torrent">T</a></td>
    <td>650 MiB</td><td></td><td><font>24</font></td></tr></table>`;

  const sink = [];
  crawler.collectHtmlRows(html, 'https://eztv.test', new Set(), sink);
  assert.equal(sink.length, 1);
  assert.equal(sink[0].imdb_id, 'tt1111111');
  assert.equal(sink[0].torrent_file_url, 'https://eztv.test/files/sample.torrent');
});

test('YTS: every region variant of a language keeps its audio tag', () => {
  assert.deepEqual(ytsLanguageHints('es'), ['spanish']);
  assert.deepEqual(ytsLanguageHints('es-es'), ['spanish']);
  assert.deepEqual(ytsLanguageHints('es-mx'), ['latino']);
  assert.deepEqual(ytsLanguageHints('es-419'), ['latino']);
  assert.deepEqual(ytsLanguageHints('es-ve'), ['latino'], 'a region variant is not "unknown"');
  assert.deepEqual(ytsLanguageHints('en-gb'), ['english']);
  assert.deepEqual(ytsLanguageHints('pt-br'), ['portuguese']);
  assert.deepEqual(ytsLanguageHints('fr'), [], 'an untranslated release is not turned into English');
  assert.deepEqual(ytsLanguageHints(''), []);
});

// ============================================================================
// Spanish catalogues
// ============================================================================

test('Pelispanda: a fully repeated page ends the category instead of spinning', async () => {
  const crawler = new PelispandaCrawler();
  clearMirrorCache('pelispanda');

  const calls = mockHttp(crawler, url => {
    if (url.includes('/wpreact/v1/movie/')) return { title: 'Sample', downloads: [{ download_link: MAGNET, quality: '1080p' }] };
    if (url.includes('/movies?')) return [{ slug: 'sample' }];
    return [];
  });

  const records = await crawler.crawl(4);
  clearMirrorCache('pelispanda');

  assert.equal(records.length, 1, 'the repeated item is fetched once');
  assert.ok(calls.some(url => url.includes('page=2')), 'page 2 is still requested');
  assert.ok(!calls.some(url => url.includes('page=3')), 'page 3 is not requested after a full repeat');
});

test('Pelispanda: only real metainfo links are downloaded', () => {
  assert.equal(isPelispandaTorrentLink('https://panda.test/files/sample.torrent', 'torrent'), true);
  assert.equal(isPelispandaTorrentLink('https://panda.test/files/sample.torrent'), true);
  assert.equal(isPelispandaTorrentLink('https://ad.example/files/sample.torrent'), true, 'host is checked when downloading');
  assert.equal(isPelispandaTorrentLink('https://panda.test/descargar/sample.html', 'torrent'), false);
  assert.equal(isPelispandaTorrentLink('https://panda.test/d/12345', 'magnet'), false);
  assert.equal(isPelispandaTorrentLink('https://panda.test/torrent/12345', 'torrent'), true);
  assert.equal(isPelispandaTorrentLink('/relative/sample.torrent'), false);
});

test('MejorTorrent: legacy listings walk the published pager only', async () => {
  const crawler = new MejorTorrentCrawler();
  clearMirrorCache('mejortorrent');

  const card = (id = 1234) => `<a href="/pelicula/${id}/sample.html">Sample</a>`;
  const calls = mockHttp(crawler, url => {
    if (url.includes('/pelicula/')) {
      const id = Number(url.match(/\/pelicula\/(\d+)\//)?.[1] ?? 1);
      const hashes = [HASH, HASH2, 'b'.repeat(40)];
      return `<h1>Sample ${id} Castellano 1080p</h1><a href="magnet:?xt=urn:btih:${hashes[id % 3]}">magnet</a>`;
    }
    // Home + a category with a real second page; every other section is empty.
    if (url.endsWith('/peliculas-hd')) {
      return card(1) + '<div class="pagination"><a href="/peliculas-hd/page/2">2</a></div>';
    }
    if (url.endsWith('/peliculas-hd/page/2')) return card(2);
    if (url.endsWith('/inicio')) return card(3);
    return '<div>seccion vacia</div>';
  });

  const records = await crawler.crawl(4);
  clearMirrorCache('mejortorrent');

  assert.equal(records.length, 3, 'the three published listings are read');
  assert.ok(calls.some(url => url.endsWith('/peliculas-hd/page/2')), 'the pager is followed');
  assert.ok(
    !calls.some(url => /\/peliculas-hd\/page\/3$/.test(url)),
    'no page beyond the one the listing publishes'
  );
  assert.ok(
    calls.filter(url => /\/series-hd\/page\/\d+$/.test(url)).length === 0,
    'an empty section is not paged through'
  );
});

// ============================================================================
// GranTorrent / Sinsitio
// ============================================================================

test('GranTorrent: movie cards across www/apex, never categories or pagers', () => {
  assert.equal(isMovieCardPath('/icefall/'), true);
  assert.equal(isMovieCardPath('/peliculas/icefall/'), true);
  assert.equal(isMovieCardPath('/categoria/accion/'), false);
  assert.equal(isMovieCardPath('/page/2/'), false);
  assert.equal(isMovieCardPath('/a/b/c/'), false);

  const crawler = new GranTorrentCrawler();
  const html = `<a href="https://www.grantorrent.foo/icefall/"><img src="/wp-content/uploads/p.jpg"></a>
    <a href="https://grantorrent.foo/categoria/accion/"><img src="/wp-content/uploads/c.jpg"></a>`;
  assert.deepEqual(crawler.parseListing(html, 'https://grantorrent.foo'), ['https://www.grantorrent.foo/icefall/']);
});

test('Sinsitio: posts are collected across www/apex and only from the site', () => {
  const crawler = new SinsitioCrawler();
  const html = `<a href="https://www.sinsitio.site/1234-sample.html">Sample</a>
    <a href="https://evil.example/1234-sample.html">Not ours</a>`;
  assert.deepEqual(crawler.parseListing(html, 'https://sinsitio.site/'), ['https://www.sinsitio.site/1234-sample.html']);

  assert.equal(
    decodeSinsitioDownload('https://www.sinsitio.site/index.php?do=download&id=42', 'https://sinsitio.site/'),
    'https://www.sinsitio.site/index.php?do=download&id=42',
    'www/apex mismatch no longer drops the attachment'
  );
  assert.equal(decodeSinsitioDownload('https://evil.example/index.php?do=download&id=42', 'https://sinsitio.site/'), null);
  assert.equal(decodeSinsitioDownload('https://sinsitio.site/index.php?do=download', 'https://sinsitio.site/'), null);
});
