/* Peerflix Ingest – web app (módulo ES, sin build)
 *
 * Funciona SIN token:
 *  - ⚡ Procesar aquí: el navegador consulta los addons Stremio y Cinemeta
 *    (todos permiten CORS) con la misma librería que la GitHub Action
 *    (./lib/*.js) y guarda los 2 picks por título en localStorage.
 *  - ☁️ Guardar en el repo: con token lanza la Action directamente; sin token
 *    abre un Issue ya relleno que el workflow issue-ingest.yml convierte en
 *    watchlist.txt + ejecución de la Action (con el GITHUB_TOKEN automático).
 *  - Dashboard: lo publicado (data/index.json), lo procesado en este navegador
 *    o, si se configura, la tabla torrents de Supabase.
 *  - Historial: API pública de GitHub (sin token, 60 peticiones/hora).
 */

import { PROVIDERS, DEFAULT_PROVIDER_SLUGS, queryableProviders, resolveProviderSlugs } from './lib/providers.js';
import { formatBytes, parseWatchlist, releaseTags, IMDB_LINE_RE } from './lib/parse.js';
import { posterUrl } from './lib/meta.js';
import {
  PICK_META,
  createJsonFetcher,
  createLimiter,
  describeError,
  loadBestTrackers,
  picksFromPublishedItem,
  processWatchlist,
} from './lib/pipeline.js';
import { buildIssueBody, buildIssueTitle, sanitizeWatchlistLines } from './lib/issue.js';
import { picksToRows, toCSV, toMagnetList } from './lib/format.js';
import { describeDatabaseWrite } from './lib/persistence.js';
import { createSeenStore, DEFAULT_BATCH_SIZE, formatWatchlistFile, rotateWatchlist } from './lib/watchlist.js';
import { normalizeProgress, pickActiveSeries, resumeKeepPredicate, resumeMissingItems } from './lib/progress.js';

const LS_KEY = 'peerflix-static.settings.v2';
const LOCAL_KEY = 'peerflix-static.local.v1';
const WORKFLOW_ID = 'static.yml'; // file name under .github/workflows/
const CARDS_PER_PAGE = 30;
const REMOTE_WAIT_MS = 15 * 60 * 1000;
const MAX_ISSUE_URL = 8000;
const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const state = {
  settings: loadSettings(),
  source: 'published',
  published: null,
  supabase: null,
  page: 0,
  total: 0,
  detectedRepo: null,
  running: null,
  lastExportItems: [],
};

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}
function saveSettings() { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); }

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleString('es-ES');
}
function pad2(n) { return String(n ?? 0).padStart(2, '0'); }
// Solo enlaces magnet: un valor raro (p. ej. "javascript:…" en la tabla de Supabase) se ignora.
function safeMagnet(url, infoHash) {
  if (typeof url === 'string' && /^magnet:\?/i.test(url.trim())) return url.trim();
  return /^[a-f0-9]{40}$/i.test(String(infoHash || '')) ? `magnet:?xt=urn:btih:${String(infoHash).toLowerCase()}` : null;
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
const MODE_LABELS = { fixture: 'datos de prueba', reprocess: 'reprocesado sin red' };
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || min)); }
function sleep(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
function seedsClass(n) {
  if (n == null) return 'badge';
  if (n >= 10) return 'badge good';
  if (n >= 1) return 'badge warn';
  return 'badge bad';
}
function flash(sel, text) {
  $(sel).textContent = text;
  setTimeout(() => { if ($(sel).textContent === text) $(sel).textContent = ''; }, 3000);
}
function setStatus(text) { $('#ingest-status').textContent = text; }
function statCard(num, lbl) {
  return `<div class="stat"><div class="num">${escapeHtml(String(num))}</div><div class="lbl">${escapeHtml(lbl)}</div></div>`;
}
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // Fallback for http:// previews or browsers without the async clipboard API.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------- repositorio (auto-detectado: no hace falta configurarlo) ----------

function repoFromLocation() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return null;
  const first = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: first || `${m[1]}.github.io`, branch: 'main', source: 'la URL de GitHub Pages' };
}

function currentRepo() {
  const s = state.settings;
  if (s.ghOwner && s.ghRepo) return { owner: s.ghOwner, repo: s.ghRepo, branch: s.ghBranch || 'main', source: 'Ajustes' };
  return state.detectedRepo || null;
}

function updateRepoLabels() {
  const repo = currentRepo();
  const footer = $('#footer-repo');
  if (repo) {
    footer.textContent = `${repo.owner}/${repo.repo}`;
    footer.href = `https://github.com/${repo.owner}/${repo.repo}`;
  } else {
    footer.textContent = '—';
    footer.removeAttribute('href');
  }
  const detected = state.detectedRepo;
  $('#repo-detected').innerHTML = detected
    ? `Detectado automáticamente desde ${escapeHtml(detected.source)}: <b>${escapeHtml(detected.owner)}/${escapeHtml(detected.repo)}</b> (rama ${escapeHtml(detected.branch)}). Déjalo vacío para usarlo.`
    : 'No lo pude detectar automáticamente (no estás en GitHub Pages): escribe owner y repo si quieres cargar o guardar el watchlist del repo.';
}

