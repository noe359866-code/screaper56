#!/usr/bin/env node
/**
 * Markdown summary of public/data/report.json, used by the Action for the job
 * summary ($GITHUB_STEP_SUMMARY) and to reply in the ingest Issue.
 *
 * Env: RUN_URL, PAGES_URL, JOB_STARTED_AT (ignore a stale report left over
 * from a previous run when this one failed before writing a new one),
 * MAX_ROWS.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportToMarkdown } from '../public/lib/format.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

export async function renderSummary({
  reportPath = resolve(ROOT, 'public/data/report.json'),
  runUrl = process.env.RUN_URL || null,
  pagesUrl = process.env.PAGES_URL || null,
  startedAt = process.env.JOB_STARTED_AT || null,
  maxRows = Number(process.env.MAX_ROWS) || 120,
} = {}) {
  let report = null;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    report = null;
  }
  const stale = report && startedAt && Date.parse(report.generatedAt) < Date.parse(startedAt) - 5000;
  if (!report || stale) {
    return [
      '## 🎬 Peerflix Ingest',
      '',
      '⚠️ Esta ejecución no generó un report.json nuevo: la ingesta falló antes de terminar.',
      runUrl ? `\n[Ver la ejecución y sus logs](${runUrl})` : '',
    ].join('\n').trim() + '\n';
  }
  return reportToMarkdown(report, { runUrl, pagesUrl: pagesUrl || report.repository?.pagesUrl || null, maxRows });
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isCli) process.stdout.write(await renderSummary());
