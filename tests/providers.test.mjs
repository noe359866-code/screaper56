import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  allProviderManifestMetadata,
  resolveEnabledProviders,
  resolveProviderSlugs,
} from '../src/providers.mjs';
import { manifestOnlyProviders } from '../public/lib/providers.js';
import { streamUrl } from '../public/lib/pipeline.js';

test('registra todos los manifests solicitados', () => {
  assert.equal(PROVIDERS.peerflix.manifestUrl, 'https://peerflix.mov/manifest.json');
  assert.equal(PROVIDERS.torrentsdb.manifestUrl, 'https://torrentsdb.com/manifest.json');
  assert.equal(PROVIDERS.torrentio.manifestUrl, 'https://torrentio.strem.fun/manifest.json');
  assert.equal(PROVIDERS.piratebay.manifestUrl, 'https://thepiratebay-plus.strem.fun/manifest.json');
  assert.equal(PROVIDERS.ytztvio.manifestUrl, 'https://ytztvio.galacticcapsule.workers.dev/manifest.json');
  assert.equal(PROVIDERS.torrentclaw.manifestUrl, 'https://torrentclaw.com/api/stremio/manifest.json');
  assert.equal(PROVIDERS.aniscraper.manifestUrl, 'https://c5541ffce7d3-aniscraper.baby-beamup.club/manifest.json');
  assert.equal(PROVIDERS.stremthru.manifestUrl, 'https://stremthru.13377001.xyz/stremio/torz/manifest.json');
  assert.equal(PROVIDERS.brazuca.manifestUrl, 'https://94c8cb9f702d-brazuca-torrents.baby-beamup.club/manifest.json');
  assert.equal(PROVIDERS.tpbAdult.manifestUrl, 'https://tpb-adult-addon.click/manifest.json');
  assert.equal(allProviderManifestMetadata().length, 10);
});

test('todos los addons consultables funcionan sin cuenta; TPB Adult queda manifest-only', () => {
  const enabled = resolveEnabledProviders().map(provider => provider.slug);
  assert.deepEqual(enabled, ['peerflix', 'torrentsdb', 'torrentio', 'piratebay', 'ytztvio', 'torrentclaw', 'aniscraper', 'stremthru', 'brazuca']);
  assert.deepEqual(manifestOnlyProviders().map(p => p.slug), ['tpbAdult']);
  assert.equal(PROVIDERS.tpbAdult.queryable, false);
  assert.equal(PROVIDERS.tpbAdult.adult, true);
  // Los que exigen registrarse (debrid) no están registrados.
  for (const slug of ['mediafusion', 'comet', 'intellDebridSearch']) assert.equal(PROVIDERS[slug], undefined);
  assert.equal(allProviderManifestMetadata().some(p => /elfhosted|debridsearch/.test(p.manifestUrl)), false);
  assert.deepEqual(resolveEnabledProviders('comet,mediafusion,torrentclaw').map(p => p.slug), ['torrentclaw']);
});

test('StremThru Torz se consulta con la configuración P2P pública y acepta alias', () => {
  const config = PROVIDERS.stremthru.baseUrl.split('/').pop();
  assert.deepEqual(JSON.parse(Buffer.from(config, 'base64').toString('utf8')), { stores: [{ c: 'p2p', t: '' }] });
  assert.equal(
    streamUrl(PROVIDERS.stremthru, { kind: 'series', imdbId: 'tt0944947', season: 1, episode: 1 }),
    `https://stremthru.13377001.xyz/stremio/torz/${config}/stream/series/tt0944947:1:1.json`,
  );
  assert.equal(
    streamUrl(PROVIDERS.torrentclaw, { kind: 'movie', imdbId: 'tt0111161' }),
    'https://torrentclaw.com/api/stremio/stream/movie/tt0111161.json',
  );
  assert.deepEqual(resolveProviderSlugs('torz, TorrentClaw, aniscraper'), ['stremthru', 'torrentclaw', 'aniscraper']);
});
