import { createHash } from 'node:crypto';

export const HASH = '1234567890abcdef1234567890abcdef12345678';
export const HASH2 = 'abcdef1234567890abcdef1234567890abcdef12';
export const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sample%20Castellano%201080p`;
export const response = data => ({ status: 200, data });
export function mockHttp(crawler, get, getBuffer) {
  const calls = [];
  crawler.httpClient = {
    get: async (url, options) => { calls.push(url); return response(await get(url, options)); },
    getBuffer: async (url, options) => { calls.push(url); if (!getBuffer) throw new Error('Unexpected buffer request'); return getBuffer(url, options); },
    request: async (options) => { calls.push(options.url); return response(await get(options.url, options)); }
  };
  return calls;
}
export function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.entries(value).flatMap(([k,v]) => [bencode(k), bencode(v)]), Buffer.from('e')]);
}
export function torrent(name = 'Sample Castellano 1080p', extra = {}) {
  const info = { name, length: 42, 'piece length': 16384, pieces: Buffer.alloc(20), ...extra };
  return { buffer: bencode({ announce: 'udp://tracker.example/announce', info }), hash: createHash('sha1').update(bencode(info)).digest('hex') };
}
