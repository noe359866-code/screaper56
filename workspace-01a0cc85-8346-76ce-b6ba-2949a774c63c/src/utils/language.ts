/**
 * Language detection and validation module for BitTorrent releases.
 * 
 * Enforces business rule:
 * - Releases MUST contain Spanish audio (Castellano or Latino) OR English audio
 *   OR Spanish / English subtitles.
 * - Dual/Multi-audio releases (e.g. ['Spanish', 'English']) are VALID and retained.
 * - Exclusively other foreign languages (e.g. French, German, Russian, Hindi)
 *   without Spanish or English audio/subs are DISCARDED.
 */

export interface DetectedLanguages {
  audio: string[];
  subtitles: string[];
}


// Canonical Audio tags
export const SPANISH_AUDIO_CANONICAL = 'Spanish';
export const LATINO_AUDIO_CANONICAL = 'Spanish (Latino)';
export const ENGLISH_AUDIO_CANONICAL = 'English';

// ============================================================================
// TAG CANONICALISATION
// ============================================================================
//
// Adapters, page fichas and title heuristics all emit language labels, and they
// never agreed on a spelling ('Castellano', 'español', 'SPA', 'Spanish'). Two
// spellings of the same language survived deduplication, split Supabase rows and
// made `audio` arrays useless for filtering. Everything is funnelled through the
// maps below, so one language always produces exactly one tag.

const AUDIO_ALIASES: ReadonlyMap<string, string> = new Map(Object.entries({
  // Peninsular Spanish
  spanish: SPANISH_AUDIO_CANONICAL,
  castellano: SPANISH_AUDIO_CANONICAL,
  'español': SPANISH_AUDIO_CANONICAL,
  espanol: SPANISH_AUDIO_CANONICAL,
  spa: SPANISH_AUDIO_CANONICAL,
  esp: SPANISH_AUDIO_CANONICAL,
  es: SPANISH_AUDIO_CANONICAL,
  'audio castellano': SPANISH_AUDIO_CANONICAL,
  'audio español': SPANISH_AUDIO_CANONICAL,
  'audio espanol': SPANISH_AUDIO_CANONICAL,
  // Latin American Spanish
  latino: LATINO_AUDIO_CANONICAL,
  lat: LATINO_AUDIO_CANONICAL,
  'spanish (latino)': LATINO_AUDIO_CANONICAL,
  'español latino': LATINO_AUDIO_CANONICAL,
  'espanol latino': LATINO_AUDIO_CANONICAL,
  'audio latino': LATINO_AUDIO_CANONICAL,
  'latino audio': LATINO_AUDIO_CANONICAL,
  'es-419': LATINO_AUDIO_CANONICAL,
  'es-mx': LATINO_AUDIO_CANONICAL,
  'es-lat': LATINO_AUDIO_CANONICAL,
  // English
  english: ENGLISH_AUDIO_CANONICAL,
  eng: ENGLISH_AUDIO_CANONICAL,
  en: ENGLISH_AUDIO_CANONICAL,
  'inglés': ENGLISH_AUDIO_CANONICAL,
  ingles: ENGLISH_AUDIO_CANONICAL,
  'audio english': ENGLISH_AUDIO_CANONICAL,
  'english audio': ENGLISH_AUDIO_CANONICAL
}));

const SUBTITLE_ALIASES: ReadonlyMap<string, string> = new Map(Object.entries({
  sub_es: 'Sub_ES',
  subes: 'Sub_ES',
  'sub-es': 'Sub_ES',
  'subs es': 'Sub_ES',
  'sub esp': 'Sub_ES',
  'sub espanol': 'Sub_ES',
  'sub español': 'Sub_ES',
  spanish: 'Sub_ES',
  castellano: 'Sub_ES',
  'español': 'Sub_ES',
  espanol: 'Sub_ES',
  vose: 'Sub_ES',
  sub_lat: 'Sub_LAT',
  sublat: 'Sub_LAT',
  'sub-lat': 'Sub_LAT',
  latino: 'Sub_LAT',
  sub_en: 'Sub_EN',
  suben: 'Sub_EN',
  'sub-en': 'Sub_EN',
  'subs en': 'Sub_EN',
  'sub eng': 'Sub_EN',
  english: 'Sub_EN',
  'inglés': 'Sub_EN',
  ingles: 'Sub_EN',
  'multi-subs': 'Multi-Subs',
  multisubs: 'Multi-Subs',
  'multi subs': 'Multi-Subs',
  multi: 'Multi-Subs',
  subtitulado: 'Subtitulado'
}));

function normalizeTagKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[\s_]+/g, m => (m.includes('_') ? '_' : ' '));
}

/**
 * Maps any Spanish/English audio spelling onto the canonical tag set.
 * Unknown languages are preserved verbatim (trimmed) so a French or Japanese
 * release is still stored honestly instead of being silently dropped.
 */
export function canonicalAudioTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = normalizeTagKey(trimmed);
  const mapped = AUDIO_ALIASES.get(key);
  if (mapped) return mapped;
  // "Spanish (Latino)" survives different bracket/spacing spellings.
  if (/^spanish\s*\(?\s*latino\s*\)?$/i.test(trimmed)) return LATINO_AUDIO_CANONICAL;
  if (/^audio[\s._-]*(castellano|espa[ñn]ol)$/i.test(trimmed)) return SPANISH_AUDIO_CANONICAL;
  if (/^audio[\s._-]*(latino|lat)$/i.test(trimmed)) return LATINO_AUDIO_CANONICAL;
  return trimmed;
}

/** Maps any subtitle spelling onto `Sub_ES` / `Sub_LAT` / `Sub_EN` / `Multi-Subs`. */
export function canonicalSubtitleTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = normalizeTagKey(trimmed);
  const mapped = SUBTITLE_ALIASES.get(key);
  if (mapped) return mapped;
  if (/^subt[ií]tulos?\s*:\s*(espa[ñn]ol|castellano|spanish)\b/i.test(trimmed)) return 'Sub_ES';
  if (/^subt[ií]tulos?\s*:\s*(ingl[eé]s|english)\b/i.test(trimmed)) return 'Sub_EN';
  if (/^subt[ií]tulos?\s*:\s*latino\b/i.test(trimmed)) return 'Sub_LAT';
  return trimmed;
}

// ============================================================================
// PRE-COMPILED REGULAR EXPRESSIONS (For extreme performance in loops)
// ============================================================================
const REGEX_LATINO = /\b(latino|lat|audio[\s._-]*latino|spanish[\s._-]*\(?latino\)?|lat[\s._-]*audio|espanol[\s._-]*latino|español[\s._-]*latino)\b/i;
const REGEX_LATINO_RAW = /-(lat|latino)\b/i;
const REGEX_LATINO_BRACKET = /\[latino\]/i;

const REGEX_CAST = /\b(castellano|espa[ñn]ol|spanish|spa|esp|audio[\s._-]*castellano|audio[\s._-]*espa[ñn]ol)\b/i;
const REGEX_CAST_RAW = /-(cast|esp|spa)\b/i;
const REGEX_CAST_BRACKET = /\[(castellano|espa[ñn]ol)\]/i;
const REGEX_CAST_EXACT = /\b(castellano|espa[ñn]ol)\b/i;

// "Audio en 5.1", "Audio en Dual", "Audio en Subs..." are CHANNEL/side notes of
// Spanish fichas, not English audio: the `en` alternative must not fire when a
// digit or another qualifier follows ("Audio en español" was already excluded).
const REGEX_ENG = /\b(english|eng|ingl[eé]s|audio[\s._-]*en(?![\s._-]*(?:espa|castellano|latino|dual|sub|\d))|audio[\s._-]*english)\b/i;
const REGEX_ENG_RAW = /-(eng)\b/i;
const REGEX_ENG_BRACKET = /\[english\]/i;

const REGEX_DUAL = /\b(dual|dual[\s._-]*audio|multi[\s._-]*audio|tri[\s._-]*audio)\b/i;

const REGEX_SUB_ES = /\b(sub_?es|subs?[\s._-]*es(?:p(?:a[ñn]ol)?)?|subtitulado[\s._-]*al?[\s._-]*espa[ñn]ol|vose)\b/i;
const REGEX_SUB_ES_BRACKET = /\[sub[._\-]?es\]/i;