async function gh(path, { method = 'GET', body = null } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  if (state.settings.ghToken) headers.authorization = `Bearer ${state.settings.ghToken}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  if (!res.ok) {
    let message = `GitHub API ${res.status}`;
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      message += `: límite de la API sin token alcanzado (60/h); se libera a las ${new Date(reset).toLocaleTimeString('es-ES')}`;
    } else {
      message += `: ${(await res.text().catch(() => '')).slice(0, 200)}`;
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function rawUrl(repo, path) {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURI(repo.branch || 'main')}/${path}?t=${Date.now()}`;
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  return new TextDecoder('utf-8').decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

/** Lee un fichero del repo: raw (sin token, repos públicos) y, si falla, la API. */
async function readRepoFile(repo, path) {
  try {
    const res = await fetch(rawUrl(repo, path), { cache: 'no-store' });
    if (res.ok) return await res.text();
    if (!state.settings.ghToken) throw new Error(`HTTP ${res.status}${res.status === 404 ? ' (¿repo privado o rama incorrecta?)' : ''}`);
  } catch (err) {
    if (!state.settings.ghToken) throw err;
  }
  const data = await gh(`/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${encodeURIComponent(repo.branch || 'main')}`);
  return decodeBase64Utf8(data.content);
}

// ---------- ajustes ----------

// Addons que existían antes de guardar `knownProviders` en los ajustes.
const LEGACY_KNOWN_PROVIDERS = ['peerflix', 'torrentsdb', 'torrentio', 'piratebay', 'ytztvio', 'tpbAdult'];

function selectedProviders() {
  const saved = state.settings.providers;
  if (!Array.isArray(saved) || !saved.length) return resolveProviderSlugs(DEFAULT_PROVIDER_SLUGS);
  // Los addons añadidos después de guardar los ajustes se activan si van
  // activados por defecto; los que el usuario desmarcó siguen desmarcados.
  const known = new Set(Array.isArray(state.settings.knownProviders) ? state.settings.knownProviders : LEGACY_KNOWN_PROVIDERS);
  const added = DEFAULT_PROVIDER_SLUGS.filter(slug => !known.has(slug));
  return resolveProviderSlugs([...saved, ...added]);
}

function renderProviderList() {
  const selected = new Set(selectedProviders());
  $('#provider-list').innerHTML = Object.values(PROVIDERS).map(p => `
    <label class="${p.adult ? 'adult' : ''}" title="${escapeHtml(p.manifestUrl)}">
      <input type="checkbox" data-provider="${p.slug}" ${selected.has(p.slug) && p.queryable ? 'checked' : ''} ${p.queryable ? '' : 'disabled'}/>
      <span><b>${escapeHtml(p.name)}</b>${p.adult ? ' 🔞' : ''}<br/><small>${escapeHtml(p.description || '')}</small><br/><a href="${escapeHtml(p.manifestUrl)}" target="_blank" rel="noopener">manifest ↗</a></span>
    </label>`).join('');
}

function readProvidersFromUI() {
  return $$('#provider-list input[type=checkbox]').filter(c => c.checked && !c.disabled).map(c => c.dataset.provider);
}

function readRemoteIngestOptions() {
  const followSeries = $$('input[name="follow-series"]').find(input => input.checked)?.value || '1';
  const rawSeriesId = $('#series-id').value.trim();
  return {
    followSeries,
    autoDiscover: $('#auto-discover').checked && followSeries !== 'only',
    discoverMovies: $('#discover-movies').checked,
    discoverSeries: $('#discover-series').checked,
    batchSize: clamp($('#ingest-batch-size').value, 1, 1000),
    seriesId: rawSeriesId,
  };
}

function saveRemoteIngestPreferences() {
  const s = state.settings;
  const followSeries = $$('input[name="follow-series"]').find(input => input.checked)?.value || '1';
  s.ingest = {
    followSeries,
    autoDiscover: $('#auto-discover').checked,
    discoverMovies: $('#discover-movies').checked,
    discoverSeries: $('#discover-series').checked,
    batchSize: clamp($('#ingest-batch-size').value, 1, 1000),
    seriesId: $('#series-id').value.trim(),
  };
  saveSettings();
}

function updateIngestOptionsUI({ persist = false } = {}) {
  const options = readRemoteIngestOptions();
  const onlySeries = options.followSeries === 'only';
  if (onlySeries) $('#auto-discover').checked = false;
  const discoveryDisabled = onlySeries || !$('#auto-discover').checked;
  $('#auto-discover').disabled = onlySeries;
  $('#discover-movies').disabled = discoveryDisabled;
  $('#discover-series').disabled = discoveryDisabled;
  $('#ingest-batch-size').disabled = discoveryDisabled;
  $('#discovery-controls').setAttribute('aria-disabled', String(discoveryDisabled));

  const summary = $('#ingest-options-summary');
  if (onlySeries) {
    summary.textContent = 'Solo se continuará una serie pendiente; no se añadirán películas ni contenido nuevo.';
  } else if (options.autoDiscover) {
    const kinds = [options.discoverMovies && 'películas', options.discoverSeries && 'series'].filter(Boolean);
    const seriesFlow = options.followSeries === '1'
      ? ' La siguiente serie no empezará hasta que termine la activa.'
      : ' Las series seleccionadas se procesarán en paralelo.';
    summary.textContent = kinds.length
      ? `Se generará un lote de hasta ${options.batchSize} entradas (${kinds.join(' y ')}).${seriesFlow}`
      : 'La rotación sustituirá el lote anterior, pero no añadirá películas ni series nuevas.';
  } else {
    summary.textContent = 'Desactivado: la Action procesa la lista tal como la has pegado, sin autogenerar ni rotar títulos.';
  }
  if (persist) saveRemoteIngestPreferences();
  updateIngestHint();
}

function applySettingsToUI() {
  const s = state.settings;
  $('#gh-owner').value = s.ghOwner || '';
  $('#gh-repo').value = s.ghRepo || '';
  $('#gh-token').value = s.ghToken || '';
  $('#gh-branch').value = s.ghBranch || '';
  $('#sb-url').value = s.sbUrl || '';
  $('#sb-anon').value = s.sbAnon || '';
  $('#sb-page-size').value = s.pageSize || 50;
  $('#use-cinemeta').checked = s.cinemeta !== false;
  $('#concurrency').value = s.concurrency || 4;
  const ingest = s.ingest || {};
  const followValue = ['1', 'only', '0'].includes(ingest.followSeries) ? ingest.followSeries : '1';
  $$('input[name="follow-series"]').forEach(input => { input.checked = input.value === followValue; });
  $('#auto-discover').checked = Boolean(ingest.autoDiscover);
  $('#discover-movies').checked = ingest.discoverMovies !== false;
  $('#discover-series').checked = ingest.discoverSeries !== false;
  $('#ingest-batch-size').value = clamp(ingest.batchSize || 10, 1, 1000);
  $('#series-id').value = ingest.seriesId || '';
  const detected = state.detectedRepo;
  $('#gh-owner').placeholder = detected ? `${detected.owner} (detectado)` : 'ej: noe359866-code';
  $('#gh-repo').placeholder = detected ? `${detected.repo} (detectado)` : 'ej: screaper56';
  $('#gh-branch').placeholder = detected?.branch || 'main';
  renderProviderList();
  updateRepoLabels();
  updateIngestOptionsUI();
}

function updateIngestHint() {
  const hint = $('#ingest-mode-hint');
  const token = Boolean(state.settings.ghToken);
  const options = readRemoteIngestOptions();
  const followLabel = options.followSeries === 'only'
    ? 'solo continúa una serie pendiente, sin películas'
    : options.followSeries === '1'
      ? 'termina una serie activa antes de iniciar otra (las películas de la lista sí se procesan)'
      : 'procesa en paralelo las series de la lista';
  hint.innerHTML = token
    ? 'Con tu token: actualiza <code>watchlist.txt</code> y lanza la Action directamente. Publica los JSON y el addon Stremio en GitHub Pages y, si hay credenciales, hace UPSERT en Supabase.'
    : 'Sin token: abre un <b>Issue ya relleno</b> en GitHub. Pulsa “Submit new issue” (tienes que ser el dueño o un colaborador del repo) y la Action actualiza <code>watchlist.txt</code>, publica los resultados y te responde en el Issue.';
  hint.innerHTML += ` <b>Plan de series:</b> ${followLabel}.`;
  if (options.autoDiscover) {
    const kinds = [options.discoverMovies && 'películas', options.discoverSeries && 'series'].filter(Boolean).join(' y ') || 'ningún tipo';
    const pendingLabel = options.followSeries === '0' ? 'mantiene las series pendientes' : 'mantiene la serie activa';
    hint.innerHTML += ` Rotación activada: reemplaza el lote anterior, ${pendingLabel} y prepara hasta ${options.batchSize} entradas (${kinds}) sin repetir.`;
  } else if (options.followSeries === 'only') {
    hint.innerHTML += ' La opción de títulos nuevos no se aplica al modo de solo serie.';
  } else {
    hint.innerHTML += ' Sin rotación: se procesa la lista pegada tal cual.';
  }
  hint.innerHTML += ' <b>La BD solo se guarda si la Action tiene los Secrets <code>SUPABASE_URL</code> y <code>SUPABASE_SERVICE_ROLE_KEY</code> y Dry-run está desactivado.</b> La anon key de Ajustes no habilita la escritura.';
}

$$('input[name="follow-series"]').forEach(input => input.addEventListener('change', () => updateIngestOptionsUI({ persist: true })));
for (const selector of ['#auto-discover', '#discover-movies', '#discover-series']) {
  $(selector).addEventListener('change', () => updateIngestOptionsUI({ persist: true }));
}
for (const selector of ['#ingest-batch-size', '#series-id']) {
  $(selector).addEventListener('input', () => updateIngestOptionsUI({ persist: true }));
}

$('#save-settings').addEventListener('click', () => {
  const s = state.settings;
  s.ghOwner = $('#gh-owner').value.trim();
  s.ghRepo = $('#gh-repo').value.trim();
  s.ghToken = $('#gh-token').value.trim();
  s.ghBranch = $('#gh-branch').value.trim();
  const sbChanged = s.sbUrl !== $('#sb-url').value.trim() || s.sbAnon !== $('#sb-anon').value.trim();
  s.sbUrl = $('#sb-url').value.trim();
  s.sbAnon = $('#sb-anon').value.trim();
  s.pageSize = clamp($('#sb-page-size').value, 20, 500);
  s.providers = readProvidersFromUI();
  s.knownProviders = Object.keys(PROVIDERS);
  s.cinemeta = $('#use-cinemeta').checked;
  s.concurrency = clamp($('#concurrency').value, 1, 8);
  if (sbChanged) state.supabase = null;
  saveSettings();
  applySettingsToUI();
  flash('#settings-status', '✅ Guardado');
});

$('#test-settings').addEventListener('click', async () => {
  const out = $('#settings-status');
  out.textContent = 'Probando…';
  const msgs = [];
  const repo = currentRepo();
  if (repo) {
    try {
      const info = await gh(`/repos/${repo.owner}/${repo.repo}`);
      msgs.push(`GitHub ✅ ${info.full_name}${info.private ? ' (privado: necesitarás token)' : ''}${state.settings.ghToken ? (info.permissions?.push ? ' · token con escritura' : ' · el token NO puede escribir') : ' · sin token'}`);
    } catch (e) { msgs.push(`GitHub ❌ ${e.message}`); }
  } else msgs.push('GitHub: sin repo');
  // ¿El navegador llega a los addons? (CORS + red)
  const fetchJSON = createJsonFetcher({ timeoutMs: 8000, retries: 0 });
  const checks = await Promise.all(queryableProviders(selectedProviders()).map(async p => {
    const t0 = performance.now();
    try { await fetchJSON(p.manifestUrl); return `${p.name} ✅ ${Math.round(performance.now() - t0)} ms`; }
    catch (e) { return `${p.name} ❌ ${describeError(e)}`; }
  }));
  msgs.push(...checks);
  if (state.settings.sbUrl && state.settings.sbAnon) {
    try {
      const sb = await getSupabase();
      const { error } = await sb.from('torrents').select('info_hash', { count: 'exact', head: true });
      msgs.push(error ? `Supabase ❌ ${error.message}` : 'Supabase ✅');
    } catch (e) { msgs.push(`Supabase ❌ ${e.message}`); }
  }
  out.textContent = msgs.join(' · ');
});

// ---------- tabs ----------
function showTab(tab) {
  $$('nav button').forEach(x => {
    const active = x.dataset.tab === tab;
    x.classList.toggle('active', active);
    x.setAttribute('aria-pressed', String(active));
  });
  $$('.tab').forEach(x => x.classList.toggle('active', x.id === `tab-${tab}`));
  if (tab === 'dashboard') refreshDashboard();
  if (tab === 'history') loadHistory();
  if (tab !== 'dashboard' && tab !== 'history') $('#main-content')?.focus({ preventScroll: true });
}
$$('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const active = document.activeElement;
  const editing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  if (e.key === '/' && !editing) {
    e.preventDefault();
    $('#q')?.focus();
    $('#q')?.select();
    return;
  }
  if (e.key === 'Escape' && active === $('#q') && $('#q').value) {
    $('#q').value = '';
    state.page = 0;
    renderDashboard();
  }
});

