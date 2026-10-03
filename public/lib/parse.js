/**
 * Normalización de streams Stremio → registros comparables.
 *
 * Código compartido por la GitHub Action (Node) y la web (navegador): sin
 * dependencias, sin `process` y sin DOM.
 */

// ---------- watchlist ----------

export const IMDB_LINE_RE = /^(tt\d{7,10})(?::s(\d{1,2})(?::e(\d{1,3}))?)?(?:\s+(.*))?$/i;

/**
 * Lee watchlist.txt: una línea por título (`tt0111161 Título`, `tt0944947:s1:e1`,
 * `tt0944947:s1`). Ignora comentarios `#` (reconociendo las cabeceras de sección
 * `# --- Películas ---` y `# --- Series ---`) y deduplica IDs/episodios repetidos.
 */
export function parseWatchlist(text, { onWarning = null } = {}) {
  const items = [];
  const seen = new Map();
  let sectionType = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^#\s*[-–—]+\s*series\b/i.test(trimmed)) { sectionType = 'series'; continue; }
    if (/^#\s*[-–—]+\s*(?:pel[ií]culas|movies)\b/i.test(trimmed)) { sectionType = 'movie'; continue; }
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(IMDB_LINE_RE);
    if (!m) { onWarning?.(`Línea ignorada (no reconozco el ID): ${rawLine.trim()}`); continue; }
    const imdbId = m[1].toLowerCase();
    const season = m[2] !== undefined ? Number(m[2]) : null;
    const episode = m[3] !== undefined ? Number(m[3]) : null;
    const label = (m[4] || '').trim() || null;
    const type = season !== null ? 'series' : 'movie';
    const typeHint = season !== null ? 'series' : sectionType;
    const key = episode !== null ? `${imdbId}:s${season}:e${episode}`
      : season !== null ? `${imdbId}:s${season}`
      : imdbId;
    if (seen.has(key)) {
      const existing = items[seen.get(key)];
      if (!existing.label && label) existing.label = label;
      if (typeHint === 'series' && !existing.typeHint) existing.typeHint = 'series';
      continue;
    }
    seen.set(key, items.length);
    items.push({ imdbId, type, ...(typeHint ? { typeHint } : {}), season, episode, label, raw: rawLine.trim() });
  }
  return items;
}

