#!/usr/bin/env node
/** Verifica la escritura después de publicar los JSON, sin ocultar errores de BD. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDatabaseWrite } from '../public/lib/persistence.js';

export function checkDatabaseResult(report) {
  const status = describeDatabaseWrite(report);
  if (status.state === 'error' || status.state === 'unknown') {
    throw new Error([status.message, status.detail].filter(Boolean).join('\n'));
  }
  return status;
}

async function main() {
  const path = process.argv[2] || new URL('../public/data/report.json', import.meta.url);
  const report = JSON.parse(await readFile(path, 'utf8'));
  const status = checkDatabaseResult(report);
  console.log(status.message);
  if (status.detail) console.log(status.detail);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