// ---------- almacén local (resultados de ⚡ Procesar aquí) ----------

function loadLocal() {
  try {
    const data = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    return data && Array.isArray(data.items) ? data : { items: [], updatedAt: null };
  } catch { return { items: [], updatedAt: null }; }
}

function saveLocal(newItems) {
  const store = loadLocal();
  const byId = new Map(store.items.map(it => [it.id, it]));
  const stamp = new Date().toISOString();
  for (const it of newItems) {
    byId.delete(it.id); // re-insert so the newest run comes first
    byId.set(it.id, { ...it, savedAt: stamp });
  }
  const items = [...byId.values()].sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ version: 1, updatedAt: stamp, items }));
    return { ok: true, count: items.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- dashboard ----------

$$('.segmented button').forEach(b => b.addEventListener('click', () => setSource(b.dataset.source)));
$('#q').addEventListener('input', debounce(() => { state.page = 0; renderDashboard(); }, 200));
for (const id of ['#type-filter', '#quality', '#lang', '#order']) {
  $(id).addEventListener('change', () => { state.page = 0; renderDashboard(); });
}
$('#refresh').addEventListener('click', () => refreshDashboard(true));
$('#prev-page').addEventListener('click', () => { if (state.page > 0) { state.page--; renderDashboard(); } });
$('#next-page').addEventListener('click', () => { state.page++; renderDashboard(); });
$('#clear-local').addEventListener('click', () => {
  if (!confirm('¿Borrar los resultados guardados en este navegador?')) return;
  localStorage.removeItem(LOCAL_KEY);
  refreshDashboard();
});

function setSource(source) {
  state.source = source;
  state.page = 0;
  $$('.segmented button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === source)));
  state.settings.dashboardSource = source;
  saveSettings();
  refreshDashboard();
}

async function refreshDashboard(force = false) {
  $$('.segmented button').forEach(b => {
    const active = b.dataset.source === state.source;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('#clear-local').classList.toggle('hidden', state.source !== 'local');
  $('#export-bar').classList.toggle('hidden', state.source === 'supabase');
  if (state.source === 'supabase') {
    $('#series-progress')?.classList.add('hidden');
    return refreshSupabase();
  }
  if (state.source === 'published') {
    $('#torrent-list').innerHTML = '<div class="empty">Cargando lo publicado…</div>';
    try {
      await loadPublished(force);
    } catch (err) {
      state.published = null;
      $('#source-info').textContent = '';
      $('#torrent-list').innerHTML = `<div class="empty">${escapeHtml(err.message)}<br/>Prueba <b>⚡ Procesar aquí</b> en la pestaña “Subir TXT / Ingestar”: no necesita token.</div>`;
      renderStats([], null);
      renderSeriesProgress();
      return;
    }
  }
  renderDashboard();
}

async function loadPublished(force = false) {
  if (state.published && !force) return state.published;
  const res = await fetch(`data/index.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'Aún no hay datos publicados (data/index.json no existe).' : `No se pudo leer data/index.json (HTTP ${res.status}).`);
  const index = await res.json();
  if (index.repository?.owner && index.repository?.name) {
    state.detectedRepo = { owner: index.repository.owner, repo: index.repository.name, branch: index.repository.branch || 'main', source: 'data/index.json' };
    applySettingsToUI();
  }
  let items = Array.isArray(index.items) ? index.items : [];
  const legacy = items.some(it => !Array.isArray(it.picks));
  if (legacy) items = await upgradeLegacyItems(items);
  // Historial de progreso de series (dónde quedó cada una); opcional.
  let progress = index.progress || null;
  try {
    const progRes = await fetch(`data/progress.json?t=${Date.now()}`, { cache: 'no-store' });
    if (progRes.ok) progress = normalizeProgress(await progRes.json());
  } catch { /* sin historial aún */ }
  state.published = { index, items, legacy, progress: progress ? normalizeProgress(progress) : null };
  return state.published;
}

// Datos del formato antiguo (todos los streams, sin picks): se calculan los
// 2 picks en el navegador con la misma selección que la Action.
async function upgradeLegacyItems(items) {
  const info = $('#source-info');
  const limit = createLimiter(6);
  let done = 0;
  return Promise.all(items.map(item => limit(async () => {
    if (Array.isArray(item.picks)) return item;
    const path = item.type === 'series'
      ? `data/series/${item.imdbId}-s${item.season}e${item.episode}.json`
      : `data/movies/${item.imdbId}.json`;
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ...picksFromPublishedItem(item, await res.json()), legacy: true };
    } catch (err) {
      return { ...item, picks: [], missing: ['es', 'en'], errors: [{ provider: 'web', error: `no se pudo leer ${path}: ${err.message}` }] };
    } finally {
      info.textContent = `Datos en formato antiguo: calculando los 2 torrents por título… ${++done}/${items.length}`;
    }
  })));
}

function currentCardItems() {
  if (state.source === 'local') return loadLocal().items;
  return state.published?.items || [];
}

function bestOf(item, field) {
  return Math.max(-1, ...(item.picks || []).map(p => p[field] ?? -1));
}

function filterItems(items) {
  const terms = $('#q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const type = $('#type-filter').value;
  const quality = $('#quality').value;
  const lang = $('#lang').value;
  const order = $('#order').value;
  const out = items.filter(it => {
    const picks = it.picks || [];
    if (type && it.type !== type) return false;
    if (quality && !picks.some(p => p.quality === quality)) return false;
    if ((lang === 'es' || lang === 'en') && !picks.some(p => p.pick === lang)) return false;
    if (lang === 'missing' && picks.length >= 2) return false;
    if (terms.length) {
      const hay = [it.label, it.name, it.imdbId, it.id, ...picks.map(p => p.title)].join(' ').toLowerCase();
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  });
  if (order === 'title') out.sort((a, b) => String(a.label).localeCompare(String(b.label), 'es'));
  if (order === 'seeders') out.sort((a, b) => bestOf(b, 'seeders') - bestOf(a, 'seeders'));
  if (order === 'size_bytes') out.sort((a, b) => bestOf(b, 'sizeBytes') - bestOf(a, 'sizeBytes'));
  return out;
}

function renderStats(items, updatedAt) {
  $('#stat-total-lbl').textContent = 'títulos';
  $('#stat-spanish-lbl').textContent = 'con 🇪🇸';
  $('#stat-english-lbl').textContent = 'con 🇬🇧';
  $('#stat-total').textContent = items.length || '0';
  $('#stat-movies').textContent = items.filter(i => i.type === 'movie').length;
  $('#stat-series').textContent = items.filter(i => i.type === 'series').length;
  $('#stat-spanish').textContent = items.filter(i => (i.picks || []).some(p => p.pick === 'es')).length;
  $('#stat-english').textContent = items.filter(i => (i.picks || []).some(p => p.pick === 'en')).length;
  $('#stat-last').textContent = updatedAt ? fmtDate(updatedAt) : '—';
}

/** Panel 📺: dónde quedó cada serie (progreso publicado por la Action). */
function renderSeriesProgress() {
  const el = $('#series-progress');
  if (!el) return;
  const progress = state.source === 'published' ? state.published?.progress : null;
  const activeId = progress?.activeSeries || null;
  const records = Object.entries(progress?.series || {});
  const pending = records
    .filter(([, r]) => r.status === 'in-progress')
    .sort(([a], [b]) => (a === activeId ? -1 : b === activeId ? 1 : 0));
  const complete = records.filter(([, r]) => r.status === 'complete').slice(0, 8);
  if (!pending.length && !complete.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const tag = (s, e) => `S${String(s ?? 0).padStart(2, '0')}E${String(e ?? 0).padStart(2, '0')}`;
  const row = ([id, r]) => {
    const pct = r.total ? Math.min(100, Math.round(100 * r.done / r.total)) : 0;
    const poster = posterUrl(id, 'small');
    const isActive = id === activeId && r.status === 'in-progress';
    const stateTxt = r.status === 'complete'
      ? '✅ completa'
      : `${isActive ? '🎯 siguiendo hasta terminarla · ' : ''}⏳ sigue en ${tag(r.nextSeason, r.nextEpisode)} la próxima ejecución`;
    return `<div class="sp-row">
      ${poster ? `<img class="sp-poster" src="${escapeHtml(poster)}" alt="" loading="lazy"/>` : ''}
      <div class="sp-main">
        <div class="sp-title">${escapeHtml(r.name)} <span class="muted small">${stateTxt}</span></div>
        <div class="sp-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="sp-fill" style="width:${pct}%"></div></div>
        <div class="muted small">${r.done}/${r.total} episodios${r.lastSeason != null ? ` · último ingerido ${tag(r.lastSeason, r.lastEpisode)}` : ''}</div>
      </div>
    </div>`;
  };
  el.innerHTML = `<details${pending.length ? ' open' : ''}><summary>📺 Por dónde van las series (${pending.length} en progreso${complete.length ? ` · ${complete.length} completada${complete.length === 1 ? '' : 's'} hace poco` : ''})</summary>
    <div class="sp-list">${[...pending, ...complete].map(row).join('')}</div></details>`;
  el.classList.remove('hidden');
}

function renderDashboard() {
  if (state.source === 'supabase') return loadTorrents();
  const all = currentCardItems();
  const local = state.source === 'local' ? loadLocal() : null;
  const index = state.published?.index;
  renderStats(all, local ? local.updatedAt : index?.finishedAt || index?.generatedAt);
  renderSeriesProgress();
  $('#source-info').textContent = local
    ? (all.length ? `${plural(all.length, 'título')} procesado${all.length === 1 ? '' : 's'} en este navegador (no se suben a ningún sitio).` : '')
    : index ? `Publicado por la Action${MODE_LABELS[index.mode] ? ` (${MODE_LABELS[index.mode]})` : ''} · ${fmtDate(index.finishedAt || index.generatedAt)}${state.published.legacy ? ' · formato antiguo: picks calculados en el navegador' : ''} · ${describeDatabaseWrite(index).message}` : '';

  const items = filterItems(all);
  state.lastExportItems = items;
  const picks = items.reduce((n, it) => n + (it.picks?.length || 0), 0);
  $('#export-count').textContent = items.length ? `${plural(items.length, 'título')} · ${plural(picks, 'torrent')}` : '';
  $$('#export-bar [data-export]').forEach(b => { b.disabled = !picks; });

  const list = $('#torrent-list');
  if (!all.length) {
    list.innerHTML = state.source === 'local'
      ? '<div class="empty">Aún no has procesado nada en este navegador. Ve a “Subir TXT / Ingestar” y pulsa <b>⚡ Procesar aquí</b>.</div>'
      : '<div class="empty">No hay títulos publicados.</div>';
    renderPager(0);
    return;
  }
  if (!items.length) { list.innerHTML = '<div class="empty">Sin resultados con esos filtros.</div>'; renderPager(0); return; }
  const maxPage = Math.max(0, Math.ceil(items.length / CARDS_PER_PAGE) - 1);
  state.page = Math.min(state.page, maxPage);
  list.innerHTML = items.slice(state.page * CARDS_PER_PAGE, (state.page + 1) * CARDS_PER_PAGE).map(renderCard).join('');
  renderPager(items.length, CARDS_PER_PAGE, 'títulos');
}

function renderPager(total, perPage = CARDS_PER_PAGE, noun = 'títulos') {
  const maxPage = Math.max(0, Math.ceil(total / perPage) - 1);
  $('#page-indicator').textContent = total ? `Página ${state.page + 1} / ${maxPage + 1} · ${total} ${noun}` : '';
  $('#prev-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page >= maxPage;
}

function episodeTag(item) {
  return item.type === 'series' ? `S${pad2(item.season)}E${pad2(item.episode)}` : '';
}

function renderPickRow(item, lang) {
  const meta = PICK_META[lang];
  const p = (item.picks || []).find(x => x.pick === lang);
  if (!p) return `<div class="pick-row missing">${meta.flag} Sin torrent en ${lang === 'es' ? 'español' : 'inglés'}</div>`;
  const magnet = safeMagnet(p.magnetUrl, p.infoHash);
  const size = p.sizeLabel || formatBytes(p.sizeBytes);
  const tags = releaseTags(p.release);
  return `<div class="pick-row">
    <span class="badge ${lang}">${meta.flag} ${escapeHtml(p.quality || '?')}</span>
    <div class="pick-main">
      <div class="pick-name" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
      <div class="pick-meta">
        <span class="${seedsClass(p.seeders)}">👤 ${p.seeders ?? '?'}</span>
        ${size ? `<span class="badge">💾 ${escapeHtml(size)}</span>` : ''}
        ${tags ? `<span class="badge tags">${escapeHtml(tags)}</span>` : ''}
        ${(p.providers || []).map(x => `<span class="badge provider">${escapeHtml(x)}</span>`).join('')}
      </div>
    </div>
    <div class="pick-actions">${magnet ? `
      <a class="ghost" href="${escapeHtml(magnet)}" title="Abrir en tu cliente torrent" aria-label="Abrir magnet en el cliente torrent">🧲</a>
      <button class="ghost copy-btn" data-magnet="${encodeURIComponent(magnet)}" aria-label="Copiar magnet">Copiar</button>` : ''}
    </div>
  </div>`;
}

function renderCard(item) {
  const picks = item.picks || [];
  const poster = posterUrl(item.imdbId);
  const tag = episodeTag(item);
  const typeBadge = item.type === 'series'
    ? `<span class="badge series">${tag}</span>`
    : '<span class="badge movie">PELÍCULA</span>';
  const label = item.label && tag && !item.label.includes(tag) ? `${item.label} ${tag}` : item.label || item.imdbId;
  const errors = item.errors?.length
    ? `<span class="badge warn" title="${escapeHtml(item.errors.map(e => `${e.provider}: ${e.error}`).join('\n'))}">${item.errors.length} addon(s) con error</span>`
    : '';
  const cls = picks.length >= 2 ? '' : picks.length ? 'incomplete' : 'empty-card';
  return `<article class="title-card ${cls}">
    <div class="poster">${poster ? `<img loading="lazy" decoding="async" src="${escapeHtml(poster)}" alt="Póster de ${escapeHtml(label)}" />` : '🎬'}</div>
    <div class="card-body">
      <div class="card-head">
        <div class="card-title">${escapeHtml(label)}</div>
      </div>
      <div class="card-sub">
        ${typeBadge}
        ${item.name && item.name !== item.label ? `<span>${escapeHtml(item.name)}${item.year ? ` (${item.year})` : ''}</span>` : ''}
        <a href="https://www.imdb.com/title/${escapeHtml(item.imdbId)}/" target="_blank" rel="noopener" title="Abrir ${escapeHtml(item.imdbId)} en IMDb">${escapeHtml(item.imdbId)}</a>
        ${item.candidateCount != null ? `<span class="badge" title="Torrents distintos que devolvieron los addons">${picks.length} de ${item.candidateCount}</span>` : ''}
        ${errors}
      </div>
      ${(item.warnings || []).map(w => `<div class="card-warn">⚠️ ${escapeHtml(w)}</div>`).join('')}
      ${renderPickRow(item, 'es')}
      ${renderPickRow(item, 'en')}
    </div>
  </article>`;
}

// Pósters: si metahub no tiene la imagen, se deja el icono.
for (const container of [$('#torrent-list'), $('#run-items')]) {
  container.addEventListener('error', e => {
    if (e.target.tagName === 'IMG') e.target.parentElement.textContent = '🎬';
  }, true);
  container.addEventListener('click', async e => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const ok = await copyText(decodeURIComponent(btn.dataset.magnet));
    btn.textContent = ok ? '✓' : '!';
    setTimeout(() => { btn.textContent = 'Copiar'; }, 1200);
  });
}

$$('#export-bar [data-export]').forEach(btn => btn.addEventListener('click', async () => {
  const items = state.lastExportItems;
  const stamp = new Date().toISOString().slice(0, 10);
  const kind = btn.dataset.export;
  if (kind === 'copy') {
    const ok = await copyText(toMagnetList(items).split('\n').filter(l => l.startsWith('magnet:')).join('\n'));
    btn.textContent = ok ? '✓ Copiados' : '! Error';
    setTimeout(() => { btn.textContent = '📋 Copiar magnets'; }, 1500);
  }
  if (kind === 'txt') download(`magnets-${stamp}.txt`, toMagnetList(items), 'text/plain;charset=utf-8');
  if (kind === 'csv') download(`torrents-${stamp}.csv`, '\ufeff' + toCSV(picksToRows(items)), 'text/csv;charset=utf-8');
  if (kind === 'json') download(`torrents-${stamp}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2), 'application/json');
}));

// ---------- Supabase (opcional, carga perezosa) ----------

async function getSupabase() {
  if (state.supabase) return state.supabase;
  const { sbUrl, sbAnon } = state.settings;
  if (!sbUrl || !sbAnon) return null;
  const { createClient } = await import(SUPABASE_ESM);
  state.supabase = createClient(sbUrl, sbAnon, { auth: { persistSession: false, autoRefreshToken: false } });
  return state.supabase;
}

async function refreshSupabase() {
  $('#source-info').textContent = 'Histórico de la tabla torrents (incluye filas de ingestas antiguas).';
  let sb;
  try { sb = await getSupabase(); }
  catch (err) { $('#torrent-list').innerHTML = `<div class="empty">No se pudo cargar supabase-js: ${escapeHtml(err.message)}</div>`; return; }
  if (!sb) {
    renderStats([], null);
    $('#torrent-list').innerHTML = '<div class="empty">Supabase es opcional: añade la URL y la anon key en “Ajustes” para ver aquí la tabla <code>torrents</code>. Mientras tanto usa 📦 Publicado o 💻 Este navegador.</div>';
    renderPager(0);
    return;
  }
  try {
    const head = { count: 'exact', head: true };
    const [totalC, moviesC, seriesC, spanishC, englishC, lastC] = await Promise.all([
      sb.from('torrents').select('info_hash', head),
      sb.from('torrents').select('info_hash', head).eq('type', 'movie'),
      sb.from('torrents').select('info_hash', head).eq('type', 'series'),
      sb.from('torrents').select('info_hash', head).cs('audio', '{es}'),
      sb.from('torrents').select('info_hash', head).cs('audio', '{en}'),
      sb.from('torrents').select('updated_at').order('updated_at', { ascending: false }).limit(1),
    ]);
    $('#stat-total-lbl').textContent = 'torrents';
    $('#stat-spanish-lbl').textContent = 'audio ES';
    $('#stat-english-lbl').textContent = 'audio EN';
    $('#stat-total').textContent = totalC.count ?? '—';
    $('#stat-movies').textContent = moviesC.count ?? '—';
    $('#stat-series').textContent = seriesC.count ?? '—';
    $('#stat-spanish').textContent = spanishC.count ?? '—';
    $('#stat-english').textContent = englishC.count ?? '—';
    $('#stat-last').textContent = lastC.data?.[0]?.updated_at ? fmtDate(lastC.data[0].updated_at) : '—';
  } catch (e) {
    console.warn(e);
  }
  loadTorrents();
}

async function loadTorrents() {
  const sb = await getSupabase().catch(() => null);
  if (!sb) return;
  $('#torrent-list').innerHTML = '<div class="empty">Cargando…</div>';
  const q = $('#q').value.trim();
  const quality = $('#quality').value;
  const lang = $('#lang').value;
  const type = $('#type-filter').value;
  const order = $('#order').value;

  let query = sb.from('torrents').select('*', { count: 'exact' });
  if (q) {
    if (/^tt\d+$/i.test(q)) query = query.eq('imdb_id', q.toLowerCase());
    else query = query.ilike('title', `%${q.replace(/[%_]/g, '\\$&')}%`);
  }
  if (type) query = query.eq('type', type);
  if (quality) query = query.eq('quality', quality);
  if (lang === 'es' || lang === 'en') query = query.cs('audio', `{${lang}}`);

  const ordering = {
    updated_at: { column: 'updated_at', ascending: false },
    seeders: { column: 'seeders', ascending: false, nullsFirst: false },
    size_bytes: { column: 'size_bytes', ascending: false, nullsFirst: false },
    title: { column: 'title', ascending: true },
  }[order];
  query = query.order(ordering.column, { ascending: ordering.ascending, nullsFirst: ordering.nullsFirst ?? true });
  const ps = state.settings.pageSize || 50;
  query = query.range(state.page * ps, (state.page + 1) * ps - 1);

  const { data, error, count } = await query;
  if (error) {
    $('#torrent-list').innerHTML = `<div class="empty">Error: ${escapeHtml(error.message)}</div>`;
    return;
  }
  state.total = count ?? 0;
  $('#torrent-list').innerHTML = data.length ? data.map(renderTorrentRow).join('') : '<div class="empty">Sin resultados.</div>';
  renderPager(state.total, ps, 'torrents');
}

function renderTorrentRow(r) {
  const size = formatBytes(r.size_bytes);
  const langs = (r.audio || []).map(l => `<span class="badge ${escapeHtml(l)}">${escapeHtml(l.toUpperCase())}</span>`).join('');
  const typeBadge = r.type === 'series'
    ? `<span class="badge series">S${pad2(r.season)}E${pad2(r.episode)}</span>`
    : '<span class="badge movie">PELÍCULA</span>';
  const imdbLink = r.imdb_id ? `<a href="https://www.imdb.com/title/${escapeHtml(r.imdb_id)}" target="_blank" rel="noopener">${escapeHtml(r.imdb_id)}</a>` : '';
  const magnet = safeMagnet(r.magnet_url, r.info_hash);
  return `
    <div class="torrent">
      <div class="q">${escapeHtml(r.quality || '?')}</div>
      <div>
        <div class="title">${escapeHtml(r.title)}</div>
        <div class="meta">
          ${typeBadge}
          <span class="${seedsClass(r.seeders)}">👤 ${r.seeders ?? '?'}</span>
          ${size ? `<span class="badge">${escapeHtml(size)}</span>` : ''}
          ${langs}
          ${r.codec ? `<span class="badge tags">${escapeHtml([r.codec, r.hdr_format, r.channels].filter(Boolean).join(' · '))}</span>` : ''}
          <span class="badge">${escapeHtml(r.source_tracker || '')}</span>
          <span>${imdbLink}</span>
        </div>
      </div>
      <div class="act">${magnet ? `
        <a href="${escapeHtml(magnet)}" class="ghost">🧲</a>
        <button class="ghost copy-btn" data-magnet="${encodeURIComponent(magnet)}">Copiar</button>` : ''}
      </div>
    </div>`;
}

// ---------- ingest: lista ----------

function inspectWatchlist(text) {
  let lines = 0;
  let invalid = 0;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (IMDB_LINE_RE.test(line)) lines++;
    else invalid++;
  }
  const items = parseWatchlist(text);
  const seasons = items.filter(i => i.type === 'series' && i.episode === null).length;
  return { valid: items.length, duplicates: lines - items.length, invalid, seasons };
}

