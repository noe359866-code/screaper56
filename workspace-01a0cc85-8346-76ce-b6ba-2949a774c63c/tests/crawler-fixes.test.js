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
