/**
 * De los montones de torrents que devuelven los addons para un título/episodio,
 * elige SOLO 2:
 *
 *   🇪🇸 el mejor con audio en español (castellano o latino, da igual)
 *   🇬🇧 el mejor con audio en inglés
 *
 * y deja en cada magnet solo los mejores trackers públicos.
 *
 * "Mejor" = calidad + salud (seeders). Se penalizan CAM/TS, packs/colecciones,
 * otra película (año distinto), otro episodio, 4K reescalados, 3D, subtítulos
 * incrustados (HC), archivos enormes (remux > 25 GB) y torrents sin seeders.
 * Ver scoreStream().
 *
 * Código compartido por la GitHub Action (Node) y la web (navegador).
 */

import { CAM_RE, SUBS_WORDS, stripSubtitleMentions } from './parse.js';

export { stripSubtitleMentions };

// ---------- trackers ----------

// ngosang/trackerslist · trackers_best.txt (copia del 2026-09-30). La Action
// intenta descargar la versión del día; esta copia es el respaldo sin red.
export const BEST_TRACKERS_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
export const BEST_TRACKERS = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.skynetcloud.site:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.gmi.gd:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker.corpscorp.online:80/announce',
  'udp://tracker.tryhackx.org:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://tracker.nyaa.vc:6969/announce',
  'http://tracker.dler.com:6969/announce',
  'udp://tracker.ducks.party:1984/announce',
  'udp://tracker2.dler.org:80/announce',
  'http://tracker.dler.org:6969/announce',
  'udp://retracker01-msk-virt.corbina.net:80/announce',
  'http://tracker.renfei.net:8080/announce',
  'udp://tracker.farted.net:6969/announce',
]);
export const DEFAULT_MAX_TRACKERS = 10;

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

/** Clave para comparar trackers: sin "tracker:", mayúsculas, "/" ni "/announce" final. */
export function normalizeTrackerKey(tracker) {
  return String(tracker ?? '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/^tracker:/i, '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\/announce$/, '');
}

/** Parsea una lista de trackers (una URL por línea, como trackers_best.txt). */
export function parseTrackerList(text) {
  const seen = new Set();
  const trackers = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const tracker = line.replace(ZERO_WIDTH_RE, '').trim();
    if (!/^(?:udp|https?|wss?):\/\/\S+$/i.test(tracker)) continue;
    const key = normalizeTrackerKey(tracker);
    if (seen.has(key)) continue;
    seen.add(key);
    trackers.push(tracker);
  }
  return trackers;
}

/**
 * Devuelve como máximo `max` trackers, todos de la lista de los mejores.
 * Primero los que el torrent ya anunciaba (más probable que tengan peers) y
 * luego el resto de la lista en su orden. Los trackers muertos o desconocidos
 * que traían los addons se descartan.
 */
export function pickBestTrackers(ownTrackers = [], bestTrackers = BEST_TRACKERS, max = DEFAULT_MAX_TRACKERS) {
  const own = new Set((ownTrackers || []).map(normalizeTrackerKey));
  const alreadyAnnounced = bestTrackers.filter(tracker => own.has(normalizeTrackerKey(tracker)));
  const others = bestTrackers.filter(tracker => !own.has(normalizeTrackerKey(tracker)));
  return [...alreadyAnnounced, ...others].slice(0, Math.max(0, max));
}

// ---------- idioma ----------

