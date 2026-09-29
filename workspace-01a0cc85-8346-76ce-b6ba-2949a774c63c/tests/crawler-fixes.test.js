import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguages } from '../src/utils/language.ts';
import { parseSizeToBytes } from '../src/utils/regex.ts';
import { parseCount } from '../src/crawlers/support.ts';
import { decodeAcortameString } from '../src/crawlers/elitetorrent.ts';

test('Subtitle phrases are not read as audio evidence', () => {
  assert.deepEqual(detectLanguages('Pelicula 1080p Sub ESP', [], false).audio, []);
  assert.deepEqual(detectLanguages('Movie ENG Sub ESP', [], false).audio, ['English']);
  assert.deepEqual(detectLanguages('Show Subs English', [], false).audio, []);
});

test('"en español" is not English audio nor English subtitles', () => {
  const audio = detectLanguages('Audio en Español', [], false);
  assert.deepEqual(audio.audio, ['Spanish']);
  const subs = detectLanguages('Film Sub en Español', [], false);
  assert.ok(!subs.subtitles.includes('Sub_EN'));
  assert.ok(!subs.audio.includes('English'));
});

test('Sizes with thousands separators and decimal commas', () => {
  assert.equal(parseSizeToBytes('1,234.5 MB'), Math.round(1234.5 * 1048576));
  assert.equal(parseSizeToBytes('2,048 MB'), 2048 * 1048576);
  assert.equal(parseSizeToBytes('3,19 GB'), Math.round(3.19 * 1073741824));
  assert.equal(parseSizeToBytes('700 bytes'), 700);
});

test('Counters accept dot thousands separators', () => {
  assert.equal(parseCount('1.234'), 1234);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('12.5'), null);
});

test('Acortame decoder accepts URL-safe Base64 without padding', () => {
  const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=x?y';
  const urlSafe = Buffer.from(magnet).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeAcortameString(urlSafe), magnet);
});

import { looksLikeBlockedPage } from '../src/crawlers/mirrors.ts';
import { isBlockedTitle } from '../src/crawlers/support.ts';
import { parseTorrentBuffer } from '../src/utils/bencode2.ts';

test('Block-page detection ignores movie titles inside a real listing', () => {
  const rows = '<tr><td>Some.Release.2024.1080p.WEB-DL</td></tr>'.repeat(200);
  assert.equal(looksLikeBlockedPage(`<html><title>Torrents</title><body>${rows}<a>Access Denied 2024 1080p</a><a>Un momento en el tiempo</a></body></html>`), false);
  assert.equal(looksLikeBlockedPage('<html><title>Just a moment...</title><body></body></html>'), true);
  assert.equal(looksLikeBlockedPage(`<html><title>x</title>${rows}<script src="/cdn-cgi/challenge-platform/h/b"></script></html>`), true);
});

test('Mainstream "adult" titles are not blocked', () => {
  assert.equal(isBlockedTitle('Adult Swim Collection S01'), false);
  assert.equal(isBlockedTitle('Some XXX release'), true);
});

test('Metainfo with a trailing newline is still parsed', () => {
  const info = 'd6:lengthi5e4:name1:a12:piece lengthi16384e6:pieces20:' + 'x'.repeat(20) + 'e';
  const buf = Buffer.from(`d8:announce9:udp://t/a4:info${info}e\n`);
  assert.ok(parseTorrentBuffer(buf));
  assert.equal(parseTorrentBuffer(Buffer.from(`d8:announce9:udp://t/a4:info${info}egarbage`)), null);
});

// ============================================================================
// Regressions: DonTorrent / EliteTorrent / Wolftorrent
// ============================================================================

