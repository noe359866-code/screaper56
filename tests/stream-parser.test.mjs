import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStremioStream, normalizeLanguage, normalizeQuality } from '../src/fetch.mjs';
import { PROVIDERS } from '../src/providers.mjs';

const HASH = '814978f980297cc7cd42be9d60b37b928a5e7cdc';

test('normaliza calidad a las categorías de la tabla', () => {
  assert.equal(normalizeQuality('Torrentio\n4k DV', ''), '4K');
  assert.equal(normalizeQuality('TPB+', 'title 1080p BluRay'), '1080p');
  assert.equal(normalizeQuality('provider', 'release 1440p'), '4K');
  assert.equal(normalizeQuality('provider', 'release unknown'), null);
});

test('la resolución explícita del release manda sobre "4K Remastered"/"RM4K" y se ignora el footer', () => {
  assert.equal(normalizeQuality('Torrentio\n4k', 'The Shawshank Redemption (1994) 4K Remastered 1080p 10bit Bluray'), '1080p');
  assert.equal(normalizeQuality('Torrentio\n4k', 'The Shawshank Redemption (1994) RM4K (1080p BluRay x265 HEVC 10bit AAC 5.1 afm72) [QxR]'), '1080p');
  assert.equal(normalizeQuality('Peerflix 🇪🇸', 'Cadena Perpetua [MicroHD][1080 px][AC3 5.1-Castellano-Ingles+Subs]'), '1080p');
  assert.equal(normalizeQuality('Torrentio', 'Movie 2019 BluRay\n👤 720 💾 480 MB ⚙️ ThePirateBay'), null);
  assert.equal(normalizeQuality('Torrentio', 'Movie 2019 BluRay', null, 'Movie.2019.2160p.BluRay.mkv'), '4K');
});

test('detecta español/inglés escritos en el título y no confunde subtítulos con audio', () => {
  assert.deepEqual(normalizeLanguage('', 'Cadena Perpetua (1994)[HDRip-XviD-AC3-ESP]'), ['es']);
  assert.deepEqual(normalizeLanguage('', 'Barbie BDrip XviD Español Castellano'), ['es']);
  assert.deepEqual(normalizeLanguage('', 'The.dark.knight.2008.1080P-Dual-Lat'), ['es']);
  assert.deepEqual(normalizeLanguage('', 'Game of Thrones (2011) 720p Dual Audio Español Latino + Ingles + Sub.Español'), ['es', 'en']);
  assert.deepEqual(normalizeLanguage('', 'game of thrones 1-4 temporada sub-español'), []);
  assert.deepEqual(normalizeLanguage('', 'Movie.2019.1080p.WEB-DL.Spanish.Subs'), []);
  assert.deepEqual(normalizeLanguage('', 'Le ali della liberta 1994 1080p BluRay ITA ENG'), ['en', 'it']);
  assert.deepEqual(normalizeLanguage('', 'Multi Subs / 🇬🇧 / 🇮🇳'), ['en', 'hi']);
  assert.deepEqual(normalizeLanguage('es', 'Cadena perpetua [Castellano-Ingles+Subs]'), ['es', 'en']);
});

test('lee el contrato Peerflix: description, seed, sizebytes y trackers', () => {
  const stream = parseStremioStream({
    name: 'Peerflix 🇪🇸 4K',
    description: 'Cadena perpetua [4K][2160p][HDR10][Castellano-Ingles+Subs][ES-EN]\nfile.mkv\n 👤 1 💾 59.61 GB 🌐 Peerflix',
    infoHash: HASH,
    sources: ['tracker:udp://tracker.example/announce', `dht:${HASH}`],
    fileIdx: 5,
    language: 'es',
    quality: '4K',
    seed: 1,
    sizebytes: 64005750128,
  }, PROVIDERS.peerflix);

  assert.equal(stream.infoHash, HASH);
  assert.equal(stream.title, 'Cadena perpetua [4K][2160p][HDR10][Castellano-Ingles+Subs][ES-EN]');
  assert.equal(stream.seeders, 1);
  assert.equal(stream.sizeBytes, 64005750128);
  assert.equal(stream.quality, '4K');
  assert.deepEqual(stream.languages, ['es', 'en']);
  assert.deepEqual(stream.trackers, ['udp://tracker.example/announce']);
});

test('lee footer Torrentio sin asumir que es la última línea', () => {
  const stream = parseStremioStream({
    name: 'Torrentio\n4k HDR',
    title: 'The Shawshank Redemption 1994 2160p BluRay\n👤 100 💾 6.91 GB ⚙️ YTS\n🇬🇧',
    infoHash: 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6',
    fileIdx: 0,
  }, PROVIDERS.torrentio);

  assert.equal(stream.seeders, 100);
  assert.equal(stream.sizeBytes, Math.round(6.91 * 1024 * 1024 * 1024));
  assert.equal(stream.externalProvider, 'YTS');
  assert.deepEqual(stream.languages, ['en']);
});

