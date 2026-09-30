/* Peerflix Ingest – client-side app
 * - Tab navigation
 * - Settings persisted in localStorage (gh token, supabase creds)
 * - Dashboard: live search against Supabase (anon key)
 * - Ingest: writes watchlist.txt to repo, dispatches workflow_dispatch,
 *           polls the run, streams logs into a panel, then shows report.json
 * - History: lists recent workflow runs via GitHub API
 */

const LS_KEY = 'peerflix-static.settings.v2';
const WORKFLOW_ID = 'static.yml'; // file name under .github/workflows/

const ALL_PROVIDERS = [
  { slug: 'peerflix',   name: 'Peerflix',        adult: false, default: true,  manifestUrl: 'https://peerflix.mov/manifest.json', note: 'Fuente principal' },
  { slug: 'torrentsdb', name: 'TorrentsDB',      adult: false, default: true,  manifestUrl: 'https://torrentsdb.com/manifest.json', note: 'Agrega YTS, EZTV, 1337x, RARGB, Nyaa, TPB, Kat, TTL, Rutracker…' },
  { slug: 'torrentio',  name: 'Torrentio',       adult: false, default: true,  manifestUrl: 'https://torrentio.strem.fun/manifest.json', note: 'Agrega YTS, EZTV, RARGB, 1337x, TPB, TGx, MagnetDL, Nyaa, MejorTorrent…' },
  { slug: 'piratebay',  name: 'ThePirateBay+',   adult: false, default: true,  manifestUrl: 'https://thepiratebay-plus.strem.fun/manifest.json', note: 'TPB directo' },
  { slug: 'ytztvio',    name: 'Ytztvio',          adult: false, default: true,  manifestUrl: 'https://ytztvio.galacticcapsule.workers.dev/manifest.json', note: 'YTS + EZTV' },
  { slug: 'tpbAdult',   name: 'TPB Adult',       adult: true,  default: false, manifestUrl: 'https://tpb-adult-addon.click/manifest.json', note: 'Solo catálogo Porn; su manifest no ofrece streams movie/series por IMDb, por eso no se mezcla en esta ingestada.' },
];

const state = {
  settings: loadSettings(),
  supabase: null,
  page: 0,
  pageSize: 50,
  total: 0,
  currentRunId: null,
  pollTimer: null,
};

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}
function saveSettings() { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); }

function renderProviderList() {
  const box = $('#provider-list');
  if (!box) return;
  const defaults = ALL_PROVIDERS.filter(p => p.default && !p.adult).map(p => p.slug);
  const selected = new Set(state.settings.providers && state.settings.providers.length
    ? state.settings.providers
    : defaults);
  box.innerHTML = ALL_PROVIDERS.map(p => `
    <label class="${p.adult ? 'adult' : ''}" title="${escapeHtml(p.manifestUrl)}">
      <input type="checkbox" data-provider="${p.slug}" ${selected.has(p.slug) ? 'checked' : ''} ${p.adult ? 'disabled' : ''}/>
      <span><b>${escapeHtml(p.name)}</b>${p.adult ? ' 🔞' : ''}<br/><small>${escapeHtml(p.note)}</small><br/><a href="${escapeHtml(p.manifestUrl)}" target="_blank" rel="noopener">manifest ↗</a></span>
    </label>
  `).join('');
}

function readProvidersFromUI() {
  return [...$$('#provider-list input[type=checkbox]')]
    .filter(c => c.checked && !c.disabled)
    .map(c => c.dataset.provider);
}

