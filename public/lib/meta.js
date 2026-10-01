/**
 * Metadatos sin API key: Cinemeta, el addon oficial de metadatos de Stremio.
 *
 *   https://v3-cinemeta.strem.io/meta/{movie|series}/{imdbId}.json
 *
 * Sustituye a TMDB (que exigía TMDB_API_KEY) para:
 *  - expandir `tt…:s1` a todos los episodios emitidos de la temporada,
 *  - expandir un ID de serie sin temporada a TODAS las temporadas y episodios,
 *  - conocer el título original y el año (mejor detección de packs y de
 *    películas homónimas de otro año),
 *  - avisar cuando la etiqueta del watchlist no cuadra con el ID de IMDb.
 *
 * Compartido por la GitHub Action (Node) y la web (navegador): Cinemeta
 * permite CORS, así que el navegador puede consultarlo directamente.
 */

export const CINEMETA_URL = 'https://v3-cinemeta.strem.io';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Respuesta de Cinemeta → { imdbId, type, name, year, yearEnd, videos } o null. */
export function normalizeMeta(raw, requestedType = null) {
  const meta = raw?.meta;
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) return null;
  const years = (String(meta.year || meta.releaseInfo || '').match(/\d{4}/g) || []).map(Number);
  const type = meta.type === 'series' || meta.type === 'movie' ? meta.type : requestedType;
  const videos = Array.isArray(meta.videos)
    ? meta.videos
      .map(v => ({
        season: Number(v?.season),
        episode: Number(v?.episode ?? v?.number),
        title: typeof (v?.name ?? v?.title) === 'string' ? (v.name ?? v.title).trim() || null : null,
        released: v?.released || v?.firstAired || null,
      }))
      .filter(v => Number.isInteger(v.season) && Number.isInteger(v.episode) && v.episode > 0)
    : null;
  return {
    imdbId: meta.imdb_id || meta.id || null,
    type,
    name: meta.name.trim(),
    year: years[0] ?? null,
    // Series en emisión: "2011–" → sin año final.
    yearEnd: years[1] ?? (type === 'series' ? null : years[0] ?? null),
    videos: type === 'series' ? videos : null,
  };
}

/**
 * Pide los metadatos de un ID. Si no hay ficha con el tipo esperado prueba el
 * otro (sirve para avisar de "tt… es una serie, no una película").
 * Los errores de red se propagan: el llamador decide si sigue sin metadatos.
 */
export async function fetchCinemeta(fetchJSON, imdbId, typeHint = 'movie', { baseUrl = CINEMETA_URL } = {}) {
  const tryType = async type => {
    try {
      return normalizeMeta(await fetchJSON(`${baseUrl}/meta/${type}/${imdbId}.json`, { timeout: 10000, retries: 1 }), type);
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  };
  const first = await tryType(typeHint === 'series' ? 'series' : 'movie');
  if (first) return first;
  return tryType(typeHint === 'series' ? 'movie' : 'series');
}

/**
 * Episodios de una temporada según Cinemeta (solo los ya emitidos: los
 * futuros no tienen torrents). null si la ficha no trae episodios.
 */
export function episodesForSeason(meta, season, { now = Date.now() } = {}) {
  if (!Array.isArray(meta?.videos)) return null;
  const byEpisode = new Map();
  for (const video of meta.videos) {
    if (video.season !== season) continue;
    const released = video.released ? Date.parse(video.released) : NaN;
    if (Number.isFinite(released) && released > now + DAY_MS) continue;
    if (!byEpisode.has(video.episode)) byEpisode.set(video.episode, video);
  }
  return [...byEpisode.values()].sort((a, b) => a.episode - b.episode);
}

/**
 * Todos los episodios ya emitidos de una serie (TODAS las temporadas, de una
 * sola vez), ordenados por temporada y episodio. Los especiales (temporada 0)
 * y los episodios aún no emitidos se descartan: no suelen tener torrents.
 */
export function episodesForSeries(meta, { now = Date.now() } = {}) {
  if (!Array.isArray(meta?.videos)) return null;
  const seen = new Set();
  const episodes = [];
  for (const video of meta.videos) {
    if (!Number.isInteger(video.season) || video.season < 1) continue;
    const released = video.released ? Date.parse(video.released) : NaN;
    if (Number.isFinite(released) && released > now + DAY_MS) continue;
    const key = `${video.season}:${video.episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    episodes.push(video);
  }
  return episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/** Año escrito en la etiqueta del watchlist: "Cadena perpetua (1994)" → 1994. */
export function labelYear(label) {
  const years = String(label ?? '').match(/(?<![0-9])(?:19|20)\d{2}(?![0-9])/g);
  return years ? Number(years[years.length - 1]) : null;
}

/** "The Pianist (2003)". */
export function metaLabel(meta) {
  if (!meta?.name) return null;
  return meta.year ? `${meta.name} (${meta.year})` : meta.name;
}

/**
 * Aviso cuando el año de la etiqueta no encaja con el ID de IMDb (±1 año).
 * Ej.: "tt0253474 El Padrino. Parte II (1974)" es en realidad The Pianist (2003).
 */
export function labelMismatch(label, meta) {
  const year = labelYear(label);
  if (!year || !meta?.year) return null;
  const from = meta.year;
  const to = meta.type === 'series' ? (meta.yearEnd ?? new Date().getFullYear()) : (meta.yearEnd ?? meta.year);
  if (year >= from - 1 && year <= to + 1) return null;
  return `la etiqueta “${label}” no cuadra: en IMDb es “${metaLabel(meta)}”`;
}

/**
 * Nombre de la serie para las etiquetas de episodios expandidos y el catálogo:
 * "Juego de Tronos – Temporada 1 completa" / "Juego de Tronos S01E01" → "Juego de Tronos".
 */
export function showLabel(label, meta) {
  const base = String(label ?? '')
    .replace(/\s*[-–—:|,]?\s*(?:(?:temporadas?|seasons?|temp\.?|saison)(?:\s*\d|\s+complet)|t\d{1,2}\b|s\d{1,2}(?:\s*e\d{1,3})?\b|\d{1,2}x\d{2,3}\b).*$/i, '')
    .trim();
  return base || meta?.name || null;
}

/** Póster sin API key (el mismo CDN que usa Stremio). */
export function posterUrl(imdbId, size = 'small') {
  return /^tt\d{7,10}$/.test(String(imdbId || '')) ? `https://images.metahub.space/poster/${size}/${imdbId}/img` : null;
}