const SPANISH_AUDIO_RE = /\b(?:castellano|espa[ñn]ol|spanish|latino|latam|esp|spa|dual[\s._-]*lat)\b/i;
const SPANISH_SUBS_ONLY_RE = new RegExp(
  `\\b(?:${SUBS_WORDS})\\b[\\s._:\\-\\[(]*(?:(?:en|in)[\\s._-]+)?(?:castellano|espa[ñn]ol|spanish|esp|spa)\\b` +
  `|\\b(?:castellano|espa[ñn]ol|spanish|esp|spa)[\\s._-]+(?:${SUBS_WORDS})\\b|\\bvose\\b`,
  'i'
);
// Escrituras no latinas (cirílico, griego, hebreo, árabe, indias, tailandés, CJK, coreano).
const NON_LATIN_RE = /[\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;
// Marcas de releases en otros idiomas que los addons no siempre convierten en bandera.
const FOREIGN_MARKERS_RE = /\b(?:ita|italian[oa]?|stagion[ei]|french|truefrench|vff|vfq|vf2|vostfr|vost|fr|german|deutsch|ger|hindi|tamil|telugu|malayalam|kannada|bengali|punjabi|urdu|korean|kor|japanese|jpn|chinese|chs|cht|mandarin|cantonese|russian|rus|ukr|ukrainian|polish|pol|pl|lektor|napisy|dubbing|cz|cze|czech|sk|slovak|hun|hungarian|magyar|turkish|tur|arabic|persian|farsi|dutch|nl|nordic|swedish|swe|danish|norwegian|finnish|portuguese|ptbr|pt-br|dublado|legendado|vietnamese|thai|indonesian|greek|hebrew|romanian|bulgarian|croatian|serbian|mvo|dvo|avo|temporada|cap[ií]tulo)\b/i;
const MIXED_AUDIO_RE = /\b(?:multi|dual)\b/i;

function streamText(stream) {
  return [stream?.title, stream?.filename].filter(Boolean).join('\n');
}

function streamProviders(stream) {
  if (Array.isArray(stream?.providers)) return stream.providers;
  return stream?.provider ? [stream.provider] : [];
}

/**
 * 3 = release en español (Peerflix, "Castellano", "Latino", "Español", "ESP"…),
 *     solo o dual con inglés
 * 2 = trae audio en español, pero como una pista más de un multi-idioma
 *     (p. ej. REMUX.ENG.ITA.RUS.ESP.LATINO) o solo con la bandera 🇪🇸/🇲🇽
 * 1 = 🇪🇸 perdida entre muchas banderas (a menudo son subtítulos: dudoso)
 * 0 = sin español o solo subtítulos en español
 */
export function spanishTier(stream) {
  const languages = stream?.languages || [];
  if (!languages.includes('es')) return 0;
  const text = streamText(stream);
  const others = languages.filter(lang => lang !== 'es' && lang !== 'en');
  // Peerflix es un addon de contenido en español: todo lo que publica trae audio ES.
  const fromSpanishAddon = streamProviders(stream).includes('peerflix');
  if (fromSpanishAddon || SPANISH_AUDIO_RE.test(stripSubtitleMentions(text))) return others.length === 0 ? 3 : 2;
  if (SPANISH_SUBS_ONLY_RE.test(text)) return 0;
  return languages.length === 1 ? 2 : 1;
}

/**
 * 2 = versión original en inglés (Torrentio/TorrentsDB no ponen bandera al
 *     inglés, así que "sin idioma y sin marcas extranjeras" cuenta como inglés)
 * 1 = trae inglés junto a otros idiomas (MULTi, ITA-ENG, dual español-inglés…)
 * 0 = sin inglés (ruso, checo, italiano, francés…)
 */
export function englishTier(stream) {
  const languages = stream?.languages || [];
  // Un release en español (p. ej. "Castellano-Inglés") como mucho es inglés secundario.
  if (spanishTier(stream) >= 2) return languages.includes('en') ? 1 : 0;
  const text = streamText(stream);
  const others = languages.filter(lang => lang !== 'en' && lang !== 'es');
  const foreign = others.length > 0 || NON_LATIN_RE.test(text) || FOREIGN_MARKERS_RE.test(text);
  const mixed = MIXED_AUDIO_RE.test(text) || languages.includes('es');
  if (languages.includes('en')) return foreign || mixed ? 1 : 2;
  if (languages.length === 0 && !foreign) return mixed ? 1 : 2;
  return 0;
}

// ---------- ¿es la película / el episodio pedido? ----------

// Años de estreno escritos en el release ("Dune 1984", "(2021)").
const YEAR_RE = /(?<![0-9])(19[2-9][0-9]|20[0-9]{2})(?![0-9])/g;

function numbersIn(texts) {
  const out = new Set();
  for (const text of texts) for (const n of String(text ?? '').match(/\d+/g) || []) out.add(Number(n));
  return out;
}

/**
 * Años que menciona el título del torrent, sin contar números que forman parte
 * del propio título de la película ("1917", "Blade Runner 2049", "2001: Odisea…")
 * ni años futuros.
 */
export function releaseYears(title, knownTitles = [], { maxYear = new Date().getFullYear() + 1 } = {}) {
  // "(1994)" de la etiqueta del watchlist es el año, no parte del título.
  const titleNumbers = numbersIn(knownTitles.map(t => String(t ?? '').replace(/\(\s*\d{4}\s*\)/g, ' ')));
  const years = new Set();
  for (const y of String(title ?? '').match(YEAR_RE) || []) {
    const year = Number(y);
    if (year <= maxYear && !titleNumbers.has(year)) years.add(year);
  }
  return [...years];
}

/**
 * true si el título del torrent trae años y ninguno encaja (±1) con el de la
 * película: suele ser otra película con el mismo nombre (remake, original…).
 */
export function isWrongYear(stream, expectedYear, knownTitles = []) {
  if (!Number.isInteger(expectedYear)) return false;
  const years = releaseYears(stream?.title, knownTitles);
  return years.length > 0 && !years.some(year => Math.abs(year - expectedYear) <= 1);
}

/**
 * Año "de consenso" entre los candidatos cuando no se conoce el de IMDb: el más
 * repetido, si lo trae al menos la mitad de los torrents con año (y 3 o más).
 * No se usa el año de la etiqueta del watchlist: puede estar mal escrita.
 */
export function consensusYear(streams, knownTitles = []) {
  const counts = new Map();
  let withYear = 0;
  for (const stream of streams || []) {
    const years = releaseYears(stream?.title, knownTitles);
    if (!years.length) continue;
    withYear++;
    for (const year of years) counts.set(year, (counts.get(year) || 0) + 1);
  }
  const [year, count] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] || [];
  return year && count >= 3 && count * 2 >= withYear ? year : null;
}