import { readFileSync } from 'node:fs';
import { DonTorrentCrawler, escapeRegex } from '../src/crawlers/dontorrent.ts';
import { EliteTorrentCrawler, isEliteDetailUrl, sameHost, decodeAcortameString as decodeShortener } from '../src/crawlers/elitetorrent.ts';
import { WolftorrentCrawler, isWolfDetailPath, isSameDomain, wolfDownloadUrl } from '../src/crawlers/wolftorrent.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { mockHttp, MAGNET, HASH } from './helpers.js';

test('DonTorrent: labels with regex metacharacters never throw', () => {
  assert.equal(escapeRegex('año (estreno)'), 'año \\(estreno\\)');
  assert.equal(escapeRegex('1080p+'), '1080p\\+');
  assert.equal(escapeRegex('plain'), 'plain');

  const crawler = new DonTorrentCrawler();
  const detail = crawler.parseDetail(
    `<h1>Poli malo</h1><p><b>Formato (estreno):</b> BluRay-1080p</p><p><b>Año:</b> 2025</p>`,
    'https://dontorrent.moi/pelicula/31014/Poli-malo'
  );
  assert.equal(detail.title, 'Poli malo');
  assert.equal(detail.year, 2025);
});

test('DonTorrent: links without a row keep their own episode instead of the page first one', () => {
  const crawler = new DonTorrentCrawler();
  // No <tr>/<li>: the old `.closest('tr, li, .card-body')` climbed to the page
  // wrapper and every download inherited the first episode of the page.
  const detail = crawler.parseDetail(`<h1>Sample Series</h1><div class="card-body">
    <p>1x01 <a href="/files/s01e01.torrent">Descargar</a></p>
    <p>1x02 <a href="/files/s01e02.torrent">Descargar</a></p>
    <p>1x03 <a href="/files/s01e03.torrent">Descargar</a></p>
    <p>${'Sinopsis larga. '.repeat(40)} <a href="/files/extra.torrent">Descargar</a></p>
    </div>`, 'https://dontorrent.moi/serie/1/sample');

  assert.equal(detail.downloads.length, 4);
  assert.deepEqual(detail.downloads.map(d => `${d.season}x${d.episode}`), ['1x1', '1x2', '1x3', 'nullxnull']);
  // The 150-char cap keeps a synopsis out of the hints.
  assert.ok(detail.downloads.every(d => d.hints.every(hint => hint.length <= 150)));
});

test('DonTorrent: a numeric slug is never stored as the title', () => {
  const crawler = new DonTorrentCrawler();
  const detail = crawler.parseDetail('<html><body><div class="card-body"></div></body></html>', 'https://dontorrent.moi/pelicula/12345/');
  assert.equal(detail.title, '');
  assert.notEqual(detail.title, '12345');
});

test('DonTorrent: a catalogue that publishes no next link is fetched once', async () => {
  clearMirrorCache('dontorrent');
  const crawler = new DonTorrentCrawler();
  const list = '<html><body><a href="/pelicula/31014/Poli-malo"><span>(BluRay-1080p)</span>Poli malo</a></body></html>';
  const calls = mockHttp(crawler, url => {
    if (url.includes('/pelicula/')) return `<h1>Descargar Poli malo Torrent</h1><a href="${MAGNET}">Descargar</a>`;
    if (url.endsWith('/dominios')) return '<html><body>Dominios</body></html>';
    return list;
  });

  const records = await crawler.crawl(3);
  assert.equal(records.length, 1);
  // `?p=2`, `?p=3` were guessed before; only real pagination is followed now.
  assert.equal(calls.filter(url => url.includes('?p=')).length, 0);
  clearMirrorCache('dontorrent');
});

test('EliteTorrent: the label <span> never blanks the value read from the <li>', async () => {
  const crawler = new EliteTorrentCrawler();
  mockHttp(crawler, () => `<h1>Descargar Sample Castellano por torrent</h1>
    <ul><li><span>Tamaño:</span> 1,5 GB</li><li><span>Idioma:</span> Castellano</li>
    <li><span>Calidad:</span> 1080p</li></ul><a href="${MAGNET}">M</a>`);

  const record = await crawler.parseEliteTorrentDetail('https://elite.example/series/sample/', 'https://elite.example');
  assert.equal(record.info_hash, HASH);
  // "Tamaño:" alone used to overwrite the 1,5 GB read one node earlier.
  assert.equal(record.size_bytes, Math.round(1.5 * 1024 ** 3));
  assert.ok(record.audio.includes('Spanish'));
  assert.equal(record.quality, '1080p');
});

