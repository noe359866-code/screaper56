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
test('HTTP: disabling Cloudflare handling does not replay cached clearance cookies', async () => {
  const engine = CloudflareBypassEngine.getInstance();
  const url = 'https://no-bypass-session.test/forum/index.php';
  engine.rememberSession('no-bypass-session.test', {
    cookieHeader: 'cf_clearance=stale-clearance',
    userAgent: 'CachedAgent',
    acceptLanguage: 'en-US',
    solvedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hasClearance: true,
    hostname: 'no-bypass-session.test'
  });
  try {
    const client = new ResilientHttpClient({
      maxRetries: 0,
      adapter: async config => {
        assert.equal(config.headers.get('Cookie'), 'bb_session=account-session');
        assert.notEqual(config.headers['User-Agent'], 'CachedAgent');
        return reply(config, 'ok');
      }
    });
    await client.get(url, {
      autoSolveCloudflare: false,
      headers: { Cookie: 'bb_session=account-session' }
    });
  } finally {
    engine.invalidateSession(url);
  }
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
