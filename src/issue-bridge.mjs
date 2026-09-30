#!/usr/bin/env node
/**
 * Issue → watchlist.txt: ingest without any personal token.
 *
 * Run by .github/workflows/issue-ingest.yml when an Issue titled "[ingest] …"
 * is opened by the repo owner or a collaborator (the web app pre-fills it).
 * The event is read from GITHUB_EVENT_PATH: the Issue body is never
 * interpolated into a shell command. Only canonical IMDb lines survive
 * (public/lib/issue.js), so nothing else can reach watchlist.txt.
 *
 * Writes:
 *   - watchlist.txt (only when the Issue has valid lines)
 *   - $COMMENT_PATH  Markdown reply for the Issue
 *   - $GITHUB_OUTPUT ok, reason, count, dry_run, providers
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_TITLE_PREFIX, parseIssueBody, watchlistFromIssue } from '../public/lib/issue.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const FORMAT_HELP = [
  'Formato esperado (lo genera la web con **☁️ Guardar en el repo**):',
  '',
  '````',
  '```watchlist',
  'tt0111161 Cadena perpetua (1994)',
  'tt0944947:s1:e1 Juego de Tronos S01E01',
  'tt0944947:s1 Juego de Tronos (temporada completa)',
  '```',
  '````',
].join('\n');

export function planFromEvent(event, { now = new Date() } = {}) {
  const issue = event?.issue;
  if (!issue || !Number.isInteger(issue.number)) {
    return { ok: false, reason: 'no-issue', message: 'El evento no trae un Issue.' };
  }
  const title = String(issue.title || '').trim();
  if (!title.toLowerCase().startsWith(ISSUE_TITLE_PREFIX)) {
    return { ok: false, reason: 'not-ingest', number: issue.number, message: `El título no empieza por ${ISSUE_TITLE_PREFIX}.` };
  }
  if (!TRUSTED_ASSOCIATIONS.has(issue.author_association)) {
    return {
      ok: false,
      reason: 'untrusted',
      number: issue.number,
      message: `🔒 Solo el dueño del repositorio o sus colaboradores pueden pedir ingestas (tu relación con el repo: ${issue.author_association || 'desconocida'}).`,
    };
  }
  const parsed = parseIssueBody(issue.body);
  if (!parsed.count) {
    return {
      ok: false,
      reason: 'empty',
      number: issue.number,
      parsed,
      message: `🤖 No encontré ningún IMDb ID válido en el Issue${parsed.invalid ? ` (${parsed.invalid} líneas no reconocidas)` : ''}, así que no cambio nada y lo cierro.\n\n${FORMAT_HELP}`,
    };
  }
  const author = issue.user?.login || null;
  return {
    ok: true,
    reason: 'ok',
    number: issue.number,
    author,
    parsed,
    watchlist: watchlistFromIssue(parsed, { issueNumber: issue.number, author, date: now }),
  };
}

export function commentFor(plan, { repository = null } = {}) {
  if (!plan.ok) return plan.message;
  const { parsed } = plan;
  const runsUrl = repository ? `https://github.com/${repository}/actions/workflows/static.yml` : null;
  return [
    `🤖 Recibido: **${parsed.count} título${parsed.count === 1 ? '' : 's'}**${parsed.invalid ? ` (${parsed.invalid} líneas no reconocidas se ignoraron)` : ''}.`,
    '',
    `- \`watchlist.txt\` actualizado con esta lista (reemplaza la anterior).`,
    `- Addons: ${parsed.providers.join(', ') || '—'}${parsed.dryRun ? ' · **dry-run** (no escribe en Supabase)' : ''}.`,
    `- Ingesta lanzada${runsUrl ? `: [ver ejecuciones](${runsUrl})` : ''}. Cuando termine te respondo aquí con los 2 torrents de cada título (🇪🇸 + 🇬🇧) y cierro el Issue.`,
  ].join('\n');
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH no está definido.');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const plan = planFromEvent(event);

  if (plan.ok) await writeFile(resolve(ROOT, process.env.WATCHLIST_PATH || 'watchlist.txt'), plan.watchlist, 'utf8');
  await writeFile(process.env.COMMENT_PATH || resolve(ROOT, 'issue-comment.md'), commentFor(plan, { repository: process.env.GITHUB_REPOSITORY || null }) + '\n', 'utf8');

  // Only digits, 0/1 and known provider slugs: safe to use in later steps.
  const outputs = {
    ok: plan.ok ? '1' : '0',
    reason: plan.reason,
    count: String(plan.parsed?.count ?? 0),
    dry_run: plan.parsed?.dryRun ? '1' : '0',
    providers: (plan.parsed?.providers || []).join(','),
  };
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  }
  console.log(`Issue #${plan.number ?? '?'}: ${plan.reason} · ${outputs.count} títulos · dry_run=${outputs.dry_run} · providers=${outputs.providers || '—'}`);
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isCli) main().catch(err => { console.error('💥', err.message || err); process.exit(1); });
