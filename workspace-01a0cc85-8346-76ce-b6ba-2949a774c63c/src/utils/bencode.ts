import crypto from 'crypto';

/**
 * Parses a bencoded BitTorrent file buffer and extracts the SHA-1 info_hash.
 * According to BEP 0003 (BitTorrent Protocol Specification), the info_hash is
 * the 20-byte SHA-1 hash of the bencoded value of the 'info' key in the metainfo file.
 */
export function extractInfoHashFromTorrentBuffer(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 20) return null;

  // Search for the '4:info' dictionary key in the buffer
  const infoKey = Buffer.from('4:info');
  const index = buffer.indexOf(infoKey);
  if (index === -1) return null;

  const startIndex = index + 6; // '4:info' is 6 bytes
  if (startIndex >= buffer.length || buffer[startIndex] !== 0x64) {
    // 0x64 is ASCII 'd' for dictionary
    return null;
  }

  // Traverse the bencoded dictionary to locate its matching closing 'e'
  let depth = 0;
  let i = startIndex;

  while (i < buffer.length) {
    const byte = buffer[i];

    if (byte === 0x64 || byte === 0x6c) {
      // 'd' (dict) or 'l' (list)
      depth++;
      i++;
    } else if (byte === 0x69) {
      // 'i' (integer): format is i<number>e
      i++;
      while (i < buffer.length && buffer[i] !== 0x65) {
        i++;
      }
      i++; // skip 'e'
    } else if (byte >= 0x30 && byte <= 0x39) {
      // '0'-'9' (string length prefix): format is <length>:<raw bytes>
      let lenStr = '';
      while (i < buffer.length && buffer[i] >= 0x30 && buffer[i] <= 0x39) {
        lenStr += String.fromCharCode(buffer[i]);
        i++;
      }
      if (buffer[i] === 0x3a) {
        // ':'
        i++; // skip ':'
        const strLen = parseInt(lenStr, 10);
        i += strLen; // skip string data bytes
      } else {
        // Malformed bencoding
        return null;
      }
    } else if (byte === 0x65) {
      // 'e' (end of dictionary or list)
      depth--;
      i++;
      if (depth === 0) {
        // Complete bencoded 'info' dictionary found from startIndex to i
        const infoDictionarySlice = buffer.subarray(startIndex, i);
        return crypto.createHash('sha1').update(infoDictionarySlice).digest('hex').toLowerCase();
      }
    } else {
      i++;
    }
  }

  return null;
}
