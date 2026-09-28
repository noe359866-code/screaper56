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

test('RARBG: six-column rows survive and off-site detail links are rejected', () => {
  const crawler = new RarbgCrawler();
  const pageUrl = 'https://rarbg.test/movies/';
  const listing = `<table>
    <tr><td><img></td><td><a href="/rarbgproxy_torrent/good.html?ref=movie">Sample Castellano</a></td>
      <td>Movies</td><td>1.5 GB</td><td>12</td><td>4</td></tr>
    <tr><td><img></td><td><a href="https://ads.example/rarbgproxy_torrent/ad.html">Ad</a></td>
      <td>Movies</td><td>1.5 GB</td><td>12</td><td>4</td></tr>
  </table>`;
  const rows = crawler.parseListing(listing, pageUrl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detailUrl, 'https://rarbg.test/rarbgproxy_torrent/good.html?ref=movie');
  assert.equal(rows[0].seeders, 12);
  assert.equal(rows[0].leechers, 4);
});

test('RARBG: duplicate listings do not hide later pages with new torrents', async () => {
  const previousBase = process.env.RARBG_BASE_URL;
  const previousSearch = process.env.RARBG_SEARCH;
  const mirror = 'https://rarbg.test';
  process.env.RARBG_BASE_URL = mirror;
  process.env.RARBG_SEARCH = 'spanish';
  clearMirrorCache('rarbg');
  try {
    const crawler = new RarbgCrawler();
    const calls = mockHttp(crawler, url => {
      if (url.includes('_torrent/')) {
        const hash = url.includes('first') ? HASH : HASH2;
        return `<h1>Sample Castellano 1080p</h1><a href="magnet:?xt=urn:btih:${hash}">Magnet</a>`;
      }
      if (url === `${mirror}/movies/`) return rarbgListing([
        { id: 'probe', title: 'Probe Sample Castellano', size: '1 GB', seeders: '1', leechers: '0' }
      ]);
      if (url === `${mirror}/search/?search=spanish`) {
        return `${rarbgListing([{ id: 'first', title: 'First Castellano 1080p', size: '1 GB', seeders: '1', leechers: '0' }])}` +
          '<div class="pagination"><a href="/search/2/?search=spanish">2</a></div>';
      }
      if (url === `${mirror}/search/2/?search=spanish`) {
        return `${rarbgListing([{ id: 'first', title: 'First Castellano 1080p', size: '1 GB', seeders: '1', leechers: '0' }])}` +
          '<div class="pagination"><a href="/search/3/?search=spanish">3</a></div>';
      }
      if (url === `${mirror}/search/3/?search=spanish`) {
        return rarbgListing([{ id: 'second', title: 'Second Castellano 720p', size: '1 GB', seeders: '2', leechers: '0' }]);
      }
      return '<table></table>';
    });
    const records = await crawler.crawl(3);
    assert.ok(calls.includes(`${mirror}/search/3/?search=spanish`));
    assert.ok(records.some(record => record.info_hash === HASH));
    assert.ok(records.some(record => record.info_hash === HASH2));
  } finally {
    if (previousBase === undefined) delete process.env.RARBG_BASE_URL;
    else process.env.RARBG_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.RARBG_SEARCH;
    else process.env.RARBG_SEARCH = previousSearch;
    clearMirrorCache('rarbg');
  }
});

