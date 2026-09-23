import * as crypto from 'node:crypto';

export interface ParsedTorrentFile {
  infoHash: string; // 40 caracteres hexadecimales en minúsculas
  name: string;
  sizeBytes: number;
  primaryTracker: string | null;
  trackers: string[];
}

/**
 * Decodificador Bencode ligero y cálculo de SHA-1 info_hash (BEP 0003).
 */
export function parseTorrentBuffer(buf: Buffer): ParsedTorrentFile | null {
  if (!buf || buf.length < 20) return null;

  // 1. Ubicar la clave '4:info'
  const target = Buffer.from('4:info');
  const targetIdx = buf.indexOf(target);
  if (targetIdx === -1) return null;

  const startPos = targetIdx + target.length;
  if (buf[startPos] !== 0x64 /* 'd' */) {
    return null;
  }

  // 2. Medir el límite de bytes del diccionario 'info'
  let endPos: number;
  try {
    endPos = skipBencodeValue(buf, startPos);
  } catch {
    return null;
  }

  const infoSlice = buf.subarray(startPos, endPos);
  const infoHash = crypto.createHash('sha1').update(infoSlice).digest('hex').toLowerCase();

  // 3. Decodificar metadatos
  let decoded: Record<string, any> | null = null;
  try {
    decoded = decodeBencode(buf) as Record<string, any>;
  } catch {
    // Si falla el árbol completo, se continúa con info básica
  }

  const info = decoded?.info || {};

  let name = '';
  if (typeof info.name === 'string') {
    name = info.name;
  } else if (Buffer.isBuffer(info.name)) {
    name = info.name.toString('utf-8');
  }

  let sizeBytes = 0;
  if (typeof info.length === 'number') {
    sizeBytes = info.length;
  } else if (Array.isArray(info.files)) {
    for (const f of info.files) {
      if (typeof f?.length === 'number') {
        sizeBytes += f.length;
      }
    }
  }

  const trackers: string[] = [];
  let primaryTracker: string | null = null;

  if (typeof decoded?.announce === 'string') {
    primaryTracker = decoded.announce;
    trackers.push(decoded.announce);
  } else if (Buffer.isBuffer(decoded?.announce)) {
    primaryTracker = decoded.announce.toString('utf-8');
    trackers.push(primaryTracker);
  }

  if (Array.isArray(decoded?.['announce-list'])) {
    for (const tier of decoded['announce-list']) {
      if (Array.isArray(tier)) {
        for (const tr of tier) {
          const trStr = typeof tr === 'string' ? tr : Buffer.isBuffer(tr) ? tr.toString('utf-8') : null;
          if (trStr && !trackers.includes(trStr)) {
            trackers.push(trStr);
          }
        }
      }
    }
  }

  return {
    infoHash,
    name,
    sizeBytes,
    primaryTracker,
    trackers
  };
}

function skipBencodeValue(buf: Buffer, p: number): number {
  if (p >= buf.length) throw new Error('Out of bounds');
  const char = buf[p];

  if (char === 0x69) { // 'i'
    const end = buf.indexOf(0x65, p);
    if (end === -1) throw new Error('Unterminated int');
    return end + 1;
  }
  if (char === 0x6c) { // 'l'
    let cur = p + 1;
    while (cur < buf.length && buf[cur] !== 0x65) {
      cur = skipBencodeValue(buf, cur);
    }
    return cur + 1;
  }
  if (char === 0x64) { // 'd'
    let cur = p + 1;
    while (cur < buf.length && buf[cur] !== 0x65) {
      cur = skipBencodeValue(buf, cur);
      cur = skipBencodeValue(buf, cur);
    }
    return cur + 1;
  }
  const colon = buf.indexOf(0x3a, p);
  if (colon === -1) throw new Error('Invalid string');
  const len = parseInt(buf.subarray(p, colon).toString('ascii'), 10);
  return colon + 1 + len;
}

function decodeBencode(buf: Buffer): any {
  let pos = 0;

  function parse(): any {
    if (pos >= buf.length) return null;
    const byte = buf[pos];

    if (byte === 0x69) {
      pos++;
      const end = buf.indexOf(0x65, pos);
      if (end === -1) return null;
      const str = buf.subarray(pos, end).toString('ascii');
      pos = end + 1;
      return parseInt(str, 10);
    }
    if (byte === 0x6c) {
      pos++;
      const list: any[] = [];
      while (pos < buf.length && buf[pos] !== 0x65) {
        list.push(parse());
      }
      pos++;
      return list;
    }
    if (byte === 0x64) {
      pos++;
      const dict: Record<string, any> = {};
      while (pos < buf.length && buf[pos] !== 0x65) {
        const key = parse();
        const val = parse();
        if (typeof key === 'string') dict[key] = val;
      }
      pos++;
      return dict;
    }
    const colon = buf.indexOf(0x3a, pos);
    if (colon === -1) return null;
    const len = parseInt(buf.subarray(pos, colon).toString('ascii'), 10);
    pos = colon + 1;
    const valBuf = buf.subarray(pos, pos + len);
    pos += len;
    return valBuf.toString('utf-8');
  }

  return parse();
}
