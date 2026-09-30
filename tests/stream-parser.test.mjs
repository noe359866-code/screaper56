import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStremioStream, normalizeQuality } from '../src/fetch.mjs';
import { PROVIDERS } from '../src/providers.mjs';

const HASH = '814978f980297cc7cd42be9d60b37b928a5e7cdc';

test('normaliza calidad a las categorías de la tabla', () => {
  assert.equal(normalizeQuality('Torrentio\n4k DV', ''), '4K');
  assert.equal(normalizeQuality('TPB+', 'title 1080p BluRay'), '1080p');
  assert.equal(normalizeQuality('provider', 'release 1440p'), '4K');
  assert.equal(normalizeQuality('provider', 'release unknown'), null);
});

test('lee el contrato Peerflix: description, seed, sizebytes y trackers', () => {
  const stream = parseStremioStream({
    name: 'Peerflix 🇪🇸 4K',
    description: 'Cadena perpetua [4K][2160p][HDR10][Castellano-Ingles+Subs][ES-EN]\nfile.mkv\n 👤 1 💾 59.61 GB 🌐 Peerflix',
    infoHash: HASH,
    sources: ['tracker:udp://tracker.example/announce', `dht:${HASH}`],
    fileIdx: 5,
    language: 'es',
    quality: '4K',
    seed: 1,
    sizebytes: 64005750128,
  }, PROVIDERS.peerflix);

  assert.equal(stream.infoHash, HASH);
  assert.equal(stream.title, 'Cadena perpetua [4K][2160p][HDR10][Castellano-Ingles+Subs][ES-EN]');
  assert.equal(stream.seeders, 1);
  assert.equal(stream.sizeBytes, 64005750128);
  assert.equal(stream.quality, '4K');
  assert.deepEqual(stream.languages, ['es', 'en']);
  assert.deepEqual(stream.trackers, ['udp://tracker.example/announce']);
});

test('lee footer Torrentio sin asumir que es la última línea', () => {
  const stream = parseStremioStream({
    name: 'Torrentio\n4k HDR',
    title: 'The Shawshank Redemption 1994 2160p BluRay\n👤 100 💾 6.91 GB ⚙️ YTS\n🇬🇧',
    infoHash: 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6',
    fileIdx: 0,
  }, PROVIDERS.torrentio);

  assert.equal(stream.seeders, 100);
  assert.equal(stream.sizeBytes, Math.round(6.91 * 1024 * 1024 * 1024));
  assert.equal(stream.externalProvider, 'YTS');
  assert.deepEqual(stream.languages, ['en']);
});
