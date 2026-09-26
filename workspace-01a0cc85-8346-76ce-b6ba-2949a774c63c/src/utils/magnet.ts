/**
 * BitTorrent Magnet URI utility module.
 * Parses, extracts, validates, and normalizes 40-character SHA1 info hashes,
 * handling both hex-encoded and Base32-encoded BTIH representations.
 */

// ============================================================================
// PRE-COMPILED LOOKUP TABLES & REGEX (Zero-allocation performance)
// ============================================================================

export const DEFAULT_TRACKERS: readonly string[] = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce'
]);

const REGEX_HEX_40 = /^[0-9a-fA-F]{40}$/;
const REGEX_BASE32_32 = /^[2-7a-zA-Z]{32}$/;
const REGEX_CLEAN_PREFIXES = /^(?:magnet:\?xt=)?(?:urn:btih:|urn:btmh:)?/i;
const REGEX_ENCODED_MAGNET = /^magnet%3a%3f/i;

// Precalculado para decodificación ultra rápida de Base32 a Bits (RFC 4648)
const BASE32_DECODE_MAP = new Int8Array(256).fill(-1);
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
for (let i = 0; i < BASE32_CHARS.length; i++) {
  BASE32_DECODE_MAP[BASE32_CHARS.charCodeAt(i)] = i;
  BASE32_DECODE_MAP[BASE32_CHARS.toLowerCase().charCodeAt(i)] = i;
}

// Precalculado para conversión de Bytes a Hexadecimal
const HEX_LOOKUP: string[] = new Array(256);
for (let i = 0; i < 256; i++) {
  HEX_LOOKUP[i] = i.toString(16).padStart(2, '0');
}

/**
 * Decodifica de forma ultra-rápida un string Base32 de 32 caracteres a un Hexadecimal de 40 caracteres.
 * Utiliza operaciones bit a bit directas (Sin asignación excesiva de memoria/GC).
 */
export function base32ToHex(base32Str: string): string {
  if (base32Str.length !== 32) {
    throw new Error(`Invalid Base32 infohash length: ${base32Str.length} (expected 32)`);
  }

  let hex = '';

  // 32 caracteres Base32 = 160 bits = 20 bytes = 40 caracteres Hexadecimales.
  // Procesamos en 4 bloques de 8 caracteres (40 bits / 5 bytes por bloque).
  for (let i = 0; i < 32; i += 8) {
    const c0 = BASE32_DECODE_MAP[base32Str.charCodeAt(i)];
    const c1 = BASE32_DECODE_MAP[base32Str.charCodeAt(i + 1)];
    const c2 = BASE32_DECODE_MAP[base32Str.charCodeAt(i + 2)];
    const c3 = BASE32_DECODE_MAP[base32Str.charCodeAt(i + 3)];
    const c4 = BASE32_DECODE_MAP[base32Str.charCodeAt(i + 4)];
    const c5 = BASE32_DECODE_MAP[base32Str.charCodeAt(i + 5)];
    const c6 = BASE32_DECODE_MAP[base32Str.charCodeAt(i + 6)];
    const c7 = BASE32_DECODE_MAP[base32Str.charCodeAt(i + 7)];

    if (c0 === -1 || c1 === -1 || c2 === -1 || c3 === -1 || c4 === -1 || c5 === -1 || c6 === -1 || c7 === -1) {
      throw new Error(`Invalid Base32 character encountered in: "${base32Str}"`);
    }

    const b0 = (c0 << 3) | (c1 >> 2);
    const b1 = ((c1 & 3) << 6) | (c2 << 1) | (c3 >> 4);
    const b2 = ((c3 & 15) << 4) | (c4 >> 1);
    const b3 = ((c4 & 1) << 7) | (c5 << 2) | (c6 >> 3);
    const b4 = ((c6 & 7) << 5) | c7;

    hex += HEX_LOOKUP[b0] + HEX_LOOKUP[b1] + HEX_LOOKUP[b2] + HEX_LOOKUP[b3] + HEX_LOOKUP[b4];
  }

  return hex;
}

/**
 * Normaliza cualquier variante de infohash a Hexadecimal estándar de 40 caracteres en minúsculas.
 * Soporta: Hex (40 chars), Base32 (32 chars), prefijos urn:btih:, o URIs Magnet completos.
 */