function updateWatchlistPreview() {
  const preview = $('#watchlist-preview');
  const stats = inspectWatchlist($('#watchlist').value);
  if (!stats.valid && !stats.duplicates && !stats.invalid) {
    preview.textContent = 'Aún no has añadido IDs.';
  } else {
    preview.textContent = `IDs válidos únicos: ${stats.valid}${stats.seasons ? ` (${stats.seasons} temporada(s) completa(s))` : ''} · repetidos (se omiten): ${stats.duplicates} · líneas no reconocidas (se ignoran): ${stats.invalid}`;
  }
  preview.classList.toggle('warning', stats.invalid > 0);
  return stats;
}

$('#watchlist').addEventListener('input', updateWatchlistPreview);
$('#clear-wl').addEventListener('click', () => {
  $('#watchlist').value = '';
  $('#upload-file').value = '';
  $('#upload-name').textContent = 'Ningún archivo seleccionado';
  updateWatchlistPreview();
});
$('#upload-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    $('#watchlist').value = await f.text();
    $('#upload-name').textContent = f.name;
    setStatus(`✅ ${f.name} cargado; revisa la lista antes de procesar.`);
    updateWatchlistPreview();
  } catch (err) {
    setStatus(`❌ No se pudo leer el archivo: ${err.message}`);
  } finally {
    // Allows choosing the same file again after editing/clearing the text.
    e.target.value = '';
  }
});
$('#load-current').addEventListener('click', async () => {
  const repo = currentRepo();
  if (!repo) { setStatus('❌ No sé cuál es tu repositorio: escribe owner y repo en Ajustes.'); return; }
  setStatus(`Cargando watchlist.txt de ${repo.owner}/${repo.repo}…`);
  try {
    $('#watchlist').value = await readRepoFile(repo, 'watchlist.txt');
    $('#upload-name').textContent = `watchlist.txt de ${repo.owner}/${repo.repo}`;
    updateWatchlistPreview();
    setStatus('✅ Watchlist cargado');
  } catch (err) {
    setStatus(`❌ No se pudo leer watchlist.txt: ${err.message}`);
  }
});