function applySettingsToUI() {
  $('#gh-owner').value = state.settings.ghOwner || '';
  $('#gh-repo').value  = state.settings.ghRepo  || '';
  $('#gh-token').value = state.settings.ghToken || '';
  $('#gh-branch').value = state.settings.ghBranch || 'arena/01a0effc-screaper56';
  $('#sb-url').value   = state.settings.sbUrl   || '';
  $('#sb-anon').value  = state.settings.sbAnon  || '';
  $('#sb-page-size').value = state.settings.pageSize || 50;
  renderProviderList();
  $('#footer-repo').textContent =
    state.settings.ghOwner && state.settings.ghRepo
      ? `${state.settings.ghOwner}/${state.settings.ghRepo}` : '—';
}
function settingsValid(needsGh = true, needsSb = true) {
  const s = state.settings;
  const gh = s.ghOwner && s.ghRepo && s.ghToken;
  const sb = s.sbUrl && s.sbAnon;
  return (!needsGh || gh) && (!needsSb || sb);
}
function ghHeaders() {
  return {
    authorization: `Bearer ${state.settings.ghToken}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'peerflix-static-ui',
  };
}
function ghApi(path, opts = {}) {
  return fetch(`https://api.github.com${path}`, { headers: ghHeaders(), ...opts }).then(async r => {
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`GitHub API ${r.status}: ${body.slice(0, 200)}`);
    }
    return r.status === 204 ? null : r.json();
  });
}
function fmtBytes(b) {
  if (b == null) return '';
  const u = ['B','KB','MB','GB','TB']; let i=0,v=b;
  while (v>=1024 && i<u.length-1){v/=1024;i++;}
  return v.toFixed(v>=100?0:1)+' '+u[i];
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleString('es-ES');
}
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function seedsClass(n) {
  if (n == null) return 'badge';
  if (n >= 10) return 'badge good';
  if (n >= 1) return 'badge warn';
  return 'badge bad';
}