const EPISODE_PATTERNS = [
  // S01E01, S01E01-E03, S01E01E02, S01.E01
  /\bs(\d{1,2})[\s._-]*e(\d{1,3})(?:[._]?(?:-|e)e?(\d{1,3}))?/gi,
  // 1x01, 1x01-03 (no confundir con "5.1x264")
  /(?<!\d)(?<!\d\.)(\d{1,2})x(?!26[45])(\d{2,3})(?:[-_](\d{2,3}))?\b/gi,
  // [Cap.101], Cap.102_103 (MejorTorrent y similares: temporada + episodio de 2 cifras)
  /\bcap[\s._-]*(\d{1,2})(\d{2})(?:[\s._-]+\d{1,2}(\d{2}))?\b/gi,
];
const SEASON_PATTERNS = [
  // S01, S01-S08, S1-8 (sin episodio detrás)
  /\bs(\d{1,2})(?![\s._-]*e\d)(?:[\s._-]*-[\s._-]*s?(\d{1,2}))?\b/gi,
  // Season 1, Seasons 1-5, Temporada 1, Temp.1, Saison 1, Stagioni 1-8, Staffel 2
  /\b(?:seasons?|temporadas?|temp|saisons?|stagion[ei]|staffel)[\s._:-]*(\d{1,2})(?:[\s._-]*(?:-|a|al|to|&|y)[\s._-]*(\d{1,2}))?\b/gi,
  // T4, T01 (abreviatura española de temporada)
  /\bt(\d{1,2})\b/gi,
];

function collectRanges(text, patterns) {
  const ranges = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of String(text ?? '').matchAll(re)) ranges.push(m.slice(1).map(v => (v === undefined ? null : Number(v))));
  }
  return ranges;
}

/**
 * ¿El torrent es el episodio pedido? 'match' | 'mismatch' | 'unknown'.
 * Primero mira el nombre del archivo (Torrentio lo da para el episodio dentro
 * del pack) y luego el título: episodio explícito o temporada/pack.
 */
export function episodeMatch(stream, season, episode) {
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return 'unknown';
  for (const text of [stream?.filename, stream?.title]) {
    const episodes = collectRanges(text, EPISODE_PATTERNS);
    if (episodes.length) {
      const hit = episodes.some(([s, from, to]) => {
        // "S01E01-E10" es un rango; un "fin" absurdo (menor o enorme) se ignora.
        const end = to != null && to >= from && to - from <= 50 ? to : from;
        return s === season && episode >= from && episode <= end;
      });
      return hit ? 'match' : 'mismatch';
    }
  }
  const seasons = collectRanges(stream?.title, SEASON_PATTERNS);
  if (!seasons.length) return 'unknown';
  return seasons.some(([from, to]) => season >= from && season <= (to ?? from)) ? 'match' : 'mismatch';
}

// ---------- puntuación ----------

