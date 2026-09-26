import test from 'node:test';
import assert from 'node:assert/strict';
import { ResilientHttpClient } from '../src/utils/http.ts';
import { CloudflareBypassEngine } from '../src/utils/anti-cloudflare.ts';

const reply = (config, data) => ({ config, status:200, statusText:'OK', data, headers:{} });
test('HTTP: configured timeout and per-request Referer reach the transport', async () => {
  const client = new ResilientHttpClient({ timeout:1234, maxRetries:0, autoSolveCloudflare:false,
    adapter: async config => {
      assert.equal(config.timeout, 1234);
      assert.equal(config.headers.Referer, 'https://example.test/detail');
      return reply(config, 'ok');
    }
  });
  assert.equal((await client.get('https://example.test/', { headers:{ Referer:'https://example.test/detail' } })).data, 'ok');
});
test('HTTP: 200 challenge uses the existing fallback path rather than masquerading as HTML', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  const original = engine.solveAndFetch;
  let solves = 0; let requests = 0;
  engine.solveAndFetch = async () => { solves++; return { cookies:'test' }; };
  try {
    const client = new ResilientHttpClient({ maxRetries:1, baseDelayMs:0,
      adapter: async config => reply(config, ++requests === 1 ? '<title>Just a moment...</title>' : '<article>Real content</article>')
    });
    assert.match((await client.get('https://example.test/')).data, /Real content/);
    assert.equal(solves, 1); assert.equal(requests, 2);
  } finally { engine.solveAndFetch = original; }
});
test('HTTP: challenge is rejected if the browser fallback is disabled', async () => {
  const client = new ResilientHttpClient({ maxRetries:0, autoSolveCloudflare:false,
    adapter: async config => reply(config, '<title>Just a moment...</title>')
  });
  await assert.rejects(client.get('https://example.test/'), /Challenge/);
});
