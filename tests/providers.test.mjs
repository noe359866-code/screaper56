import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  allProviderManifestMetadata,
  resolveEnabledProviders,
} from '../src/providers.mjs';

test('registra los cinco manifests solicitados', () => {
  assert.equal(PROVIDERS.peerflix.manifestUrl, 'https://peerflix.mov/manifest.json');
  assert.equal(PROVIDERS.torrentsdb.manifestUrl, 'https://torrentsdb.com/manifest.json');
  assert.equal(PROVIDERS.torrentio.manifestUrl, 'https://torrentio.strem.fun/manifest.json');
  assert.equal(PROVIDERS.piratebay.manifestUrl, 'https://thepiratebay-plus.strem.fun/manifest.json');
  assert.equal(PROVIDERS.tpbAdult.manifestUrl, 'https://tpb-adult-addon.click/manifest.json');
  assert.equal(allProviderManifestMetadata().length, 5);
});

test('los cuatro manifests con IDs IMDb son queryables y TPB Adult queda catalog-only', () => {
  const enabled = resolveEnabledProviders().map(provider => provider.slug);
  assert.deepEqual(enabled, ['peerflix', 'torrentsdb', 'torrentio', 'piratebay']);
  assert.equal(PROVIDERS.tpbAdult.queryable, false);
  assert.equal(PROVIDERS.tpbAdult.adult, true);
});