test('EliteTorrent: a dual-language ficha keeps both audio tracks', async () => {
  const crawler = new EliteTorrentCrawler();
  mockHttp(crawler, () => `<h1>Descargar Sample por torrent</h1>
    <p class="descrip"><span>Idioma:</span> Castellano / Inglés</p><a href="${MAGNET}">M</a>`);

  const record = await crawler.parseEliteTorrentDetail('https://elite.example/peliculas/sample/', 'https://elite.example');
  assert.ok(record.audio.includes('Spanish'));
  assert.ok(record.audio.includes('English'), 'the second language was lost to an else-if');
});

test('EliteTorrent: category, pager and genre routes are not queued as details', () => {
  const base = 'https://www.elitetorrent.com';
  for (const href of [
    '/peliculas/',
    '/peliculas/accion/',
    '/series/page/2/',
    '/series/drama/',
    '/calidad/1080p-10-1/',
    '/idioma/castellano-17-1/',
    '/peliculas/feed/',
    '/peliculas/index.php',
    'https://ads.example/peliculas/sample/',
    'https://user:pass@www.elitetorrent.com/peliculas/sample/'
  ]) {
    assert.equal(isEliteDetailUrl(href, base), false, href);
  }
  for (const href of [
    '/peliculas/1234-sample-castellano',
    '/peliculas/1234-sample-castellano.html',
    '/series/1234/sample-castellano/',
    '/series/sample/',
    'https://elitetorrent.com/peliculas/1234-sample/'
  ]) {
    assert.equal(isEliteDetailUrl(href, base), true, href);
  }

  assert.equal(sameHost('https://elitetorrent.com/a', 'https://www.elitetorrent.com/b'), true);
  assert.equal(sameHost('https://elitetorrent.com/a', 'https://ads.example/b'), false);
});

test('EliteTorrent: nested URL-safe Base64 without padding is decoded', () => {
  const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=x';
  const inner = Buffer.from(magnet).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const outer = Buffer.from(inner).toString('base64').replace(/=+$/, '');
  assert.equal(decodeShortener(outer), magnet);
  assert.equal(decodeShortener('not base64!!'), rot13Of('not base64!!'));
});

