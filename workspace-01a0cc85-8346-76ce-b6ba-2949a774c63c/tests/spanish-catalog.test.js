import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { literalDownloadCandidates, spanishReleaseHints } from '../src/crawlers/spanish-catalog.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { SinsitioCrawler } from '../src/crawlers/sinsitio.ts';
import { WolftorrentCrawler } from '../src/crawlers/wolftorrent.ts';
import { DonTorrentCrawler } from '../src/crawlers/dontorrent.ts';
import { EliteTorrentCrawler } from '../src/crawlers/elitetorrent.ts';
import { MejorTorrentCrawler } from '../src/crawlers/mejortorrent.ts';
import { HASH, mockHttp, torrent } from './helpers.js';
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
  // The ficha's explicit «Subtítulos: Español» still wins the subtitle slot,
  // and the site marker (the only audio evidence a DLE post may lack) tags
  // the audio Spanish — both survive the language filter below.
  assert.deepEqual(records[0].audio, ['Spanish']);
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
test('Wolftorrent: a live-shaped ficha (no Idioma row) passes the language filter and keeps quality', async () => {
  // Live shape 2026-09-29: h1 title, «Calidad/Tamaño» as dt/dd WITHOUT colons,
  // no language row anywhere and a scene-style torrent name with no language
  // tag either. The catalogue is «películas en español», so the record must
  // still reach the database instead of being discarded with audio=[].
  clearMirrorCache('wolftorrent');
  const crawler = new WolftorrentCrawler();
  const file = torrent('Normal.2026.1080p.WEB-DL');
  mockHttp(crawler, url => {
    if (url.includes('/pelicula/')) {
      return `<h1>Normal</h1>
        <dl><dt>Año</dt><dd>2026</dd><dt>Calidad</dt><dd>1080p</dd><dt>Tamaño</dt><dd>955,72 MB</dd></dl>
        <button data-url="/descargar/rytkrd">Descargar torrent</button>`;
    }
    return '<a href="/pelicula/rytkrd">Normal</a>';
  }, () => file.buffer);

  const records = await crawler.crawl(1);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0].audio, ['Spanish']);
  assert.deepEqual(records[0].subtitles, []);
  assert.equal(records[0].quality, '1080p', 'the dt/dd «Calidad» row must reach the title parser');
  assert.equal(crawler.filterSpanishReleases(records).accepted.length, 1);
  clearMirrorCache('wolftorrent');
});

test('Sinsitio: a live post whose name= carries no language still passes the language filter', async () => {
  // Live anatomy 2026-09-29: the classic-cinema post
  // «El Rostro impenetrable (1961) Marlon Brando» publishes
  // name=El Rostro Impenetrable 1961marlon Brando Mkv — no Castellano in
  // h1, name= or body — and the listing titles of /series/ («Crookhaven T1»)
  // carry no language either. The site IS «películas en español», so the
  // site marker must keep the record out of the discard pile.
  clearMirrorCache('sinsitio');
  const crawler = new SinsitioCrawler();
  const file = torrent('El Rostro Impenetrable 1961 Mkv');
  const attachment = `https://www.sinsitio.site/index.php?do=download&id=69715`;
  mockHttp(crawler, url => {
    if (url.includes('35920-')) {
      return `<h1>El Rostro impenetrable (1961) Marlon Brando</h1>
        <a href="/ddlUrl.php?url=${Buffer.from(attachment).toString('base64')}&name=El%20Rostro%20Impenetrable%201961marlon%20Brando%20Mkv">Descargar</a>`;
    }
    return '<a href="/cine-clsico-de-todos-los-tiempos/35920-el-rostro-impenetrable-1961.html">Post</a>';
  }, () => file.buffer);

  const records = await crawler.crawl(1);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0].audio, ['Spanish'], 'the site marker is the only language evidence this post has');
  assert.equal(crawler.filterSpanishReleases(records).accepted.length, 1);
  clearMirrorCache('sinsitio');
});

test('Sinsitio: a live series post yields one record per episode with season/episode parsed', async () => {
  // Live anatomy 2026-09-29 (/series/34972-crookhaven-t1.html): ONE post
  // with a ddlUrl.php link PER EPISODE, each carrying its own name= with
  // «1xN … Castellano» — the season/episode and language come from there.
  clearMirrorCache('sinsitio');
  const crawler = new SinsitioCrawler();
  const episodeFiles = {
    67974: torrent('Crookhaven 1x1 Hdtv Xvid Castellano'),
    67975: torrent('Crookhaven 1x2 Hdtv Xvid Castellano')
  };
  const episodeLinks = Object.entries(episodeFiles)
    .map(([id, file]) => {
      const episode = id === '67974' ? '1x1' : '1x2';
      const encoded = Buffer.from(`https://www.sinsitio.site/index.php?do=download&id=${id}`).toString('base64');
      return `<a href="/ddlUrl.php?url=${encoded}&name=Crookhaven%20${episode}%20Hdtv%20Xvid%20Castellano">🎬 Ep</a>`;
    })
    .join('');
  mockHttp(crawler, url => {
    if (url.includes('34972-')) return `<h1>Crookhaven T1</h1>${episodeLinks}`;
    return '<a href="/series/34972-crookhaven-t1.html">Crookhaven T1</a>';
  }, url => {
    const id = url.match(/id=(\d+)/)?.[1];
    return episodeFiles[id].buffer;
  });

  const records = await crawler.crawl(1);

  assert.equal(records.length, 2, 'one record per episode link');
  assert.deepEqual(records.map(record => record.season), [1, 1]);
  assert.deepEqual(records.map(record => record.episode), [1, 2]);
  assert.ok(records.every(record => record.type === 'series'));
  assert.ok(records.every(record => record.audio.includes('Spanish')));
  clearMirrorCache('sinsitio');
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