test('RARBG: catalogue failures after a successful probe are not reported as an empty success', async () => {
  const previousBase = process.env.RARBG_BASE_URL;
  const previousSearch = process.env.RARBG_SEARCH;
  const mirror = 'https://rarbg-flaky.test';
  process.env.RARBG_BASE_URL = mirror;
  process.env.RARBG_SEARCH = '';
  clearMirrorCache('rarbg');
  try {
    const crawler = new RarbgCrawler();
    let movieRequests = 0;
    mockHttp(crawler, url => {
      if (url === `${mirror}/movies/` && movieRequests++ === 0) {
        return rarbgListing([{ id: 'probe', title: 'Probe Castellano', size: '1 GB', seeders: '1', leechers: '0' }]);
      }
      throw new Error('simulated catalogue outage');
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.RARBG_BASE_URL;
    else process.env.RARBG_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.RARBG_SEARCH;
    else process.env.RARBG_SEARCH = previousSearch;
    clearMirrorCache('rarbg');
  }
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

test('MagnetDL: detail links stay on the active site and the first valid magnet wins', () => {
  const crawler = new MagnetDlCrawler();
  const pageUrl = 'https://magnetdl.test/single/1';
  const details = crawler.parseDetail(
    `<h1>Sample Castellano</h1>
      <a href="magnet:?xt=urn:btih:invalid">Malformed</a>
      <a href="magnet:?xt=urn:btih:${HASH}">Valid</a>
      <a href="https://ad.example/file.torrent">Ad</a>
      <a href="http://magnetdl.test/downgrade.torrent">Downgrade</a>
      <a href="https://user:pass@magnetdl.test/credentialed.torrent">Credentials</a>
      <a href="https://magnetdl.test:444/other-port.torrent">Other port</a>
      <a href="/files/sample.torrent?download=1">Valid file</a>`,
    'Sample...',
    pageUrl
  );
  assert.equal(details.magnet, `magnet:?xt=urn:btih:${HASH}`);
  assert.equal(details.torrentFileUrl, 'https://magnetdl.test/files/sample.torrent?download=1');

  const hashOnly = crawler.parseDetail(`Info Hash: ${'0'.repeat(40)}; Hash: ${HASH2}`, 'Hash fallback', pageUrl);
  assert.equal(hashOnly.magnet, `magnet:?xt=urn:btih:${HASH2}&dn=Hash%20fallback`);
  assert.equal(hashOnly.torrentFileUrl, null);

  const embedded = crawler.parseDetail(
    `<script>const magnet = 'magnet:?xt=urn:btih:${HASH2}&amp;dn=Embedded%20Castellano';</script>`,
    'Embedded Castellano',
    pageUrl
  );
  assert.equal(embedded.magnet, `magnet:?xt=urn:btih:${HASH2}&dn=Embedded%20Castellano`);
});

test('MagnetDL: pagination must remain on the current route and mirror origin', () => {
  const crawler = new MagnetDlCrawler();
  const current = 'https://magnetdl.test/download/movies/';
  assert.equal(
    crawler.nextPage('<div class="pagination"><a href="/download/movies/2/">Next</a></div>', current, '/download/movies/', 1),
    'https://magnetdl.test/download/movies/2/'
  );
  for (const href of [
    'https://attacker.example/download/movies/2/',
    'https://magnetdl.test:444/download/movies/2/',
    'http://magnetdl.test/download/movies/2/',
    '/download/movies-evil/2/',
    'https://user:pass@magnetdl.test/download/movies/2/'
  ]) {
    assert.equal(
      crawler.nextPage(`<div class="pagination"><a rel="next" href="${href}">Next</a></div>`, current, '/download/movies/', 1),
      null,
      `${href} must not be followed`
    );
  }
});

test('MagnetDL: listing rejects detail links outside the active mirror site', () => {
  const crawler = new MagnetDlCrawler();
  const pageUrl = 'https://magnetdl.test/download/movies/';
  const row = (href, id) => `<tr><td><a href="magnet:?xt=urn:btih:invalid">Bad</a>
      <a href="magnet:?xt=urn:btih:${HASH}">Valid</a></td><td><a href="${href}">Sample Castellano ${id}</a></td>
    <td>Today</td><td>movies</td><td>1 GB</td><td>5</td><td>2</td></tr>`;
  const rows = crawler.parseListing(`<table>${[
    row('/single/1', 1),
    row('https://attacker.example/single/2', 2),
    row('http://magnetdl.test/single/3', 3),
    row('https://magnetdl.test:444/single/4', 4),
    row('https://user:pass@magnetdl.test/single/5', 5)
  ].join('')}</table>`, pageUrl, null);
  assert.deepEqual(rows.map(item => item.detailUrl), ['https://magnetdl.test/single/1']);
  assert.equal(rows[0].magnet, `magnet:?xt=urn:btih:${HASH}`);
});

test('MagnetDL: repeated listing rows do not hide later published pages', async () => {
  const previousBase = process.env.MAGNETDL_BASE_URL;
  const previousSearch = process.env.MAGNETDL_SEARCH;
  const mirror = 'https://magnetdl-pagination.test';
  process.env.MAGNETDL_BASE_URL = mirror;
  process.env.MAGNETDL_SEARCH = 'spanish';
  clearMirrorCache('magnetdl');
  try {
    const crawler = new MagnetDlCrawler();
    const row = (id, title, hash) => `<tr><td></td><td><a href="/single/${id}">${title}</a></td>
      <td>Today</td><td>movies</td><td>1 GB</td><td>5</td><td>2</td>
      <td><a href="magnet:?xt=urn:btih:${hash}">Magnet</a></td></tr>`;
    const listing = rows => `<table>${rows}</table>`;
    const pageOneRow = row(1, 'Sample Castellano 1080p', HASH);
    const laterRow = row(2, 'Otra Castellano 720p', HASH2);
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/download/movies/`) return listing(pageOneRow); // probe + movie catalog
      if (url === `${mirror}/download/tv/`) return listing('');
      if (url === `${mirror}/s/spanish/`) {
        return `${listing(pageOneRow)}<div class="pagination"><a href="/s/spanish/2/">Next »</a></div>`;
      }
      if (url === `${mirror}/s/spanish/2/`) {
        return `${listing(pageOneRow)}<div class="pagination"><a href="/s/spanish/3/">Next »</a></div>`;
      }
      if (url === `${mirror}/s/spanish/3/`) return listing(laterRow);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const records = await crawler.crawl(3);
    assert.ok(calls.includes(`${mirror}/s/spanish/3/`));
    assert.deepEqual(new Set(records.map(record => record.info_hash)), new Set([HASH, HASH2]));
  } finally {
    if (previousBase === undefined) delete process.env.MAGNETDL_BASE_URL;
    else process.env.MAGNETDL_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.MAGNETDL_SEARCH;
    else process.env.MAGNETDL_SEARCH = previousSearch;
    clearMirrorCache('magnetdl');
  }
});

test('MagnetDL: a mirror probe followed by catalogue failures is an explicit error', async () => {
  const previousBase = process.env.MAGNETDL_BASE_URL;
  const previousSearch = process.env.MAGNETDL_SEARCH;
  const mirror = 'https://magnetdl-flaky.test';
  process.env.MAGNETDL_BASE_URL = mirror;
  process.env.MAGNETDL_SEARCH = '';
  clearMirrorCache('magnetdl');
  try {
    const crawler = new MagnetDlCrawler();
    const probeListing = '<table><tr><td><a href="/single/1">Probe Castellano</a></td></tr></table>';
    let probeCount = 0;
    mockHttp(crawler, async url => {
      if (url === `${mirror}/download/movies/` && probeCount++ === 0) return probeListing;
      throw new Error('simulated catalogue outage');
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.MAGNETDL_BASE_URL;
    else process.env.MAGNETDL_BASE_URL = previousBase;
    if (previousSearch === undefined) delete process.env.MAGNETDL_SEARCH;
    else process.env.MAGNETDL_SEARCH = previousSearch;
    clearMirrorCache('magnetdl');
  }
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

test('TPB: APiBay source URLs require a content-verified web mirror', async () => {
  const previousBase = process.env.THEPIRATEBAY_BASE_URL;
  const previousApi = process.env.APIBAY_BASE_URL;
  const mirror = 'https://tpb.test';
  process.env.THEPIRATEBAY_BASE_URL = mirror;
  process.env.APIBAY_BASE_URL = 'https://apibay.test';
  clearMirrorCache('thepiratebay');
  try {
    const crawler = new ThePirateBayCrawler();
    const item = {
      id: '42', name: 'Sample Castellano', info_hash: HASH,
      category: '201', seeders: '5', leechers: '1', size: '1000'
    };
    mockHttp(crawler, url => {
      if (url === `${mirror}/search/test/1/99/200`) return '<table id="searchResult"></table>';
      if (url.startsWith('https://apibay.test/')) return [item];
      if (url.startsWith(`${mirror}/search/`)) return '<table id="searchResult"></table>';
      throw new Error(`Unexpected URL: ${url}`);
    });

    const [record] = await crawler.crawl(1);
    assert.equal(record.source_url, `${mirror}/description.php?id=42`);
    assert.equal(record.source_tracker, null);
    assert.doesNotMatch(record.magnet_url, /[?&]tr=/);
  } finally {
    if (previousBase === undefined) delete process.env.THEPIRATEBAY_BASE_URL;
    else process.env.THEPIRATEBAY_BASE_URL = previousBase;
    if (previousApi === undefined) delete process.env.APIBAY_BASE_URL;
    else process.env.APIBAY_BASE_URL = previousApi;
    clearMirrorCache('thepiratebay');
  }
});

test('TPB: total API and mirror outage is an explicit failure', async () => {
  const previousBase = process.env.THEPIRATEBAY_BASE_URL;
  const previousApi = process.env.APIBAY_BASE_URL;
  const previousSearch = process.env.THEPIRATEBAY_SEARCH;
  process.env.THEPIRATEBAY_BASE_URL = 'https://tpb-offline.test';
  process.env.APIBAY_BASE_URL = 'https://apibay-offline.test';
  process.env.THEPIRATEBAY_SEARCH = 'spanish';
  clearMirrorCache('thepiratebay');
  try {
    const crawler = new ThePirateBayCrawler();
    mockHttp(crawler, async () => { throw new Error('simulated network outage'); });
    await assert.rejects(crawler.crawl(1), /No usable responses from APiBay or the web mirror/);
  } finally {
    if (previousBase === undefined) delete process.env.THEPIRATEBAY_BASE_URL;
    else process.env.THEPIRATEBAY_BASE_URL = previousBase;
    if (previousApi === undefined) delete process.env.APIBAY_BASE_URL;
    else process.env.APIBAY_BASE_URL = previousApi;
    if (previousSearch === undefined) delete process.env.THEPIRATEBAY_SEARCH;
    else process.env.THEPIRATEBAY_SEARCH = previousSearch;
    clearMirrorCache('thepiratebay');
  }
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

  const downgraded = crawler.parseDetail(
    '<a href="http://tpb.test/download/1/Sample.torrent">Download</a>',
    url
  );
  assert.equal(downgraded.torrentFileUrl, null, 'a same-host HTTP downgrade is not trusted');
});

test('TPB: HTML rows keep the download link of the row and the row-category type', () => {
  const crawler = new ThePirateBayCrawler();
  const html = `<table id="searchResult"><tr class="header"><td>c</td></tr>
    <tr><td class="vertTh"><a href="/browse/208">TV shows</a></td>
    <td><div class="detName"><a href="https://ads.example/description.php?id=9">Sample S01E02 Castellano</a></div>
    <a href="${MAGNET}">M</a><a href="/download/9/Sample.torrent">DL</a>
    <font class="detDesc">Uploaded 01-01, Size 1.5 GiB, ULed by x</font></td>
    <td>10</td><td>2</td></tr></table>`;

  const sink = [];
  const { added } = crawler.collectHtmlRows(html, 'https://tpb.test', new Set(), sink);
  assert.equal(added, 1);
  assert.equal(sink[0].type, 'series', 'the row is an episode, not a movie');
  assert.equal(sink[0].torrent_file_url, 'https://tpb.test/download/9/Sample.torrent');
  assert.equal(sink[0].source_url, null, 'off-site title links are not stored as TPB source pages');
  assert.equal(sink[0].source_tracker, null, 'trackers absent from the page magnet stay unknown');
  assert.equal(sink[0].seeders, 10);
  assert.equal(sink[0].leechers, 2);
});

// ============================================================================
// Nyaa / TorrentGalaxy
// ============================================================================

test('Nyaa: non-video categories are not indexed as video', () => {
  const crawler = new NyaaCrawler();
  const row = (category, title, hash) => `<tr><td><img title="${category}"></td>
    <td><a href="/view/1">${title}</a></td>
    <td><a href="magnet:?xt=urn:btih:${hash}">M</a><a href="/download/1.torrent">T</a></td>
    <td>1.5 GiB</td><td>2026-01-01</td><td>10</td><td>2</td></tr>`;

  const html = `<table class="torrent-list"><tbody>
    ${row('Audio - Lossless', 'Some Album', HASH)}
    ${row('Literature - Manga', 'Some Book', HASH2)}
    ${row('Software - Applications', 'Some App', 'abcdefabcdefabcdefabcdefabcdefabcdefabcd')}
    ${row('Pictures - Graphics', 'Some Picture', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')}
    ${row('Games - PC', 'Some Game', '1234512345123451234512345123451234512345')}
    ${row('Other - Miscellaneous', 'Some Other File', '2222222222222222222222222222222222222222')}
    ${row('Live Action - English-translated', 'Sample Castellano 1080p', 'abcdef1234567890abcdef1234567890abcdef12')}
  </tbody></table>`;

  const records = crawler.parseRows(html, 'https://nyaa.test', 'https://nyaa.test');
  assert.equal(records.length, 1, 'only the video row survives');
  assert.equal(records[0].type, 'movie');
});

test('TorrentGalaxy: peers come from cells and metainfo links must be trusted and hash-matched', () => {
  const crawler = new TorrentGalaxyCrawler();
  const mirror = 'https://tgx.test';

  const row = (hash, fileHref, titleHref = '/torrent/1/sample') => `<div class="tgxtablerow">
    <a href="${titleHref}">Sample Castellano 1080p</a>
    <a href="magnet:?xt=urn:btih:${hash}">M</a>
    ${fileHref ? `<a href="${fileHref}">iTorrents</a>` : ''}
    <span class="badge">2.1 GB</span>
    <span class="tgxtablecell seeders">1,234</span>
    <span class="tgxtablecell leechers">56</span>
  </div>`;

  const [record] = crawler.parseTorrentGalaxyHtml(
    row(HASH, `/torrent/${HASH}/sample.torrent`), `${mirror}/torrents`, mirror
  );
  assert.equal(record.seeders, 1234);
  assert.equal(record.leechers, 56);
  assert.equal(record.torrent_file_url, `${mirror}/torrent/${HASH}/sample.torrent`);

  const [mismatch] = crawler.parseTorrentGalaxyHtml(
    row(HASH, `/torrent/${HASH2}/sample.torrent`), `${mirror}/torrents`, mirror
  );
  assert.equal(mismatch.torrent_file_url, null, 'a file link for another hash is not stored');

  const [adLink] = crawler.parseTorrentGalaxyHtml(
    row(HASH, `https://ads.example/torrent/${HASH}/sample.torrent`, 'https://ads.example/torrent/1/sample'),
    `${mirror}/torrents`, mirror
  );
  assert.equal(adLink.torrent_file_url, null, 'a matching hash does not make an arbitrary host trusted');
  assert.equal(adLink.source_url, `${mirror}/torrents`, 'an off-site title link falls back to the listing page');

  const itorrents = crawler.parseTorrentGalaxyHtml(
    row(HASH, `https://itorrents.org/torrent/${HASH}/sample.torrent`), `${mirror}/torrents`, mirror
  )[0];
  assert.equal(itorrents.torrent_file_url, `https://itorrents.org/torrent/${HASH}/sample.torrent`);
});

test('TorrentGalaxy: iTorrents hash fallback builds a tracker-free magnet', () => {
  const crawler = new TorrentGalaxyCrawler();
  const mirror = 'https://tgx.test';
  const html = `<div class="tgxtablerow">
    <a href="/torrent/7/sample">Sample Castellano 1080p</a>
    <a href="https://itorrents.org/torrent/${HASH}.torrent">iTorrents</a>
  </div>`;
  const [record] = crawler.parseTorrentGalaxyHtml(html, `${mirror}/torrents`, mirror);
  assert.equal(record.info_hash, HASH);
  assert.equal(record.torrent_file_url, `https://itorrents.org/torrent/${HASH}.torrent`);
  assert.equal(record.source_tracker, null);
  assert.doesNotMatch(record.magnet_url, /[?&]tr=/);
});

test('TorrentGalaxy: a duplicate page across endpoints does not stop published pagination', async () => {
  const previousBase = process.env.TORRENTGALAXY_BASE_URL;
  const mirror = 'https://tgx.test';
  process.env.TORRENTGALAXY_BASE_URL = mirror;
  clearMirrorCache('torrentgalaxy');
  try {
    const crawler = new TorrentGalaxyCrawler();
    const row = (id, hash) => `<div class="tgxtablerow">
      <a href="/torrent/${id}/sample">Sample ${id} Castellano 1080p</a>
      <a href="magnet:?xt=urn:btih:${hash}">M</a>
      <span class="badge">1.5 GB</span>
    </div>`;
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/`) return '<div class="tgxtable"></div>';
      if (url === `${mirror}/movies`) return row(1, HASH);
      if (url.includes('/torrents.php?search=spanish')) {
        if (url.includes('page=2')) return row(2, HASH2);
        return `${row(1, HASH)}<div class="pagination"><a href="/torrents.php?search=spanish&amp;sort=id&amp;order=desc&amp;page=2">2</a></div>`;
      }
      return '<div class="empty"></div>';
    });

    const records = await crawler.crawl(2);
    assert.ok(calls.some(url => url.includes('/torrents.php?search=spanish') && url.includes('page=2')));
    assert.ok(records.some(record => record.info_hash === HASH2), 'page 2 releases are retained after an overlap');
  } finally {
    if (previousBase === undefined) delete process.env.TORRENTGALAXY_BASE_URL;
    else process.env.TORRENTGALAXY_BASE_URL = previousBase;
    clearMirrorCache('torrentgalaxy');
  }
});

test('TorrentGalaxy: a mirror that passes its probe but fails every catalogue is an error', async () => {
  const previousBase = process.env.TORRENTGALAXY_BASE_URL;
  const mirror = 'https://tgx-flaky.test';
  process.env.TORRENTGALAXY_BASE_URL = mirror;
  clearMirrorCache('torrentgalaxy');
  try {
    const crawler = new TorrentGalaxyCrawler();
    mockHttp(crawler, url => {
      if (url === `${mirror}/`) return '<div class="tgxtable"></div>';
      throw new Error('simulated catalogue outage');
    });
    await assert.rejects(crawler.crawl(1), /No usable catalogue responses/);
  } finally {
    if (previousBase === undefined) delete process.env.TORRENTGALAXY_BASE_URL;
    else process.env.TORRENTGALAXY_BASE_URL = previousBase;
    clearMirrorCache('torrentgalaxy');
  }
});

test('TorrentGalaxy: repeated result pages stop pagination without an off-by-one request', async () => {
  const previousBase = process.env.TORRENTGALAXY_BASE_URL;
  const mirror = 'https://tgx.test';
  process.env.TORRENTGALAXY_BASE_URL = mirror;
  clearMirrorCache('torrentgalaxy');
  try {
    const crawler = new TorrentGalaxyCrawler();
    const row = `<div class="tgxtablerow"><a href="/torrent/1/sample">Sample Castellano 1080p</a>
      <a href="magnet:?xt=urn:btih:${HASH}">M</a></div>`;
    const calls = mockHttp(crawler, url => {
      if (url === `${mirror}/`) return '<div class="tgxtable"></div>';
      if (url === `${mirror}/movies`) return `${row}<div class="pagination"><a href="/movies?page=2">2</a></div>`;
      if (url === `${mirror}/movies?page=2`) return `${row}<div class="pagination"><a href="/movies?page=3">3</a></div>`;
      return '<div class="empty"></div>';
    });

    await crawler.crawl(3);
    assert.ok(calls.includes(`${mirror}/movies?page=2`));
    assert.equal(calls.includes(`${mirror}/movies?page=3`), false);
  } finally {
    if (previousBase === undefined) delete process.env.TORRENTGALAXY_BASE_URL;
    else process.env.TORRENTGALAXY_BASE_URL = previousBase;
    clearMirrorCache('torrentgalaxy');
  }
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

test('MejorTorrent: an overlapping category page does not hide its own next page', async () => {
  const crawler = new MejorTorrentCrawler();
  clearMirrorCache('mejortorrent');
  const card = id => `<a href="/pelicula/${id}/sample.html">Sample ${id}</a>`;
  const calls = mockHttp(crawler, url => {
    if (url.includes('/pelicula/')) {
      const id = Number(url.split('/pelicula/')[1]?.split('/')[0] || 1);
      return `<h1>Sample ${id} Castellano</h1><a href="magnet:?xt=urn:btih:${id === 1 ? HASH : HASH2}">M</a>`;
    }
    if (url.endsWith('/peliculas-hd')) {
      return `${card(1)}<div class="pagination"><a href="/peliculas-hd/page/2">2</a></div>`;
    }
    if (url.endsWith('/peliculas-hd/page/2')) return card(2);
    if (url.endsWith('/inicio')) return card(1);
    return '<div>empty section</div>';
  });

  const records = await crawler.crawl(3);
  clearMirrorCache('mejortorrent');
  assert.equal(records.length, 2);
  assert.ok(calls.some(url => url.endsWith('/peliculas-hd/page/2')));
});

test('MejorTorrent: repeated WordPress API pages stop and external post links are ignored', async () => {
  const crawler = new MejorTorrentCrawler();
  const mirror = 'https://mejortorrent.test';
  const pageOne = [
    { link: `${mirror}/pelicula/sample/` },
    { link: 'https://evil.example/pelicula/injected/' }
  ];
  const calls = mockHttp(crawler, url => {
    if (url.includes('/wp-json/')) return pageOne;
    if (url === `${mirror}/pelicula/sample/`) {
      return `<h1>Sample Castellano 1080p</h1><a href="magnet:?xt=urn:btih:${HASH}">Magnet</a><a href="https://evil.example/ad.torrent">Ad</a>`;
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const records = await crawler.crawlModernMeMode(mirror, 6);
  assert.equal(records.length, 1);
  assert.equal(calls.filter(url => url.includes('/wp-json/')).length, 2);
  assert.equal(calls.filter(url => url === `${mirror}/pelicula/sample/`).length, 1);
  assert.ok(calls.every(url => !url.includes('evil.example')));
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
  const html = `<a href="https://www.grantorrent.test/icefall/"><img src="/wp-content/uploads/p.jpg"></a>
    <a href="https://grantorrent.test/categoria/accion/"><img src="/wp-content/uploads/c.jpg"></a>`;
  assert.deepEqual(crawler.parseListing(html, 'https://grantorrent.test'), ['https://www.grantorrent.test/icefall/']);
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
  assert.equal(decodeSinsitioDownload('http://sinsitio.site/index.php?do=download&id=42', 'https://sinsitio.site/'), null);
  assert.equal(decodeSinsitioDownload('https://sinsitio.site/index.php?do=download', 'https://sinsitio.site/'), null);
});