const REGEX_SUB_LAT = /\b(sub_?lat|subs?[\s._-]*lat(?:ino)?|subtitulado[\s._-]*latino)\b/i;
const REGEX_SUB_LAT_BRACKET = /\[sub[._\-]?lat\]/i;

const REGEX_SUB_EN = /\b(sub_?en|subs?[\s._-]*en(?:g(?:lish)?)?(?![\s._-]*(?:espa|castellano|latino))|english[\s._-]*subtitles)\b/i;
const REGEX_SUB_EN_BRACKET = /\[sub[._\-]?en\]/i;

const REGEX_MULTI_SUB = /\b(multi[\s._-]*subs?|multisubs?|multiple[\s._-]*subtitles)\b/i;
const REGEX_GENERIC_SUB = /\b(subbed|subtitulado)\b/i;

const REGEX_ES_TRACKERS = /\b(pelispanda|mejortorrent|elitetorrent|dontorrent|wolftorrent|sinsitio|t0rrenta|estrenostorrent)\b/i;
const REGEX_OTHER_FOREIGN = /\b(french|truefrench|vostfr|german|deutsch|hindi|tamil|telugu|malayalam|korean|japanese|russian|polish|turkish|mandarin)\b/i;

// Subtitle phrases ("Sub ESP", "Subs English", "Subtitulado en español") must
// not be read as AUDIO evidence: `esp`/`eng`/`spanish` inside them used to add
// a phantom Spanish/English audio track.
const REGEX_SUBTITLE_PHRASES = new RegExp(
  [
    '\\bsubt[ií]tulos?\\s*:?[\\s._-]*(?:en[\\s._-]+)?(?:espa[ñn]ol|castellano|spanish|latino|ingl[eé]s|english|es|en|esp|eng|lat)\\b',
    '\\bsubtitulad[oa]s?[\\s._-]*(?:al?|en)?[\\s._-]*(?:espa[ñn]ol|castellano|latino|ingl[eé]s)?\\b',
    '\\bsubs?[\\s._-]*(?:en[\\s._-]+)?(?:espa[ñn]ol|castellano|spanish|latino|ingl[eé]s|english|esp|eng|es|en|lat)\\b',
    '\\b(?:english|spanish)[\\s._-]*subs?(?:titles)?\\b'
  ].join('|'),
  'gi'
);

/**
 * Detects audio and subtitle languages from title text, tags, and page metadata.
 */