$('#auto-rotate-wl').addEventListener('click', async () => {
  setStatus('🔄 Buscando títulos nuevos y eliminando los anteriores…');
  try {
    let initial = {};
    try {
      const res = await fetch(`data/seen.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) initial = await res.json();
    } catch { /* ignore */ }
    const seen = createSeenStore(initial);
    if (state.published?.index) seen.addFromIndex(state.published.index);
    for (const item of loadLocal().items) seen.addItem(item);
    const fetchJSON = createJsonFetcher({ timeoutMs: 10000, retries: 1 });
    // Solo se conserva y continúa 1 serie activa a la vez hasta terminarla.
    const progress = state.published?.progress || normalizeProgress(null);
    const currentItems = parseWatchlist($('#watchlist').value);
    const activeSeriesId = pickActiveSeries(progress, currentItems, { seen });
    const preResumed = resumeMissingItems(progress, currentItems, { activeSeriesId });
    const rotation = await rotateWatchlist($('#watchlist').value, {
      seen,
      fetchJSON: state.settings.cinemeta !== false ? fetchJSON : null,
      autoDiscover: true,
      replaceAll: true,
      keep: resumeKeepPredicate(progress, { activeSeriesId }),
      batchSize: Math.max(1, DEFAULT_BATCH_SIZE - preResumed.length),
      maxSeries: preResumed.length > 0 ? 0 : 1,
    });
    const resumed = resumeMissingItems(progress, rotation.items, { activeSeriesId });
    $('#watchlist').value = resumed.length
      ? formatWatchlistFile([...rotation.items, ...resumed], { removedCount: rotation.removedCount, addedCount: rotation.addedCount })
      : rotation.text;
    $('#upload-name').textContent = `Lote nuevo (${rotation.addedCount} nuevos · ${rotation.removedCount} anteriores eliminados${resumed.length ? ` · ${resumed.length} serie continúa` : ''})`;
    updateWatchlistPreview();
    setStatus(`✅ Watchlist actualizado: ${rotation.addedCount} títulos nuevos (${rotation.removedCount} anteriores eliminados${resumed.length ? `; ${resumed.length} serie en progreso continúa donde quedó` : ''}).`);
  } catch (err) {
    setStatus(`❌ No se pudo autogenerar el watchlist: ${err.message}`);
  }
});

// ---------- ingest: progreso ----------

function log(text, cls = '') {
  const el = $('#run-log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  el.append(line);
  el.scrollTop = el.scrollHeight;
}
function setProgress(pct) { $('#run-progress-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`; }

function resetRunUI() {
  $('#run-log').textContent = '';
  $('#run-meta').textContent = '';
  $('#run-steps').innerHTML = '';
  $('#run-summary').innerHTML = '';
  $('#run-items').innerHTML = '';
  $('#run-actions').classList.add('hidden');
  setProgress(0);
}

function beginRun(kind) {
  const controller = new AbortController();
  state.running = { kind, controller };
  $('#process-local').disabled = true;
  $('#ingest').disabled = true;
  $('#cancel-run').classList.remove('hidden');
  return controller;
}

function endRun() {
  state.running = null;
  $('#process-local').disabled = false;
  $('#ingest').disabled = false;
  $('#cancel-run').classList.add('hidden');
}

$('#cancel-run').addEventListener('click', () => {
  if (!state.running) return;
  state.running.controller.abort();
  setStatus(state.running.kind === 'remote' ? '⏹ Dejé de esperar (la Action sigue en GitHub).' : '⏹ Cancelando…');
});

function renderResultSummary({ items, candidates, errors, durationMs, extra = [] }) {
  const es = items.filter(i => (i.picks || []).some(p => p.pick === 'es')).length;
  const en = items.filter(i => (i.picks || []).some(p => p.pick === 'en')).length;
  const picks = items.reduce((n, i) => n + (i.picks?.length || 0), 0);
  $('#run-summary').innerHTML = [
    statCard(items.length, 'títulos'),
    statCard(picks, 'elegidos'),
    statCard(es, 'con 🇪🇸'),
    statCard(en, 'con 🇬🇧'),
    ...(candidates != null ? [statCard(candidates, 'candidatos')] : []),
    ...extra,
    statCard(errors, 'errores'),
    statCard(durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : '—', 'duración'),
  ].join('');
}

function logErrorSummary(errors) {
  const real = errors.filter(e => !e.skipped);
  const grouped = new Map();
  for (const e of real) grouped.set(`${e.provider}: ${e.error}`, (grouped.get(`${e.provider}: ${e.error}`) || 0) + 1);
  for (const [key, count] of grouped) log(`❌ ${key}${count > 1 ? ` (×${count})` : ''}`, 'err');
  const skipped = errors.length - real.length;
  if (skipped) log(`⏭ ${skipped} consulta(s) omitidas: ese addon ya había fallado varias veces seguidas.`, 'warn');
}

// ---------- ⚡ procesar en el navegador (sin token) ----------

$('#process-local').addEventListener('click', processLocally);

async function processLocally() {
  const text = $('#watchlist').value;
  if (!updateWatchlistPreview().valid) { setStatus('❌ Añade al menos un IMDb ID válido.'); return; }
  const providers = queryableProviders(selectedProviders());
  if (!providers.length) { setStatus('❌ Activa al menos un proveedor en Ajustes.'); return; }

  resetRunUI();
  const controller = beginRun('local');
  const started = Date.now();
  setStatus('⚡ Procesando en tu navegador…');
  log(`⚡ Consultando ${providers.map(p => p.name).join(', ')} desde tu navegador (sin token).`);
  try {
    const fetchJSON = createJsonFetcher({ timeoutMs: 20000, retries: 1, signal: controller.signal });
    const trackers = await loadBestTrackers({ timeoutMs: 6000 });
    if (trackers.warning) log(`⚠️ ${trackers.warning}`, 'warn');
    const cards = $('#run-items');
    const result = await processWatchlist(text, {
      providers,
      fetchJSON,
      metadata: state.settings.cinemeta !== false,
      concurrency: clamp(state.settings.concurrency || 4, 1, 8),
      bestTrackers: trackers.trackers,
      signal: controller.signal,
      onWarning: message => log(`⚠️ ${message}`, 'warn'),
      onQueries: queries => {
        log(`📋 ${queries.length} títulos/episodios × ${providers.length} addons = ${queries.length * providers.length} consultas`);
        setProgress(4);
      },
      onItem: ({ item, streams }, { done, total }) => {
        setProgress(4 + 96 * done / total);
        const es = streams.find(s => s.pick === 'es');
        const en = streams.find(s => s.pick === 'en');
        const fmt = (s, flag) => s ? `${flag} ${s.quality || '?'} 👤${s.seeders ?? '?'}` : `${flag} —`;
        const icon = streams.length === 2 ? '✅' : streams.length ? '🟡' : '⚠️';
        log(`${icon} [${done}/${total}] ${item.label} · ${fmt(es, '🇪🇸')} · ${fmt(en, '🇬🇧')} · ${streams.length}/${item.candidateCount}`, streams.length ? 'ok' : 'warn');
        $('#run-meta').textContent = `${done}/${total} títulos · ${((Date.now() - started) / 1000).toFixed(0)} s`;
        cards.insertAdjacentHTML('beforeend', renderCard(item));
      },
    });
    const finished = result.results.filter(r => !r.errors.some(e => e.error === 'cancelado')).map(r => r.item);
    logErrorSummary(result.errors.filter(e => e.error !== 'cancelado'));
    const failedEverywhere = result.totals.candidates === 0 && result.errors.length > 0 && !controller.signal.aborted;
    if (failedEverywhere && result.errors.every(e => /red|CORS/i.test(e.error) || e.skipped)) {
      log('💡 Tu navegador no pudo contactar con los addons. ¿Un bloqueador de anuncios o una red que los bloquea? Prueba ☁️ Guardar en el repo: lo procesa GitHub.', 'warn');
    }
    // Cards in watchlist order (they were appended in completion order).
    cards.innerHTML = finished.map(renderCard).join('');
    const saved = finished.length ? saveLocal(finished) : { ok: true, count: loadLocal().items.length };
    renderResultSummary({ items: finished, candidates: result.totals.candidates, errors: result.errors.filter(e => !e.skipped && e.error !== 'cancelado').length, durationMs: Date.now() - started });
    if (controller.signal.aborted) {
      setStatus(`⏹ Cancelado: ${plural(finished.length, 'título')} terminado${finished.length === 1 ? '' : 's'}${finished.length ? ' y guardado' + (finished.length === 1 ? '' : 's') + ' en este navegador' : ''}.`);
    } else if (!saved.ok) {
      setStatus(`⚠️ Procesado, pero no cupo en el almacenamiento del navegador (${saved.error}). Descárgalo desde el Dashboard.`);
    } else {
      setStatus(`✅ Listo: ${plural(finished.length, 'título')}. Guardado${finished.length === 1 ? '' : 's'} en este navegador (${saved.count} en total).`);
    }
    setProgress(100);
    if (finished.length) $('#run-actions').classList.remove('hidden');
  } catch (err) {
    setStatus(`❌ ${describeError(err)}`);
    log(`❌ ${describeError(err)}`, 'err');
  } finally {
    endRun();
  }
}

$('#open-local-dashboard').addEventListener('click', () => {
  state.source = 'local';
  state.settings.dashboardSource = 'local';
  saveSettings();
  state.page = 0;
  showTab('dashboard');
});

// ---------- ☁️ guardar en el repo (token opcional) ----------

$('#ingest').addEventListener('click', ingestRemote);

async function ingestRemote() {
  const text = $('#watchlist').value;
  const listStats = updateWatchlistPreview();
  const options = readRemoteIngestOptions();
  const canRunWithoutList = options.autoDiscover || options.followSeries === 'only' || Boolean(options.seriesId);
  if (!listStats.valid && !canRunWithoutList) {
    setStatus('❌ Añade un IMDb ID, activa la rotación automática o indica una serie prioritaria.');
    return;
  }
  const repo = currentRepo();
  if (!repo) {
    setStatus('❌ No sé cuál es tu repositorio: escribe owner y repo en Ajustes (o abre esta web desde GitHub Pages).');
    return;
  }
  const dryRun = $('#dryrun').checked;
  const providers = selectedProviders();
  if (options.seriesId && !/^tt\d{7,10}$/i.test(options.seriesId)) {
    setStatus('❌ La serie prioritaria debe ser un IMDb ID válido, por ejemplo tt0944947.');
    return;
  }
  options.seriesId = options.seriesId.toLowerCase();
  resetRunUI();
  const request = { dryRun, providers, ...options };
  if (state.settings.ghToken) return dispatchWithToken(repo, text, request);
  return ingestViaIssue(repo, text, request);
}

async function ingestViaIssue(repo, text, { dryRun, providers, followSeries, autoDiscover, discoverMovies, discoverSeries, batchSize, seriesId }) {
  const { lines, invalid } = sanitizeWatchlistLines(text);
  const title = buildIssueTitle(lines.length);
  const body = buildIssueBody(text, {
    dryRun,
    providers,
    followSeries,
    rotateWatchlist: autoDiscover,
    discoverMovies,
    discoverSeries,
    batchSize,
    seriesId,
  });
  const base = `https://github.com/${repo.owner}/${repo.repo}/issues/new`;
  let url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  let copied = false;
  if (url.length > MAX_ISSUE_URL) {
    // Very long lists do not fit in a URL: copy the body and open an empty issue.
    copied = await copyText(body);
    url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent('Pega aquí (Ctrl+V) el contenido que copió la web.')}`;
  }
  window.open(url, '_blank', 'noopener');
  const since = Date.now();
  const modeLabel = followSeries === 'only' ? 'solo serie activa' : followSeries === '1' ? 'una serie a la vez' : 'series en paralelo';
  log(`📝 Issue preparado en ${repo.owner}/${repo.repo}: ${plural(lines.length, 'título')} · ${modeLabel}${autoDiscover ? ` · lote nuevo de hasta ${batchSize}` : ''}${invalid ? ` (${invalid} líneas no válidas descartadas)` : ''}${dryRun ? ' · dry-run' : ''}.`);
  $('#run-meta').innerHTML = `Si no se abrió la pestaña: <a href="${escapeHtml(url)}" target="_blank" rel="noopener">abrir el Issue en GitHub ↗</a>${copied ? ' · la lista está copiada en el portapapeles: pégala en el cuerpo del Issue' : ''}.`;
  setStatus('👉 En la pestaña de GitHub pulsa “Submit new issue” (tienes que ser el dueño o un colaborador). Esperaré aquí el resultado.');
  await watchRemoteRun(repo, since);
}

async function dispatchWithToken(repo, text, { dryRun, providers, followSeries, autoDiscover, discoverMovies, discoverSeries, batchSize, seriesId }) {
  const controller = beginRun('remote');
  try {
    setStatus('Enviando watchlist.txt al repo…');
    setProgress(8);
    const path = `/repos/${repo.owner}/${repo.repo}/contents/watchlist.txt`;
    let sha;
    try { sha = (await gh(`${path}?ref=${encodeURIComponent(repo.branch)}`)).sha; } catch { /* first write */ }
    await gh(path, {
      method: 'PUT',
      body: {
        message: `chore(watchlist): update from UI ${new Date().toISOString()}`,
        content: btoa(unescape(encodeURIComponent(text))),
        branch: repo.branch,
        ...(sha ? { sha } : {}),
      },
    });
    log('✅ watchlist.txt actualizado.', 'ok');
    setStatus('Lanzando la GitHub Action…');
    setProgress(15);
    const since = Date.now();
    await gh(`/repos/${repo.owner}/${repo.repo}/actions/workflows/${WORKFLOW_ID}/dispatches`, {
      method: 'POST',
      body: {
        ref: repo.branch,
        inputs: {
          dry_run: dryRun ? '1' : '0',
          rotate_watchlist: autoDiscover ? '1' : '0',
          follow_series: followSeries,
          series_id: seriesId,
          batch_size: String(batchSize),
          discover_movies: discoverMovies ? '1' : '0',
          discover_series: discoverSeries ? '1' : '0',
          providers: providers.join(','),
        },
      },
    });
    log('🚀 Action lanzada.', 'ok');
    endRun();
    await watchRemoteRun(repo, since);
  } catch (err) {
    setStatus(`❌ ${err.message}`);
    log(`❌ ${err.message}`, 'err');
    if (err.status === 401 || err.status === 403) log('💡 Revisa el token (Contents + Actions en lectura/escritura) o bórralo para usar el modo por Issue.', 'warn');
  } finally {
    if (state.running?.controller === controller) endRun();
  }
}

async function findRecentRun(repo, since) {
  const data = await gh(`/repos/${repo.owner}/${repo.repo}/actions/workflows/${WORKFLOW_ID}/runs?per_page=5`);
  return (data.workflow_runs || []).find(r => new Date(r.created_at).getTime() >= since - 60_000) || null;
}

async function fetchFreshReport(repo, since) {
  const urls = [`data/report.json?t=${Date.now()}`]; // esta misma web (GitHub Pages)
  if (repo) urls.push(rawUrl(repo, 'public/data/report.json'));
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const report = await res.json();
      if (report?.finishedAt && Date.parse(report.finishedAt) > since) return report;
    } catch { /* try the next source */ }
  }
  return null;
}

function renderJob(job) {
  $('#run-steps').innerHTML = (job.steps || []).map(step =>
    `<span class="step ${escapeHtml(step.status)} ${escapeHtml(step.conclusion || '')}">${step.status === 'completed' ? (step.conclusion === 'success' ? '✓' : step.conclusion === 'skipped' ? '–' : '✗') : step.status === 'in_progress' ? '…' : '·'} ${escapeHtml(step.name)}</span>`
  ).join('');
  const steps = job.steps || [];
  const done = steps.filter(s => s.status === 'completed').length;
  if (steps.length) setProgress(20 + 70 * done / steps.length);
}

/**
 * Espera el resultado de la Action sin token: sondea el report publicado (esta
 * web o raw.githubusercontent.com, sin límite) y el estado del run en la API
 * pública (límite 60/h, por eso cada 30 s sin token).
 */
async function watchRemoteRun(repo, since) {
  const controller = beginRun('remote');
  const deadline = since + REMOTE_WAIT_MS;
  const apiEvery = state.settings.ghToken ? 5000 : 30000;
  let run = null;
  let lastApi = 0;
  let finishedRun = null;
  try {
    while (Date.now() < deadline && !controller.signal.aborted) {
      const report = await fetchFreshReport(repo, since);
      if (report) {
        showRunReport(report, run);
        setProgress(100);
        setStatus(`Terminado: ${plural(report.items?.length ?? 0, 'título')} publicado${(report.items?.length ?? 0) === 1 ? '' : 's'} · ${describeDatabaseWrite(report).message}`);
        return;
      }
      if (Date.now() - lastApi >= apiEvery) {
        lastApi = Date.now();
        try {
          if (!run) {
            run = await findRecentRun(repo, since);
            if (run) log(`🏃 Action en marcha: ${run.display_title || run.name} · ${run.html_url}`, 'ok');
          }
          if (run) {
            const jobs = await gh(`/repos/${repo.owner}/${repo.repo}/actions/runs/${run.id}/jobs?per_page=5`);
            const job = jobs.jobs?.[0];
            if (job) {
              renderJob(job);
              $('#run-meta').innerHTML = `<a href="${escapeHtml(run.html_url)}" target="_blank" rel="noopener">Run #${escapeHtml(run.run_number)}</a> · ${escapeHtml(job.status)}${job.conclusion ? ` · ${escapeHtml(job.conclusion)}` : ''}`;
              if (job.status === 'completed') {
                if (job.conclusion !== 'success') {
                  setStatus(`⚠️ La Action terminó con “${job.conclusion}”. Mira el detalle en GitHub.`);
                  return;
                }
                finishedRun = finishedRun || Date.now();
              }
            }
          } else {
            $('#run-meta').innerHTML = $('#run-meta').innerHTML || 'Esperando a que arranque la Action…';
          }
        } catch (err) {
          log(`⚠️ ${err.message}`, 'warn');
          if (err.status === 403 || err.status === 429) lastApi = Date.now() + 60_000;
        }
      }
      // The job finished but the report is not visible yet (git push / Pages).
      if (finishedRun && Date.now() - finishedRun > 3 * 60_000) {
        setStatus('⚠️ La Action terminó, pero no veo el report.json nuevo. Recarga el Dashboard en un rato.');
        return;
      }
      await sleep(10000, controller.signal);
    }
    if (!controller.signal.aborted) setStatus('⌛ Dejé de esperar tras 15 minutos. Mira el Historial o el Issue en GitHub.');
  } finally {
    endRun();
  }
}

