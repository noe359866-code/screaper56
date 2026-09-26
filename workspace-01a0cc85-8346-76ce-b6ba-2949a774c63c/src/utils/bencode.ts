import { parseTorrentBuffer } from './bencode2.js';

/** Compatibility entry point: validation and raw-info hashing live in one parser. */
export function extractInfoHashFromTorrentBuffer(buffer: Buffer): string | null {
  return parseTorrentBuffer(buffer)?.infoHash ?? null;
}