function rot13Of(value) {
  return value.replace(/[a-zA-Z]/g, char => {
    const code = char.charCodeAt(0);
    const base = code >= 65 && code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

test('Wolftorrent: pagination and category routes are not queued as details', () => {
  const base = 'https://wolftorrent.com';
  assert.equal(isWolfDetailPath('/pelicula/abc123/Sample', base), true);
  assert.equal(isWolfDetailPath('/serie/def456/Serie-1-Temporada', base), true);
  // Same site, different host spelling: accepted (the old strict origin check
  // threw away every link when the base URL and the links disagreed on www).
  assert.equal(isWolfDetailPath('https://www.wolftorrent.com/pelicula/abc123/Sample', base), true);

  for (const href of [
    '/pelicula/page/2/',
    '/serie/categoria/accion/',
    '/pelicula/calidad/1080p/',
    '/pelicula/abc123/sample.torrent',
    '/peliculas',
    'https://ads.example/pelicula/abc123/Sample',
    'https://user:pass@wolftorrent.com/pelicula/abc123/Sample'
  ]) {
    assert.equal(isWolfDetailPath(href, base), false, href);
  }

  assert.equal(isSameDomain('https://wolftorrent.com/a', 'https://www.wolftorrent.com/b'), true);
  assert.equal(isSameDomain('https://cdn.wolftorrent.com/a', 'https://wolftorrent.com/b'), true);
  assert.equal(isSameDomain('https://wolfmax4k.com/a', 'https://wolftorrent.com/b'), false);
  assert.equal(isSameDomain('https://user:pass@wolftorrent.com/a', 'https://wolftorrent.com/b'), false);
});

test('Wolftorrent: every same-domain download endpoint is accepted, offsite ones are not', () => {
  const base = 'https://wolftorrent.com/serie/abc123/Sample';
  for (const href of ['/descargar/1', '/descarga/1', '/download/1', '/get/1?id=2', '/torrent/1', '/links/1', '/files/a.torrent']) {
    assert.match(wolfDownloadUrl(href, base), /wolftorrent\.com/, href);
  }
  assert.equal(wolfDownloadUrl('https://ads.example/download/abc', base), null);
  assert.equal(wolfDownloadUrl('https://ads.example/file.torrent', base), null);
  assert.equal(wolfDownloadUrl('https://user:pass@wolftorrent.com/files/a.torrent', base), null);
  assert.equal(wolfDownloadUrl('/index.php?do=download&id=42', base), 'https://wolftorrent.com/index.php?do=download&id=42');
  assert.equal(wolfDownloadUrl('/?id=42', base), null, 'a generic id query is not enough to trust a download endpoint');
  assert.equal(wolfDownloadUrl('http://wolftorrent.com/files/a.torrent', base), null);
  assert.equal(wolfDownloadUrl('javascript:alert(1)', base), null);
  // A valid magnet is accepted, whatever host published it, but malformed
  // magnets are filtered before they enter the generic catalogue pipeline.
  assert.equal(wolfDownloadUrl(MAGNET, base), MAGNET);
  assert.equal(wolfDownloadUrl('magnet:?xt=urn:btih:invalid', base), null);
});

test('Wolftorrent: the 2026 WolfMax4K layout (slugless ids and episode fichas) is queued as details', () => {
  const base = 'https://wolfmax4k.com';
  // Links observed on the live site (2026-09): short ids, no slug, and
  // per-episode fichas under /serie/episodio/.
  assert.equal(isWolfDetailPath('/pelicula/ryqb95', base), true);
  assert.equal(isWolfDetailPath('/serie/5se8eg', base), true);
  assert.equal(isWolfDetailPath('/serie/episodio/5sjfvr', base), true);
  assert.equal(isWolfDetailPath('https://wolfmax4k.com/pelicula/ryqb95', base), true);

  // The legacy id/slug fichas keep working.
  assert.equal(isWolfDetailPath('/pelicula/abc123/Sample', base), true);

  for (const href of [
    '/peliculas',                  // catalogue root, no id segment
    '/peliculas?anyo=2025',        // filter query, not a release
    '/peliculas/estrenos',         // listing word, no digits in the id slot
    '/pelicula/mortal-kombat-ii',  // slug-only, no id
    '/serie/page/2/',
    '/pelicula/ryqb95/caratula.webp',
    'https://ads.example/pelicula/ryqb95'
  ]) {
    assert.equal(isWolfDetailPath(href, base), false, href);
  }

  // End to end: a home like the live one queues movie AND episode fichas.
  const crawler = new WolftorrentCrawler();
  const html = `
    <a href="/pelicula/ryqb95">Las catadoras del Hitler</a>
    <a href="/serie/5se8eg">El problema final</a>
    <a href="/serie/episodio/5sjfvr">Episodio 1x02</a>
    <a href="/peliculas?genero=Drama">Drama</a>
    <a href="/peliculas">Catálogo</a>`;
  const links = crawler.parseListing(html, `${base}/peliculas`).sort();
  assert.deepEqual(links, [
    `${base}/pelicula/ryqb95`,
    `${base}/serie/5se8eg`,
    `${base}/serie/episodio/5sjfvr`
  ]);
});