const QUALITY_POINTS = { '4K': 3.25, '1080p': 3, '720p': 1.5, '480p': 0.5 };
const UNKNOWN_QUALITY_POINTS = 1;
// Un "4K reescalado" pesa como un 4K pero se ve como un 1080p.
const UPSCALED_4K_POINTS = 2.75;
// A partir de ~100 seeders un torrent ya va fluido: más seeders no lo hacen mejor.
const SEEDERS_CAP = 100;
const GIB = 1024 ** 3;

// Plurales genéricos sueltos ("3D Peliculas", "0peliculas series", "Zombie Movies",
// "World War 2 Films") = colección, no una película.
const PACK_RE = /\b(?:collection|colecci[oó]n|trilog(?:y|[ií]a)|duolog(?:y|[ií]a)|tetralog(?:y|[ií]a)|quadrilog(?:y|[ií]a)|anthology|antolog[ií]a|filmograph(?:y|ie)|box[\s._-]?set|pack|top[\s._-]?\d{2,4}|movies|films)\b|(?<![a-z])\d*pel[ií]culas\b/i;
// Una película suelta tiene pocos archivos; si el vídeo es el nº 100+ es un pack.
const PACK_FILE_INDEX = 100;
const THREE_D_RE = /\b(?:3d|h-?sbs|h-?ou|half-?sbs|half-?ou)\b/i;
const HARDCODED_SUBS_RE = /\b(?:hc|hardsubs?|hardcoded)\b/i;
const UPSCALED_RE = /(?:re-?escal|upscal|ai[\s._-]?enhanced)/i;
// Otra película u otro episodio: contenido equivocado, peor que un pack.
const WRONG_CONTENT_PENALTY = 5;

// Preferencia por idioma (se suma a la puntuación):
//  · español: un release en español gana casi siempre a un multi-idioma con
//    pista española, y ambos al "dudoso" (que suele ser solo subtítulos);
//  · inglés: la versión original gana al inglés mezclado salvo que este sea
//    bastante mejor.
const TIER_BONUS = { es: [0, 0, 8, 10], en: [0, 0, 2] };

// Palabras que no identifican una película: sirven para detectar torrents cuyo
// título no tiene nada que ver con el resto (packs, colecciones, otra película).
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'los', 'las', 'del', 'con', 'por', 'una', 'uno', 'des', 'les', 'der', 'die', 'das', 'und', 'dos', 'une', 'ein', 'eine',
  'movie', 'movies', 'film', 'films', 'pelicula', 'peliculas', 'serie', 'series', 'season', 'seasons', 'temporada', 'temporadas',
  'complete', 'completa', 'collection', 'coleccion', 'pack', 'trilogy', 'trilogia', 'saga', 'edition', 'extended', 'remastered',
  'directors', 'cut', 'unrated', 'imax', 'part', 'parte', 'vol', 'volume', 'episode', 'episodio', 'capitulo',
  'amazing', 'great', 'essential', 'epic', 'best', 'top', 'imdb', 'official', 'mega', 'ultimate', 'all', 'new', 'full',
  'bluray', 'brrip', 'bdrip', 'bdremux', 'remux', 'webrip', 'web', 'hdtv', 'hdrip', 'dvdrip', 'microhd', 'fullbluray', 'uhd', 'hdr', 'sdr',
  'hevc', 'avc', 'aac', 'dts', 'truehd', 'atmos', 'opus', 'mkv', 'avi', 'rip', 'dual', 'multi', 'audio', 'subs', 'sub', 'esub', 'esubs',
  'castellano', 'latino', 'espanol', 'spanish', 'english', 'ingles', 'ita', 'eng', 'rus', 'french', 'german', 'dublado', 'dubbed',
  'www', 'com', 'org', 'net', 'yts', 'yify', 'rarbg', 'proper', 'repack', 'internal', 'limited', 'amzn', 'hmax', 'dsnp', 'atvp',
]);

function significantWords(text) {
  const words = String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words.filter(word => /^[a-z]{3,}$/.test(word) && !TITLE_STOPWORDS.has(word)));
}

/**
 * Devuelve una función que dice si el título de un torrent es "ajeno": no
 * comparte ninguna palabra con los títulos que se repiten entre los candidatos
 * (ni con la etiqueta del watchlist o el título original de IMDb). Así caen
 * "0peliculas series", "Amazing Films 11" o "Videos cosas" aunque tengan
 * cientos de seeders.
 */
