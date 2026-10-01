/** Estado de escritura compartido por la web, el resumen y la Action. */

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function describeDatabaseWrite(report = {}) {
  const db = report.db || {};
  const dryRun = db.dryRun ?? report.dryRunDb;
  const skipped = dryRun === true || Boolean(db.skipReason);
  // En reportes antiguos, inserted contaba los candidatos incluso sin escribir.
  const saved = skipped ? 0 : count(db.inserted);
  const prepared = count(db.prepared) ?? (skipped ? count(db.inserted) : null);
  const failures = Array.isArray(db.failures) ? db.failures : [];

  if (failures.length) {
    return {
      state: 'error', saved, prepared,
      message: `❌ Error al guardar en Supabase (${saved ?? '?'}${prepared != null ? ` de ${prepared}` : ''} registros guardados).`,
      detail: failures.join('; '),
    };
  }

  if (skipped) {
    const totals = `${prepared ?? '?'} registros preparados; 0 guardados`;
    if (db.skipReason === 'missing-credentials') {
      const missing = Array.isArray(db.missingCredentials) && db.missingCredentials.length
        ? db.missingCredentials.join(' y ')
        : 'SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY';
      return {
        state: 'skipped', saved: 0, prepared,
        message: `⚠️ No se escribió en Supabase: faltan credenciales de escritura (${totals}).`,
        detail: `Configura ${missing} en Settings → Secrets and variables → Actions del repositorio. La anon key de la web solo sirve para leer; nunca pongas la service-role key en la web.`,
      };
    }
    if (db.skipReason === 'dry-run') {
      const detail = report.mode === 'fixture' || report.mode === 'reprocess'
        ? `El modo ${report.mode} no escribe en Supabase. Ejecuta una ingesta normal para guardar.`
        : 'Desactiva Dry-run (dry_run=0) y configura los Secrets de Supabase en GitHub Actions para guardar.';
      return {
        state: 'skipped', saved: 0, prepared,
        message: `⚠️ No se escribió en Supabase: dry-run activo (${totals}).`,
        detail,
      };
    }
    return {
      state: 'skipped', saved: 0, prepared,
      message: `⚠️ No se escribió en Supabase: escritura desactivada (${totals}).`,
      detail: 'Este reporte antiguo no indica si fue por dry-run o por falta de credenciales. Revisa dry_run y los Secrets SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en GitHub Actions.',
    };
  }

  // No se puede afirmar que se guardó si el reporte no confirma la escritura.
  if (saved == null || dryRun !== false) {
    return {
      state: 'unknown', saved: null, prepared,
      message: '⚠️ No hay confirmación de escritura en Supabase.',
      detail: 'Revisa el report.json y los logs de la ingesta.',
    };
  }
  if (saved === 0) {
    return {
      state: 'empty', saved: 0, prepared,
      message: 'ℹ️ No había registros válidos para guardar en Supabase.',
      detail: null,
    };
  }
  return {
    state: 'saved', saved, prepared,
    message: `✅ ${saved} registros guardados/actualizados en Supabase${db.mode === 'insert+update' ? ' (insert + update: la tabla no tiene UNIQUE en info_hash)' : ''}.`,
    detail: null,
  };
}
