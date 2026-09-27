import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInfoHash, parseMagnetUri } from '../src/utils/magnet.ts';
import { parseTorrentBuffer } from '../src/utils/bencode2.ts';
import { bencode } from './helpers.js';
import { MirrorResolutionError } from '../src/crawlers/mirrors.ts';
import { diagnoseFailure, summarizeFailure } from '../src/crawlers/failure-diagnosis.ts';

const first = '0123456789abcdef0123456789abcdef01234567';
const second = 'abcdef0123456789abcdef0123456789abcdef01';
test('BTIH IDs: reject BTMH masquerading as v1 and conflicting exact topics', () => {
  assert.equal(normalizeInfoHash(`urn:btmh:${first}`), null);
  assert.equal(parseMagnetUri(`magnet:?xt=urn:btmh:${first}`), null);
  assert.equal(parseMagnetUri(`magnet:?xt=urn:btih:${first}&xt=urn:btih:${second}`), null);
  assert.equal(parseMagnetUri(`magnet:?xt=urn:btih:${first}&xt=urn:btih:${first}`)?.infoHash, first);
  assert.equal(parseMagnetUri(`magnet:?xt=urn:btih:${'0'.repeat(40)}`), null);
  assert.equal(parseMagnetUri(`notmagnet:?xt=urn:btih:${first}`), null);
  assert.equal(normalizeInfoHash(`prefix magnet:?xt=urn:btih:${first}`), null);
});

test('Malformed piece metadata cannot be treated as valid .torrent', () => {
  assert.equal(parseTorrentBuffer(bencode({ info: { name: 'a', length: 10, pieces: 'short' } })), null);
  assert.equal(parseTorrentBuffer(bencode({ info: { name: 'a', length: 10, 'piece length': -1 } })), null);
});

test('Error controller preserves classifications and bounds long mirror messages', () => {
  const error = new MirrorResolutionError('x', [
    { mirror: 'https://a.invalid', reason: 'getaddrinfo ENOTFOUND a.invalid' },
    { mirror: 'https://b.invalid', reason: 'request timed out' }
  ]);
  assert.equal(diagnoseFailure('x', error).kind, 'network');
  assert.ok(summarizeFailure(error, 90).length <= 90);
  assert.equal(diagnoseFailure('x', new Error('Zero extracted records')).kind, 'empty');
});
