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
// PRE-COMPILED REGULAR EXPRESSIONS (For extreme performance in loops)
// ============================================================================
const REGEX_LATINO = /\b(latino|lat|audio[\s._-]*latino|spanish[\s._-]*\(?latino\)?|lat[\s._-]*audio|espanol[\s._-]*latino|español[\s._-]*latino)\b/i;
const REGEX_LATINO_RAW = /-(lat|latino)\b/i;
const REGEX_LATINO_BRACKET = /\[latino\]/i;

const REGEX_CAST = /\b(castellano|espa[ñn]ol|spanish|spa|esp|audio[\s._-]*castellano|audio[\s._-]*espa[ñn]ol)\b/i;
const REGEX_CAST_RAW = /-(cast|esp|spa)\b/i;
const REGEX_CAST_BRACKET = /\[(castellano|espa[ñn]ol)\]/i;
const REGEX_CAST_EXACT = /\b(castellano|espa[ñn]ol)\b/i;

const REGEX_ENG = /\b(english|eng|ingl[eé]s|audio[\s._-]*en|audio[\s._-]*english)\b/i;
const REGEX_ENG_RAW = /-(eng)\b/i;
const REGEX_ENG_BRACKET = /\[english\]/i;

const REGEX_DUAL = /\b(dual|dual[\s._-]*audio|multi[\s._-]*audio|tri[\s._-]*audio)\b/i;

const REGEX_SUB_ES = /\b(sub_?es|subs?[\s._-]*es(?:p(?:a[ñn]ol)?)?|subtitulado[\s._-]*al?[\s._-]*espa[ñn]ol|vose|vos)\b/i;
const REGEX_SUB_ES_BRACKET = /\[sub[._\-]?es\]/i;

const REGEX_SUB_LAT = /\b(sub_?lat|subs?[\s._-]*lat(?:ino)?|subtitulado[\s._-]*latino)\b/i;
const REGEX_SUB_LAT_BRACKET = /\[sub[._\-]?lat\]/i;

const REGEX_SUB_EN = /\b(sub_?en|subs?[\s._-]*en(?:g(?:lish)?)?|english[\s._-]*subtitles)\b/i;
const REGEX_SUB_EN_BRACKET = /\[sub[._\-]?en\]/i;

const REGEX_MULTI_SUB = /\b(multi[\s._-]*subs?|multisubs?|multiple[\s._-]*subtitles)\b/i;
const REGEX_GENERIC_SUB = /\b(subbed|subtitulado)\b/i;

const REGEX_ES_TRACKERS = /\b(pelispanda|mejortorrent|elitetorrent)\b/i;
const REGEX_OTHER_FOREIGN = /\b(french|truefrench|vostfr|german|deutsch|hindi|tamil|telugu|malayalam|korean|japanese|russian|polish|turkish|mandarin)\b/i;

/**
 * Detects audio and subtitle languages from title text, tags, and page metadata.
 */
export function detectLanguages(rawText: string, metadataHints: string[] = [], inferDefaults = true): DetectedLanguages {
  const combinedText = [rawText, ...metadataHints].join(' ');

  const audioSet = new Set<string>();
  const subtitlesSet = new Set<string>();

  // 1. Detect Spanish Latino Audio
  if (REGEX_LATINO.test(combinedText) || REGEX_LATINO_RAW.test(rawText) || REGEX_LATINO_BRACKET.test(combinedText)) {
    audioSet.add(LATINO_AUDIO_CANONICAL);
  }

  // 2. Detect Castellano / Spanish Audio
  if (REGEX_CAST.test(combinedText) || REGEX_CAST_RAW.test(rawText) || REGEX_CAST_BRACKET.test(combinedText)) {
    // Si ya es Latino, NO lo añadimos como Castellano a menos que el texto diga explícitamente "Castellano" o "Español".
    // Esto previene que un título que solo dice "Spanish (Latino)" active ambos audios.
    if (!audioSet.has(LATINO_AUDIO_CANONICAL) || REGEX_CAST_EXACT.test(combinedText)) {
      audioSet.add(SPANISH_AUDIO_CANONICAL);
    }
  }

  // 3. Detect English Audio
  if (REGEX_ENG.test(combinedText) || REGEX_ENG_RAW.test(rawText) || REGEX_ENG_BRACKET.test(combinedText)) {
    audioSet.add(ENGLISH_AUDIO_CANONICAL);
  }

  // 4. Handle Dual / Multi-Audio indicators
  if (inferDefaults && REGEX_DUAL.test(combinedText)) {
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
  for (const a of audio) {
    if (VALID_AUDIO_TAGS.has(a.toLowerCase())) return true;
  }
  for (const s of subtitles) {
    if (VALID_SUB_TAGS.has(s.toLowerCase())) return true;
  }
  return false;
}