export function buildTitleMatcher(streams, labels = []) {
  const wordsByStream = new Map();
  const frequency = new Map();
  for (const stream of streams || []) {
    const words = significantWords(stream?.title);
    wordsByStream.set(stream, words);
    for (const word of words) frequency.set(word, (frequency.get(word) || 0) + 1);
  }
  const minFrequency = (streams?.length || 0) >= 10 ? 3 : 2;
  const titleWords = new Set([...frequency].filter(([, count]) => count >= minFrequency).map(([word]) => word));
  for (const label of Array.isArray(labels) ? labels : [labels]) {
    for (const word of significantWords(label)) titleWords.add(word);
  }
  return function isOffTitle(stream) {
    if (!titleWords.size) return false;
    const words = wordsByStream.get(stream) ?? significantWords(stream?.title);
    if (!words.size) return false; // "Up", "Se7en"…: no se puede juzgar
    for (const word of words) if (titleWords.has(word)) return false;
    return true;
  };
}

export function seedersPoints(seeders) {
  if (seeders == null) return 0;   // desconocido: ni premio ni castigo
  if (seeders <= 0) return -3;     // probablemente muerto
  return 1.5 * Math.log10(Math.min(seeders, SEEDERS_CAP) + 1);
}

/** Calidad + salud − penalizaciones. Mayor es mejor. */
export function scoreStream(stream, { type = 'movie', offTitle = false, wrongContent = false } = {}) {
  const text = streamText(stream);
  let score = QUALITY_POINTS[stream?.quality] ?? UNKNOWN_QUALITY_POINTS;
  if (stream?.quality === '4K' && UPSCALED_RE.test(text)) score = UPSCALED_4K_POINTS;
  score += seedersPoints(stream?.seeders);
  score += technicalPoints(stream);
  if (CAM_RE.test(text)) score -= 4;
  // En series los packs de temporada son normales (fileIdx apunta al episodio).
  const moviePack = type === 'movie' && (PACK_RE.test(stream?.title || '') || (stream?.fileIdx ?? 0) >= PACK_FILE_INDEX);
  if (offTitle || moviePack) score -= 3;
  if (wrongContent) score -= WRONG_CONTENT_PENALTY;
  if (THREE_D_RE.test(text)) score -= 1.5;
  if (HARDCODED_SUBS_RE.test(text)) score -= 1;
  // Remux enormes: la mejor imagen, pero poco prácticos para ver en streaming.
  if (stream?.sizeBytes > 40 * GIB) score -= 2.5;
  else if (stream?.sizeBytes > 25 * GIB) score -= 1;
  return Math.round(score * 100) / 100;
}

// ---------- señales de calidad / confianza ----------

const SOURCE_POINTS = [
  [/\bremux\b/i, 4.0],
  [/\b(?:bluray|blu-?ray)\b/i, 3.5],
  [/\bweb-?dl\b/i, 3.25],
  [/\bweb(?:rip)?\b/i, 2.5],
  [/\bhdtv\b/i, 1.5],
  [/\b(?:brrip|bdrip)\b/i, 1.5],
];

const BAD_SOURCE_RE = /\b(?:cam|ts|telesync|telecine|scr|screener|hdcam|hdts|workprint)\b/i;
const AUDIO_QUALITY_RE = /\b(?:truehd|atmos|dts-?hd|dts|ddp|eac3|ac3|aac|opus|flac)\b/i;
const LOSSLESS_AUDIO_RE = /\b(?:truehd|dts-?hd|flac)\b/i;

function technicalPoints(stream) {
  const text = streamText(stream);
  let points = 0;
  for (const [re, value] of SOURCE_POINTS) {
    if (re.test(text)) { points += value; break; }
  }
  if (AUDIO_QUALITY_RE.test(text)) points += 0.75;
  if (LOSSLESS_AUDIO_RE.test(text)) points += 0.5;
  if (/\b(?:10bit|10-bit)\b/i.test(text)) points += 0.35;
  if (/\b(?:hdr10\\+?|dolby[ ._-]?vision|dv)\b/i.test(text)) points += 0.4;
  if (BAD_SOURCE_RE.test(text)) points -= 5;
  return points;
}

/**
 * Confianza del idioma. Las banderas del parser son útiles, pero una marca
 * textual explícita es más fiable que asumir idioma por ausencia de marcas.
 */