// ---------- tabs ----------
$$('nav button').forEach(b => b.addEventListener('click', () => {
  $$('nav button').forEach(x => x.classList.remove('active'));
  $$('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const tab = b.dataset.tab;
  $(`#tab-${tab}`).classList.add('active');
  if (tab === 'dashboard') refreshDashboard();
  if (tab === 'history') loadHistory();
}));

// ---------- settings ----------
$('#save-settings').addEventListener('click', () => {
  state.settings.ghOwner = $('#gh-owner').value.trim();
  state.settings.ghRepo  = $('#gh-repo').value.trim();
  state.settings.ghToken = $('#gh-token').value.trim();
  state.settings.ghBranch = $('#gh-branch').value.trim() || 'main';
  state.settings.sbUrl   = $('#sb-url').value.trim();
  state.settings.sbAnon  = $('#sb-anon').value.trim();
  state.settings.pageSize = Math.max(20, Math.min(500, Number($('#sb-page-size').value) || 50));
  state.settings.providers = readProvidersFromUI();
  saveSettings();
  initSupabase();
  applySettingsToUI();
  flash('#settings-status', '✅ Guardado');
});
$('#test-settings').addEventListener('click', async () => {
  $('#settings-status').textContent = 'Probando…';
  const ghOk = settingsValid(true, false);
  const sbOk = settingsValid(false, true);
  const msgs = [];
  if (ghOk) {
    try { await ghApi(`/repos/${state.settings.ghOwner}/${state.settings.ghRepo}`); msgs.push('GitHub OK'); }
    catch (e) { msgs.push(`GitHub: ${e.message}`); }
  } else msgs.push('GitHub: faltan datos');
  if (sbOk) {
    try {
      initSupabase();
      const { error } = await state.supabase.from('torrents').select('info_hash', { count: 'exact', head: true });
      msgs.push(error ? `Supabase: ${error.message}` : 'Supabase OK');
    } catch (e) { msgs.push(`Supabase: ${e.message}`); }
  } else msgs.push('Supabase: faltan datos');
  $('#settings-status').textContent = msgs.join(' · ');
});
function flash(sel, text) {
  $(sel).textContent = text;
  setTimeout(() => { if ($(sel).textContent === text) $(sel).textContent = ''; }, 3000);
}

// ---------- supabase ----------
function initSupabase() {
  if (!settingsValid(false, true)) { state.supabase = null; return; }
  state.supabase = window.supabase.createClient(state.settings.sbUrl, state.settings.sbAnon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------- dashboard ----------
$('#q').addEventListener('input', debounce(() => { state.page = 0; loadTorrents(); }, 250));
$('#quality').addEventListener('change', () => { state.page = 0; loadTorrents(); });
$('#lang').addEventListener('change', () => { state.page = 0; loadTorrents(); });
$('#order').addEventListener('change', () => { state.page = 0; loadTorrents(); });
$('#refresh').addEventListener('click', loadTorrents);
$('#prev-page').addEventListener('click', () => { if (state.page > 0) { state.page--; loadTorrents(); } });
$('#next-page').addEventListener('click', () => {
  const maxPage = Math.floor((state.total - 1) / state.pageSize);
  if (state.page < maxPage) { state.page++; loadTorrents(); }
});

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function refreshDashboard() {
  if (!state.supabase) {
    $('#torrent-list').innerHTML = '<div class="empty">Configura Supabase en la pestaña "Ajustes" para ver el dashboard.</div>';
    return;
  }
  // Aggregate stats
  try {
    const [totalC, moviesC, seriesC, spanishC, lastC] = await Promise.all([
      state.supabase.from('torrents').select('info_hash', { count: 'exact', head: true }),
      state.supabase.from('torrents').select('info_hash', { count: 'exact', head: true }).eq('type','movie'),
      state.supabase.from('torrents').select('info_hash', { count: 'exact', head: true }).eq('type','series'),
      state.supabase.from('torrents').select('info_hash', { count: 'exact', head: true }).cs('audio','{es}'),
      state.supabase.from('torrents').select('updated_at').order('updated_at',{ascending:false}).limit(1),
    ]);
    $('#stat-total').textContent  = totalC.count ?? '—';
    $('#stat-movies').textContent = moviesC.count ?? '—';
    $('#stat-series').textContent = seriesC.count ?? '—';
    $('#stat-spanish').textContent = spanishC.count ?? '—';
    $('#stat-last').textContent   = lastC.data?.[0]?.updated_at ? fmtDate(lastC.data[0].updated_at) : '—';
  } catch (e) {
    console.warn(e);
  }
  loadTorrents();
}

async function loadTorrents() {
  if (!state.supabase) return;
  $('#torrent-list').innerHTML = '<div class="empty">Cargando…</div>';
  const q = $('#q').value.trim();
  const quality = $('#quality').value;
  const lang = $('#lang').value;
  const order = $('#order').value;

  let query = state.supabase.from('torrents').select('*', { count: 'exact' });
  if (q) {
    // search title OR imdb_id
    if (q.startsWith('tt')) query = query.eq('imdb_id', q);
    else query = query.ilike('title', `%${q.replace(/[%_]/g, '\\$&')}%`);
  }
  if (quality) query = query.eq('quality', quality);
  if (lang) query = query.cs('audio', `{${lang}}`);

  const ordering = {
    updated_at: { column: 'updated_at', ascending: false },
    seeders:    { column: 'seeders', ascending: false, nullsFirst: false },
    size_bytes: { column: 'size_bytes', ascending: false, nullsFirst: false },
    title:      { column: 'title', ascending: true },
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
  if (!data.length) {
    $('#torrent-list').innerHTML = '<div class="empty">Sin resultados.</div>';
  } else {
    $('#torrent-list').innerHTML = data.map(renderTorrent).join('');
  }
  const maxPage = Math.floor((state.total - 1) / ps);
  $('#page-indicator').textContent = `Página ${state.page + 1} / ${maxPage + 1} · ${state.total} torrents`;
  $('#prev-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page >= maxPage;
}

function renderTorrent(r) {
  const q = r.quality || '?';
  const size = fmtBytes(r.size_bytes);
  const seedTxt = r.seeders == null ? '?' : r.seeders;
  const langs = (r.audio || []).map(l => `<span class="badge ${l}">${l.toUpperCase()}</span>`).join('');
  const typeBadge = r.type === 'series'
    ? `<span class="badge series">S${String(r.season||0).padStart(2,'0')}E${String(r.episode||0).padStart(2,'0')}</span>`
    : `<span class="badge movie">PELÍCULA</span>`;
  const imdbLink = r.imdb_id ? `<a href="https://www.imdb.com/title/${r.imdb_id}" target="_blank" rel="noopener">${r.imdb_id}</a>` : '';
  const magnet = r.magnet_url || (r.info_hash ? `magnet:?xt=urn:btih:${r.info_hash}` : '#');
  return `
    <div class="torrent">
      <div class="q">${escapeHtml(q)}</div>
      <div>
        <div class="title">${escapeHtml(r.title)}</div>
        <div class="meta">
          ${typeBadge}
          <span class="${seedsClass(r.seeders)}">👤 ${seedTxt}</span>
          ${size ? `<span class="badge">${escapeHtml(size)}</span>` : ''}
          ${langs}
          <span class="badge">${escapeHtml(r.source_tracker || '')}</span>
          <span>${imdbLink}</span>
        </div>
      </div>
      <div class="act">
        <a href="${escapeHtml(magnet)}" class="ghost" target="_blank">🧲</a>
        <button class="ghost copy-btn" data-magnet="${encodeURIComponent(magnet)}">Copiar</button>
      </div>
    </div>`;
}
$('#torrent-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const m = decodeURIComponent(btn.dataset.magnet);
  try { await navigator.clipboard.writeText(m); btn.textContent = '✓'; }
  catch { btn.textContent = '!'; }
  setTimeout(() => { btn.textContent = 'Copiar'; }, 1200);
});

// ---------- ingest ----------
$('#clear-wl').addEventListener('click', () => { $('#watchlist').value = ''; });
$('#upload-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const text = await f.text();
  $('#watchlist').value = text;
});
$('#load-current').addEventListener('click', async () => {
  if (!settingsValid(true, false)) { alert('Configura GitHub en Ajustes primero.'); return; }
  $('#ingest-status').textContent = 'Cargando watchlist.txt del repo…';
  try {
    const data = await ghApi(`/repos/${state.settings.ghOwner}/${state.settings.ghRepo}/contents/watchlist.txt`);
    const content = atob(data.content);
    $('#watchlist').value = content;
    $('#ingest-status').textContent = '✅ Watchlist cargado';
  } catch (err) {
    $('#ingest-status').textContent = '❌ ' + err.message;
  }
});

$('#ingest').addEventListener('click', runIngest);

async function runIngest() {
  if (!settingsValid(true, false)) {
    alert('Configura GitHub (owner/repo/token) en la pestaña Ajustes primero.');
    return;
  }
  const text = $('#watchlist').value;
  if (!text.trim()) { alert('La lista está vacía.'); return; }
  const dryRun = $('#dryrun').checked;
  const btn = $('#ingest');
  btn.disabled = true;
  $('#ingest-status').textContent = 'Enviando watchlist.txt al repo…';
  $('#run-log').textContent = '';
  $('#run-progress-fill').style.width = '10%';
  $('#run-meta').textContent = '';
  $('#run-summary').innerHTML = '';
  $('#run-items').innerHTML = '';

  try {
    // 1. Get current SHA of watchlist.txt to update it
    const owner = state.settings.ghOwner, repo = state.settings.ghRepo;
    let sha = null;
    try {
      const existing = await ghApi(`/repos/${owner}/${repo}/contents/watchlist.txt`);
      sha = existing.sha;
    } catch { /* first write */ }

    const content = btoa(unescape(encodeURIComponent(text)));
    await ghApi(`/repos/${owner}/${repo}/contents/watchlist.txt`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `chore(watchlist): update from UI ${new Date().toISOString()}`,
        content,
        sha: sha || undefined,
      }),
    });

    // 2. Trigger workflow_dispatch
    $('#ingest-status').textContent = 'Lanzando GitHub Action…';
    $('#run-progress-fill').style.width = '25%';
    const providers = (state.settings.providers || []).join(',') || 'peerflix,torrentsdb,torrentio,piratebay,ytztvio';
    const dispatchStartedAt = Date.now();
    await ghApi(`/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_ID}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: state.settings.ghBranch || 'main', inputs: { dry_run: dryRun ? '1' : '0', providers } }),
    });

    // 3. Find the run created by this dispatch, not an unrelated scheduled run.
    $('#ingest-status').textContent = 'Esperando a que la Action arranque…';
    await new Promise(r => setTimeout(r, 3000));
    let runId = null;
    for (let attempt = 0; attempt < 20 && !runId; attempt++) {
      const runs = await ghApi(`/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_ID}/runs?per_page=10`);
      const current = runs.workflow_runs.find(r =>
        r.event === 'workflow_dispatch' &&
        r.status !== 'completed' &&
        new Date(r.created_at).getTime() >= dispatchStartedAt - 30_000
      ) || runs.workflow_runs.find(r => r.status !== 'completed');
      if (current) { runId = current.id; break; }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!runId) throw new Error('No se encontró el run recién lanzado.');

    state.currentRunId = runId;
    $('#run-meta').textContent = `Run #${runId} — en curso…`;

    // 4. Poll until completed, streaming logs at the end
    await pollRun(owner, repo, runId);
  } catch (err) {
    $('#ingest-status').textContent = '❌ ' + err.message;
    $('#run-log').textContent += '\n' + err.message;
    btn.disabled = false;
  }
}

