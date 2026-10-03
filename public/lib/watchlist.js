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

export const MAX_BATCH_SIZE = 1000;
export const DEFAULT_BATCH_SIZE = MAX_BATCH_SIZE;

function boundedBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(parsed)));
}

/** Páginas de catálogo que se prueban por género prioritario y ejecución. */
const FOCUS_MAX_REQUESTS = 4;

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

function isSeriesEntry(item) {
  return Boolean(item && (item.type === 'series' || item.typeHint === 'series' || item.season != null));
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

  if (isSeriesEntry(item)) {
    // Serie sin temporada: el ID solo basta; la ingesta la expande a TODAS
    // las temporadas y episodios emitidos de una sola vez.
    if (!Number.isInteger(season)) {
      const label = baseName || item.label || '';
      return `${id}${label ? ' ' + label : ''}${discoveryTag(item)}`;
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
  return `${id}${label ? ' ' + label : ''}${discoveryTag(item)}`;
}

/** "  # Anime" cuando el título salió de un género prioritario del descubrimiento. */
function discoveryTag(item) {
  const tag = String(item?.discovery || '').replace(/[#\r\n`]/g, '').trim();
  return tag ? `  # ${tag}` : '';
}

/** Genera el contenido completo de `watchlist.txt` con cabecera informativa. */
export function formatWatchlistFile(items, { date = new Date(), removedCount = 0, addedCount = 0 } = {}) {
  const stamp = (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const movies = items.filter(i => !isSeriesEntry(i));
  const series = items.filter(isSeriesEntry);
  const lines = [
    '# Peerflix Static – Watchlist',
    '# -----------------------------------------------------------',
    `# Actualizado automáticamente el ${stamp}` +
      (removedCount || addedCount ? ` (${addedCount} nuevos · ${removedCount} anteriores eliminados).` : '.'),
    '# En cada ejecución de la Action se eliminan los títulos ya procesados',
    '# y se cargan películas y series nuevas (1935–2099) para no repetir torrents ni nombres.',
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

// ---------- Descubrimiento automático desde catálogos de Cinemeta (1935–2099) ----------

export const MIN_SEARCH_YEAR = 1935;
export const MAX_SEARCH_YEAR = 2099;
export const SEARCH_YEAR_RANGE = Object.freeze({ min: MIN_SEARCH_YEAR, max: MAX_SEARCH_YEAR });

/**
 * Construye la lista completa de años de búsqueda entre `minYear` (1935) y
 * `maxYear` (2099), intercalando décadas desde 1935 hasta `pivotYear` para que
 * cada lote combine cine clásico, moderno y estrenos recientes en lugar de
 * concentrarse solo en 2026/2025, seguido de los años futuros hasta 2099.
 */
export function buildSearchYears({
  minYear = MIN_SEARCH_YEAR,
  maxYear = MAX_SEARCH_YEAR,
  pivotYear = 2026,
} = {}) {
  const clampPivot = Math.min(maxYear, Math.max(minYear, pivotYear));
  const decades = new Map();
  for (let y = clampPivot; y >= minYear; y--) {
    const decade = Math.floor(y / 10) * 10;
    if (!decades.has(decade)) decades.set(decade, []);
    decades.get(decade).push(y);
  }
  const buckets = [...decades.values()];
  const interleaved = [];
  let added = true;
  while (added) {
    added = false;
    for (const bucket of buckets) {
      if (bucket.length) {
        interleaved.push(bucket.shift());
        added = true;
      }
    }
  }
  for (let y = clampPivot + 1; y <= maxYear; y++) {
    interleaved.push(y);
  }
  return interleaved;
}

export const SEARCH_YEARS = Object.freeze(buildSearchYears());

/** Géneros de los catálogos `top`/`imdbRating` de Cinemeta. */
export const CINEMETA_GENRES = Object.freeze({
  movie: Object.freeze([
    'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family',
    'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western',
  ]),
  // Talk-Show y Game-Show se omiten: programas diarios con miles de episodios.
  series: Object.freeze([
    'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family',
    'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western',
    'Reality-TV',
  ]),
});

/**
 * Genera las rutas de catálogo de Cinemeta para `movie` o `series` cubriendo
 * todos los años de 1935 a 2099 (`/catalog/{kind}/year/genre={año}.json`)
 * junto con los listados `top` e `imdbRating` paginados y los de cada género.
 */
export function buildCatalogPaths(kind = 'movie', {
  minYear = MIN_SEARCH_YEAR,
  maxYear = MAX_SEARCH_YEAR,
  pivotYear = 2026,
} = {}) {
  const years = buildSearchYears({ minYear, maxYear, pivotYear });
  const ranked = [
    `/catalog/${kind}/top.json`,
    `/catalog/${kind}/imdbRating.json`,
    `/catalog/${kind}/top/skip=100.json`,
    `/catalog/${kind}/imdbRating/skip=100.json`,
    `/catalog/${kind}/top/skip=200.json`,
    `/catalog/${kind}/imdbRating/skip=200.json`,
    `/catalog/${kind}/top/skip=300.json`,
    `/catalog/${kind}/imdbRating/skip=300.json`,
    `/catalog/${kind}/top/skip=400.json`,
    `/catalog/${kind}/imdbRating/skip=400.json`,
    `/catalog/${kind}/top/skip=500.json`,
  ];
  // "Y más": cada género de Cinemeta (Animation, Documentary, Horror, Sci-Fi…)
  // en sus listados Popular y Featured, intercalado con los rankings generales.
  const byGenre = (CINEMETA_GENRES[kind] || CINEMETA_GENRES.movie).flatMap(genre => [
    `/catalog/${kind}/top/genre=${encodeURIComponent(genre)}.json`,
    `/catalog/${kind}/imdbRating/genre=${encodeURIComponent(genre)}.json`,
  ]);
  const general = [];
  for (let i = 0; i < Math.max(ranked.length, byGenre.length); i++) {
    if (i < ranked.length) general.push(ranked[i]);
    if (2 * i < byGenre.length) general.push(byGenre[2 * i]);
    if (2 * i + 1 < byGenre.length) general.push(byGenre[2 * i + 1]);
  }
  // Se reparten entre los años para que cada ejecución toque varios géneros.
  const step = Math.max(1, Math.floor(years.length / general.length));
  const paths = [];
  let gIdx = 0;
  for (let i = 0; i < years.length; i++) {
    if (i % step === 0 && gIdx < general.length) {
      paths.push(general[gIdx++]);
    }
    paths.push(`/catalog/${kind}/year/genre=${years[i]}.json`);
  }
  while (gIdx < general.length) paths.push(general[gIdx++]);
  return Object.freeze(paths);
}

export const MOVIE_CATALOG_PATHS = buildCatalogPaths('movie');
export const SERIES_CATALOG_PATHS = buildCatalogPaths('series');

// ---------- géneros prioritarios: anime, documentales… ----------

const isJapanese = meta => /\bjapan\b/i.test(Array.isArray(meta?.country) ? meta.country.join(', ') : String(meta?.country || ''));

/**
 * Géneros a los que cada lote del descubrimiento reserva hueco. Cinemeta no
 * tiene género "Anime": es `Animation` con país Japón.
 */
export const FOCUS_GENRES = Object.freeze([
  Object.freeze({ id: 'anime', label: 'Anime', genre: 'Animation', match: isJapanese, tmdb: 'with_genres=16&with_original_language=ja' }),
  Object.freeze({ id: 'documentary', label: 'Documental', genre: 'Documentary', tmdb: 'with_genres=99' }),
]);
export const DEFAULT_FOCUS_GENRE_IDS = Object.freeze(FOCUS_GENRES.map(g => g.id));

const GENRE_ALIASES = new Map([
  ['anime', 'anime'], ['animes', 'anime'],
  ['documentary', 'documentary'], ['documental', 'documentary'], ['documentales', 'documentary'], ['docs', 'documentary'],
  ['animacion', 'Animation'], ['animación', 'Animation'], ['dibujos', 'Animation'],
  ['terror', 'Horror'], ['comedia', 'Comedy'], ['familia', 'Family'], ['familiar', 'Family'], ['infantil', 'Family'],
  ['ciencia-ficcion', 'Sci-Fi'], ['ciencia ficcion', 'Sci-Fi'], ['ciencia ficción', 'Sci-Fi'], ['scifi', 'Sci-Fi'],
  ['fantasia', 'Fantasy'], ['fantasía', 'Fantasy'], ['historia', 'History'], ['biografia', 'Biography'], ['biografía', 'Biography'],
  ['deporte', 'Sport'], ['deportes', 'Sport'], ['guerra', 'War'], ['accion', 'Action'], ['acción', 'Action'],
  ['aventura', 'Adventure'], ['crimen', 'Crime'], ['misterio', 'Mystery'], ['romance', 'Romance'], ['romantica', 'Romance'],
  ['suspenso', 'Thriller'], ['suspense', 'Thriller'], ['drama', 'Drama'], ['reality', 'Reality-TV'],
]);

/**
 * "anime,documentales,terror" → géneros prioritarios. Vacío/ausente = anime +
 * documentales; "0"/"no"/"none" = ninguno. Acepta cualquier género de
 * Cinemeta y alias en español.
 */
export function resolveFocusGenres(raw) {
  if (raw == null) return [...FOCUS_GENRES];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  // Ya resueltos (p. ej. FOCUS_GENRES): se aceptan tal cual.
  if (list.length && list.every(v => v && typeof v === 'object' && v.genre)) return [...list];
  const cleaned = list.map(v => String(v?.id ?? v ?? '').trim()).filter(Boolean);
  if (!cleaned.length) return [...FOCUS_GENRES];
  if (cleaned.length === 1 && /^(?:0|no|none|ninguno|false|off)$/i.test(cleaned[0])) return [];
  const known = new Map([...CINEMETA_GENRES.series].map(g => [g.toLowerCase(), g]));
  const out = [];
  for (const value of cleaned) {
    const alias = GENRE_ALIASES.get(value.toLowerCase()) ?? known.get(value.toLowerCase()) ?? null;
    if (!alias) continue;
    const focus = FOCUS_GENRES.find(g => g.id === alias)
      ?? FOCUS_GENRES.find(g => !g.match && g.genre === alias)
      ?? { id: alias.toLowerCase(), label: alias, genre: alias };
    if (!out.some(g => g.id === focus.id)) out.push(focus);
  }
  return out;
}

/** Popular y Featured de un género, paginados (0–500). */
export function focusCatalogPaths(kind, genre) {
  const g = encodeURIComponent(genre);
  const paths = [];
  for (let skip = 0; skip <= 500; skip += 100) {
    for (const id of ['top', 'imdbRating']) {
      paths.push(skip ? `/catalog/${kind}/${id}/genre=${g}&skip=${skip}.json` : `/catalog/${kind}/${id}/genre=${g}.json`);
    }
  }
  return paths;
}

/**
 * Cuántos huecos del lote van a géneros prioritarios: la mitad (1 por género)
 * y, si el lote es de 1 (la serie a seguir), se alterna con un título general.
 */
export function focusQuota(target, genreCount, cursor = 0) {
  if (target <= 0 || genreCount <= 0) return 0;
  if (target === 1) return (cursor % (genreCount + 1)) < genreCount ? 1 : 0;
  return Math.min(genreCount, Math.floor(target / 2));
}

/**
 * Pool integrado de respaldo (películas y series reales de 1935 en adelante con
 * torrents activos) por si Cinemeta no responde o se ejecuta sin red.
 */
export const FALLBACK_DISCOVERY_POOL = Object.freeze([
  // Intercalado por décadas desde 1935 hasta la actualidad
  { imdbId: 'tt15398776', type: 'movie', name: 'Oppenheimer', year: 2023 },
  { imdbId: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption', year: 1994 },
  { imdbId: 'tt0068646', type: 'movie', name: 'The Godfather', year: 1972 },
  { imdbId: 'tt0026029', type: 'movie', name: 'The 39 Steps', year: 1935 },
  { imdbId: 'tt1375666', type: 'movie', name: 'Inception', year: 2010 },
  { imdbId: 'tt0034583', type: 'movie', name: 'Casablanca', year: 1942 },
  { imdbId: 'tt0088763', type: 'movie', name: 'Back to the Future', year: 1985 },
  { imdbId: 'tt0050083', type: 'movie', name: '12 Angry Men', year: 1957 },
  { imdbId: 'tt0468569', type: 'movie', name: 'The Dark Knight', year: 2008 },
  { imdbId: 'tt0060196', type: 'movie', name: 'The Good, the Bad and the Ugly', year: 1966 },
  { imdbId: 'tt15239678', type: 'movie', name: 'Dune: Part Two', year: 2024 },
  { imdbId: 'tt0026138', type: 'movie', name: 'Bride of Frankenstein', year: 1935 },
  { imdbId: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 },
  { imdbId: 'tt0047478', type: 'movie', name: 'Seven Samurai', year: 1954 },
  { imdbId: 'tt0816692', type: 'movie', name: 'Interstellar', year: 2014 },
  { imdbId: 'tt0032138', type: 'movie', name: 'The Wizard of Oz', year: 1939 },
  { imdbId: 'tt0078748', type: 'movie', name: 'Alien', year: 1979 },
  { imdbId: 'tt0120737', type: 'movie', name: 'The Lord of the Rings: The Fellowship of the Ring', year: 2001 },
  { imdbId: 'tt0054215', type: 'movie', name: 'Psycho', year: 1960 },
  { imdbId: 'tt0081505', type: 'movie', name: 'The Shining', year: 1980 },
  { imdbId: 'tt0033467', type: 'movie', name: 'Citizen Kane', year: 1941 },
  { imdbId: 'tt6751668', type: 'movie', name: 'Parasite', year: 2019 },
  { imdbId: 'tt0110912', type: 'movie', name: 'Pulp Fiction', year: 1994 },
  { imdbId: 'tt0047396', type: 'movie', name: 'Rear Window', year: 1954 },
  { imdbId: 'tt1745960', type: 'movie', name: 'Top Gun: Maverick', year: 2022 },
  { imdbId: 'tt0109830', type: 'movie', name: 'Forrest Gump', year: 1994 },
  { imdbId: 'tt0137523', type: 'movie', name: 'Fight Club', year: 1999 },
  { imdbId: 'tt0167260', type: 'movie', name: 'The Lord of the Rings: The Return of the King', year: 2003 },
  { imdbId: 'tt0099685', type: 'movie', name: 'GoodFellas', year: 1990 },
  { imdbId: 'tt0114369', type: 'movie', name: 'Se7en', year: 1995 },
  { imdbId: 'tt0172495', type: 'movie', name: 'Gladiator', year: 2000 },
  { imdbId: 'tt0407887', type: 'movie', name: 'The Departed', year: 2006 },
  { imdbId: 'tt0482571', type: 'movie', name: 'The Prestige', year: 2006 },
  { imdbId: 'tt2582802', type: 'movie', name: 'Whiplash', year: 2014 },
  { imdbId: 'tt1392190', type: 'movie', name: 'Mad Max: Fury Road', year: 2015 },
  { imdbId: 'tt1856101', type: 'movie', name: 'Blade Runner 2049', year: 2017 },
  { imdbId: 'tt4633694', type: 'movie', name: 'Spider-Man: Into the Spider-Verse', year: 2018 },
  { imdbId: 'tt4154756', type: 'movie', name: 'Avengers: Infinity War', year: 2018 },
  { imdbId: 'tt4154796', type: 'movie', name: 'Avengers: Endgame', year: 2019 },
  { imdbId: 'tt7286456', type: 'movie', name: 'Joker', year: 2019 },
  { imdbId: 'tt8579674', type: 'movie', name: '1917', year: 2019 },
  { imdbId: 'tt1160419', type: 'movie', name: 'Dune', year: 2021 },
  { imdbId: 'tt1877830', type: 'movie', name: 'The Batman', year: 2022 },
  { imdbId: 'tt6710474', type: 'movie', name: 'Everything Everywhere All at Once', year: 2022 },
  { imdbId: 'tt9362722', type: 'movie', name: 'Spider-Man: Across the Spider-Verse', year: 2023 },
  { imdbId: 'tt1517268', type: 'movie', name: 'Barbie', year: 2023 },
  { imdbId: 'tt12037194', type: 'movie', name: 'Furiosa: A Mad Max Saga', year: 2024 },
  { imdbId: 'tt6263850', type: 'movie', name: 'Deadpool & Wolverine', year: 2024 },
  { imdbId: 'tt27165187', type: 'movie', name: 'The End of Oak Street', year: 2026 },
  { imdbId: 'tt37287335', type: 'movie', name: 'Obsession', year: 2026 },
  { imdbId: 'tt28014327', type: 'movie', name: 'Mayday', year: 2026 },
  { imdbId: 'tt34206385', type: 'movie', name: 'Primetime', year: 2026 },
  { imdbId: 'tt35298123', type: 'movie', name: 'Teenage Sex and Death at Camp Miasma', year: 2026 },
  // Series populares de distintas décadas (serie completa: todas las temporadas y episodios)
  { imdbId: 'tt0944947', type: 'series', name: 'Game of Thrones', year: 2011 },
  { imdbId: 'tt0903747', type: 'series', name: 'Breaking Bad', year: 2008 },
  { imdbId: 'tt0108778', type: 'series', name: 'Friends', year: 1994 },
  { imdbId: 'tt0141842', type: 'series', name: 'The Sopranos', year: 1999 },
  { imdbId: 'tt0052520', type: 'series', name: 'The Twilight Zone', year: 1959 },
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
  { imdbId: 'tt33539520', type: 'series', name: 'Neagley', year: 2026 },
  { imdbId: 'tt26545992', type: 'series', name: 'Lanterns', year: 2026 },
]);

function normalizeCatalogMeta(raw, fallbackType = 'movie', {
  now = Date.now(),
  minYear = MIN_SEARCH_YEAR,
  maxYear = MAX_SEARCH_YEAR,
} = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const imdbId = String(raw.imdb_id || raw.id || '').toLowerCase().trim();
  if (!IMDB_ID_RE.test(imdbId)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const type = raw.type === 'series' || fallbackType === 'series' ? 'series' : 'movie';
  const yearMatch = String(raw.year || raw.releaseInfo || '').match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  if (year != null && (year < minYear || year > maxYear)) return null;
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
  ...FOCUS_GENRES.map(g => `/discover/movie?sort_by=popularity.desc&${g.tmdb}`),
  '/movie/top_rated',
  '/movie/popular',
  '/movie/now_playing',
  ...SEARCH_YEARS.map(y => `/discover/movie?sort_by=popularity.desc&primary_release_date.gte=${MIN_SEARCH_YEAR}-01-01&primary_release_date.lte=${MAX_SEARCH_YEAR}-12-31&primary_release_year=${y}`),
]);

const TMDB_SERIES_FEEDS = Object.freeze([
  '/trending/tv/week',
  ...FOCUS_GENRES.map(g => `/discover/tv?sort_by=popularity.desc&${g.tmdb}`),
  '/tv/top_rated',
  '/tv/popular',
  ...SEARCH_YEARS.map(y => `/discover/tv?sort_by=popularity.desc&first_air_date.gte=${MIN_SEARCH_YEAR}-01-01&first_air_date.lte=${MAX_SEARCH_YEAR}-12-31&first_air_date_year=${y}`),
]);

/**
 * Descubre películas y series desde TMDB (cuando hay TMDB_API_KEY) entre 1935
 * y 2099 y resuelve su IMDb ID (`tt...`) mediante `/external_ids`.
 */
export async function discoverFromTmdb(fetchJSON, {
  apiKey = '',
  seen = createSeenStore(),
  movieCount = 8,
  seriesCount = 2,
  cursor = 0,
  now = Date.now(),
  minYear = MIN_SEARCH_YEAR,
  maxYear = MAX_SEARCH_YEAR,
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
      const sep = feed.includes('?') ? '&' : '?';
      const url = `https://api.themoviedb.org/3${feed}${sep}api_key=${encodeURIComponent(key)}&language=es-ES&page=${page}`;
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
          }, kind === 'tv' ? 'series' : 'movie', { now, minYear, maxYear });
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

function orderCatalogPathsForCursor(paths, cursor, { now = Date.now(), minYear = MIN_SEARCH_YEAR, maxYear = MAX_SEARCH_YEAR } = {}) {
  const currentYear = new Date(now).getUTCFullYear();
  const activeMax = Math.min(maxYear, Math.max(minYear, currentYear + 1));
  const primary = [];
  const future = [];
  for (const path of paths) {
    const m = path.match(/genre=(\d{4})\.json$/);
    if (!m) {
      primary.push(path);
      continue;
    }
    const y = Number(m[1]);
    if (y < minYear || y > maxYear) continue;
    if (y <= activeMax) primary.push(path);
    else future.push(path);
  }
  const rotatedPrimary = primary.map((_, i) => primary[(cursor + i) % primary.length]);
  const rotatedFuture = future.map((_, i) => future[(cursor + i) % future.length]);
  return [...rotatedPrimary, ...rotatedFuture];
}

/**
 * Descubre títulos nuevos (películas y series entre 1935 y 2099) que NO estén en `seen`.
 * Si hay `tmdbApiKey` consulta primero TMDB; después los catálogos públicos de
 * Cinemeta rotando según `seen.cursor` (repartiendo entre varios años/décadas)
 * y por último `FALLBACK_DISCOVERY_POOL`.
 */
export async function discoverCatalogItems(fetchJSON, {
  seen = createSeenStore(),
  count = DEFAULT_BATCH_SIZE,
  movieCount = null,
  seriesCount = null,
  tmdbApiKey = '',
  baseUrl = CINEMETA_URL,
  now = Date.now(),
  minYear = MIN_SEARCH_YEAR,
  maxYear = MAX_SEARCH_YEAR,
  focusGenres = FOCUS_GENRES,
  onWarning = null,
} = {}) {
  const total = boundedBatchSize(count);
  const targetSeries = seriesCount != null
    ? Math.min(total, Math.max(0, Math.floor(Number(seriesCount) || 0)))
    : (total >= 2 ? Math.max(1, Math.round(total * 0.2)) : 0);
  const targetMovies = movieCount != null
    ? Math.min(total - targetSeries, Math.max(0, Math.floor(Number(movieCount) || 0)))
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
  const focus = resolveFocusGenres(focusGenres);

  // 1) Géneros prioritarios (anime, documentales…): 1 título por género, hasta
  //    la mitad del lote, rotando el género y la página en cada ejecución.
  if (focus.length && typeof fetchJSON === 'function') {
    const collectFocus = async (kind, target, bucket) => {
      const quota = focusQuota(target, focus.length, cursor);
      let taken = 0;
      for (let g = 0; g < focus.length && taken < quota && bucket.length < target; g++) {
        const genre = focus[(cursor + g) % focus.length];
        const paths = focusCatalogPaths(kind, genre.genre);
        for (let i = 0; i < FOCUS_MAX_REQUESTS && i < paths.length; i++) {
          const path = paths[(cursor + i) % paths.length];
          let data;
          try {
            data = await fetchJSON(`${root}${path}`, { timeout: 10000, retries: 1 });
          } catch (err) {
            onWarning?.(`Catálogo Cinemeta (${path}): ${err.message || err}`);
            continue;
          }
          const hit = (data?.metas || [])
            .filter(raw => !genre.match || genre.match(raw))
            .map(raw => normalizeCatalogMeta(raw, kind, { now, minYear, maxYear }))
            .find(canPick);
          if (hit) {
            recordPick({ ...hit, discovery: genre.label }, bucket);
            taken++;
            break;
          }
        }
      }
    };
    await collectFocus('movie', targetMovies, pickedMovies);
    await collectFocus('series', targetSeries, pickedSeries);
  }

  if (tmdbApiKey && typeof fetchJSON === 'function') {
    const fromTmdb = await discoverFromTmdb(fetchJSON, {
      apiKey: tmdbApiKey,
      seen,
      movieCount: targetMovies - pickedMovies.length,
      seriesCount: targetSeries - pickedSeries.length,
      cursor,
      now,
      minYear,
      maxYear,
      onWarning,
    });
    for (const m of fromTmdb.movies) if (canPick(m) && pickedMovies.length < targetMovies) recordPick(m, pickedMovies);
    for (const s of fromTmdb.series) if (canPick(s) && pickedSeries.length < targetSeries) recordPick(s, pickedSeries);
  }

  let visitedPaths = 0;
  if (typeof fetchJSON === 'function') {
    const collectFromCatalog = async (catalogPaths, kind, target, bucket) => {
      const needed = target - bucket.length;
      if (needed <= 0) return 0;
      const ordered = orderCatalogPathsForCursor(catalogPaths, cursor, { now, minYear, maxYear });
      // Cuando se piden más de 3 títulos, repartimos entre varios catálogos/años
      // (1935–2099) para no llenar todo el lote con un único año (p. ej. 2025/2026).
      const perCatalogCap = needed <= 3 ? needed : Math.max(2, Math.ceil(needed / 6));
      const maxRequests = needed <= 3
        ? ordered.length
        : Math.min(ordered.length, Math.max(10, Math.ceil(needed / perCatalogCap) + 4));
      const reserve = [];
      let requests = 0;

      for (let i = 0; i < ordered.length && bucket.length < target && requests < maxRequests; i++) {
        const path = ordered[i];
        requests++;
        try {
          const data = await fetchJSON(`${root}${path}`, { timeout: 10000, retries: 1 });
          let takenHere = 0;
          for (const raw of data?.metas || []) {
            const item = normalizeCatalogMeta(raw, kind, { now, minYear, maxYear });
            if (!canPick(item)) continue;
            if (takenHere < perCatalogCap && bucket.length < target) {
              recordPick(item, bucket);
              takenHere++;
            } else {
              reserve.push(item);
            }
          }
        } catch (err) {
          onWarning?.(`Catálogo Cinemeta (${path}): ${err.message || err}`);
        }
      }

      for (const item of reserve) {
        if (bucket.length >= target) break;
        if (canPick(item)) recordPick(item, bucket);
      }
      return requests;
    };

    const movieReqs = await collectFromCatalog(MOVIE_CATALOG_PATHS, 'movie', targetMovies, pickedMovies);
    const seriesReqs = await collectFromCatalog(SERIES_CATALOG_PATHS, 'series', targetSeries, pickedSeries);
    visitedPaths = Math.max(movieReqs, seriesReqs);
  }

  // Respaldo con el pool integrado si Cinemeta no devolvió suficientes títulos nuevos.
  if (pickedMovies.length < targetMovies || pickedSeries.length < targetSeries) {
    const poolLen = FALLBACK_DISCOVERY_POOL.length;
    for (let i = 0; i < poolLen; i++) {
      const raw = FALLBACK_DISCOVERY_POOL[(cursor + i) % poolLen];
      const item = normalizeCatalogMeta({ ...raw, imdb_id: raw.imdbId }, raw.type, { now, minYear, maxYear });
      if (!canPick(item)) continue;
      if (item.type === 'movie' && pickedMovies.length < targetMovies) {
        recordPick(item, pickedMovies);
      } else if (item.type === 'series' && pickedSeries.length < targetSeries) {
        recordPick(item, pickedSeries);
      }
      if (pickedMovies.length >= targetMovies && pickedSeries.length >= targetSeries) break;
    }
  }

  seen.cursor = cursor + Math.max(1, visitedPaths);
  return [...pickedMovies, ...pickedSeries];
}

/**
 * Actualiza el texto de `watchlist.txt`:
 *  1) Elimina todas las entradas que ya estén en `seen` (anteriores o ya en BD)
 *     y elimina cualquier ID o nombre duplicado. Con `keep(item)` (p. ej. una
 *     serie a la que aún le faltan episodios) la entrada se conserva aunque
 *     ya esté en el historial: así las series en progreso no se pierden.
 *  2) Si `autoDiscover` está activo (o si tras limpiar anteriores la lista
 *     queda con menos de `batchSize` títulos), rellena con títulos nuevos de
 *     Cinemeta / respaldo asegurando variedad (películas + series) sin repetir.
 */
export async function rotateWatchlist(currentText, {
  seen = createSeenStore(),
  fetchJSON = null,
  autoDiscover = true,
  replaceAll = false,
  keep = null,
  batchSize = DEFAULT_BATCH_SIZE,
  maxSeries = null,
  onlySeries = false,
  tmdbApiKey = '',
  baseUrl = CINEMETA_URL,
  now = Date.now(),
  minYear = MIN_SEARCH_YEAR,
  maxYear = MAX_SEARCH_YEAR,
  focusGenres = FOCUS_GENRES,
  onWarning = null,
} = {}) {
  const targetSize = onlySeries ? 1 : boundedBatchSize(batchSize);
  const currentItems = parseWatchlist(currentText);
  const removedItems = [];
  const keptItems = [];
  const batchIds = new Set();
  const batchTitles = new Set();

  for (const item of currentItems) {
    const id = item.imdbId.toLowerCase();
    const normTitle = normalizeTitleKey(item.label || item.name);
    const isDuplicateInBatch = batchIds.has(id) || (normTitle && batchTitles.has(normTitle));
    const mustKeep = !isDuplicateInBatch && typeof keep === 'function' && keep({ ...item, imdbId: id });
    if (!mustKeep && (onlySeries || replaceAll || isDuplicateInBatch || seen.hasItem(item))) {
      seen.addItem(item);
      removedItems.push(item);
      continue;
    }
    batchIds.add(id);
    if (normTitle) batchTitles.add(normTitle);
    keptItems.push(mustKeep ? { ...item, type: 'series' } : item);
  }

  let addedItems = [];
  if (autoDiscover && keptItems.length < targetSize) {
    const needed = targetSize - keptItems.length;
    const keptSeriesCount = keptItems.filter(isSeriesEntry).length;
    const hasSeries = keptSeriesCount > 0;
    const hasMovies = keptItems.some(i => !isSeriesEntry(i));
    let seriesCount;
    if (onlySeries) {
      seriesCount = needed;
    } else {
      seriesCount = targetSize >= 2 ? Math.max(1, Math.round(needed * 0.2)) : 0;
      if (hasSeries && needed === 1 && !hasMovies) seriesCount = 0;
      if (!hasSeries && targetSize >= 2 && seriesCount === 0) seriesCount = 1;
      if (Number.isInteger(maxSeries) && maxSeries >= 0) {
        seriesCount = Math.min(seriesCount, Math.max(0, maxSeries - keptSeriesCount));
      }
    }
    const movieCount = onlySeries ? 0 : Math.max(0, needed - seriesCount);

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
      minYear,
      maxYear,
      focusGenres,
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