export function languageConfidence(stream, lang) {
  const text = streamText(stream);
  const clean = stripSubtitleMentions(text);
  const languages = Array.isArray(stream?.languages) ? stream.languages : [];

  if (lang === 'es') {
    if (SPANISH_SUBS_ONLY_RE.test(text)) return 0;
    if (/\b(?:castellano|espa[ñn]ol|spanish|latino|latam|es-?la|es-?mx|es-?es)\b/i.test(clean)) return 1;
    if (languages.includes('es')) return spanishTier(stream) >= 2 ? 0.9 : 0.55;
    if (streamProviders(stream).includes('peerflix')) return 0.8;
    return 0;
  }

  if (lang === 'en') {
    if (FOREIGN_MARKERS_RE.test(clean) && !/\b(?:eng|english|en)\b/i.test(clean)) return 0.1;
    if (/\b(?:english|eng|en-?us|en-?gb)\b/i.test(clean)) return 1;
    if (languages.includes('en')) return englishTier(stream) >= 2 ? 0.95 : 0.75;
    // Sin idioma explícito: solo confianza media, nunca la tratamos como certeza.
    return languages.length === 0 && !NON_LATIN_RE.test(clean) ? 0.55 : 0;
  }

  return 0;
}

function titleSimilarity(stream, knownTitles) {
  const expected = new Set();
  for (const title of knownTitles) for (const word of significantWords(title)) expected.add(word);
  if (!expected.size) return 0;
  const actual = significantWords(stream?.title);
  if (!actual.size) return 0;
  let hits = 0;
  for (const word of actual) if (expected.has(word)) hits++;
  return Math.min(3, hits * 0.6);
}

// ---------- selección ----------

export const PICK_LANGUAGES = Object.freeze(['es', 'en']);

/**
 * Devuelve como máximo 2 streams distintos: [mejor ES, mejor EN]. Si no hay
 * candidato para un idioma, ese hueco queda vacío (no se rellena con otro
 * idioma). Cada stream devuelto lleva `pick` ('es' | 'en') y `score`.
 *
 * Opcional (mejora la puntuación cuando se conoce, p. ej. vía Cinemeta):
 *  - `titles`: otros títulos del mismo contenido (título original de IMDb…)
 *  - `year`: año de estreno de la película (penaliza otra película homónima)
 *  - `season`/`episode`: episodio pedido (penaliza otro episodio/temporada)
 */
export function selectBestStreams(streams, { type = 'movie', label = '', titles = [], year = null, season = null, episode = null } = {}) {
  const list = (streams || []).filter(Boolean);
  const knownTitles = [label, ...titles].filter(Boolean);
  const isOffTitle = buildTitleMatcher(list, knownTitles);
  const expectedYear = type === 'movie'
    ? (Number.isInteger(year) ? year : consensusYear(list, knownTitles))
    : null;
  const ranked = list.map(stream => {
    const wrongContent = type === 'movie'
      ? isWrongYear(stream, expectedYear, knownTitles)
      : episodeMatch(stream, season, episode) === 'mismatch';
    let score = scoreStream(stream, { type, offTitle: isOffTitle(stream), wrongContent });
    score += titleSimilarity(stream, knownTitles);
    const tiers = { es: spanishTier(stream), en: englishTier(stream) };
    const confidence = { es: languageConfidence(stream, 'es'), en: languageConfidence(stream, 'en') };
    return { stream, score: Math.round(score * 100) / 100, tiers, confidence };
  });

  const best = (lang, excludeHash = null) => {
    const candidates = ranked
      .filter(c => c.tiers[lang] > 0 && c.confidence[lang] >= (lang === 'es' ? 0.55 : 0.55) && c.stream.infoHash !== excludeHash)
      .map(c => {
        const confidenceBonus = c.confidence[lang] * 4;
        const tierBonus = TIER_BONUS[lang][c.tiers[lang]];
        return { ...c, rank: Math.round((c.score + tierBonus + confidenceBonus) * 100) / 100 };
      });
    candidates.sort((a, b) =>
      b.rank - a.rank ||
      (b.stream.seeders ?? -1) - (a.stream.seeders ?? -1) ||
      streamProviders(b.stream).length - streamProviders(a.stream).length ||
      String(a.stream.infoHash).localeCompare(String(b.stream.infoHash))
    );
    return candidates[0] || null;
  };

  const es = best('es');
  const en = best('en', es?.stream.infoHash ?? null);
  return [
    es && { ...es.stream, pick: 'es', score: es.rank },
    en && { ...en.stream, pick: 'en', score: en.rank },
  ].filter(Boolean);
}