function showRunReport(report, run) {
  const items = report.items || [];
  const dbStatus = describeDatabaseWrite(report);
  renderResultSummary({
    items,
    candidates: report.totalCandidates,
    errors: (report.errors || []).filter(e => !e.skipped).length + (report.db?.failures?.length || 0),
    durationMs: report.durationMs,
    extra: [
      statCard(dbStatus.saved ?? '—', 'guardados en Supabase'),
      ...(dbStatus.state !== 'saved' && dbStatus.prepared != null ? [statCard(dbStatus.prepared, 'preparados para la BD')] : []),
    ],
  });
  const dbLogLevel = dbStatus.state === 'error' ? 'err' : dbStatus.state === 'saved' || dbStatus.state === 'empty' ? 'ok' : 'warn';
  log(dbStatus.message, dbLogLevel);
  if (dbStatus.detail) log(dbStatus.detail, dbLogLevel);
  for (const w of report.warnings || []) log(`⚠️ ${w}`, 'warn');
  logErrorSummary(report.errors || []);
  if (run) log(`🔗 ${run.html_url}`);
  $('#run-items').innerHTML = items.map(it => Array.isArray(it.picks) ? renderCard(it) : '').join('');
  state.published = null; // el Dashboard "Publicado" se recargará
}

// ---------- historial (API pública, sin token) ----------

