import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseTorrentBuffer } from '../src/utils/bencode2.ts';
import { extractInfoHashFromTorrentBuffer } from '../src/utils/bencode.ts';
import { parseSizeToBytes, parseTorrentTitle } from '../src/utils/regex.ts';
import { parseMagnetUri } from '../src/utils/magnet.ts';
import { detectLanguages } from '../src/utils/language.ts';
import { PelispandaCrawler } from '../src/crawlers/pelispanda.ts';
import { bencode, torrent, HASH } from './helpers.js';

test('Bencode: hash original info bytes, not fake 4:info inside a comment', () => {
  const info = { name: 'Sample', length: 0 };
  const buffer = bencode({ comment: '4:infod4:name4:fakee', info });
  const parsed = parseTorrentBuffer(buffer);
  assert.equal(parsed.infoHash, createHash('sha1').update(bencode(info)).digest('hex'));
  assert.equal(extractInfoHashFromTorrentBuffer(buffer), parsed.infoHash);
  assert.equal(parsed.sizeBytes, 0);
});
test('Bencode: multifile size, UTF-8 name and announce tiers', () => {
  const buffer = bencode({ 'announce-list': [['udp://a', 'udp://b']], info: {
    name: 'fallback', 'name.utf-8': 'Película', files: [{ length: 4 }, { length: 5 }]
  }});
  const parsed = parseTorrentBuffer(buffer);
  assert.equal(parsed.name, 'Película');
  assert.equal(parsed.sizeBytes, 9);
  assert.deepEqual(parsed.trackers, ['udp://a', 'udp://b']);
});
test('Bencode: rejects malformed/truncated/HTML/duplicate/non-dictionary info without hanging', () => {
  for (const raw of ['<html>login</html>', 'd4:infoi3ee', 'd4:infod6:lengthi-1eee',
    'd4:infod6:lengthi1ee', 'd4:infod6:lengthi01eee', 'd4:infod6:lengthi1e6:lengthi2eee',
    'd4:info9999999999999999999999999999:x', 'd4:infoi12xe', 'd4:infode4:infodee']) {
    assert.equal(parseTorrentBuffer(Buffer.from(raw)), null, raw);
  }
  assert.equal(parseTorrentBuffer(Buffer.concat([torrent().buffer, Buffer.from('junk')])), null);
  assert.equal(parseTorrentBuffer(bencode({ info: { length: 42, 'meta version': 2 } })), null);
});
test('Sizes: Nyaa GiB/MiB and Spanish decimals', () => {
  assert.equal(parseSizeToBytes('1.5 GiB'), 1610612736);
  assert.equal(parseSizeToBytes('1,5 GB'), 1610612736);
  assert.equal(parseSizeToBytes('650 MiB'), 681574400);
  assert.equal(parseSizeToBytes('10 KB'), 10240);
  for (const value of ['N/A', '1..2 GB', '-1 GB', '3 hours ago']) assert.equal(parseSizeToBytes(value), null);
});
test('Episodic labels: 1x02, 2ª Temporada, T3, S04 and Capítulo', () => {
  assert.equal(parseTorrentTitle('Serie 1x02').episode, 2);
  assert.equal(parseTorrentTitle('Serie 2ª Temporada Capítulo 3').season, 2);
  assert.equal(parseTorrentTitle('Serie 2ª Temporada Capítulo 3').episode, 3);
  assert.equal(parseTorrentTitle('Serie T3').season, 3);
  assert.equal(parseTorrentTitle('Serie S04').season, 4);
});
test('Hybrid/Base32 magnets and normalized deduplication', () => {
  const parsed = parseMagnetUri(`magnet:?xt=urn:btmh:1220dead&xt=urn:btih:${'A'.repeat(32)}`);
  assert.equal(parsed.infoHash, '0'.repeat(40));
  const crawler = new PelispandaCrawler();
  const rec = { type:'movie', title:'Sample', audio:[], subtitles:[] };
  const out = crawler.deduplicateRecords([
    { ...rec, info_hash: HASH.toUpperCase() }, { ...rec, info_hash: HASH },
    { ...rec, info_hash: 'broken' }, { ...rec, info_hash: '0'.repeat(40) }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].info_hash, HASH);
});
test('Explicit language mode does not manufacture English for unknown releases', () => {
  assert.deepEqual(detectLanguages('Sample', [], false), { audio: [], subtitles: [] });
  assert.deepEqual(detectLanguages('Sample', ['sub_en'], false), { audio: [], subtitles: ['Sub_EN'] });
});