export function normalizeInfoHash(rawHash: string): string | null {
  if (typeof rawHash !== 'string' || !rawHash) return null;

  let clean = rawHash.trim();

  // Si se pasa un URI Magnet completo, delegar la extracción al parser
  if (clean.toLowerCase().includes('magnet:?')) {
    const parsed = parseMagnetUri(clean);
    return parsed ? parsed.infoHash : null;
  }

  // Limpiar prefijos comunes y caracteres envolventes (<>, {}, quotes)
  clean = clean
    .replace(/^[\{<"']|[\}>"']$/g, '')
    .replace(REGEX_CLEAN_PREFIXES, '')
    .trim();

  // Caso 1: 40-character Hex
  if (REGEX_HEX_40.test(clean)) {
    return clean.toLowerCase();
  }

  // Caso 2: 32-character Base32
  if (REGEX_BASE32_32.test(clean)) {
    try {
      return base32ToHex(clean);
    } catch {
      return null;
    }
  }

  return null;
}

export interface ParsedMagnet {
  infoHash: string; // 40-char lowercase hex
  displayName?: string;
  trackers: string[];
  exactTopic?: string;
}

/**
 * Parsea un string URI Magnet a sus componentes de manera robusta.
 */
export function parseMagnetUri(magnetUri: string): ParsedMagnet | null {
  if (typeof magnetUri !== 'string' || !magnetUri) return null;

  let uri = magnetUri.trim();

  // Auto-decodificar si el magnet viene completamente URL-encoded
  if (REGEX_ENCODED_MAGNET.test(uri)) {
    try {
      uri = decodeURIComponent(uri);
    } catch {
      // Ignorar error si el formato estaba malformado
    }
  }

  const queryIdx = uri.indexOf('?');
  if (queryIdx === -1 || !uri.substring(0, queryIdx).toLowerCase().startsWith('magnet:')) {
    return null;
  }

  const queryString = uri.substring(queryIdx + 1);
  if (!queryString) return null;

  let displayName: string | undefined;
  let rawBtihHash: string | null = null;
  let exactTopic: string | undefined;
  const trackersSet = new Set<string>();

  // Parser manual de parámetros para evitar el bug de '+' -> ' ' en trackers con URLSearchParams
  const pairs = queryString.split(/[&;]/);
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;

    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;

    const key = pair.substring(0, eqIdx).toLowerCase();
    const val = pair.substring(eqIdx + 1);

    if (!val) continue;

    if (key === 'xt') {
      const decodedXt = safeDecodeURIComponent(val);
      if (REGEX_CLEAN_PREFIXES.test(decodedXt)) {
        const hashCandidate = normalizeInfoHash(decodedXt);
        if (hashCandidate) {
          rawBtihHash = hashCandidate;
          exactTopic = decodedXt;
        }
      }
    } else if (key === 'dn') {
      try {
        displayName = decodeURIComponent(val.replace(/\+/g, ' ')).trim();
      } catch {
        displayName = val.trim();
      }
    } else if (key === 'tr') {
      const decodedTracker = safeDecodeURIComponent(val).trim();
      if (decodedTracker) {
        trackersSet.add(decodedTracker);
      }
    }
  }

  if (!rawBtihHash) return null;

  return {
    infoHash: rawBtihHash,
    displayName: displayName || undefined,
    trackers: Array.from(trackersSet),
    exactTopic
  };
}

export interface BuildMagnetOptions {
  includeDefaultTrackers?: boolean;
}

/**
 * Construye un URI Magnet estándar a partir de un infohash, título y trackers opcionales.
 */
export function buildMagnetUri(
  infoHash: string,
  title?: string,
  trackers: string[] = [],
  options: BuildMagnetOptions = { includeDefaultTrackers: true }
): string {
  const normHash = normalizeInfoHash(infoHash);
  if (!normHash) {
    throw new Error(`Cannot build magnet: invalid infohash "${infoHash}"`);
  }

  const combinedTrackers = options.includeDefaultTrackers !== false
    ? [...trackers, ...DEFAULT_TRACKERS]
    : trackers;

  const uniqueTrackers = new Set<string>();
  for (const tr of combinedTrackers) {
    if (tr && typeof tr === 'string') {
      uniqueTrackers.add(tr.trim());
    }
  }

  let uri = `magnet:?xt=urn:btih:${normHash}`;

  if (title && title.trim()) {
    uri += `&dn=${encodeURIComponent(title.trim())}`;
  }

  for (const tr of uniqueTrackers) {
    uri += `&tr=${safeEncodeURIComponent(tr)}`;
  }

  return uri;
}

/**
 * Decodifica de forma segura un componente de URI evitando fallos si ya está codificado o malformado.
 */
function safeEncodeURIComponent(str: string): string {
  try {
    // Si ya está codificado, primero lo decodifica para evitar doble codificación (%2520)
    return encodeURIComponent(decodeURIComponent(str));
  } catch {
    return encodeURIComponent(str);
  }
}
