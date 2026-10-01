/**
 * Rotación automática de watchlist.txt y control de historial (sin repetir
 * películas, series, nombres ni torrents entre ejecuciones).
 *
 * Compartido por la GitHub Action (Node) y la web (navegador): sin dependencias
 * de Node ni del DOM.
 */

import { CINEMETA_URL } from './meta.js';
import { IMDB_LINE_RE, parseWatchlist } from './parse.js';

const IMDB_ID_RE = /^tt\d{7,10}$/i;
const HEX_40_RE = /^[0-9a-f]{40}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_BATCH_SIZE = 10;

/**
 * Normaliza un título humano o de release para detectar nombres repetidos
 * aunque varíen mayúsculas, acentos, el año "(2026)" o sufijos "S01E01".
 */
export function normalizeTitleKey(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(\s*(?:19|20)\d{2}(?:\s*[–-]\s*(?:19|20)?\d{0,4})?\s*\)/g, ' ')
    .replace(/\b(?:s\d{1,2}\s*e\d{1,3}|s\d{1,2}|temporada\s*\d{1,2}|season\s*\d{1,2}|\d{1,2}x\d{2,3})\b.*$/i, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!cleaned || IMDB_ID_RE.test(cleaned)) return null;
  return cleaned;
}

/** Clave canónica de una entrada de watchlist (`tt1234567`, `tt1234567:s1:e1`, `tt1234567:s1`). */
export function watchlistItemKey(item) {
  if (!item?.imdbId) return '';
  const id = String(item.imdbId).toLowerCase().trim();
  const season = item.season != null ? Number(item.season) : null;
  const episode = item.episode != null ? Number(item.episode) : null;
  if (Number.isInteger(season) && Number.isInteger(episode)) return `${id}:s${season}:e${episode}`;
  if (Number.isInteger(season)) return `${id}:s${season}`;
  return id;
}

function pad2(n) {
  return String(n ?? 1).padStart(2, '0');
}

/** Formatea una entrada como línea canónica para `watchlist.txt`. */
export function formatWatchlistLine(item) {
  const id = String(item.imdbId || '').toLowerCase().trim();
  const season = item.season != null ? Number(item.season) : null;
  const episode = item.episode != null ? Number(item.episode) : null;
  const baseName = String(item.name || item.label || '')
    .replace(/\s*\(\s*\d{4}\s*\)\s*$/, '')
    .replace(/\s+S\d{2}E\d{2}.*$/i, '')
    .trim();

  if (item.type === 'series' || season != null) {
    // Serie sin temporada: el ID solo basta; la ingesta la expande a TODAS
    // las temporadas y episodios emitidos de una sola vez.
    if (!Number.isInteger(season)) {
      const label = baseName || item.label || '';
      return `${id}${label ? ' ' + label : ''}`;
    }
    const s = season;
    const ep = Number.isInteger(episode) ? episode : 1;
    const tag = `S${pad2(s)}E${pad2(ep)}`;
    const label = baseName ? `${baseName} ${tag}` : (item.label || '');
    return `${id}:s${s}:e${ep}${label ? ' ' + label : ''}`;
  }

  const year = item.year && !String(item.label || '').includes(`(${item.year})`)
    ? ` (${item.year})`
    : '';
  const label = item.label || (baseName ? `${baseName}${year}` : '');
  return `${id}${label ? ' ' + label : ''}`;
}

