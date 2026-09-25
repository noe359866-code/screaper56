import crypto from 'crypto';

/**
 * Skips a single bencoded item starting at the given index and returns the index immediately after it.
 * Returns -1 if the bencoded structure is malformed.
 */
function skipBencodedItem(buffer: Buffer, startIndex: number): number {
  let i = startIndex;
  if (i >= buffer.length) return -1;

  const byte = buffer[i];

  // Integer: i<number>e
  if (byte === 0x69) {
    i++;
    while (i < buffer.length && buffer[i] !== 0x65) {
      i++;
    }
    if (i >= buffer.length) return -1;
    return i + 1; // Skip 'e'
  } 
  // List ('l') or Dictionary ('d')
  else if (byte === 0x6c || byte === 0x64) {
    i++; // Skip 'l' or 'd'
    let depth = 1;
    while (i < buffer.length && depth > 0) {
      const nextByte = buffer[i];
      if (nextByte === 0x65) { // 'e'
        depth--;
        i++;
      } else {
        const nextI = skipBencodedItem(buffer, i);
        if (nextI === -1) return -1;
        i = nextI;
      }
    }
    return depth === 0 ? i : -1;
  } 
  // String: <length>:<data>
  else if (byte >= 0x30 && byte <= 0x39) {
    let colonIndex = -1;
    for (let j = i; j < Math.min(i + 20, buffer.length); j++) {
      if (buffer[j] === 0x3a) { // ':'
        colonIndex = j;
        break;
      }
    }
    if (colonIndex === -1) return -1;

    const lenStr = buffer.toString('utf8', i, colonIndex);
    const strLen = parseInt(lenStr, 10);
    if (isNaN(strLen) || strLen < 0) return -1;

    const dataStart = colonIndex + 1;
    const nextI = dataStart + strLen;
    if (nextI > buffer.length) return -1;
    return nextI;
  } 
  else {
    return -1; // Invalid bencode token
  }
}

/**
 * Parses a bencoded BitTorrent file buffer and extracts the SHA-1 info_hash safely.
 * According to BEP 0003, the info_hash is the 20-byte SHA-1 hash of the bencoded 
 * value of the 'info' key in the metainfo file.
 */
export function extractInfoHashFromTorrentBuffer(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 10) return null;

  // The root of a valid .torrent file must be a bencoded dictionary starting with 'd' (0x64)
  if (buffer[0] !== 0x64) return null;

  let i = 1; // Skip root 'd'

  while (i < buffer.length) {
    if (buffer[i] === 0x65) {
      // End of root dictionary ('e') without finding 'info'
      break;
    }

    // 1. Parse the dictionary key (must be a bencoded string)
    const keyStart = i;
    const keyEnd = skipBencodedItem(buffer, keyStart);
    if (keyEnd === -1) return null;

    // Find the colon separating length and string data for the key
    let colonIndex = -1;
    for (let j = keyStart; j < Math.min(keyStart + 20, keyEnd); j++) {
      if (buffer[j] === 0x3a) {
        colonIndex = j;
        break;
      }
    }
    if (colonIndex === -1) return null;

    // Fast check if the key bytes spell 'info' (length 4, bytes: i, n, f, o)
    const isInfoKey = (
      keyEnd - (colonIndex + 1) === 4 &&
      buffer[colonIndex + 1] === 0x69 && // 'i'
      buffer[colonIndex + 2] === 0x6e && // 'n'
      buffer[colonIndex + 3] === 0x66 && // 'f'
      buffer[colonIndex + 4] === 0x6f    // 'o'
    );

    // 2. Parse the corresponding value
    const valueStart = keyEnd;
    const valueEnd = skipBencodedItem(buffer, valueStart);
    if (valueEnd === -1) return null;

    if (isInfoKey) {
      // Exactly slice the raw bencoded 'info' dictionary bytes (zero-copy subarray)
      const infoDictionarySlice = buffer.subarray(valueStart, valueEnd);
      return crypto.createHash('sha1').update(infoDictionarySlice).digest('hex').toLowerCase();
    }

    // Move pointer to the next key-value pair in the root dictionary
    i = valueEnd;
  }

  return null;
}
