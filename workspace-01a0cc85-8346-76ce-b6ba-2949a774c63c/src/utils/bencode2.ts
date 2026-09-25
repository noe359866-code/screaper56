import * as crypto from 'node:crypto';

export interface ParsedTorrentFile {
  infoHash: string; // 40 caracteres hexadecimales en minúsculas
  name: string;
  sizeBytes: number;
  primaryTracker: string | null;
  trackers: string[];
}

/**
 * Salta un elemento bencode individual a partir de un índice dado y retorna el índice posterior.
 * Retorna -1 si la estructura bencode está mal formada.
 */
function skipBencodedItem(buffer: Buffer, startIndex: number): number {
  let i = startIndex;
  if (i >= buffer.length) return -1;

  const byte = buffer[i];

  // Entero: i<number>e
  if (byte === 0x69) {
    i++;
    while (i < buffer.length && buffer[i] !== 0x65) {
      i++;
    }
    if (i >= buffer.length) return -1;
    return i + 1; // Salta 'e'
  } 
  // Lista ('l') o Diccionario ('d')
  else if (byte === 0x6c || byte === 0x64) {
    i++; // Salta 'l' o 'd'
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
  // Cadena de texto: <length>:<data>
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

    const nextI = colonIndex + 1 + strLen;
    if (nextI > buffer.length) return -1;
    return nextI;
  } 
  else {
    return -1; // Token bencode inválido
  }
}

/**
 * Extrae una cadena de texto de un búfer bencode en un índice de cadena válido.
 */
function parseBencodedStringContent(buffer: Buffer, startIndex: number): { value: string; nextIndex: number } | null {
  const colonIdx = buffer.indexOf(0x3a, startIndex);
  if (colonIdx === -1) return null;

  const lenStr = buffer.toString('utf8', startIndex, colonIdx);
  const strLen = parseInt(lenStr, 10);
  if (isNaN(strLen) || strLen < 0) return null;

  const dataStart = colonIdx + 1;
  const dataEnd = dataStart + strLen;
  if (dataEnd > buffer.length) return null;

  const value = buffer.toString('utf8', dataStart, dataEnd);
  return { value, nextIndex: dataEnd };
}

/**
 * Analiza de forma ligera y ultra rápida un diccionario 'info' bencode para extraer name y sizeBytes.
 */
function parseInfoDictionary(buffer: Buffer, startIdx: number, endIdx: number): { name: string; sizeBytes: number } {
  let i = startIdx + 1; // Salta 'd' inicial del info dict
  let name = '';
  let sizeBytes = 0;

  while (i < endIdx - 1) {
    const keyResult = parseBencodedStringContent(buffer, i);
    if (!keyResult) break;

    const key = keyResult.value;
    const valStart = keyResult.nextIndex;
    const valEnd = skipBencodedItem(buffer, valStart);
    if (valEnd === -1 || valEnd > endIdx) break;

    if (key === 'name') {
      const nameResult = parseBencodedStringContent(buffer, valStart);
      if (nameResult) name = nameResult.value;
    } else if (key === 'length') {
      // Entero bencode: i<number>e
      if (buffer[valStart] === 0x69) {
        const intStr = buffer.toString('utf8', valStart + 1, valEnd - 1);
        const len = parseInt(intStr, 10);
        if (!isNaN(len)) sizeBytes = len;
      }
    } else if (key === 'files') {
      // Torrents multi-archivo
      if (buffer[valStart] === 0x6c) { // 'l'
        let fileIdx = valStart + 1;
        while (fileIdx < valEnd - 1) {
          const fileDictEnd = skipBencodedItem(buffer, fileIdx);
          if (fileDictEnd === -1) break;

          // Parsear cada subdiccionario de archivo buscando 'length'
          let subI = fileIdx + 1;
          while (subI < fileDictEnd - 1) {
            const subKeyRes = parseBencodedStringContent(buffer, subI);
            if (!subKeyRes) break;
            const subKey = subKeyRes.value;
            const subValStart = subKeyRes.nextIndex;
            const subValEnd = skipBencodedItem(buffer, subValStart);
            if (subValEnd === -1) break;

            if (subKey === 'length' && buffer[subValStart] === 0x69) {
              const lenStr = buffer.toString('utf8', subValStart + 1, subValEnd - 1);
              const fileLen = parseInt(lenStr, 10);
              if (!isNaN(fileLen)) sizeBytes += fileLen;
            }
            subI = subValEnd;
          }
          fileIdx = fileDictEnd;
        }
      }
    }

    i = valEnd;
  }

  return { name, sizeBytes };
}

/**
 * Decodificador Bencode seguro, de pasada única y cálculo exacto de SHA-1 info_hash (BEP 0003).
 */
export function parseTorrentBuffer(buf: Buffer): ParsedTorrentFile | null {
  if (!buf || buf.length < 20 || buf[0] !== 0x64 /* 'd' */) {
    return null;
  }

  let i = 1; // Salta el 'd' del diccionario raíz
  let infoHash = '';
  let name = '';
  let sizeBytes = 0;
  let primaryTracker: string | null = null;
  const trackers: string[] = [];

  // Recorrer el diccionario raíz clave por clave de manera estructural (sin falsos positivos)
  while (i < buf.length) {
    if (buf[i] === 0x65) { // 'e' final del diccionario raíz
      break;
    }

    const keyResult = parseBencodedStringContent(buf, i);
    if (!keyResult) return null;

    const key = keyResult.value;
    const valStart = keyResult.nextIndex;
    const valEnd = skipBencodedItem(buf, valStart);
    if (valEnd === -1) return null;

    if (key === 'announce') {
      const announceRes = parseBencodedStringContent(buf, valStart);
      if (announceRes) {
        const trackerUrl = announceRes.value;
        if (!primaryTracker) primaryTracker = trackerUrl;
        if (!trackers.includes(trackerUrl)) trackers.push(trackerUrl);
      }
    } else if (key === 'announce-list') {
      // Estructura de listas anidadas de tiers de trackers
      if (buf[valStart] === 0x6c) {
        let tierIdx = valStart + 1;
        while (tierIdx < valEnd - 1) {
          const tierEnd = skipBencodedItem(buf, tierIdx);
          if (tierEnd === -1) break;

          if (buf[tierIdx] === 0x6c) {
            let trIdx = tierIdx + 1;
            while (trIdx < tierEnd - 1) {
              const trRes = parseBencodedStringContent(buf, trIdx);
              if (trRes) {
                const trUrl = trRes.value;
                if (!trackers.includes(trUrl)) trackers.push(trUrl);
              }
              const nextTr = skipBencodedItem(buf, trIdx);
              if (nextTr === -1) break;
              trIdx = nextTr;
            }
          }
          tierIdx = tierEnd;
        }
      }
    } else if (key === 'info') {
      // Extraer infoHash matemáticamente exacto (BEP 0003)
      const infoSlice = buf.subarray(valStart, valEnd);
      infoHash = crypto.createHash('sha1').update(infoSlice).digest('hex').toLowerCase();

      // Analizar metadatos internos del diccionario info de forma ligera
      const infoMeta = parseInfoDictionary(buf, valStart, valEnd);
      name = infoMeta.name;
      sizeBytes = infoMeta.sizeBytes;
    }

    i = valEnd;
  }

  if (!infoHash) {
    return null;
  }

  return {
    infoHash,
    name,
    sizeBytes,
    primaryTracker,
    trackers
  };
}
