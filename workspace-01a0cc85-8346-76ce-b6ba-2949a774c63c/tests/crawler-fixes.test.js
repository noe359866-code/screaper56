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