// A season request expands into individual episode requests. Deduplicate after
// expansion too, so an explicit episode plus a whole-season line is fetched
// and reported only once (e.g. tt0944947:s1:e1 + tt0944947:s1).
export function dedupeQueries(queries) {
  const unique = new Map();
  for (const query of queries) {
    const imdbId = String(query.imdbId || '').toLowerCase();
    const key = query.kind === 'movie'
      ? `movie:${imdbId}`
      : `series:${imdbId}:s${Number(query.season)}:e${Number(query.episode)}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, query);
    } else if ((!existing.label || existing.label === existing.imdbId) && query.label) {
      // Keep a useful user-supplied/generated label when the first entry has none.
      unique.set(key, { ...existing, label: query.label });
    }
  }
  return [...unique.values()];
}

export function stremioId(query) {
  if (query.kind === 'movie') return query.imdbId;
  return `${query.imdbId}:${query.season}:${query.episode}`;
}

// ---------- magnets / trackers ----------

export function buildMagnet(infoHash, title, trackers = []) {
  const params = [`xt=urn:btih:${infoHash}`];
  if (title) params.push(`dn=${encodeURIComponent(title)}`);
  const uniq = new Set();
  for (const t of trackers) {
    const clean = String(t).replace(/^tracker:/, '').trim();
    if (clean && !uniq.has(clean)) { uniq.add(clean); params.push(`tr=${encodeURIComponent(clean)}`); }
  }
  return `magnet:?${params.join('&')}`;
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

export function trackersFromMagnet(magnet) {
  if (typeof magnet !== 'string' || !magnet.toLowerCase().startsWith('magnet:?')) return [];
  const trackers = [];
  try {
    const params = new URLSearchParams(magnet.slice(magnet.indexOf('?') + 1));
    for (const tracker of params.getAll('tr')) {
      const clean = tracker.replace(ZERO_WIDTH_RE, '').trim();
      if (clean) trackers.push(clean);
    }
  } catch {
    // A malformed magnet must not make the whole provider response fail.
  }
  return trackers;
}

// ---------- idioma ----------

// Parse language flag emojis (🇪🇸 → es, 🇬🇧/🇺🇸 → en, etc.)
const FLAG_REGIONS = {
  ES: 'es', MX: 'es', AR: 'es', CL: 'es', CO: 'es', PE: 'es', VE: 'es', UY: 'es',
  GB: 'en', US: 'en', CA: 'en', AU: 'en', IE: 'en', NZ: 'en',
  BR: 'pt', PT: 'pt',
  FR: 'fr', DE: 'de', IT: 'it', JP: 'ja', RU: 'ru', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh',
  // Otros idiomas que Torrentio marca con bandera. Antes se descartaban y un
  // release "🇬🇧 / 🇮🇳" parecía solo inglés.
  IN: 'hi', PL: 'pl', CZ: 'cs', SK: 'sk', NL: 'nl', UA: 'uk', TR: 'tr', HU: 'hu',
  SE: 'sv', NO: 'no', DK: 'da', FI: 'fi', GR: 'el', SA: 'ar', IL: 'he', TH: 'th',
  VN: 'vi', ID: 'id', RO: 'ro', BG: 'bg', HR: 'hr', RS: 'sr', LT: 'lt', LV: 'lv',
  EE: 'et', IR: 'fa', MY: 'ms',
};
// Idiomas escritos en el título ("Castellano", "Español", "ESP", "ITA.ENG"…).
const TEXT_LANGUAGES = [
  ['es', /\b(?:castellano|espa[ñn]ol|spanish|latino|latam|esp|spa|dual[\s._-]*lat)\b/i],
  ['en', /\b(?:english|ingl[ée]s|eng)\b/i],
  ['fr', /\b(?:french|fran[çc]ais|franc[ée]s|truefrench|vff|vfq)\b/i],
  ['de', /\b(?:german|deutsch|alem[áa]n)\b/i],
  ['it', /\b(?:italian[oa]?|ita)\b/i],
  ['pt', /\b(?:portuguese|portugu[êée]s|dublado)\b/i],
  ['ja', /\b(?:japanese|japon[ée]s)\b/i],
  ['ru', /\b(?:russian|rus)\b/i],
  ['hi', /\bhindi\b/i],
];
const FLAG_RE = /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/g;
function regionPairToLang(pair) {
  // A flag is two regional indicator letters. Convert back to the ISO-3166 code.
  const c1 = pair.codePointAt(0) - 0x1F1E6 + 0x41;
  const c2 = pair.codePointAt(2) - 0x1F1E6 + 0x41;
  const code = String.fromCharCode(c1) + String.fromCharCode(c2);
  return FLAG_REGIONS[code] || null;
}

const LANGUAGE_WORDS = [
  'castellano', 'espa[ñn]ol', 'spanish', 'latino', 'latam', 'esp', 'spa',
  'english', 'ingl[ée]s', 'eng',
  'french', 'fran[çc]ais', 'franc[ée]s', 'fre', 'fra',
  'italian[oa]?', 'ita', 'german', 'deutsch', 'alem[áa]n', 'ger',
  'portuguese', 'portugu[êée]s', 'por', 'japanese', 'japon[ée]s', 'jpn',
  'russian', 'rus', 'korean', 'kor', 'chinese', 'hindi',
].join('|');
export const SUBS_WORDS = 'subs?|subt[ií]tulos?|subtitulad[oa]s?|subtitles?|subbed|sous[\\s.-]?titres?|legendas?|legendado|napisy';
const LANGUAGE_LIST = `(?:${LANGUAGE_WORDS})(?:[\\s._\\-/,&+]+(?:${LANGUAGE_WORDS}))*`;
// "Sub Español", "sub-español", "Subtítulos en español", "SUB ITA ENG"…
const SUBS_THEN_LANGUAGE_RE = new RegExp(`\\b(?:${SUBS_WORDS})\\b[\\s._:\\-\\[(]*(?:(?:en|in)[\\s._-]+)?${LANGUAGE_LIST}\\b`, 'gi');
// "Spanish Subs", "ENG Sub"… ("Castellano+Subs" NO: ahí el castellano es audio)
const LANGUAGE_THEN_SUBS_RE = new RegExp(`\\b(?:${LANGUAGE_WORDS})[\\s._-]+(?:${SUBS_WORDS})\\b`, 'gi');

/** Quita las menciones que solo describen subtítulos para no confundirlas con audio. */
export function stripSubtitleMentions(text) {
  return String(text ?? '').replace(SUBS_THEN_LANGUAGE_RE, ' ').replace(LANGUAGE_THEN_SUBS_RE, ' ');
}

export function normalizeLanguage(lang, extraText = '') {
  const out = new Set();
  const add = (raw) => {
    if (!raw) return;
    for (const tok of String(raw).split(/[,+\s/|]+/).filter(Boolean)) {
      const l = tok.toLowerCase().trim();
      if (['es','spa','esp','castellano','latino','spanish','español','espanol'].includes(l)) out.add('es');
      else if (['en','eng','english','ingles','inglés'].includes(l)) out.add('en');
      else if (['pt','por','portuguese','português','portugues','portugués'].includes(l)) out.add('pt');
      else if (['fr','fra','fre','french','français','frances','francés'].includes(l)) out.add('fr');
      else if (['de','deu','ger','german','aleman','alemán'].includes(l)) out.add('de');
      else if (['it','ita','italian','italiano'].includes(l)) out.add('it');
      else if (['ja','jpn','japanese','japones','japonés'].includes(l)) out.add('ja');
      else if (['ru','rus','russian'].includes(l)) out.add('ru');
      else if (['ko','kor','korean'].includes(l)) out.add('ko');
      else if (['zh','chi','zho','chinese'].includes(l)) out.add('zh');
      else if (l.length <= 3 && /^[a-z]{2,3}$/.test(l)) out.add(l);
    }
  };
  add(lang);
  // flag emojis in description / title / extraText
  const hay = (extraText || '') + ' ' + (lang || '');
  const flags = hay.match(FLAG_RE) || [];
  for (const f of flags) {
    const code = regionPairToLang(f);
    if (code) out.add(code);
  }
  // Language names written in the release text. "Sub Español", "Spanish Subs"
  // or "SUB ITA ENG" describe subtitles, not audio, so they are ignored.
  const spokenText = stripSubtitleMentions(extraText || '');
  for (const [code, re] of TEXT_LANGUAGES) if (re.test(spokenText)) out.add(code);
  return [...out];
}

// ---------- calidad ----------

// An explicit resolution ("1080p", "2160p") always beats marketing tokens such
// as "4K Remastered" / "RM4K" / "UHD", which are usually 1080p encodes.
const RESOLUTION_RULES = [
  ['4K', /\b(?:2160|1440)[pi]?\b/],
  ['1080p', /\b1080[pi]?\b/],
  ['720p', /\b720[pi]?\b/],
  ['480p', /\b(?:480|576)[pi]?\b/],
];
const MARKETING_RULES = [
  ['4K', /\b(?:4k|uhd|ultra[\s.-]?hd)\b/],
  ['1080p', /\b(?:full[\s.-]?hd|fhd)\b/],
];

function qualityFrom(text, rules) {
  const blob = String(text || '').toLowerCase();
  if (!blob.trim()) return null;
  for (const [quality, re] of rules) if (re.test(blob)) return quality;
  return null;
}

export function normalizeQuality(nameField, titleField, explicitQuality = null, filename = null) {
  // The database has four normalized buckets. Treat 1440p as the 4K bucket
  // instead of dropping it, while never inventing a quality when none exists.
  // Only the release line is read: footers such as "👤 720" or "💾 480 MB"
  // must not become a resolution.
  const releaseLine = String(titleField || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const all = [...RESOLUTION_RULES, ...MARKETING_RULES];
  // 1) resolución escrita en el release o en el archivo (lo que subió el autor);
  // 2) la calidad que declara el addon (Peerflix a veces dice "4K" por el
  //    nombre de la web de origen, p. ej. "wolfmax4k", aunque el release diga 1080p);
  // 3) etiquetas de marketing.
  return qualityFrom(releaseLine, RESOLUTION_RULES)
    || qualityFrom(filename, RESOLUTION_RULES)
    || qualityFrom(explicitQuality, all)
    || qualityFrom(nameField, RESOLUTION_RULES)
    || qualityFrom(releaseLine, MARKETING_RULES)
    || qualityFrom(nameField, MARKETING_RULES)
    || qualityFrom(filename, MARKETING_RULES)
    || null;
}

// ---------- ficha técnica del release ----------

export const CAM_RE = /\b(?:cam|camrip|hdcam|hqcam|ts|hdts|telesync|tc|hdtc|telecine|scr|screener|dvdscr|bdscr|workprint)\b/i;
const SOURCE_RULES = [
  ['CAM', CAM_RE],
  ['REMUX', /\b(?:bd|uhd)?[\s._-]?remux\b/i],
  ['WEB-DL', /\bweb[\s._-]?dl\b|\bwebdl\b/i],
  ['WEBRip', /\bweb[\s._-]?rip\b/i],
  ['BluRay', /\b(?:blu[\s._-]?ray|bd[\s._-]?rip|br[\s._-]?rip|bdr|bd25|bd50|microhd|fullbluray)\b/i],
  ['WEB', /\bweb\b/i],
  ['HDTV', /\bhdtv(?:rip)?\b/i],
  ['DVD', /\b(?:dvd[\s._-]?rip|dvd[59r]?|dvdfull)\b/i],
  ['HDRip', /\bhd[\s._-]?rip\b/i],
];
const CODEC_RULES = [
  ['HEVC', /\b(?:x[\s.]?265|h[\s.]?265|hevc)\b/i],
  ['AV1', /\bav1\b/i],
  ['AVC', /\b(?:x[\s.]?264|h[\s.]?264|avc)\b/i],
  ['XviD', /\b(?:xvid|divx)\b/i],
];
const HDR_RULES = [
  ['DV', /\b(?:dv|dovi|dolby[\s._-]?vision)\b/i],
  ['HDR10+', /\bhdr10(?:\+|plus)/i],
  ['HDR10', /\bhdr10\b(?!\+)/i],
  ['HDR', /\bhdr\b/i],
];
// Sin \b: los códecs de audio suelen ir pegados a los canales ("DDP5.1", "AAC2.0").
const AUDIO_RULES = [
  ['Atmos', /(?:^|[^a-z])atmos(?![a-z])/i],
  ['TrueHD', /(?:^|[^a-z])true[\s._-]?hd(?![a-z])/i],
  ['DTS-HD', /(?:^|[^a-z])dts[\s._-]?(?:hd|ma|x)(?![a-z])/i],
  ['DTS', /(?:^|[^a-z])dts(?![a-z])/i],
  ['DD+', /(?:^|[^a-z])(?:ddp|dd\+|e[\s._-]?ac[\s._-]?3)(?![a-z])/i],
  ['AC3', /(?:^|[^a-z])(?:ac3|dd)(?![a-z])/i],
  ['AAC', /(?:^|[^a-z])aac(?![a-z])/i],
  ['Opus', /(?:^|[^a-z])opus(?![a-z])/i],
  ['FLAC', /(?:^|[^a-z])flac(?![a-z])/i],
  ['MP3', /(?:^|[^a-z])mp3(?![a-z])/i],
];
const CHANNELS_RE = /(?<![0-9.])([2-8])[.\s]([01])(?![0-9])|(?<![0-9])([268])ch\b/i;

/**
 * Ficha técnica del release a partir del nombre: origen (BluRay, WEB-DL…),
 * códec de vídeo, HDR, códecs de audio y canales. Solo para mostrar y exportar;
 * lo desconocido queda en null / [].
 */
export function parseReleaseInfo(...texts) {
  const text = texts.filter(Boolean).join(' ');
  const firstMatch = rules => rules.find(([, re]) => re.test(text))?.[0] ?? null;
  const hdr = HDR_RULES.filter(([, re]) => re.test(text)).map(([label]) => label);
  // "HDR10" ya implica "HDR": no repetir.
  const hdrClean = hdr.filter(label => !(label === 'HDR' && hdr.some(other => other.startsWith('HDR10'))));
  const audio = AUDIO_RULES.filter(([, re]) => re.test(text)).map(([label]) => label)
    .filter((label, _, all) => !(label === 'DTS' && all.includes('DTS-HD')) && !(label === 'AC3' && all.includes('DD+')));
  const ch = text.match(CHANNELS_RE);
  const channels = ch ? (ch[1] ? `${ch[1]}.${ch[2]}` : { 2: '2.0', 6: '5.1', 8: '7.1' }[ch[3]]) : null;
  return {
    source: firstMatch(SOURCE_RULES),
    codec: firstMatch(CODEC_RULES),
    hdr: hdrClean,
    audio: audio.slice(0, 3),
    channels,
  };
}

/** "BluRay · HEVC · HDR10 · DTS-HD 7.1" (vacío si no se sabe nada). */
export function releaseTags(info) {
  if (!info) return '';
  const audio = [info.audio?.join('/') || '', info.channels || ''].filter(Boolean).join(' ');
  return [info.source, info.codec, ...(info.hdr || []), audio].filter(Boolean).join(' · ');
}

// ---------- streams ----------

export function parseSize(label) {
  if (!label) return null;
  const m = label.toLowerCase().replace(',', '.').match(/([0-9.]+)\s*(tib|tb|gib|gb|mib|mb|kib|kb|b)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  const mult = {
    b: 1,
    kb: 1024, kib: 1024,
    mb: 1024 * 1024, mib: 1024 * 1024,
    gb: 1024 * 1024 * 1024, gib: 1024 * 1024 * 1024,
    tb: 1024 ** 4, tib: 1024 ** 4,
  }[unit];
  if (!mult) return null;
  return Math.round(n * mult);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const SIZE_UNIT = String.raw`[0-9.,]+\s*(?:TB|GB|MB|KB|B|TiB|GiB|MiB|KiB)`;
const SIZE_BADGE_RE = Object.freeze({
  file: new RegExp(`(?:💾|📏)\\s*(${SIZE_UNIT})`, 'iu'),
  pack: new RegExp(`📦\\s*(${SIZE_UNIT})`, 'iu'),
});
const SUBTITLE_LINE_RE = /^\s*💬/u;
const DEFAULT_SOURCE_RE = /(?:⚙️|🌐)\s*([^\s]+)/u;

/** Badge que precede a la fuente/indexador en el título ("⚙️ YTS", "🔍 Knaben"). */
function sourceBadgeRe(badge) {
  if (!badge) return DEFAULT_SOURCE_RE;
  const escaped = String(badge).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*([^\\s]+)`, 'u');
}

export function parseStremioStream(rawStream, provider) {
  if (!rawStream) return null;
  const infoHash = String(rawStream.infoHash || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return null;

  // Addons are not completely uniform: Peerflix uses `description`, while
  // Torrentio/TorrentsDB/TPB+ normally use `title`.
  const nameField = String(rawStream.name || '');
  const titleField = String(rawStream.title || rawStream.description || '');
  const metadataText = `${nameField}\n${titleField}`;
  const lines = titleField.split('\n').map(s => s.trim()).filter(Boolean);
  // Torrentio/TorrentsDB expose the real file name, which often carries the
  // audio languages ("[Hindi + English]") that the truncated title lost.
  const filename = typeof rawStream.behaviorHints?.filename === 'string' && rawStream.behaviorHints.filename.trim()
    ? rawStream.behaviorHints.filename.trim()
    : null;
  // TorrentClaw, StremThru Torz y AniScraper empiezan el título con badges
  // ("🔵 65/100 · 👤 579", "💿 BluRay REMUX"): el release real es el archivo.
  const useFilename = Boolean(provider.titleFromFilename && filename);
  const releaseTitle = (useFilename ? filename : null)
    || lines[0] || nameField.replace(/\n/g, ' ').trim() || infoHash;

  // Seed/size may be proper JSON fields (Peerflix) or footer badges in title.
  // 👤/🌱 = seeders; 💾/📏 = tamaño del archivo; 📦 = tamaño del pack (Torz).
  const seedMatch = metadataText.match(/(?:👤|🌱)\s*(\d+|\?)/u);
  const sourceMatch = metadataText.match(sourceBadgeRe(provider.sourceBadge));
  const explicitSeeders = rawStream.seed ?? rawStream.seeders;
  const seeders = Number.isSafeInteger(explicitSeeders) && explicitSeeders >= 0
    ? explicitSeeders
    : seedMatch && /^\d+$/.test(seedMatch[1]) ? Number(seedMatch[1]) : null;
  const explicitSize = rawStream.sizebytes ?? rawStream.sizeBytes;
  const videoSize = rawStream.behaviorHints?.videoSize;
  const fileSizeBadge = metadataText.match(SIZE_BADGE_RE.file);
  const packSizeBadge = metadataText.match(SIZE_BADGE_RE.pack);
  const sizeBytes = Number.isSafeInteger(explicitSize) && explicitSize >= 0
    ? explicitSize
    : fileSizeBadge ? parseSize(fileSizeBadge[1])
      : Number.isSafeInteger(videoSize) && videoSize > 0 ? videoSize
        : parseSize(packSizeBadge ? packSizeBadge[1] : null);

  const sourceTrackers = Array.isArray(rawStream.sources)
    ? rawStream.sources
      .map(x => String(x).replace(/^tracker:/, '').replace(ZERO_WIDTH_RE, '').trim())
      .filter(x => x && !/^dht:/i.test(x))
    : [];
  const magnetUrl = rawStream.magnet || rawStream.magnetUrl || null;
  const trackers = [...new Set([...sourceTrackers, ...trackersFromMagnet(magnetUrl)])];

  const quality = normalizeQuality(nameField, useFilename ? filename : titleField, rawStream.quality || rawStream.tag, filename);
  // Las líneas "💬 🇪🇸 🇬🇧 …" (TorrentClaw, Torz) son subtítulos, no audio.
  const languageText = metadataText.split('\n').filter(line => !SUBTITLE_LINE_RE.test(line)).join('\n');
  const detected = normalizeLanguage(rawStream.language, filename ? `${languageText}\n${filename}` : languageText);
  const externalProvider = sourceMatch
    ? sourceMatch[1].replace(/[.,]+$/, '')
    : provider.slug === 'ytztvio' && nameField && !/(?:4k|2160p|1440p|1080p|720p|480p)/i.test(nameField)
      ? nameField.trim()
      : null;
  // Idiomas implícitos del addon (Brazuca = doblado PT), salvo sus fuentes de anime.
  const exceptSource = (provider.defaultLanguagesExceptSources || [])
    .some(src => String(externalProvider || '').toLowerCase().includes(src));
  const languages = [...new Set([...detected, ...(exceptSource ? [] : provider.defaultLanguages || [])])];

  return {
    infoHash,
    title: releaseTitle,
    quality,
    seeders,
    sizeBytes,
    trackers,
    magnetUrl,
    languages,
    filename,
    fileIdx: rawStream.fileIdx ?? null,
    provider: provider.slug,
    providerName: provider.name,
    externalProvider,
  };
}

/**
 * Fusiona por infoHash los streams de todos los providers: combina trackers y
 * providers, conserva los mejores seeders/título/calidad sin inventar datos.
 * Acepta streams que ya traen `providers` (datos publicados reprocesados).
 */
export function mergeStreams(results) {
  const map = new Map();
  for (const r of results) {
    for (const s of r.streams) {
      const sProviders = Array.isArray(s.providers) && s.providers.length ? s.providers : [s.provider];
      const sNames = Array.isArray(s.providerNames) && s.providerNames.length ? s.providerNames : [s.providerName];
      const sExternal = Array.isArray(s.externalProviders) ? s.externalProviders : s.externalProvider ? [s.externalProvider] : [];
      const existing = map.get(s.infoHash);
      if (!existing) {
        map.set(s.infoHash, {
          ...s,
          providers: [...sProviders],
          providerNames: [...sNames],
          externalProviders: [...new Set(sExternal)],
          trackers: [...(s.trackers || [])],
          languages: [...(s.languages || [])],
          magnetUrl: s.magnetUrl || null,
        });
        continue;
      }
      // merge trackers
      const tset = new Set(existing.trackers);
      for (const t of s.trackers || []) tset.add(t);
      existing.trackers = [...tset];
      if (!existing.magnetUrl && s.magnetUrl) existing.magnetUrl = s.magnetUrl;
      if (!existing.filename && s.filename) existing.filename = s.filename;
      // merge providers
      sProviders.forEach((slug, i) => {
        if (!existing.providers.includes(slug)) { existing.providers.push(slug); existing.providerNames.push(sNames[i] ?? slug); }
      });
      for (const ext of sExternal) if (!existing.externalProviders.includes(ext)) existing.externalProviders.push(ext);
      // choose best seeders/title/quality; fill whatever is still unknown
      if ((s.seeders ?? -1) > (existing.seeders ?? -1)) {
        existing.seeders = s.seeders;
        existing.title = s.title;
        existing.quality = s.quality || existing.quality;
        existing.sizeBytes = s.sizeBytes ?? existing.sizeBytes;
        existing.magnetUrl = s.magnetUrl || existing.magnetUrl;
      } else {
        if (s.quality && !existing.quality) existing.quality = s.quality;
        if (existing.sizeBytes == null && s.sizeBytes != null) existing.sizeBytes = s.sizeBytes;
      }
      if (existing.fileIdx == null && s.fileIdx != null) existing.fileIdx = s.fileIdx;
      // Antes se perdían los idiomas del segundo addon cuando este solo aportaba la calidad.
      existing.languages = [...new Set([...existing.languages, ...(s.languages || [])])];
    }
  }
  return [...map.values()];
}
