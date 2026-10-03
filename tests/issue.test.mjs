import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ISSUE_TITLE_PREFIX,
  buildIssueBody,
  buildIssueTitle,
  parseIssueBody,
  sanitizeWatchlistLines,
  watchlistFromIssue,
} from '../public/lib/issue.js';
import { commentFor, planFromEvent } from '../src/issue-bridge.mjs';

const LIST = [
  '# comentario',
  'tt0111161 Cadena perpetua (1994)',
  'TT0944947:S1:E1   Juego de Tronos S01E01',
  'tt0944947:s1',
  'esto no es un id',
  'tt0068646 $(rm -rf /) `whoami` ; echo pwned',
].join('\n');

test('buildIssueBody → parseIssueBody: ida y vuelta con opciones', () => {
  const body = buildIssueBody(LIST, { dryRun: true, providers: ['peerflix', 'torrentio', 'inventado'] });
  const parsed = parseIssueBody(body);
  assert.equal(parsed.count, 4);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.providers, ['peerflix', 'torrentio']);
  assert.deepEqual(parsed.lines.slice(0, 3), [
    'tt0111161 Cadena perpetua (1994)',
    'tt0944947:s1:e1 Juego de Tronos S01E01',
    'tt0944947:s1',
  ]);
  assert.match(buildIssueTitle(4, new Date('2026-09-30T12:00:00Z')), /^\[ingest\] 4 títulos · 2026-09-30 12:00 UTC$/);
  assert.ok(buildIssueTitle(1).startsWith(ISSUE_TITLE_PREFIX));
});

test('solo pasan líneas IMDb canónicas: sin backticks ni caracteres de control', () => {
  const { lines, invalid } = sanitizeWatchlistLines(`${LIST}\ntt1234567 ${'x'.repeat(500)}\ntt7654321 a\u0000b\u001bc`);
  assert.equal(invalid, 1);
  const evil = lines.find(l => l.startsWith('tt0068646'));
  assert.equal(evil.includes('`'), false);
  assert.ok(lines.find(l => l.startsWith('tt1234567')).length <= 10 + 200);
  assert.equal(lines.find(l => l.startsWith('tt7654321')), 'tt7654321 a b c');
});

test('parseIssueBody acepta listas pegadas a mano (sin bloque) y opciones por defecto', () => {
  const parsed = parseIssueBody('tt0111161\r\ntt1375666 Inception');
  assert.equal(parsed.count, 2);
  assert.equal(parsed.dryRun, false);
  assert.deepEqual(parsed.providers, ['peerflix', 'torrentsdb', 'torrentio', 'piratebay', 'ytztvio', 'torrentclaw', 'aniscraper', 'stremthru']);
  assert.equal(parseIssueBody('```\nnada útil\n```').count, 0);
});

test('watchlistFromIssue genera un watchlist.txt válido', () => {
  const parsed = parseIssueBody(buildIssueBody(LIST));
  const text = watchlistFromIssue(parsed, { issueNumber: 12, author: 'noe', date: new Date('2026-09-30T00:00:00Z') });
  assert.match(text, /Issue #12 de @noe el 2026-09-30/);
  assert.equal(parseIssueBody(text).count, 4);
});

function event({ title = '[ingest] 2 títulos', body = buildIssueBody(LIST), association = 'OWNER' } = {}) {
  return { issue: { number: 7, title, body, author_association: association, user: { login: 'noe' } } };
}

test('planFromEvent: solo dueño/colaboradores, solo títulos [ingest] y con IDs válidos', () => {
  const ok = planFromEvent(event());
  assert.equal(ok.ok, true);
  assert.equal(ok.parsed.count, 4);
  assert.match(ok.watchlist, /tt0111161 Cadena perpetua/);
  assert.match(commentFor(ok, { repository: 'o/r' }), /\*\*4 títulos\*\*.*\n[\s\S]*actions\/workflows\/static\.yml/);

  assert.equal(planFromEvent(event({ association: 'NONE' })).reason, 'untrusted');
  assert.equal(planFromEvent(event({ association: 'CONTRIBUTOR' })).reason, 'untrusted');
  assert.equal(planFromEvent(event({ title: 'Bug: algo' })).reason, 'not-ingest');
  const empty = planFromEvent(event({ body: 'hola' }));
  assert.equal(empty.reason, 'empty');
  assert.match(commentFor(empty), /No encontré ningún IMDb ID válido/);
  assert.equal(planFromEvent({}).reason, 'no-issue');
});
