import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDatabaseWrite } from '../public/lib/persistence.js';
import { reportToMarkdown } from '../public/lib/format.js';
import { checkDatabaseResult } from '../src/check-db.mjs';

function report(db, extra = {}) { return { ...extra, db }; }

test('reporte antiguo dry-run: 52 candidatos NO son 52 filas guardadas', () => {
  const input = report({ inserted: 52, rejected: 0, failures: [], dryRun: true });
  const status = describeDatabaseWrite(input);
  assert.equal(status.state, 'skipped');
  assert.equal(status.saved, 0);
  assert.equal(status.prepared, 52);
  assert.match(status.message, /52 registros preparados; 0 guardados/);
  assert.match(status.detail, /no indica si fue por dry-run o por falta de credenciales/);
  assert.doesNotMatch(reportToMarkdown(input), /Supabase: ✅/);
});

test('dryRunDb antiguo también se interpreta sin afirmar que se guardó', () => {
  const status = describeDatabaseWrite(report({ inserted: 12 }, { dryRunDb: true }));
  assert.equal(status.state, 'skipped');
  assert.equal(status.saved, 0);
  assert.equal(status.prepared, 12);
});

test('falta de credenciales: indica los Secrets, no pide la service-role en la web', () => {
  const input = report({
    inserted: 0, prepared: 52, dryRun: true, skipReason: 'missing-credentials',
    missingCredentials: ['SUPABASE_SERVICE_ROLE_KEY'],
  });
  const status = describeDatabaseWrite(input);
  assert.equal(status.saved, 0);
  assert.match(status.message, /faltan credenciales de escritura/);
  assert.match(status.detail, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(status.detail, /SUPABASE_URL/);
  assert.match(status.detail, /nunca pongas la service-role key en la web/);
  const markdown = reportToMarkdown(input);
  assert.match(markdown, /0 guardados/);
  assert.match(markdown, /Secrets and variables/);
});

test('dry-run explícito explica cómo habilitar la escritura', () => {
  const status = describeDatabaseWrite(report({ inserted: 0, prepared: 2, dryRun: true, skipReason: 'dry-run' }));
  assert.match(status.message, /dry-run activo/);
  assert.match(status.detail, /dry_run=0/);
  assert.equal(status.saved, 0);
});

test('fixture y reprocess nunca se anuncian como ingestas con escritura', () => {
  for (const mode of ['fixture', 'reprocess']) {
    const status = describeDatabaseWrite(report({ inserted: 0, prepared: 2, dryRun: true, skipReason: 'dry-run' }, { mode }));
    assert.match(status.detail, new RegExp(`El modo ${mode} no escribe`));
    assert.equal(status.saved, 0);
  }
});

test('los fallos de escritura tienen prioridad y conservan los guardados parciales', () => {
  const input = report({ inserted: 1, prepared: 2, dryRun: false, failures: ['42501 permission denied'] });
  const status = describeDatabaseWrite(input);
  assert.equal(status.state, 'error');
  assert.equal(status.saved, 1);
  assert.match(status.message, /1 de 2 registros guardados/);
  assert.match(status.detail, /42501/);
  const markdown = reportToMarkdown(input);
  assert.match(markdown, /Supabase: ❌ Error al guardar/);
  assert.match(markdown, /42501/);
  assert.doesNotMatch(markdown, /Supabase: ✅/);
});

test('UPSERT confirmado se presenta como guardado/actualizado, no como filas nuevas', () => {
  const status = describeDatabaseWrite(report({ inserted: 52, prepared: 52, dryRun: false, mode: 'upsert' }));
  assert.equal(status.state, 'saved');
  assert.equal(status.saved, 52);
  assert.match(status.message, /52 registros guardados\/actualizados/);
});

test('sin candidatos no se anuncia una escritura inexistente', () => {
  const status = describeDatabaseWrite(report({ inserted: 0, prepared: 0, dryRun: false }));
  assert.equal(status.state, 'empty');
  assert.equal(status.saved, 0);
  assert.match(status.message, /No había registros válidos/);
});

test('sin estado de BD el resumen no inventa un éxito', () => {
  for (const input of [{}, { db: {} }, { db: { inserted: 5 } }]) {
    const status = describeDatabaseWrite(input);
    assert.equal(status.state, 'unknown');
    assert.equal(status.saved, null);
    assert.doesNotMatch(reportToMarkdown(input), /Supabase: ✅/);
  }
});

test('check de la Action falla con errores o sin confirmación, no con Supabase opcional', () => {
  assert.throws(() => checkDatabaseResult(report({ inserted: 0, prepared: 2, dryRun: false, failures: ['42501 denied'] })), /42501/);
  assert.throws(() => checkDatabaseResult({}), /No hay confirmación/);
  assert.equal(checkDatabaseResult(report({ inserted: 0, prepared: 2, dryRun: true, skipReason: 'missing-credentials' })).state, 'skipped');
  assert.equal(checkDatabaseResult(report({ inserted: 0, prepared: 2, dryRun: true, skipReason: 'dry-run' })).state, 'skipped');
  assert.equal(checkDatabaseResult(report({ inserted: 2, prepared: 2, dryRun: false })).state, 'saved');
  assert.equal(checkDatabaseResult(report({ inserted: 0, prepared: 0, dryRun: false })).state, 'empty');
});
