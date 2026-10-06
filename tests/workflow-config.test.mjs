import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('la rotación automática es opt-in y el workflow de Issue comparte el bloqueo del watchlist', async () => {
  const [staticWorkflow, issueWorkflow] = await Promise.all([
    read('../.github/workflows/static.yml'),
    read('../.github/workflows/issue-ingest.yml'),
  ]);
  assert.match(staticWorkflow, /rotate_watchlist:\s*\n\s*description:[^\n]*\n\s*required: false\n\s*default: "0"/);
  assert.match(staticWorkflow, /AUTO_WATCHLIST:\s*\$\{\{\s*github\.event_name\s*==\s*'schedule'\s*&&\s*vars\.AUTO_WATCHLIST\s*==\s*'1'\s*&&\s*'1'\s*\|\|\s*inputs\.rotate_watchlist\s*\|\|\s*'0'\s*\}\}/);
  assert.match(staticWorkflow, /en modo 1: como máximo una, solo si no hay una activa/);
  assert.match(staticWorkflow, /group:\s*peerflix-static/);
  assert.match(issueWorkflow, /group:\s*peerflix-static/);
});