async function pollRun(owner, repo, runId) {
  const logEl = $('#run-log');
  const fill = $('#run-progress-fill');
  const meta = $('#run-meta');
  let completed = false;
  let lastLog = '';
  while (!completed) {
    const run = await ghApi(`/repos/${owner}/${repo}/actions/runs/${runId}`);
    meta.textContent = `Run #${run.run_number} (${run.status}) – ${run.conclusion || '…'}  ·  ${fmtDate(run.updated_at)}`;
    if (run.status === 'completed') {
      completed = true;
      fill.style.width = '90%';
      // fetch job logs
      try {
        const jobs = await ghApi(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=10`);
        const job = jobs.jobs?.[0];
        if (job) {
          const logR = await fetch(job.logs_url, { headers: ghHeaders() });
          if (logR.ok) lastLog = await logR.text();
        }
      } catch {}
      logEl.textContent = lastLog || '(no se pudieron obtener logs)';
      fill.style.width = '100%';
      await new Promise(r => setTimeout(r, 1500)); // wait for Pages commit
      await showRunReport(owner, repo, run);
      $('#ingest').disabled = false;
      $('#ingest-status').textContent = run.conclusion === 'success' ? '✅ Completado' : `⚠️ ${run.conclusion}`;
      return;
    }
    // Progress feel while running
    const progress = 30 + Math.min(60, (Date.now() / 1000) % 60);
    fill.style.width = progress + '%';
    await new Promise(r => setTimeout(r, 2500));
  }
}

async function showRunReport(owner, repo, run) {
  // The Action commits generated public/ after checkout, so run.head_sha is
  // the pre-ingest commit. Read the branch ref that received that generated
  // commit instead of the stale workflow head SHA; retry while git push/Pages
  // propagation completes.
  const status = $('#ingest-status');
  let report = null;
  for (let attempt = 0; attempt < 15 && !report; attempt++) {
    try {
      const ref = encodeURI(state.settings.ghBranch || run.head_branch || 'main');
      const cacheBust = `?run=${encodeURIComponent(String(run.id))}&attempt=${attempt}`;
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/public/data/report.json${cacheBust}`;
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const candidate = await r.json();
        if (candidate && candidate.finishedAt) { report = candidate; break; }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!report) { status.textContent = 'Run terminado pero no se pudo leer report.json (despliegue Pages en curso)'; return; }

  $('#run-summary').innerHTML = [
    statCard(report.movies, 'películas'),
    statCard(report.episodes, 'episodios'),
    statCard(report.totalStreams, 'streams'),
    statCard(report.db.inserted ?? '—', report.db.dryRun ? 'a insertar' : 'insertados'),
    statCard(report.errors.length, 'errores'),
    statCard((report.durationMs/1000).toFixed(1)+'s', 'duración'),
  ].join('');

  const rows = [];
  for (const it of report.items) {
    const badge = it.type === 'series'
      ? `<span class="badge series">S${String(it.season||0).padStart(2,'0')}E${String(it.episode||0).padStart(2,'0')}</span>`
      : `<span class="badge movie">PELÍCULA</span>`;
    const seedClass = it.bestSeeders == null ? 'badge' : it.bestSeeders >= 5 ? 'badge good' : it.bestSeeders >= 1 ? 'badge warn' : 'badge bad';
    rows.push(`
      <div class="run-item">
        <div class="head">
          <div>
            ${badge}
            <strong>${escapeHtml(it.label)}</strong>
            <span class="muted">${escapeHtml(it.imdbId)}</span>
          </div>
          <div>
            <span class="${seedClass}">👤 ${it.bestSeeders ?? '?'} seeds</span>
            <span class="badge">${it.streamCount} streams</span>
            <span class="badge">${(it.qualities||[]).join('/') || '?'}</span>
            <span class="badge">${(it.languages||[]).join(',').toUpperCase() || '?'}</span>
            ${(it.providers || []).map(p => `<span class="badge provider">${escapeHtml(p)}</span>`).join('')}
          </div>
        </div>
      </div>`);
  }
  if (report.errors.length) {
    rows.push(`<div class="run-item"><h3 style="margin-top:0">Errores</h3><pre class="log err">${escapeHtml(report.errors.map(e => `${e.id}  ${e.error}`).join('\n'))}</pre></div>`);
  }
  $('#run-items').innerHTML = rows.join('');
}

function statCard(num, lbl) {
  return `<div class="stat"><div class="num">${escapeHtml(String(num))}</div><div class="lbl">${escapeHtml(lbl)}</div></div>`;
}

// ---------- history ----------
$('#refresh-history').addEventListener('click', loadHistory);
async function loadHistory() {
  const list = $('#history-list');
  if (!settingsValid(true, false)) { list.innerHTML = '<div class="empty">Configura GitHub en Ajustes.</div>'; return; }
  list.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const data = await ghApi(`/repos/${state.settings.ghOwner}/${state.settings.ghRepo}/actions/workflows/${WORKFLOW_ID}/runs?per_page=10`);
    if (!data.workflow_runs.length) { list.innerHTML = '<div class="empty">Aún no hay ejecuciones.</div>'; return; }
    list.innerHTML = data.workflow_runs.map(run => {
      const isCurrent = state.currentRunId === run.id;
      return `
        <div class="run-item">
          <div class="head">
            <div>
              <span class="status-dot ${run.conclusion || run.status}"></span>
              <strong>#${run.run_number}</strong>
              <span class="muted">${run.event}${isCurrent ? ' · actual' : ''} · ${fmtDate(run.created_at)}</span>
            </div>
            <div>
              <span class="badge ${run.conclusion === 'success' ? 'good' : run.conclusion === 'failure' ? 'bad' : 'warn'}">${run.conclusion || run.status}</span>
              <a href="${run.html_url}" target="_blank" rel="noopener" class="ghost" style="padding:4px 8px;text-decoration:none">abrir</a>
            </div>
          </div>
          <div class="muted" style="margin-top:6px;font-size:12px">
            <code>${run.head_sha.slice(0,7)}</code> · ${escapeHtml(run.head_commit?.message.split('\n')[0] || '')}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- boot ----------
applySettingsToUI();
initSupabase();
if (settingsValid(false, true)) refreshDashboard();
else $('#torrent-list').innerHTML = '<div class="empty">Configura Supabase en la pestaña "Ajustes" para ver el dashboard.</div>';