test('lee Ytztvio y conserva trackers del campo magnet', () => {
  const stream = parseStremioStream({
    name: '2160p',
    title: 'The Shawshank Redemption (1994)\n👤100:59 💾6.91 GB ⚙️x265',
    infoHash: 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6',
    magnet: 'magnet:?xt=urn:btih:C3DA9A3DC2CE14D0D4FC0E87D1B2023502F8DCD6&dn=Shawshank&tr=udp://tracker.one:80&tr=https://tracker.two:443',
  }, PROVIDERS.ytztvio);

  assert.equal(stream.seeders, 100);
  assert.equal(stream.sizeBytes, Math.round(6.91 * 1024 * 1024 * 1024));
  assert.equal(stream.quality, '4K');
  assert.deepEqual(stream.trackers, ['udp://tracker.one:80', 'https://tracker.two:443']);
  assert.match(stream.magnetUrl, /^magnet:\?xt=urn:btih:/);
});

test('guarda behaviorHints.filename y lo usa para detectar el audio', () => {
  const s = parseStremioStream({
    name: 'Torrentio\n4k',
    title: 'The Shawshank Redemption (1994) 4K Remastered 1080p 10bit Bluray…\n👤 12 💾 9.8 GB ⚙️ 1337x',
    infoHash: HASH,
    behaviorHints: { filename: 'The.Shawshank.Redemption.1994.1080p.BluRay.[Org DDP 2.0 Hindi + DDP 5.1 English].mkv' },
  }, PROVIDERS.torrentio);
  assert.equal(s.filename, 'The.Shawshank.Redemption.1994.1080p.BluRay.[Org DDP 2.0 Hindi + DDP 5.1 English].mkv');
  assert.equal(s.quality, '1080p');
  assert.deepEqual(s.languages, ['en', 'hi']);
});

test('ficha técnica del release: origen, códec, HDR, audio y canales', async () => {
  const { parseReleaseInfo, releaseTags } = await import('../public/lib/parse.js');
  const info = parseReleaseInfo('Top.Gun.Maverick.2022.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR10.H.265-EVO');
  assert.equal(info.source, 'WEB-DL');
  assert.equal(info.codec, 'HEVC');
  assert.deepEqual(info.hdr, ['DV', 'HDR10']);
  assert.deepEqual(info.audio, ['Atmos', 'DD+']);
  assert.equal(info.channels, '5.1');
  assert.equal(releaseTags(info), 'WEB-DL · HEVC · DV · HDR10 · Atmos/DD+ 5.1');
  const es = parseReleaseInfo('Cadena Perpetua [MicroHD][1080 px][AC3 5.1-Castellano-Ingles+Subs]');
  assert.equal(es.source, 'BluRay');
  assert.deepEqual(es.audio, ['AC3']);
  assert.equal(es.channels, '5.1');
  const unknown = parseReleaseInfo('Movie');
  assert.deepEqual(unknown, { source: null, codec: null, hdr: [], audio: [], channels: null });
  assert.equal(parseReleaseInfo('Movie.2019.HDTS.x264').source, 'CAM');
});

test('la resolución escrita en el release gana a la calidad que declara el addon', () => {
  // Peerflix a veces dice "4K" por la web de origen ("wolfmax4k") aunque el release sea 1080p.
  assert.equal(normalizeQuality('Peerflix', 'Barbie (2023) [Bluray 1080p][Esp](wolfmax4k.com)', '4K'), '1080p');
  assert.equal(normalizeQuality('Peerflix', 'Barbie (2023) [Bluray][Esp]', '4K'), '4K');
  assert.equal(normalizeQuality('Torrentio\n4k', 'Oppenheimer'), '4K');
});

test('mergeStreams conserva los idiomas de cada addon y rellena lo que falta', async () => {
  const { mergeStreams } = await import('../public/lib/parse.js');
  const base = { infoHash: HASH, title: 'X 1080p', trackers: ['udp://a'], magnetUrl: null, fileIdx: null, externalProvider: null };
  const merged = mergeStreams([
    { streams: [{ ...base, quality: null, seeders: 10, sizeBytes: null, languages: ['es'], provider: 'peerflix', providerName: 'Peerflix' }] },
    { streams: [{ ...base, quality: '1080p', seeders: 3, sizeBytes: 123, languages: ['en'], fileIdx: 2, trackers: ['udp://b'], provider: 'torrentio', providerName: 'Torrentio' }] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].languages.sort(), ['en', 'es']);
  assert.equal(merged[0].quality, '1080p');
  assert.equal(merged[0].sizeBytes, 123);
  assert.equal(merged[0].fileIdx, 2);
  assert.equal(merged[0].seeders, 10);
  assert.deepEqual(merged[0].providers, ['peerflix', 'torrentio']);
  assert.deepEqual(merged[0].trackers, ['udp://a', 'udp://b']);
});
