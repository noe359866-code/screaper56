/**
 * BitTorrent Magnet URI utility module.
 * Parses, extracts, validates, and normalizes 40-character SHA1 info hashes,
 * handling both hex-encoded and Base32-encoded BTIH representations.
 */

// Base32 decoding alphabet (RFC 4648)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodes a 32-character Base32 string into a 40-character lowercase hex string.
 */
export function base32ToHex(base32Str: string): string {
  const clean = base32Str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length !== 32) {
    throw new Error(`Invalid Base32 infohash length: ${clean.length} (expected 32)`);
  }

  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = BASE32_ALPHABET.indexOf(clean[i]);
    if (val === -1) {
      throw new Error(`Invalid Base32 character: ${clean[i]}`);
    }
    bits += val.toString(2).padStart(5, '0');
  }

  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    const chunk = bits.substring(i, i + 4);
    hex += parseInt(chunk, 2).toString(16);
  }

  return hex.substring(0, 40).toLowerCase();
}

/**
 * Normalizes any infohash candidate string to standard 40-character lowercase hex.
 * Handles:
 * - 40-char Hex (e.g. "9d86667f49f42712909c2888d346b37a17c44191")
 * - 32-char Base32 (e.g. "TWEGM72J6QRRE4U4FBENGRVTOIN4IQMR")
 */
export function normalizeInfoHash(rawHash: string): string | null {
  if (!rawHash) return null;
  const clean = rawHash.trim().replace(/^urn:btih:/i, '');

  // 40-character Hex
  if (/^[0-9a-fA-F]{40}$/.test(clean)) {
    return clean.toLowerCase();
  }

  // 32-character Base32
  if (/^[2-7a-zA-Z]{32}$/.test(clean)) {
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
 * Parses a magnet URI string into its components.
 */
export function parseMagnetUri(magnetUri: string): ParsedMagnet | null {
  if (!magnetUri || !magnetUri.startsWith('magnet:?')) {
    return null;
  }

  const query = magnetUri.substring('magnet:?'.length);
  const params = new URLSearchParams(query);

  const xt = params.get('xt');
  if (!xt) return null;

  const rawHash = xt.replace(/^urn:btih:/i, '');
  const infoHash = normalizeInfoHash(rawHash);
  if (!infoHash) return null;

  const displayName = params.get('dn') || undefined;
  const trackers = params.getAll('tr');

  return {
    infoHash,
    displayName,
    trackers,
    exactTopic: xt
  };
}

/**
 * Assembles a standard Magnet URI from an infohash, title, and optional tracker list.
 */
export function buildMagnetUri(
  infoHash: string,
  title?: string,
  trackers: string[] = []
): string {
  const normHash = normalizeInfoHash(infoHash);
  if (!normHash) {
    throw new Error(`Cannot build magnet: invalid infohash "${infoHash}"`);
  }

  const defaultTrackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.openbittorrent.com:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.demonii.com:1337/announce'
  ];

  const mergedTrackers = Array.from(new Set([...trackers, ...defaultTrackers]));
  let uri = `magnet:?xt=urn:btih:${normHash}`;

  if (title) {
    uri += `&dn=${encodeURIComponent(title)}`;
  }

  for (const tr of mergedTrackers) {
    uri += `&tr=${encodeURIComponent(tr)}`;
  }

  return uri;
}
