import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, streamToTorrentRecord } from '../src/db.mjs';

const HASH = '0123456789abcdef0123456789abcdef01234567';

function candidate(overrides = {}) {
  return {
    item: { imdbId: 'tt0111161', type: 'movie', season: null, episode: null },
    stream: {
      infoHash: HASH.toUpperCase(),
      title: 'The Shawshank Redemption 1080p [ES-EN]',
      quality: '1080p',
      audioLangs: ['es', 'en', 'es'],
      fileIdx: 0,
      seeders: 12,
      sizeBytes: 1234,
      providers: ['peerflix', 'torrentio'],
      magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      ...overrides,
    },
  };
}

test('mapea el stream al esquema existente sin inventar magnet_url', () => {
  const record = streamToTorrentRecord(candidate().item, candidate().stream);
  assert.equal(record.info_hash, HASH);
  assert.equal(record.imdb_id, 'tt0111161');
  assert.deepEqual(record.audio, ['es', 'en']);
  assert.deepEqual(record.subtitles, ['es', 'en']);
  assert.equal(record.source_tracker, 'peerflix+torrentio');
  assert.equal(record.magnet_url, undefined);
  assert.equal(record.seeders, 12);
  assert.equal(record.size_bytes, 1234);
});

test('rechaza info-hashes que no sean 40 hex distintos de cero', () => {
  assert.equal(streamToTorrentRecord(candidate().item, { ...candidate().stream, infoHash: '0'.repeat(40) }), null);
  assert.equal(streamToTorrentRecord(candidate().item, { ...candidate().stream, infoHash: 'not-a-hash' }), null);
});

test('dry-run deduplica por info_hash y cuenta rechazos', async () => {
  const repo = createRepository({ dryRun: true });
  const result = await repo.upsert([
    candidate(),
    candidate({ title: 'same hash, richer title' }),
    { item: candidate().item, stream: { ...candidate().stream, infoHash: 'bad' } },
  ]);
  assert.deepEqual(result, { inserted: 1, rejected: 1, dryRun: true });
});