/** Genera el contenido completo de `watchlist.txt` con cabecera informativa. */
export function formatWatchlistFile(items, { date = new Date(), removedCount = 0, addedCount = 0 } = {}) {
  const stamp = (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const movies = items.filter(i => i.type !== 'series' && i.season == null);
  const series = items.filter(i => i.type === 'series' || i.season != null);
  const lines = [
    '# Peerflix Static – Watchlist',
    '# -----------------------------------------------------------',
    `# Actualizado automáticamente el ${stamp}` +
      (removedCount || addedCount ? ` (${addedCount} nuevos · ${removedCount} anteriores eliminados).` : '.'),
    '# En cada ejecución de la Action se eliminan los títulos ya procesados',
    '# y se cargan películas y series nuevas para no repetir torrents ni nombres.',
    '#',
    '# Formatos soportados:',
    '#   tt1234567          -> película (IMDb); si el ID resulta ser una serie,',
    '#                         se ingesta COMPLETA: todas las temporadas y',
    '#                         episodios ya emitidos, de una sola vez',
    '#   tt1234567:s3:e4    -> episodio concreto (serie, temporada 3, ep. 4)',
    '#   tt1234567:s3       -> todos los episodios emitidos de la temporada 3',
    '# -----------------------------------------------------------',
    '',
  ];
  if (movies.length) {
    lines.push('# --- Películas ---');
    for (const item of movies) lines.push(formatWatchlistLine(item));
    lines.push('');
  }
  if (series.length) {
    lines.push('# --- Series ---');
    for (const item of series) lines.push(formatWatchlistLine(item));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Almacén en memoria + serializable (`public/data/seen.json`) de todos los
 * IMDb IDs, claves, títulos y hashes ya procesados o presentes en Supabase.
 */
export function createSeenStore(initial = {}) {
  const imdbIds = new Set();
  const keys = new Set();
  const hashes = new Set();
  const titles = new Set();
  let cursor = Number.isInteger(initial?.cursor) && initial.cursor >= 0 ? initial.cursor : 0;

  const addImdbId = id => {
    const clean = String(id || '').toLowerCase().trim();
    if (IMDB_ID_RE.test(clean)) {
      imdbIds.add(clean);
      keys.add(clean);
    }
  };

  const addKey = key => {
    const clean = String(key || '').toLowerCase().trim();
    if (!clean) return;
    const m = clean.match(IMDB_LINE_RE);
    if (m) {
      const id = m[1].toLowerCase();
      imdbIds.add(id);
      if (m[2] !== undefined && m[3] !== undefined) keys.add(`${id}:s${Number(m[2])}:e${Number(m[3])}`);
      else if (m[2] !== undefined) keys.add(`${id}:s${Number(m[2])}`);
      else keys.add(id);
      return;
    }
    const colon = clean.match(/^(tt\d{7,10}):(\d{1,2}):(\d{1,3})$/);
    if (colon) {
      imdbIds.add(colon[1]);
      keys.add(`${colon[1]}:s${Number(colon[2])}:e${Number(colon[3])}`);
    }
  };

  const addHash = hash => {
    const clean = String(hash || '').toLowerCase().trim();
    if (HEX_40_RE.test(clean) && !/^0{40}$/.test(clean)) hashes.add(clean);
  };

  const addTitle = title => {
    const norm = normalizeTitleKey(title);
    if (norm) titles.add(norm);
  };

  for (const id of initial?.imdbIds || initial?.ids || []) addImdbId(id);
  for (const k of initial?.keys || []) addKey(k);
  for (const h of initial?.hashes || []) addHash(h);
  for (const t of initial?.titles || []) addTitle(t);

  return {
    imdbIds,
    keys,
    hashes,
    titles,
    get cursor() { return cursor; },
    set cursor(val) { if (Number.isInteger(val) && val >= 0) cursor = val; },
    addImdbId,
    addKey,
    addHash,
    addTitle,

    /** ¿Este título o episodio ya fue procesado antes? */
    hasItem(item) {
      if (!item) return false;
      const id = String(item.imdbId || item.imdb_id || item.id || '').toLowerCase().trim();
      if (id && imdbIds.has(id)) return true;
      const key = watchlistItemKey(item);
      if (key && keys.has(key)) return true;
      for (const candidateTitle of [item.name, item.label, item.title]) {
        const norm = normalizeTitleKey(candidateTitle);
        if (norm && titles.has(norm)) return true;
      }
      return false;
    },

    hasHash(hash) {
      return hashes.has(String(hash || '').toLowerCase().trim());
    },

    /** Registra un item de watchlist o resultado. */
    addItem(item) {
      if (!item) return;
      addImdbId(item.imdbId || item.imdb_id);
      addKey(watchlistItemKey(item));
      if (item.id) addKey(item.id);
      addTitle(item.name);
      addTitle(item.label);
    },

    /** Incorpora lo publicado en `public/data/index.json`. */
    addFromIndex(index) {
      for (const item of index?.items || []) {
        this.addItem(item);
        for (const pick of item?.picks || []) {
          addHash(pick.infoHash);
          addTitle(pick.title);
        }
      }
    },

    /** Incorpora los resultados de `runPipeline`. */
    addFromResults(results) {
      for (const entry of results || []) {
        const item = entry?.item || entry;
        this.addItem(item);
        for (const stream of entry?.streams || item?.picks || []) {
          addHash(stream.infoHash);
          addTitle(stream.title);
        }
      }
    },

    /** Incorpora las filas ya guardadas en la tabla `torrents` de Supabase. */
    addFromDatabaseRows(rows) {
      for (const row of rows || []) {
        if (!row) continue;
        if (row.imdb_id) {
          addImdbId(row.imdb_id);
          if (row.season != null && row.episode != null) {
            addKey(`${String(row.imdb_id).toLowerCase()}:s${Number(row.season)}:e${Number(row.episode)}`);
          }
        }
        if (row.info_hash) addHash(row.info_hash);
        if (row.title) addTitle(row.title);
      }
    },

    toJSON({ now = new Date() } = {}) {
      return {
        version: 1,
        updatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
        cursor,
        imdbIds: [...imdbIds],
        keys: [...keys],
        hashes: [...hashes],
        titles: [...titles],
      };
    },
  };
}

// ---------- Descubrimiento automático desde catálogos de Cinemeta ----------

export const MOVIE_CATALOG_PATHS = Object.freeze([
  '/catalog/movie/top.json',
  '/catalog/movie/year/genre=2026.json',
  '/catalog/movie/year/genre=2025.json',
  '/catalog/movie/imdbRating.json',
  '/catalog/movie/top/skip=100.json',
  '/catalog/movie/year/genre=2024.json',
  '/catalog/movie/imdbRating/skip=100.json',
  '/catalog/movie/top/skip=200.json',
  '/catalog/movie/imdbRating/skip=200.json',
  '/catalog/movie/top/skip=300.json',
]);

export const SERIES_CATALOG_PATHS = Object.freeze([
  '/catalog/series/top.json',
  '/catalog/series/year/genre=2026.json',
  '/catalog/series/year/genre=2025.json',
  '/catalog/series/imdbRating.json',
  '/catalog/series/top/skip=100.json',
  '/catalog/series/year/genre=2024.json',
  '/catalog/series/imdbRating/skip=100.json',
  '/catalog/series/top/skip=200.json',
]);

/**
 * Pool integrado de respaldo (películas y series reales con torrents activos)
 * por si Cinemeta no responde o se ejecuta sin red hacia el catálogo.
 */
export const FALLBACK_DISCOVERY_POOL = Object.freeze([
  // Películas recientes y populares
  { imdbId: 'tt27165187', type: 'movie', name: 'The End of Oak Street', year: 2026 },
  { imdbId: 'tt37287335', type: 'movie', name: 'Obsession', year: 2026 },
  { imdbId: 'tt28014327', type: 'movie', name: 'Mayday', year: 2026 },
  { imdbId: 'tt34206385', type: 'movie', name: 'Primetime', year: 2026 },
  { imdbId: 'tt35298123', type: 'movie', name: 'Teenage Sex and Death at Camp Miasma', year: 2026 },
  { imdbId: 'tt15398776', type: 'movie', name: 'Oppenheimer', year: 2023 },
  { imdbId: 'tt15239678', type: 'movie', name: 'Dune: Part Two', year: 2024 },
  { imdbId: 'tt1745960', type: 'movie', name: 'Top Gun: Maverick', year: 2022 },
  { imdbId: 'tt1877830', type: 'movie', name: 'The Batman', year: 2022 },
  { imdbId: 'tt9362722', type: 'movie', name: 'Spider-Man: Across the Spider-Verse', year: 2023 },
  { imdbId: 'tt4154796', type: 'movie', name: 'Avengers: Endgame', year: 2019 },
  { imdbId: 'tt4154756', type: 'movie', name: 'Avengers: Infinity War', year: 2018 },
  { imdbId: 'tt7286456', type: 'movie', name: 'Joker', year: 2019 },
  { imdbId: 'tt6751668', type: 'movie', name: 'Parasite', year: 2019 },
  { imdbId: 'tt8579674', type: 'movie', name: '1917', year: 2019 },
  { imdbId: 'tt1856101', type: 'movie', name: 'Blade Runner 2049', year: 2017 },
  { imdbId: 'tt1392190', type: 'movie', name: 'Mad Max: Fury Road', year: 2015 },
  { imdbId: 'tt0816692', type: 'movie', name: 'Interstellar', year: 2014 },
  { imdbId: 'tt1375666', type: 'movie', name: 'Inception', year: 2010 },
  { imdbId: 'tt0468569', type: 'movie', name: 'The Dark Knight', year: 2008 },
  { imdbId: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 },
  { imdbId: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption', year: 1994 },
  { imdbId: 'tt0110912', type: 'movie', name: 'Pulp Fiction', year: 1994 },
  { imdbId: 'tt0109830', type: 'movie', name: 'Forrest Gump', year: 1994 },
  { imdbId: 'tt0137523', type: 'movie', name: 'Fight Club', year: 1999 },
  { imdbId: 'tt0120737', type: 'movie', name: 'The Lord of the Rings: The Fellowship of the Ring', year: 2001 },
  { imdbId: 'tt0167260', type: 'movie', name: 'The Lord of the Rings: The Return of the King', year: 2003 },
  { imdbId: 'tt0068646', type: 'movie', name: 'The Godfather', year: 1972 },
  { imdbId: 'tt0099685', type: 'movie', name: 'GoodFellas', year: 1990 },
  { imdbId: 'tt0114369', type: 'movie', name: 'Se7en', year: 1995 },
  { imdbId: 'tt0172495', type: 'movie', name: 'Gladiator', year: 2000 },
  { imdbId: 'tt0407887', type: 'movie', name: 'The Departed', year: 2006 },
  { imdbId: 'tt0482571', type: 'movie', name: 'The Prestige', year: 2006 },
  { imdbId: 'tt2582802', type: 'movie', name: 'Whiplash', year: 2014 },
  { imdbId: 'tt4633694', type: 'movie', name: 'Spider-Man: Into the Spider-Verse', year: 2018 },
  { imdbId: 'tt1160419', type: 'movie', name: 'Dune', year: 2021 },
  { imdbId: 'tt6710474', type: 'movie', name: 'Everything Everywhere All at Once', year: 2022 },
  { imdbId: 'tt1517268', type: 'movie', name: 'Barbie', year: 2023 },
  { imdbId: 'tt12037194', type: 'movie', name: 'Furiosa: A Mad Max Saga', year: 2024 },
  { imdbId: 'tt6263850', type: 'movie', name: 'Deadpool & Wolverine', year: 2024 },
  // Series populares (serie completa: todas las temporadas y episodios)
  { imdbId: 'tt33539520', type: 'series', name: 'Neagley', year: 2026 },
  { imdbId: 'tt26545992', type: 'series', name: 'Lanterns', year: 2026 },
  { imdbId: 'tt0944947', type: 'series', name: 'Game of Thrones', year: 2011 },
  { imdbId: 'tt0903747', type: 'series', name: 'Breaking Bad', year: 2008 },
  { imdbId: 'tt4574334', type: 'series', name: 'Stranger Things', year: 2016 },
  { imdbId: 'tt7366338', type: 'series', name: 'Chernobyl', year: 2019 },
  { imdbId: 'tt3581920', type: 'series', name: 'The Last of Us', year: 2023 },
  { imdbId: 'tt11198330', type: 'series', name: 'House of the Dragon', year: 2022 },
  { imdbId: 'tt12637874', type: 'series', name: 'Fallout', year: 2024 },
  { imdbId: 'tt2788316', type: 'series', name: 'Shogun', year: 2024 },
  { imdbId: 'tt1190634', type: 'series', name: 'The Boys', year: 2019 },
  { imdbId: 'tt8111088', type: 'series', name: 'The Mandalorian', year: 2019 },
  { imdbId: 'tt3032476', type: 'series', name: 'Better Call Saul', year: 2015 },
  { imdbId: 'tt2861424', type: 'series', name: 'Rick and Morty', year: 2013 },
]);

function normalizeCatalogMeta(raw, fallbackType = 'movie', { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const imdbId = String(raw.imdb_id || raw.id || '').toLowerCase().trim();
  if (!IMDB_ID_RE.test(imdbId)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const type = raw.type === 'series' || fallbackType === 'series' ? 'series' : 'movie';
  const yearMatch = String(raw.year || raw.releaseInfo || '').match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const currentYear = new Date(now).getUTCFullYear();
  if (year && year > currentYear) return null;
  if (raw.released) {
    const releasedMs = Date.parse(raw.released);
    if (Number.isFinite(releasedMs) && releasedMs > now + DAY_MS) return null;
  }
  if (type === 'series') {
    // Serie completa: sin temporada ni episodio, la ingesta expande TODAS
    // las temporadas y episodios emitidos de una sola vez (Cinemeta).
    return {
      imdbId,
      ...(raw.tmdbId != null ? { tmdbId: Number(raw.tmdbId) } : {}),
      type: 'series',
      season: null,
      episode: null,
      name,
      year,
      label: name,
    };
  }
  return {
    imdbId,
    ...(raw.tmdbId != null ? { tmdbId: Number(raw.tmdbId) } : {}),
    type: 'movie',
    season: null,
    episode: null,
    name,
    year,
    label: year ? `${name} (${year})` : name,
  };
}

const TMDB_MOVIE_FEEDS = Object.freeze([
  '/trending/movie/week',
  '/movie/popular',
  '/movie/now_playing',
  '/movie/top_rated',
]);

const TMDB_SERIES_FEEDS = Object.freeze([
  '/trending/tv/week',
  '/tv/popular',
  '/tv/top_rated',
]);

/**
 * Descubre películas y series desde TMDB (cuando hay TMDB_API_KEY) y resuelve
 * su IMDb ID (`tt...`) mediante `/external_ids`.
 */
export async function discoverFromTmdb(fetchJSON, {
  apiKey = '',
  seen = createSeenStore(),
  movieCount = 8,
  seriesCount = 2,
  cursor = 0,
  now = Date.now(),
  onWarning = null,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key || typeof fetchJSON !== 'function') return { movies: [], series: [] };

  const movies = [];
  const series = [];
  const batchIds = new Set();
  const batchTitles = new Set();
  const page = (cursor % 5) + 1;

  const tryFeed = async (kind, feeds, target, bucket) => {
    for (let i = 0; i < feeds.length && bucket.length < target; i++) {
      const feed = feeds[(cursor + i) % feeds.length];
      const url = `https://api.themoviedb.org/3${feed}?api_key=${encodeURIComponent(key)}&language=es-ES&page=${page}`;
      let list;
      try {
        const data = await fetchJSON(url, { timeout: 10000, retries: 1 });
        list = data?.results || [];
      } catch (err) {
        onWarning?.(`TMDB (${feed}): ${err.message || err}`);
        continue;
      }
      for (const entry of list) {
        if (bucket.length >= target) break;
        if (!entry?.id) continue;
        const rawTitle = entry.title || entry.name || entry.original_title || entry.original_name || '';
        const normTitle = normalizeTitleKey(rawTitle);
        if (!normTitle || batchTitles.has(normTitle) || seen.titles.has(normTitle)) continue;
        const releaseDate = entry.release_date || entry.first_air_date || null;
        if (releaseDate && Date.parse(releaseDate) > now + DAY_MS) continue;
        try {
          const extUrl = `https://api.themoviedb.org/3/${kind}/${entry.id}/external_ids?api_key=${encodeURIComponent(key)}`;
          const ext = await fetchJSON(extUrl, { timeout: 8000, retries: 1 });
          const imdbId = String(ext?.imdb_id || '').toLowerCase().trim();
          if (!IMDB_ID_RE.test(imdbId) || batchIds.has(imdbId)) continue;
          const item = normalizeCatalogMeta({
            imdb_id: imdbId,
            tmdbId: entry.id,
            name: rawTitle,
            type: kind === 'tv' ? 'series' : 'movie',
            year: releaseDate ? releaseDate.slice(0, 4) : null,
            released: releaseDate,
          }, kind === 'tv' ? 'series' : 'movie', { now });
          if (!item || seen.hasItem(item)) continue;
          batchIds.add(item.imdbId);
          batchTitles.add(normTitle);
          bucket.push(item);
        } catch {
          // Si un ID de TMDB no tiene external_ids, pasamos al siguiente.
        }
      }
    }
  };

  if (movieCount > 0) await tryFeed('movie', TMDB_MOVIE_FEEDS, movieCount, movies);
  if (seriesCount > 0) await tryFeed('tv', TMDB_SERIES_FEEDS, seriesCount, series);
  return { movies, series };
}

/**
 * Descubre títulos nuevos (películas y series) que NO estén en `seen`.
 * Si hay `tmdbApiKey` consulta primero TMDB; después los catálogos públicos de
 * Cinemeta rotando según `seen.cursor` y por último `FALLBACK_DISCOVERY_POOL`.
 */
export async function discoverCatalogItems(fetchJSON, {
  seen = createSeenStore(),
  count = DEFAULT_BATCH_SIZE,
  movieCount = null,
  seriesCount = null,
  tmdbApiKey = '',
  baseUrl = CINEMETA_URL,
  now = Date.now(),
  onWarning = null,
} = {}) {
  const total = Math.max(1, Number(count) || DEFAULT_BATCH_SIZE);
  const targetSeries = seriesCount != null
    ? Math.max(0, Number(seriesCount))
    : (total >= 2 ? Math.max(1, Math.round(total * 0.2)) : 0);
  const targetMovies = movieCount != null
    ? Math.max(0, Number(movieCount))
    : Math.max(0, total - targetSeries);

  const pickedMovies = [];
  const pickedSeries = [];
  const batchIds = new Set();
  const batchTitles = new Set();

  const canPick = candidate => {
    if (!candidate) return false;
    if (batchIds.has(candidate.imdbId)) return false;
    const normTitle = normalizeTitleKey(candidate.name || candidate.label);
    if (normTitle && batchTitles.has(normTitle)) return false;
    if (seen.hasItem(candidate)) return false;
    return true;
  };

  const recordPick = (candidate, bucket) => {
    batchIds.add(candidate.imdbId);
    const normTitle = normalizeTitleKey(candidate.name || candidate.label);
    if (normTitle) batchTitles.add(normTitle);
    bucket.push(candidate);
  };

  const root = String(baseUrl || CINEMETA_URL).replace(/\/+$/, '');
  const cursor = seen.cursor || 0;

  if (tmdbApiKey && typeof fetchJSON === 'function') {
    const fromTmdb = await discoverFromTmdb(fetchJSON, {
      apiKey: tmdbApiKey,
      seen,
      movieCount: targetMovies,
      seriesCount: targetSeries,
      cursor,
      now,
      onWarning,
    });
    for (const m of fromTmdb.movies) if (canPick(m) && pickedMovies.length < targetMovies) recordPick(m, pickedMovies);
    for (const s of fromTmdb.series) if (canPick(s) && pickedSeries.length < targetSeries) recordPick(s, pickedSeries);
  }

  if (typeof fetchJSON === 'function') {
    // Películas desde catálogos rotativos
    for (let i = 0; i < MOVIE_CATALOG_PATHS.length && pickedMovies.length < targetMovies; i++) {
      const path = MOVIE_CATALOG_PATHS[(cursor + i) % MOVIE_CATALOG_PATHS.length];
      try {
        const data = await fetchJSON(`${root}${path}`, { timeout: 10000, retries: 1 });
        for (const raw of data?.metas || []) {
          if (pickedMovies.length >= targetMovies) break;
          const item = normalizeCatalogMeta(raw, 'movie', { now });
          if (canPick(item)) recordPick(item, pickedMovies);
        }
      } catch (err) {
        onWarning?.(`Catálogo Cinemeta (${path}): ${err.message || err}`);
      }
    }

    // Series desde catálogos rotativos
    for (let i = 0; i < SERIES_CATALOG_PATHS.length && pickedSeries.length < targetSeries; i++) {
      const path = SERIES_CATALOG_PATHS[(cursor + i) % SERIES_CATALOG_PATHS.length];
      try {
        const data = await fetchJSON(`${root}${path}`, { timeout: 10000, retries: 1 });
        for (const raw of data?.metas || []) {
          if (pickedSeries.length >= targetSeries) break;
          const item = normalizeCatalogMeta(raw, 'series', { now });
          if (canPick(item)) recordPick(item, pickedSeries);
        }
      } catch (err) {
        onWarning?.(`Catálogo Cinemeta (${path}): ${err.message || err}`);
      }
    }
  }

  // Respaldo con el pool integrado si Cinemeta no devolvió suficientes títulos nuevos.
  if (pickedMovies.length < targetMovies || pickedSeries.length < targetSeries) {
    const poolLen = FALLBACK_DISCOVERY_POOL.length;
    for (let i = 0; i < poolLen; i++) {
      const raw = FALLBACK_DISCOVERY_POOL[(cursor + i) % poolLen];
      const item = normalizeCatalogMeta({ ...raw, imdb_id: raw.imdbId }, raw.type, { now });
      if (!canPick(item)) continue;
      if (item.type === 'movie' && pickedMovies.length < targetMovies) {
        recordPick(item, pickedMovies);
      } else if (item.type === 'series' && pickedSeries.length < targetSeries) {
        recordPick(item, pickedSeries);
      }
      if (pickedMovies.length >= targetMovies && pickedSeries.length >= targetSeries) break;
    }
  }

  seen.cursor = cursor + 1;
  return [...pickedMovies, ...pickedSeries];
}

/**
 * Actualiza el texto de `watchlist.txt`:
 *  1) Elimina todas las entradas que ya estén en `seen` (anteriores o ya en BD)
 *     y elimina cualquier ID o nombre duplicado.
 *  2) Si `autoDiscover` está activo (o si tras limpiar anteriores la lista
 *     queda con menos de `batchSize` títulos), rellena con títulos nuevos de
 *     Cinemeta / respaldo asegurando variedad (películas + series) sin repetir.
 */
export async function rotateWatchlist(currentText, {
  seen = createSeenStore(),
  fetchJSON = null,
  autoDiscover = true,
  replaceAll = false,
  batchSize = DEFAULT_BATCH_SIZE,
  tmdbApiKey = '',
  baseUrl = CINEMETA_URL,
  now = Date.now(),
  onWarning = null,
} = {}) {
  const targetSize = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
  const currentItems = parseWatchlist(currentText);
  const removedItems = [];
  const keptItems = [];
  const batchIds = new Set();
  const batchTitles = new Set();

  for (const item of currentItems) {
    const id = item.imdbId.toLowerCase();
    const normTitle = normalizeTitleKey(item.label || item.name);
    const isDuplicateInBatch = batchIds.has(id) || (normTitle && batchTitles.has(normTitle));
    if (replaceAll || isDuplicateInBatch || seen.hasItem(item)) {
      seen.addItem(item);
      removedItems.push(item);
      continue;
    }
    batchIds.add(id);
    if (normTitle) batchTitles.add(normTitle);
    keptItems.push(item);
  }

  let addedItems = [];
  if (autoDiscover && keptItems.length < targetSize) {
    const needed = targetSize - keptItems.length;
    const hasSeries = keptItems.some(i => i.type === 'series');
    const hasMovies = keptItems.some(i => i.type === 'movie');
    let seriesCount = targetSize >= 2 ? Math.max(1, Math.round(needed * 0.2)) : 0;
    if (hasSeries && needed === 1 && !hasMovies) seriesCount = 0;
    if (!hasSeries && targetSize >= 2 && seriesCount === 0) seriesCount = 1;
    const movieCount = Math.max(0, needed - seriesCount);

    // Creamos una vista temporal de `seen` que también incluye los `keptItems`
    // para que `discoverCatalogItems` no los duplique.
    const tempSeen = createSeenStore(seen.toJSON({ now }));
    for (const item of keptItems) tempSeen.addItem(item);

    addedItems = await discoverCatalogItems(fetchJSON, {
      seen: tempSeen,
      count: needed,
      movieCount,
      seriesCount,
      tmdbApiKey,
      baseUrl,
      now,
      onWarning,
    });
    seen.cursor = tempSeen.cursor;
  }

  const finalItems = [...keptItems, ...addedItems];
  const text = formatWatchlistFile(finalItems, {
    date: new Date(now),
    removedCount: removedItems.length,
    addedCount: addedItems.length,
  });

  return {
    text,
    items: finalItems,
    removedItems,
    keptItems,
    addedItems,
    removedCount: removedItems.length,
    keptCount: keptItems.length,
    addedCount: addedItems.length,
  };
}

/**
 * Filtra los resultados de la pipeline para persistir en Supabase SOLO los 2
 * picks elegidos por título (1 🇪🇸 + 1 🇬🇧), descartando hashes o nombres de
 * torrents ya vistos o repetidos.
 */
export function selectUniqueDbCandidates(results, { seen = null } = {}) {
  const dbCandidates = [];
  const usedHashes = new Set();
  const usedReleaseTitles = new Set();
  let skippedSeen = 0;
  let skippedDuplicates = 0;

  for (const { item, streams = [] } of results || []) {
    for (const stream of streams) {
      const hash = String(stream?.infoHash || '').toLowerCase().trim();
      if (!HEX_40_RE.test(hash)) continue;
      if (seen?.hasHash?.(hash)) {
        skippedSeen++;
        continue;
      }
      if (usedHashes.has(hash)) {
        skippedDuplicates++;
        continue;
      }
      const releaseKey = `${item.id || item.imdbId}|${normalizeTitleKey(stream.title) || hash}`;
      if (usedReleaseTitles.has(releaseKey)) {
        skippedDuplicates++;
        continue;
      }
      usedHashes.add(hash);
      usedReleaseTitles.add(releaseKey);
      dbCandidates.push({ item, stream });
    }
  }

  return { dbCandidates, skippedSeen, skippedDuplicates };
}
