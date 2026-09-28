import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { config, loadConfig } from '../src/config/env.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';

function withEnv(values, task) {
  const keys = ['DRY_RUN', 'TARGET_CRAWLERS', 'MAX_PAGES', 'REQUEST_TIMEOUT_MS', 'CRAWLER_CONCURRENCY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DRY_RUN: 'true', ...values });
    return task();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('config supports Object.keys, spread and JSON serialization without Proxy invariant errors', () => {
  withEnv({}, () => {
    loadConfig(true);
    assert.ok(Object.keys(config).includes('dryRun'));
    assert.equal({ ...config }.dryRun, true);
    assert.equal(JSON.parse(JSON.stringify(config)).dryRun, true);
    assert.throws(() => { config.dryRun = false; }, TypeError);
    assert.equal(config.dryRun, true);
    assert.ok(Object.isFrozen(loadConfig()));
    assert.ok(Object.isFrozen(config.targetCrawlers));
  });
});

test('config rejects typo booleans rather than accidentally enabling live writes', () => {
  withEnv({ DRY_RUN: 'tru', SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'placeholder' }, () => {
    assert.throws(() => loadConfig(true), /DRY_RUN/);
  });
});

test('config rejects empty target lists and accepts normalized unique names', () => {
  for (const value of [' ', ',', ', ,']) withEnv({ TARGET_CRAWLERS: value }, () => assert.throws(() => loadConfig(true), /at least one/));
  withEnv({ TARGET_CRAWLERS: ' EZTV,eztv,NYAA ' }, () => assert.deepEqual(loadConfig(true).targetCrawlers, ['eztv', 'nyaa']));
});

test('config default crawler list and registry cannot drift silently', () => {
  withEnv({ TARGET_CRAWLERS: 'all' }, () => assert.deepEqual([...loadConfig(true).targetCrawlers].sort(), Object.keys(CRAWLER_REGISTRY).sort()));
});

test('config rejects overflow, fractions and malformed integer settings', () => {
  for (const value of ['99999999999999999999999', '2147483648', '1.5', '3x', '0', '-1']) {
    withEnv({ MAX_PAGES: value }, () => assert.throws(() => loadConfig(true), /integer/));
  }
  withEnv({ REQUEST_TIMEOUT_MS: '999' }, () => assert.throws(() => loadConfig(true), /integer/));
});

test('config rejects credential-bearing URLs without printing secrets', () => {
  withEnv({ DRY_RUN: 'false', SUPABASE_URL: 'https://user:private-password@database.test', SUPABASE_SERVICE_ROLE_KEY: 'placeholder' }, () => {
    assert.throws(() => loadConfig(true), error => /SUPABASE_URL/.test(error.message) && !error.message.includes('private-password'));
  });
});

test('config failed reload does not retain the preceding cached settings', () => {
  withEnv({}, () => {
    loadConfig(true);
    process.env.DRY_RUN = 'invalid';
    assert.throws(() => loadConfig(true));
    assert.throws(() => loadConfig());
  });
});

test('CLI startup failure returns exit code 1 without requiring real credentials or network', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, DRY_RUN: 'invalid', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' }, encoding: 'utf8', timeout: 10000
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /DRY_RUN/);
});

test('diagnostic CLI rejects inherited object properties as crawler names', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/diagnose.mjs', 'toString'], {
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /crawler names/);
  assert.doesNotMatch(child.stdout, /Worker/);
});
