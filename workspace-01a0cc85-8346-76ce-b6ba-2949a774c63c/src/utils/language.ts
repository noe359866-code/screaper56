/**
 * Language detection and validation module for BitTorrent releases.
 * 
 * Enforces business rule:
 * - Releases MUST contain Spanish audio (Castellano or Latino) OR Spanish subtitles.
 * - Dual/Multi-audio releases (e.g. ['Spanish', 'English']) are VALID and retained.
 * - Purely English (or other foreign languages without Spanish audio/subs) are DISCARDED.
 */

export interface DetectedLanguages {
  audio: string[];
  subtitles: string[];
}

// Canonical Spanish audio tags
const SPANISH_AUDIO_CANONICAL = 'Spanish';
const LATINO_AUDIO_CANONICAL = 'Spanish (Latino)';
const ENGLISH_AUDIO_CANONICAL = 'English';

/**
 * Detects audio and subtitle languages from title text, tags, and page metadata.
 */
export function detectLanguages(rawText: string, metadataHints: string[] = []): DetectedLanguages {
  const combinedText = [rawText, ...metadataHints].join(' ').toLowerCase();

  const audioSet = new Set<string>();
  const subtitlesSet = new Set<string>();

  // 1. Detect Spanish Latino Audio
  if (
    /\b(latino|lat|audio[\s._-]*latino|spanish[\s._-]*\(?latino\)?|lat[\s._-]*audio)\b/i.test(combinedText) ||
    /-(lat|latino)\b/i.test(rawText) ||
    /\[latino\]/i.test(combinedText)
  ) {
    audioSet.add(LATINO_AUDIO_CANONICAL);
  }

  // 2. Detect Castellano / Spanish Audio
  if (
    /\b(castellano|espa[ñn]ol|spanish|spa|esp|audio[\s._-]*castellano|audio[\s._-]*espa[ñn]ol)\b/i.test(combinedText) ||
    /-(cast|esp|spa)\b/i.test(rawText) ||
    /\[castellano\]/i.test(combinedText) ||
    /\[espa[ñn]ol\]/i.test(combinedText)
  ) {
    // Only add generic Spanish if not exclusively marked as Latino, or add alongside
    if (!audioSet.has(LATINO_AUDIO_CANONICAL) || /\b(castellano|espa[ñn]ol)\b/i.test(combinedText)) {
      audioSet.add(SPANISH_AUDIO_CANONICAL);
    }
  }

  // 3. Detect English Audio
  if (
    /\b(english|eng|audio[\s._-]*en|audio[\s._-]*english)\b/i.test(combinedText) ||
    /-(eng)\b/i.test(rawText) ||
    /\[english\]/i.test(combinedText)
  ) {
    audioSet.add(ENGLISH_AUDIO_CANONICAL);
  }

  // 4. Handle Dual / Multi-Audio indicators
  if (/\b(dual|dual[\s._-]*audio|multi[\s._-]*audio|tri[\s._-]*audio)\b/i.test(combinedText)) {
    // If dual/multi is specified and Spanish is present, English is almost universally the second track in western releases
    if (audioSet.has(SPANISH_AUDIO_CANONICAL) || audioSet.has(LATINO_AUDIO_CANONICAL)) {
      audioSet.add(ENGLISH_AUDIO_CANONICAL);
    } else if (audioSet.has(ENGLISH_AUDIO_CANONICAL)) {
      // If found in a Spanish source/tracker with "Dual", assume Spanish is the second track
      audioSet.add(SPANISH_AUDIO_CANONICAL);
    }
  }

  // 5. Detect Subtitles
  // Sub_ES / Spanish Subtitles
  if (
    /\b(sub_?es|subs?[\s._-]*es(?:p(?:a[ñn]ol)?)?|subtitulado[\s._-]*al?[\s._-]*espa[ñn]ol|vose|vos)\b/i.test(combinedText) ||
    /\[sub[._\-]?es\]/i.test(combinedText)
  ) {
    subtitlesSet.add('Sub_ES');
  }

  // Sub_LAT / Latino Subtitles
  if (
    /\b(sub_?lat|subs?[\s._-]*lat(?:ino)?|subtitulado[\s._-]*latino)\b/i.test(combinedText) ||
    /\[sub[._\-]?lat\]/i.test(combinedText)
  ) {
    subtitlesSet.add('Sub_LAT');
  }

  // Sub_EN / English Subtitles
  if (
    /\b(sub_?en|subs?[\s._-]*en(?:g(?:lish)?)?)\b/i.test(combinedText) ||
    /\[sub[._\-]?en\]/i.test(combinedText)
  ) {
    subtitlesSet.add('Sub_EN');
  }

  // Multi-Subs
  if (
    /\b(multi[\s._-]*subs?|multisubs?|multiple[\s._-]*subtitles)\b/i.test(combinedText)
  ) {
    subtitlesSet.add('Multi-Subs');
  }

  // Generic Subbed / Subtitulado
  if (
    /\b(subbed|subtitulado)\b/i.test(combinedText) &&
    subtitlesSet.size === 0
  ) {
    subtitlesSet.add('Subtitulado');
  }

  // If no audio is identified yet but the source is a purely Spanish site (divxtotal, pelispanda)
  if (audioSet.size === 0 && /\b(divxtotal|pelispanda)\b/i.test(combinedText)) {
    audioSet.add(SPANISH_AUDIO_CANONICAL);
  }

  return {
    audio: Array.from(audioSet),
    subtitles: Array.from(subtitlesSet)
  };
}

/**
 * MANDATORY SELECTION RULE ENFORCEMENT:
 * - Must have Spanish audio (Castellano or Latino) OR Spanish subtitles.
 * - Releases exclusively in English or other languages without Spanish MUST be discarded.
 * 
 * @returns true if the release satisfies the Spanish content constraint, false otherwise.
 */
export function hasValidSpanishRelease(audio: string[], subtitles: string[]): boolean {
  // Check Spanish audio presence
  const hasSpanishAudio = audio.some(a => {
    const val = a.toLowerCase();
    return (
      val === 'spanish' ||
      val === 'spanish (latino)' ||
      val === 'castellano' ||
      val === 'español' ||
      val === 'latino' ||
      val === 'spa' ||
      val === 'esp' ||
      val === 'lat'
    );
  });

  // Check Spanish subtitle presence
  const hasSpanishSubs = subtitles.some(s => {
    const val = s.toLowerCase();
    return (
      val === 'sub_es' ||
      val === 'sub_lat' ||
      val === 'multi-subs' ||
      val === 'subtitulado' ||
      val === 'spanish' ||
      val === 'spanish (latino)' ||
      val === 'castellano' ||
      val === 'latino' ||
      val === 'español'
    );
  });

  return hasSpanishAudio || hasSpanishSubs;
}