export function detectLanguages(rawText: string, metadataHints: string[] = [], inferDefaults = true): DetectedLanguages {
  const combinedText = [rawText, ...metadataHints].join(' ');
  // Audio detection runs on the text WITHOUT subtitle phrases.
  const audioText = combinedText.replace(REGEX_SUBTITLE_PHRASES, ' ');
  const audioRaw = String(rawText ?? '').replace(REGEX_SUBTITLE_PHRASES, ' ');

  const audioSet = new Set<string>();
  const subtitlesSet = new Set<string>();

  // 1. Detect Spanish Latino Audio
  if (REGEX_LATINO.test(audioText) || REGEX_LATINO_RAW.test(audioRaw) || REGEX_LATINO_BRACKET.test(audioText)) {
    audioSet.add(LATINO_AUDIO_CANONICAL);
  }

  // 2. Detect Castellano / Spanish Audio
  if (REGEX_CAST.test(audioText) || REGEX_CAST_RAW.test(audioRaw) || REGEX_CAST_BRACKET.test(audioText)) {
    // Si ya es Latino, NO lo añadimos como Castellano a menos que el texto diga explícitamente "Castellano" o "Español".
    // Esto previene que un título que solo dice "Spanish (Latino)" active ambos audios.
    if (!audioSet.has(LATINO_AUDIO_CANONICAL) || REGEX_CAST_EXACT.test(audioText)) {
      audioSet.add(SPANISH_AUDIO_CANONICAL);
    }
  }

  // 3. Detect English Audio
  if (REGEX_ENG.test(audioText) || REGEX_ENG_RAW.test(audioRaw) || REGEX_ENG_BRACKET.test(audioText)) {
    audioSet.add(ENGLISH_AUDIO_CANONICAL);
  }

  // 4. Handle Dual / Multi-Audio indicators
  if (inferDefaults && REGEX_DUAL.test(audioText)) {
    if (audioSet.has(SPANISH_AUDIO_CANONICAL) || audioSet.has(LATINO_AUDIO_CANONICAL)) {
      audioSet.add(ENGLISH_AUDIO_CANONICAL);
    } else if (audioSet.has(ENGLISH_AUDIO_CANONICAL)) {
      audioSet.add(SPANISH_AUDIO_CANONICAL);
    } else {
      audioSet.add(ENGLISH_AUDIO_CANONICAL);
    }
  }

  // 5. Detect Subtitles
  if (REGEX_SUB_ES.test(combinedText) || REGEX_SUB_ES_BRACKET.test(combinedText)) subtitlesSet.add('Sub_ES');
  if (REGEX_SUB_LAT.test(combinedText) || REGEX_SUB_LAT_BRACKET.test(combinedText)) subtitlesSet.add('Sub_LAT');
  if (REGEX_SUB_EN.test(combinedText) || REGEX_SUB_EN_BRACKET.test(combinedText)) subtitlesSet.add('Sub_EN');
  if (REGEX_MULTI_SUB.test(combinedText)) subtitlesSet.add('Multi-Subs');

  if (REGEX_GENERIC_SUB.test(combinedText) && subtitlesSet.size === 0) {
    subtitlesSet.add('Subtitulado');
  }

  // 6. Default Fallback Logic when no explicit audio tag is in the title
  if (inferDefaults && audioSet.size === 0) {
    // If from a purely Spanish tracker
    if (REGEX_ES_TRACKERS.test(combinedText)) {
      audioSet.add(SPANISH_AUDIO_CANONICAL);
    } else {
      // Check if release is explicitly tagged with another foreign language without English or Spanish
      if (!REGEX_OTHER_FOREIGN.test(combinedText)) {
        // Western / international releases on YTS, EZTV, 1337x, TPB, TorrentGalaxy default to English
        audioSet.add(ENGLISH_AUDIO_CANONICAL);
      }
    }
  }

  return {
    audio: Array.from(audioSet),
    subtitles: Array.from(subtitlesSet)
  };
}

/**
 * MANDATORY SELECTION RULE ENFORCEMENT:
 * - Must have Spanish audio (Castellano or Latino) OR English audio
 *   OR Spanish / English subtitles.
 * - Releases exclusively in other foreign languages (e.g. Russian, Hindi, French)
 *   without Spanish or English are discarded.
 */
export function hasValidSpanishRelease(audio: string[], subtitles: string[]): boolean {
  return hasValidLanguageRelease(audio, subtitles);
}

// Optimización: Usamos Sets para comprobaciones de idioma ultrarrápidas
const VALID_AUDIO_TAGS = new Set([
  'spanish', 'spanish (latino)', 'castellano', 'español', 'latino', 'spa', 'esp', 'lat',
  'english', 'eng', 'en', 'inglés', 'ingles'
]);

const VALID_SUB_TAGS = new Set([
  'sub_es', 'sub_lat', 'multi-subs', 'subtitulado', 'spanish', 'spanish (latino)', 
  'castellano', 'latino', 'español', 'sub_en', 'english', 'eng'
]);

export function hasValidLanguageRelease(audio: string[], subtitles: string[]): boolean {
  const audioList = Array.isArray(audio) ? audio : [];
  const subtitleList = Array.isArray(subtitles) ? subtitles : [];

  for (const value of audioList) {
    if (typeof value !== 'string') continue;
    const canonical = canonicalAudioTag(value);
    if (canonical && VALID_AUDIO_TAGS.has(canonical.toLowerCase())) return true;
  }
  for (const value of subtitleList) {
    if (typeof value !== 'string') continue;
    const canonical = canonicalSubtitleTag(value);
    if (canonical && VALID_SUB_TAGS.has(canonical.toLowerCase())) return true;
  }
  return false;
}
