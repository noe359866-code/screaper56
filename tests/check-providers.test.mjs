import test from 'node:test';
import assert from 'node:assert/strict';

import { checkProvider, healthToMarkdown } from '../src/check-providers.mjs';
import { HttpError } from '../public/lib/pipeline.js';
import { PROVIDERS } from '../public/lib/providers.js';

const hash = n => n.toString(16).padStart(40, '0');

function fakeFetch(handler) {
  return async url => handler(url);
}

test('checkProvider: ok, caído y solo-manifest', async () => {
  let clock = 0;
  const now = () => (clock += 50);
  const healthy = await checkProvider(PROVIDERS.torrentio, {
    now,
    fetchJSON: fakeFetch(url => url.endsWith('manifest.json')
      ? { id: 'x', version: '1.2.3' }
      : { streams: [{ name: 'Torrentio\n1080p', title: 'Movie.2020.1080p.WEB-DL\n👤 12 💾 2 GB', infoHash: hash(1) }] }),
  });
  assert.equal(healthy.status, 'ok');
  assert.equal(healthy.manifest.version, '1.2.3');
  assert.deepEqual(healthy.probes.map(p => [p.kind, p.streams]), [['movie', 1], ['series', 1]]);

  const down = await checkProvider(PROVIDERS.ytztvio, {
    now,
    fetchJSON: fakeFetch(() => { throw new HttpError(403, 'forbidden'); }),
  });
  assert.equal(down.status, 'down');
  assert.equal(down.probes[0].error, 'HTTP 403');

  // AniScraper solo tiene anime: vacío con película/serie occidental es normal.
  const anime = await checkProvider(PROVIDERS.aniscraper, { now, fetchJSON: fakeFetch(url => url.endsWith('manifest.json') ? { version: '1' } : { streams: [] }) });
  assert.equal(anime.status, 'ok');

  const md = healthToMarkdown([healthy, down, anime]);
  assert.match(md, /\| ✅ \| Torrentio `torrentio` \| sí \| v1\.2\.3/);
  assert.match(md, /\| ❌ \| Ytztvio `ytztvio` \| sí \| ❌ HTTP 403 \| ❌ HTTP 403 \| ❌ HTTP 403 \|/);
});
