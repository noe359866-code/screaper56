/**
 * Exportaciones y resúmenes a partir de los títulos procesados (cada uno con
 * sus 2 picks). Lo usa la web (descargar CSV / magnets) y la Action (resumen
 * Markdown para el job y para responder en el Issue de ingesta).
 */

import { releaseTags } from './parse.js';
import { describeDatabaseWrite } from './persistence.js';

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
  const dbStatus = describeDatabaseWrite(report);
  lines.push(`Supabase: ${md(dbStatus.message)}`);
  if (dbStatus.detail) lines.push(md(dbStatus.detail).slice(0, 600));
  if (report.watchlist?.autoUpdated) {
    const wl = report.watchlist;
    lines.push(`Watchlist: 🔄 actualizado automáticamente (**${wl.addedCount ?? 0} nuevos** · ${wl.removedCount ?? 0} anteriores eliminados${wl.resumedCount ? ` · ${wl.resumedCount} serie(s) en progreso continúan` : ''} · ${wl.totalSeen ?? wl.totalSeenBefore ?? 0} en historial sin repetir)`);
  }
  lines.push('');
  const activeSeriesId = report.progress?.activeSeries || report.watchlist?.activeSeries || null;
  const progressSeries = Object.entries(report.progress?.series || {});
  const inProgress = progressSeries
    .filter(([, r]) => r.status === 'in-progress')
    .sort(([a], [b]) => (a === activeSeriesId ? -1 : b === activeSeriesId ? 1 : 0));
  const completed = progressSeries.filter(([, r]) => r.status === 'complete');
  if (inProgress.length || completed.length) {
    const tag = (s, e) => `S${String(s ?? 0).padStart(2, '0')}E${String(e ?? 0).padStart(2, '0')}`;
    lines.push('### 📺 Progreso de series (dónde quedó cada una)');
    for (const [id, r] of inProgress) {
      const activeBadge = id === activeSeriesId ? ' *(🎯 siguiendo hasta terminarla)*' : '';
      lines.push(`- ⏳ **${md(r.name)}**: ${r.done}/${r.total} episodios · último ${tag(r.lastSeason, r.lastEpisode)} · sigue en **${tag(r.nextSeason, r.nextEpisode)}** en la próxima ejecución${activeBadge}`);
    }
    for (const [, r] of completed.slice(0, 10)) {
      lines.push(`- ✅ **${md(r.name)}**: completa (${r.total} episodios)`);
    }
    if (completed.length > 10) lines.push(`- … y ${completed.length - 10} series completas más en el historial.`);
    lines.push('');
  }
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
    lines.push('| Addon | Respuestas | Errores | Omitidas | Streams | Picks (solo él) | Media |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const [slug, s] of stats) {
      const picks = s.picks != null ? `${s.picks} (${s.uniquePicks ?? 0})` : '—';
      const errors = `${s.errors ?? 0}${s.rateLimited ? ` (${s.rateLimited}× 429)` : ''}`;
      lines.push(`| ${md(slug)} | ${s.ok ?? '—'} | ${errors} | ${s.skipped ?? 0} | ${s.streams ?? 0} | ${picks} | ${s.avgMs != null ? s.avgMs + ' ms' : '—'} |`);
    }
    lines.push('');
    lines.push('_Picks (solo él): torrents publicados en los que aparece el addon y, entre paréntesis, los que solo él encontró._');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  const warnings = report.warnings || [];
  if (warnings.length) {
    lines.push('### ⚠️ Avisos');
    for (const { text, count } of groupWarnings(warnings).slice(0, 30)) lines.push(`- ${md(text)}${count > 1 ? ` (×${count})` : ''}`);
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

/**
 * Agrupa avisos que solo cambian en el ID ("OMDb (tt0055892): HTTP 401" ×100
 * → "OMDb (tt…): HTTP 401 (×100)") para que no tapen los demás.
 */
export function groupWarnings(warnings) {
  const groups = new Map();
  for (const warning of warnings || []) {
    const text = String(warning);
    const key = text.replace(/\btt\d{7,}(?::\d+:\d+)?\b/g, 'tt…');
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { text: key === text ? text : key, count: 1 });
  }
  return [...groups.values()];
}