$('#refresh-history').addEventListener('click', loadHistory);
async function loadHistory() {
  const list = $('#history-list');
  const repo = currentRepo();
  if (!repo) { list.innerHTML = '<div class="empty">No sé cuál es tu repositorio: escríbelo en Ajustes.</div>'; return; }
  list.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const data = await gh(`/repos/${repo.owner}/${repo.repo}/actions/workflows/${WORKFLOW_ID}/runs?per_page=10`);
    if (!data.workflow_runs?.length) { list.innerHTML = '<div class="empty">Aún no hay ejecuciones.</div>'; return; }
    list.innerHTML = data.workflow_runs.map(run => `
      <div class="run-item">
        <div class="head">
          <div>
            <span class="status-dot ${escapeHtml(run.conclusion || run.status)}"></span>
            <strong>#${escapeHtml(run.run_number)}</strong>
            <span>${escapeHtml(run.display_title || run.name || '')}</span>
            <span class="muted">${escapeHtml(run.event)} · ${fmtDate(run.created_at)}</span>
          </div>
          <div>
            <span class="badge ${run.conclusion === 'success' ? 'good' : run.conclusion === 'failure' ? 'bad' : 'warn'}">${escapeHtml(run.conclusion || run.status)}</span>
            <a href="${escapeHtml(run.html_url)}" target="_blank" rel="noopener" class="ghost" style="padding:4px 8px;text-decoration:none">abrir</a>
          </div>
        </div>
        <div class="muted" style="margin-top:6px;font-size:12px">
          <code>${escapeHtml(run.head_sha.slice(0, 7))}</code> · ${escapeHtml(run.head_commit?.message.split('\n')[0] || '')}
        </div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- arranque ----------
state.detectedRepo = repoFromLocation();
state.source = ['published', 'local', 'supabase'].includes(state.settings.dashboardSource) ? state.settings.dashboardSource : 'published';
applySettingsToUI();
updateWatchlistPreview();
refreshDashboard();
