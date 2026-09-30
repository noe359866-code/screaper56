/**
 * Exportaciones y resúmenes a partir de los títulos procesados (cada uno con
 * sus 2 picks). Lo usa la web (descargar CSV / magnets) y la Action (resumen
 * Markdown para el job y para responder en el Issue de ingesta).
 */

import { releaseTags } from './parse.js';

const FLAGS = { es: '🇪🇸', en: '🇬🇧' };
const LANGUAGE_NAMES = { es: 'Español', en: 'Inglés' };

function episodeTag(item) {
  return item.type === 'series'
    ? `S${String(item.season ?? 0).padStart(2, '0')}E${String(item.episode ?? 0).padStart(2, '0')}`
    : '';
}

/** Una fila por pick (máx. 2 por título). */
export function picksToRows(items) {
  const rows = [];
  for (const item of items || []) {
    for (const pick of item.picks || []) {
      rows.push({
        imdb_id: item.imdbId,
        tipo: item.type === 'series' ? 'serie' : 'película',
        temporada: item.season ?? '',
        episodio: item.episode ?? '',
        titulo: item.label,
        idioma: LANGUAGE_NAMES[pick.pick] || pick.pick,
        calidad: pick.quality || '',
        seeders: pick.seeders ?? '',
        tamano: pick.sizeLabel || '',
        ficha: releaseTags(pick.release),
        proveedores: (pick.providers || []).join('+'),
        release: pick.title,
        info_hash: pick.infoHash,
        magnet: pick.magnetUrl || `magnet:?xt=urn:btih:${pick.infoHash}`,
      });
    }
  }
  return rows;
}

function csvCell(value) {
  let text = String(value ?? '');
  // Evita que Excel/LibreOffice interpreten una celda como fórmula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map(row => headers.map(h => csvCell(row[h])).join(','))].join('\r\n') + '\r\n';
}

/** Lista de magnets lista para pegar en un cliente torrent (con comentarios). */
export function toMagnetList(items) {
  const lines = [];
  for (const item of items || []) {
    for (const pick of item.picks || []) {
      const tag = episodeTag(item);
      lines.push(`# ${item.label}${tag && !item.label.includes(tag) ? ' ' + tag : ''} — ${FLAGS[pick.pick] || ''} ${pick.quality || '?'} · 👤 ${pick.seeders ?? '?'}${pick.sizeLabel ? ' · ' + pick.sizeLabel : ''}`);
      lines.push(pick.magnetUrl || `magnet:?xt=urn:btih:${pick.infoHash}`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

function md(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;');
}

function pickCell(pick) {
  if (!pick) return '—';
  return [pick.quality || '?', `👤 ${pick.seeders ?? '?'}`, pick.sizeLabel].filter(Boolean).join(' · ');
}

function seconds(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—';
}

/**
 * Resumen Markdown del report.json (job summary de GitHub y respuesta en el
 * Issue). Se limita el número de filas para no pasar el límite de 65 536
 * caracteres de un comentario.
 */
export function reportToMarkdown(report, { pagesUrl = null, runUrl = null, maxRows = 120 } = {}) {
  if (!report) return '⚠️ No hay report.json.';
  const items = report.items || [];
  const lines = [];
  const picks = report.picks || { es: 0, en: 0 };
  lines.push('## 🎬 Peerflix Ingest — 2 torrents por título (🇪🇸 + 🇬🇧)');
  lines.push('');
  lines.push(`**${items.length} títulos** (${report.movies ?? 0} películas · ${report.episodes ?? 0} episodios) · ` +
    `**${report.totalStreams ?? 0} elegidos** (🇪🇸 ${picks.es ?? 0} · 🇬🇧 ${picks.en ?? 0}) de ${report.totalCandidates ?? '?'} candidatos · ${seconds(report.durationMs)}`);
  const db = report.db || {};
  const dbText = db.failures?.length
    ? `❌ ${md(db.failures[0]).slice(0, 300)}`
    : db.dryRun ? `dry-run (${db.inserted ?? 0} registros sin escribir)` : `✅ ${db.inserted ?? 0} registros${db.mode === 'insert+update' ? ' (insert + update: la tabla no tiene UNIQUE en info_hash)' : ''}`;
  lines.push(`Supabase: ${dbText}`);
  lines.push('');
  if (items.length) {
    lines.push('| | Título | 🇪🇸 Español | 🇬🇧 Inglés |');
    lines.push('|---|---|---|---|');
    for (const item of items.slice(0, maxRows)) {
      const es = (item.picks || []).find(p => p.pick === 'es');
      const en = (item.picks || []).find(p => p.pick === 'en');
      const icon = es && en ? '✅' : es || en ? '🟡' : '⚠️';
      lines.push(`| ${icon} | ${md(item.label)} \`${item.id}\` | ${pickCell(es)} | ${pickCell(en)} |`);
    }
    if (items.length > maxRows) lines.push(`\n… y ${items.length - maxRows} títulos más en el dashboard.`);
    lines.push('');
  }
  const stats = Object.entries(report.perProviderStats || {});
  if (stats.length) {
    lines.push('<details><summary>Addons consultados</summary>');
    lines.push('');
    lines.push('| Addon | Respuestas | Errores | Omitidas | Streams | Media |');
    lines.push('|---|---|---|---|---|---|');
    for (const [slug, s] of stats) {
      lines.push(`| ${md(slug)} | ${s.ok ?? '—'} | ${s.errors ?? 0} | ${s.skipped ?? 0} | ${s.streams ?? 0} | ${s.avgMs != null ? s.avgMs + ' ms' : '—'} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  const warnings = report.warnings || [];
  if (warnings.length) {
    lines.push('### ⚠️ Avisos');
    for (const w of warnings.slice(0, 30)) lines.push(`- ${md(w)}`);
    lines.push('');
  }
  const errors = (report.errors || []).filter(e => !e.skipped);
  const skipped = (report.errors || []).filter(e => e.skipped);
  if (errors.length || skipped.length) {
    lines.push('### ❌ Errores de addons');
    const grouped = new Map();
    for (const e of errors) {
      const key = `${e.provider}: ${e.error}`;
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }
    for (const [key, count] of [...grouped].slice(0, 20)) lines.push(`- ${md(key)}${count > 1 ? ` (×${count})` : ''}`);
    if (skipped.length) lines.push(`- ${skipped.length} consulta(s) omitidas por errores repetidos del mismo addon`);
    lines.push('');
  }
  const links = [pagesUrl && `[Abrir el dashboard](${pagesUrl})`, runUrl && `[Ver la ejecución](${runUrl})`].filter(Boolean);
  if (links.length) lines.push(links.join(' · '));
  return lines.join('\n').trim() + '\n';
}
