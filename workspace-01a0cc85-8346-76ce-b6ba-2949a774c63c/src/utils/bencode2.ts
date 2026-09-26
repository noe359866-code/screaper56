import { createHash } from 'node:crypto';

export interface ParsedTorrentFile {
  infoHash: string;
  name: string;
  sizeBytes: number;
  primaryTracker: string | null;
  trackers: string[];
}

type Value = Buffer | number | Value[] | { [key: string]: Value };
const isDict = (v: Value | undefined): v is { [key: string]: Value } =>
  !!v && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v);

/** Parse the entire metainfo, hashing the original bytes of the ROOT info value.
 * Bounds/depth checks prevent malformed downloads (including HTML) hanging a worker.
 */
export function parseTorrentBuffer(buffer: Buffer): ParsedTorrentFile | null {
  if (!buffer.length || buffer.length > 10 * 1024 * 1024 || buffer[0] !== 100) return null;
  let pos = 0;
  let infoBytes: Buffer | undefined;
  function parse(depth = 0): Value {
    if (depth > 64 || pos >= buffer.length) throw new Error('Invalid bencode bounds');
    const token = buffer[pos];
    if (token === 105) {
      const end = buffer.indexOf(101, ++pos);
      if (end < 0) throw new Error('Unterminated integer');
      const text = buffer.toString('ascii', pos, end);
      if (!/^(0|-?[1-9]\d*)$/.test(text)) throw new Error('Invalid integer');
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw new Error('Unsafe integer');
      pos = end + 1;
      return value;
    }
    if (token === 108 || token === 100) {
      pos++;
      const list: Value[] = [];
      const dict: { [key: string]: Value } = Object.create(null);
      while (buffer[pos] !== 101) {
        if (token === 108) list.push(parse(depth + 1));
        else {
          const key = parse(depth + 1);
          if (!Buffer.isBuffer(key)) throw new Error('Invalid dictionary key');
          const name = key.toString('utf8');
          if (Object.hasOwn(dict, name)) throw new Error('Duplicate dictionary key');
          const start = pos;
          dict[name] = parse(depth + 1);
          if (depth === 0 && name === 'info') infoBytes = buffer.subarray(start, pos);
        }
      }
      pos++;
      return token === 108 ? list : dict;
    }
    const colon = buffer.indexOf(58, pos);
    if (colon < 0 || colon - pos > 10) throw new Error('Invalid string length');
    const text = buffer.toString('ascii', pos, colon);
    if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error('Invalid string');
    const end = colon + 1 + Number(text);
    if (end > buffer.length) throw new Error('Truncated string');
    const value = buffer.subarray(colon + 1, end);
    pos = end;
    return value;
  }
  try {
    const root = parse();
    if (pos !== buffer.length || !isDict(root) || !isDict(root.info) || !infoBytes) return null;
    const info = root.info;
    // v2-only metainfo cannot be represented by our v1 BTIH schema.
    if (info['meta version'] === 2 && !Buffer.isBuffer(info.pieces)) return null;
    const length = (v: Value | undefined): number => {
      if (typeof v !== 'number' || v < 0) throw new Error('Invalid file length');
      return v;
    };
    const sizeBytes = Array.isArray(info.files)
      ? info.files.reduce<number>((sum, file) => {
          if (!isDict(file)) throw new Error('Invalid file');
          return sum + length(file.length);
        }, 0)
      : length(info.length);
    if (!Number.isSafeInteger(sizeBytes)) return null;
    const text = (v: Value | undefined) => Buffer.isBuffer(v) ? v.toString('utf8') : '';
    const trackers = new Set<string>();
    if (text(root.announce)) trackers.add(text(root.announce));
    if (Array.isArray(root['announce-list'])) {
      for (const tier of root['announce-list']) {
        if (Array.isArray(tier)) for (const tr of tier) if (text(tr)) trackers.add(text(tr));
      }
    }
    return {
      infoHash: createHash('sha1').update(infoBytes).digest('hex'),
      name: text(info['name.utf-8']) || text(info.name), sizeBytes,
      trackers: [...trackers], primaryTracker: [...trackers][0] || null
    };
  } catch { return null; }
}
