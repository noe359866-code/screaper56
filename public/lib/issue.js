/**
 * Ingesta "sin token": la web abre un Issue de GitHub ya relleno con el
 * watchlist. El workflow .github/workflows/issue-ingest.yml lo lee (solo si lo
 * abre el dueño o un colaborador), actualiza watchlist.txt y lanza la Action
 * de ingesta con el GITHUB_TOKEN automático: no hace falta ningún PAT.
 *
 * Este módulo construye el cuerpo del Issue (web) y lo interpreta (Action).
 */

import { IMDB_LINE_RE } from './parse.js';
import { resolveProviderSlugs } from './providers.js';
import { MAX_BATCH_SIZE } from './watchlist.js';

export const ISSUE_TITLE_PREFIX = '[ingest]';
export const ISSUE_MARKER = '<!-- peerflix-static:ingest -->';
const MAX_LINES = MAX_BATCH_SIZE;
const MAX_LABEL = 200;
const TRUE_VALUES = new Set(['1', 'true', 'si', 'sí', 'yes', 'y', 'x', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function cleanLabel(label) {
  return String(label ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);
}

/** Líneas válidas del watchlist, reescritas en forma canónica (nada más pasa). */
export function sanitizeWatchlistLines(text) {
  const lines = [];
  let invalid = 0;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(IMDB_LINE_RE);
    if (!m) { invalid++; continue; }
    const id = m[1].toLowerCase();
    const season = m[2] !== undefined ? `:s${Number(m[2])}` : '';
    const episode = m[3] !== undefined ? `:e${Number(m[3])}` : '';
    const label = cleanLabel(m[4]);
    lines.push(`${id}${season}${episode}${label ? ' ' + label : ''}`);
    if (lines.length >= MAX_LINES) break;
  }
  return { lines, invalid };
}

export function buildIssueTitle(count, date = new Date()) {
  return `${ISSUE_TITLE_PREFIX} ${count} título${count === 1 ? '' : 's'} · ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function normalizeFollowSeries(value, fallback = '0') {
  const clean = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'si', 'sí', 'single'].includes(clean)) return '1';
  if (['only', 'solo', 'exclusive', 'serie'].includes(clean)) return 'only';
  if (['0', 'false', 'no', 'off', 'multi'].includes(clean)) return '0';
  return fallback;
}

function normalizeFlag(value, fallback = false) {
  const clean = String(value ?? '').trim().toLowerCase();
  if (TRUE_VALUES.has(clean)) return true;
  if (FALSE_VALUES.has(clean)) return false;
  return fallback;
}

function normalizeBatchSize(value, fallback = MAX_BATCH_SIZE) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, parsed));
}

function normalizeSeriesId(value) {
  return String(value ?? '').match(/\btt\d{7,10}\b/i)?.[0]?.toLowerCase() || '';
}

export function buildIssueBody(watchlistText, {
  dryRun = false,
  providers = [],
  followSeries = '0',
  rotateWatchlist = false,
  discoverMovies = true,
  discoverSeries = true,
  batchSize = MAX_BATCH_SIZE,
  seriesId = '',
} = {}) {
  const { lines } = sanitizeWatchlistLines(watchlistText);
  const slugs = resolveProviderSlugs(providers);
  return [
    ISSUE_MARKER,
    'Ingesta pedida desde la web (sin token). Pulsa **Submit new issue**: la Action',
    'actualiza `watchlist.txt`, busca los torrents (2 por título: 🇪🇸 + 🇬🇧) y responde aquí.',
    '',
    `dry_run: ${dryRun ? '1' : '0'}`,
    `providers: ${slugs.join(',')}`,
    `follow_series: ${normalizeFollowSeries(followSeries)}`,
    `rotate_watchlist: ${normalizeFlag(rotateWatchlist) ? '1' : '0'}`,
    `discover_movies: ${normalizeFlag(discoverMovies, true) ? '1' : '0'}`,
    `discover_series: ${normalizeFlag(discoverSeries, true) ? '1' : '0'}`,
    `batch_size: ${normalizeBatchSize(batchSize)}`,
    `series_id: ${normalizeSeriesId(seriesId)}`,
    '',
    '```watchlist',
    ...lines,
    '```',
  ].join('\n');
}

/** Interpreta el cuerpo del Issue: líneas válidas + opciones de ingesta. */
export function parseIssueBody(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const fence = text.match(/```[ \t]*(?:watchlist|txt|text|plain)?[ \t]*\n([\s\S]*?)```/i);
  const listText = fence ? fence[1] : text;
  const outside = fence ? text.replace(fence[0], '') : text;
  const { lines, invalid } = sanitizeWatchlistLines(listText);
  const dryMatch = outside.match(/^[ \t]*(?:dry[-_ ]?run|prueba)[ \t]*[:=][ \t]*(\S+)/im);
  const providersMatch = outside.match(/^[ \t]*(?:providers|proveedores|addons)[ \t]*[:=][ \t]*([^\n]*)$/im);
  const option = name => outside.match(new RegExp(`^[ \\t]*${name}[ \\t]*[:=][ \\t]*([^\\n]*)$`, 'im'))?.[1]?.trim() ?? null;
  const followSeries = normalizeFollowSeries(option('follow_series'), '0');
  const batchSize = normalizeBatchSize(option('batch_size'));
  const seriesId = normalizeSeriesId(option('series_id'));
  return {
    lines,
    count: lines.length,
    invalid,
    dryRun: dryMatch ? TRUE_VALUES.has(dryMatch[1].toLowerCase()) : false,
    providers: resolveProviderSlugs(providersMatch ? providersMatch[1] : ''),
    followSeries,
    rotateWatchlist: normalizeFlag(option('rotate_watchlist'), false),
    discoverMovies: normalizeFlag(option('discover_movies'), true),
    discoverSeries: normalizeFlag(option('discover_series'), true),
    batchSize,
    seriesId,
  };
}

/** Contenido de watchlist.txt generado a partir de un Issue. */
export function watchlistFromIssue(parsed, { issueNumber = null, author = null, date = new Date() } = {}) {
  return [
    '# Peerflix Static – Watchlist',
    `# Actualizado desde el Issue${issueNumber ? ` #${issueNumber}` : ''}${author ? ` de @${author}` : ''} el ${date.toISOString().slice(0, 10)} (ingesta sin token).`,
    '# Formatos: tt1234567 (si es serie: todas las temporadas y episodios) · tt1234567:s1:e1 · tt1234567:s1 (temporada completa, sin API key)',
    '',
    ...parsed.lines,
    '',
  ].join('\n');
}
