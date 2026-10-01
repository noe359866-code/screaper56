import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BEST_TRACKERS,
  buildTitleMatcher,
  englishTier,
  normalizeTrackerKey,
  parseTrackerList,
  pickBestTrackers,
  scoreStream,
  selectBestStreams,
  spanishTier,
  stripSubtitleMentions,
} from '../public/lib/select.js';
import { toOutputStream } from '../src/fetch.mjs';

const GB = 1024 ** 3;
let counter = 0;
function hash(n) {
  return n.toString(16).padStart(40, '0');
}
function candidate(title, extra = {}) {
  counter++;
  return {
    infoHash: hash(counter),
    title,
    filename: null,
    quality: null,
    languages: [],
    seeders: 10,
    sizeBytes: 2 * GB,
    trackers: [],
    providers: ['torrentio'],
    providerNames: ['Torrentio'],
    externalProviders: [],
    fileIdx: 0,
    ...extra,
  };
}
const byPick = (picks) => Object.fromEntries(picks.map(p => [p.pick, p]));

test('Cadena perpetua (datos reales): elige 1 en español y 1 en inglés, sin packs ni idiomas ajenos', () => {
  const pack = candidate('Imdb top 263 movies hindi english gdrive', { quality: '1080p', seeders: 2081, fileIdx: 227, sizeBytes: 1.6 * GB });
  const yify = candidate('The Shawshank Redemption (1994) 1080p BrRip - 1.6GB - YIFY', { quality: '1080p', seeders: 450, providers: ['torrentsdb', 'torrentio', 'piratebay', 'ytztvio'], sizeBytes: 1.6 * GB });
  const yts4k = candidate('The Shawshank Redemption (1994) 2160p BRRip 5.1 10Bit x265 -YTS', { quality: '4K', seeders: 100, sizeBytes: 6.9 * GB });
  const remux = candidate('The.Shawshank.Redemption.1994.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FraMeSToR', { quality: '4K', seeders: 101, sizeBytes: 58 * GB });
  const microhd = candidate('Cadena Perpetua [MicroHD][1080 px][AC3 5.1-Castellano-Ingles+Subs]', { quality: '1080p', seeders: 9, languages: ['es', 'en'], providers: ['peerflix'], sizeBytes: 5 * GB });
  const es4k = candidate('Cadena perpetua [4Kreescalado][2160p][HDR10][AC3 5.1 Castellano-AC3 5.1-Ingles+Subs][ES-EN]', { quality: '4K', seeders: 1, languages: ['es', 'en'], providers: ['peerflix'], sizeBytes: 64 * GB });
  const manyFlags = candidate('The.Shawshank.Redemption.1994.bluray.sdr.1080p.av1.5.1.opus.subs-Dust', { quality: '1080p', seeders: 128, languages: ['en', 'ja', 'it', 'es', 'ko', 'zh', 'fr', 'de'] });
  const russian = candidate('Побег из Шоушенка / The Shawshank Redemption (1994) BDRip 1080p', { quality: '1080p', seeders: 60, languages: ['ru'] });
  const czech = candidate('The Shawshank Redemption 1994 1080p BluRay (CZ/EN)', { quality: '1080p', seeders: 50 });
  const italian = candidate('Le ali della liberta 1994 1080p BluRay ITA ENG', { quality: '1080p', seeders: 30, languages: ['it', 'en'] });
  const all = [pack, yify, yts4k, remux, microhd, es4k, manyFlags, russian, czech, italian];

  const picks = selectBestStreams(all, { type: 'movie', label: 'Cadena perpetua (1994)' });
  assert.equal(picks.length, 2);
  const { es, en } = byPick(picks);
  assert.equal(es.infoHash, microhd.infoHash);
  assert.equal(en.infoHash, yts4k.infoHash);
  assert.notEqual(es.infoHash, en.infoHash);
  assert.equal(typeof es.score, 'number');
});

test('español "en general": castellano o latino; un release en español gana al remux multi-idioma', () => {
  const multi = candidate('Fight.Club.1999.1080p.REMUX.ENG.ITA.HINDI.RUS.UKR.And.ESP.LATINO.DTS-HD.Master', { quality: '1080p', seeders: 155, languages: ['en', 'es', 'it', 'hi', 'ru'], sizeBytes: 31.5 * GB });
  const latino = candidate('Fight Club (1999) 1080p Dual Audio Español Latino Ingles', { quality: '1080p', seeders: 5, languages: ['es', 'en'] });
  assert.equal(spanishTier(multi), 2);
  assert.equal(spanishTier(latino), 3);
  const { es } = byPick(selectBestStreams([multi, latino], { type: 'movie' }));
  assert.equal(es.infoHash, latino.infoHash);

  // Si no hay release en español, el multi-idioma con pista española sirve.
  const { es: fallback } = byPick(selectBestStreams([multi], { type: 'movie' }));
  assert.equal(fallback.infoHash, multi.infoHash);
});

test('subtítulos en español no cuentan como audio en español', () => {
  const subs = candidate('game of thrones 1-4 temporada sub-español', { languages: ['es'] });
  const vose = candidate('Movie 2019 1080p WEB-DL VOSE', { languages: ['es'] });
  assert.equal(spanishTier(subs), 0);
  assert.equal(spanishTier(vose), 0);
  assert.equal(stripSubtitleMentions('Dual Audio Español Latino + Ingles + Sub.Español').includes('Sub.Español'), false);
  assert.match(stripSubtitleMentions('Dual Audio Español Latino + Ingles + Sub.Español'), /Español Latino/);
  // "Castellano+Subs" = audio castellano y además subtítulos.
  assert.match(stripSubtitleMentions('[AC3 5.1 Castellano+Subs]'), /Castellano/);
});

test('inglés: sin bandera = versión original; marcas extranjeras o multi = inglés mezclado', () => {
  assert.equal(englishTier(candidate('The Matrix 1999 2160p BluRay')), 2);
  assert.equal(englishTier(candidate('The Matrix 1999 1080p', { languages: ['en'] })), 2);
  assert.equal(englishTier(candidate('The Matrix 1999 MULTi 1080p BluRay x264')), 1);
  assert.equal(englishTier(candidate('Barbie 2023 1080p WEB-DL (HC-KOR)', { languages: ['en', 'ko'] })), 1);
  assert.equal(englishTier(candidate('Matrix 1999 1080p Castellano-Ingles', { languages: ['es', 'en'], providers: ['peerflix'] })), 1);
  assert.equal(englishTier(candidate('Hra o trůny / Game of Thrones (CZ)[720p]')), 0);
  assert.equal(englishTier(candidate('Игра престолов / Game of Thrones [S01-08]')), 0);
  assert.equal(englishTier(candidate('Les evades 1994 1080p', { languages: ['fr'] })), 0);
});

test('el pick en inglés nunca repite el torrent español y los huecos no se rellenan con otro idioma', () => {
  const dual = candidate('Joker [MicroHD 1080p][AC3 5.1-Castellano-AC3 5.1-Ingles+Subs][ES-EN]', { quality: '1080p', seeders: 21, languages: ['es', 'en'], providers: ['peerflix'] });
  const onlyDual = selectBestStreams([dual], { type: 'movie' });
  assert.deepEqual(onlyDual.map(p => p.pick), ['es']);

  const english = candidate('Joker.2019.2160p.4K.BluRay.x265.10bit.HDR.AAC5.1', { quality: '4K', seeders: 108 });
  const onlyEnglish = selectBestStreams([english], { type: 'movie' });
  assert.deepEqual(onlyEnglish.map(p => p.pick), ['en']);

  const french = candidate('Joker 2019 FRENCH 1080p', { quality: '1080p', seeders: 500, languages: ['fr'] });
  assert.deepEqual(selectBestStreams([french], { type: 'movie' }), []);
  assert.deepEqual(selectBestStreams([], { type: 'movie' }), []);
});

test('evita CAM/TS, torrents muertos, 3D y remux gigantes aunque tengan más seeders', () => {
  const cam = candidate('Barbie (2023) NEW 1080p HDTS x264 ESub AAC - HushRips', { quality: '1080p', seeders: 2087 });
  const telesync = candidate('Barbie.2023.English.1080p.HD(AdsFree)TeleSync.DD2.0.x264', { quality: '1080p', seeders: 699, languages: ['en'] });
  const web = candidate('Barbie.2023.1080p.WEBRip.1400MB.DD5.1.x264-GalaxyRG', { quality: '1080p', seeders: 40 });
  assert.equal(byPick(selectBestStreams([cam, telesync, web], { type: 'movie' })).en.infoHash, web.infoHash);

  const dead4k = candidate('Movie 2020 2160p WEB-DL', { quality: '4K', seeders: 0 });
  const alive720 = candidate('Movie 2020 720p WEB-DL', { quality: '720p', seeders: 5 });
  assert.ok(scoreStream(alive720) > scoreStream(dead4k));

  const threeD = candidate('Movie 2020 1080p 3D HSBS BluRay', { quality: '1080p', seeders: 50 });
  const flat = candidate('Movie 2020 1080p BluRay', { quality: '1080p', seeders: 50 });
  assert.ok(scoreStream(flat) > scoreStream(threeD));

  const huge = candidate('Top.Gun.Maverick.2022.2160p.REMUX.ENG.And.ESP.LATINO.TrueHD', { quality: '4K', seeders: 202, sizeBytes: 66 * GB });
  const normal = candidate('Top.Gun.Maverick.2022.2160p.WEB-DL.DDP5.1.Atmos.HDR', { quality: '4K', seeders: 202, sizeBytes: 22.9 * GB });
  assert.ok(scoreStream(normal) - scoreStream(huge) >= 2);
});

test('descarta packs y títulos ajenos ("0peliculas series") aunque tengan más seeders', () => {
  const pack = candidate('0peliculas series', { quality: '4K', seeders: 73, languages: ['es'], fileIdx: 49 });
  const spanish = candidate('Interstellar [BluRay 1080p][AC3 5.1 Spanish DTS 5.1-English+Subs][ES-EN]', { quality: '1080p', seeders: 63, languages: ['es', 'en'], providers: ['peerflix'] });
  const english = [
    candidate('Interstellar.2014.IMAX.2160p.10bit.HDR.BluRay.6CH.x265.HEVC-PSA', { quality: '4K', seeders: 110 }),
    candidate('Interstellar (2014) 1080p BrRip x264 - YIFY', { quality: '1080p', seeders: 500 }),
    candidate('Interstellar 2014 2160p BluRay', { quality: '4K', seeders: 100 }),
  ];
  const junk = candidate('Videos cosas', { quality: '4K', seeders: 90, languages: ['es', 'en'], fileIdx: 299 });
  const all = [pack, junk, spanish, ...english];
  const isOffTitle = buildTitleMatcher(all, 'Interestelar (2014)');
  assert.equal(isOffTitle(junk), true);
  assert.equal(isOffTitle(spanish), false);
  assert.equal(isOffTitle(english[0]), false);
  // "0peliculas series" no tiene palabras que comparar, pero es una colección.
  assert.ok(Math.abs(scoreStream({ ...pack, title: 'Interstellar 2014 2160p' }) - scoreStream(pack) - 3) < 1e-9);
  assert.equal(byPick(selectBestStreams(all, { type: 'movie', label: 'Interestelar (2014)' })).es.infoHash, spanish.infoHash);

  const collection = candidate('The Christopher Nolan Collection (2000-2023) BDRip 1080p', { quality: '1080p', seeders: 50 });
  const single = candidate('Interstellar 2014 1080p BluRay', { quality: '1080p', seeders: 50 });
  assert.ok(scoreStream(single) - scoreStream(collection) > 2.99);
  // En series los packs de temporada son lo normal: no se penalizan como pack.
  const seasonPack = candidate('Game of Thrones Complete Series Pack 1080p', { quality: '1080p', seeders: 50 });
  assert.ok(scoreStream(seasonPack, { type: 'series' }) > scoreStream(seasonPack, { type: 'movie' }));
});

test('trackers: solo los mejores, primero los que el torrent ya anunciaba y como máximo MAX_TRACKERS', () => {
  const own = [
    'udp://tracker.coppersurfer.tk:6969/announce',   // muerto
    'udp://9.rarbg.to:2710/announce',                // muerto
    'udp://explodie.org:6969',                       // de los mejores, sin /announce
    'udp://open.demonii.com:1337/announce\u200b',    // de los mejores, con carácter invisible
  ];
  const trackers = pickBestTrackers(own, BEST_TRACKERS, 10);
  assert.equal(trackers.length, 10);
  assert.deepEqual(trackers.slice(0, 2), ['udp://open.demonii.com:1337/announce', 'udp://explodie.org:6969/announce']);
  assert.ok(trackers.every(t => BEST_TRACKERS.includes(t)));
  assert.equal(new Set(trackers).size, trackers.length);
  assert.equal(pickBestTrackers([], BEST_TRACKERS, 3).length, 3);
  assert.equal(normalizeTrackerKey('tracker:UDP://Tracker.OpenTrackr.org:1337/announce/'), 'udp://tracker.opentrackr.org:1337');
});

test('parseTrackerList lee trackers_best.txt: una URL por línea, sin duplicados ni basura', () => {
  const text = [
    'udp://tracker.opentrackr.org:1337/announce', '',
    'udp://open.stealth.si:80/announce', '',
    '# comentario', 'no-es-un-tracker',
    'UDP://tracker.opentrackr.org:1337/announce', // duplicado
    'http://tracker.renfei.net:8080/announce',
    'wss://tracker.openwebtorrent.com',
  ].join('\n');
  assert.deepEqual(parseTrackerList(text), [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'http://tracker.renfei.net:8080/announce',
    'wss://tracker.openwebtorrent.com',
  ]);
});

test('toOutputStream publica el pick con bandera, trackers recortados, sources de Stremio y magnet', () => {
  const hash = 'ab'.repeat(20);
  const out = toOutputStream({
    ...candidate('The Matrix 1999 2160p BluRay', {
      infoHash: hash, quality: '4K', seeders: 241, sizeBytes: 6.5 * GB,
      trackers: ['udp://tracker.coppersurfer.tk:6969/announce', 'udp://open.stealth.si:80/announce'],
      providers: ['torrentsdb', 'torrentio'], providerNames: ['TorrentsDB', 'Torrentio'],
    }),
    pick: 'en',
    score: 8.26,
  }, BEST_TRACKERS);
  assert.equal(out.name, '🇬🇧 Inglés 4K');
  assert.equal(out.pick, 'en');
  assert.equal(out.language, 'en');
  assert.deepEqual(out.audioLangs, ['en']);
  assert.equal(out.trackers.length, 10);
  assert.equal(out.trackers[0], 'udp://open.stealth.si:80/announce');
  assert.ok(!out.trackers.some(t => t.includes('coppersurfer')));
  assert.equal(out.sources.length, 11);
  assert.equal(out.sources.at(-1), `dht:${hash}`);
  assert.ok(out.sources.slice(0, -1).every(s => s.startsWith('tracker:')));
  assert.ok(out.magnetUrl.startsWith(`magnet:?xt=urn:btih:${hash}`));
  assert.equal((out.magnetUrl.match(/&tr=/g) || []).length, 10);
  assert.match(out.description, /👤 241 💾 6\.5 GB ⚙️ TorrentsDB\+Torrentio/);
});

test('película: penaliza otra película homónima de otro año (±1 de tolerancia)', () => {
  const dune2021 = candidate('Dune.2021.2160p.HMAX.WEB-DL.DDP5.1.Atmos.HDR.HEVC-EVO', { quality: '4K', seeders: 90, sizeBytes: 20 * GB });
  const dune1984 = candidate('Dune 1984 2160p UHD BluRay x265', { quality: '4K', seeders: 100, sizeBytes: 12 * GB });
  const noYear = candidate('Dune 1080p BluRay', { quality: '1080p', seeders: 40 });
  const all = [dune2021, dune1984, noYear];
  // Año conocido (Cinemeta).
  assert.equal(byPick(selectBestStreams(all, { type: 'movie', label: 'Dune', year: 2021 })).en.infoHash, dune2021.infoHash);
  // Sin año conocido, gana el año de consenso entre los candidatos.
  const many = [dune2021, dune1984, noYear,
    candidate('Dune (2021) 1080p WEB-DL', { quality: '1080p', seeders: 5 }),
    candidate('Dune.2021.720p.BluRay', { quality: '720p', seeders: 5 })];
  assert.equal(byPick(selectBestStreams(many, { type: 'movie', label: 'Dune' })).en.infoHash, dune2021.infoHash);
  // ±1: Cinemeta dice 2003 para El pianista, los releases dicen 2002.
  const pianist = candidate('The Pianist 2002 2160p BluRay', { quality: '4K', seeders: 80 });
  assert.equal(byPick(selectBestStreams([pianist, noYear], { type: 'movie', year: 2003 })).en.infoHash, pianist.infoHash);
});

test('los números del propio título no cuentan como año ("Blade Runner 2049", "1917")', async () => {
  const { releaseYears } = await import('../public/lib/select.js');
  assert.deepEqual(releaseYears('Blade.Runner.2049.2017.2160p', ['Blade Runner 2049']), [2017]);
  assert.deepEqual(releaseYears('1917 (2019) 1080p', ['1917 (2019)']), [2019]);
  assert.deepEqual(releaseYears('Movie 2150 1080p', []), []); // años imposibles
});

test('series: detecta otro episodio/temporada (S01E02, 1x01, Cap.101, T4, packs)', async () => {
  const { episodeMatch } = await import('../public/lib/select.js');
  const t = (title, filename = null) => ({ title, filename });
  assert.equal(episodeMatch(t('Game.of.Thrones.S01E01.1080p'), 1, 1), 'match');
  assert.equal(episodeMatch(t('Game.of.Thrones.S01E02.1080p'), 1, 1), 'mismatch');
  assert.equal(episodeMatch(t('Game.of.Thrones.S01E01-E10.1080p'), 1, 5), 'match');
  assert.equal(episodeMatch(t('Breaking.Bad.1x01.HDTV.XviD'), 1, 1), 'match');
  assert.equal(episodeMatch(t('Juego de Tronos - Temp.1 [HDTV][Cap.101][Spanish_English]'), 1, 1), 'match');
  assert.equal(episodeMatch(t('Juego de Tronos [HDTV][Cap.102_103]'), 1, 3), 'match');
  assert.equal(episodeMatch(t('Breaking Bad T4 720p Dual Latino-Ingles'), 1, 1), 'mismatch');
  assert.equal(episodeMatch(t('Game of Thrones Seasons 1-5 CENSORED'), 1, 1), 'match');
  assert.equal(episodeMatch(t('Game of Thrones S08 2160p'), 1, 1), 'mismatch');
  assert.equal(episodeMatch(t('Game of Thrones Complete', 'Game.of.Thrones.S01E02.mkv'), 1, 1), 'mismatch');
  assert.equal(episodeMatch(t('Game of Thrones Complete', 'Game.of.Thrones.S01E01.mkv'), 1, 1), 'match');
  assert.equal(episodeMatch(t('Breaking Bad: Complete Series'), 1, 1), 'unknown');
  assert.equal(episodeMatch(t('Movie DD5.1x264'), 1, 1), 'unknown'); // no es "1x264"

  const wrongSeason = candidate('Breaking Bad T4 720p Dual Latino-Ingles', { quality: '720p', seeders: 60, languages: ['es', 'en'] });
  const pack = candidate('Breaking Bad (S01)(2008)(1080p)(WebDL)( EN 5.1+SPA 2.0)(Complete)', { quality: '1080p', seeders: 17, languages: ['es', 'en'] });
  const picks = byPick(selectBestStreams([wrongSeason, pack], { type: 'series', label: 'Breaking Bad S01E01', season: 1, episode: 1 }));
  assert.equal(picks.es.infoHash, pack.infoHash);
});

test('un 4K reescalado puntúa por debajo de un 4K real', () => {
  const real = candidate('Movie 2019 2160p UHD BluRay', { quality: '4K', seeders: 20 });
  const upscaled = candidate('Movie [4K UHDreescalado][2160p]', { quality: '4K', seeders: 20 });
  const fhd = candidate('Movie 2019 1080p BluRay', { quality: '1080p', seeders: 20 });
  assert.ok(scoreStream(upscaled) < scoreStream(real));
  assert.ok(scoreStream(upscaled) < scoreStream(fhd));
});

test('buildTitleMatcher acepta varios títulos (etiqueta + título original de IMDb)', () => {
  const streams = [candidate('The Pianist 2002 1080p'), candidate('Il pianista 2002 ITA')];
  const offByLabel = buildTitleMatcher(streams, 'El Padrino. Parte II (1974)');
  const offByBoth = buildTitleMatcher(streams, ['El Padrino. Parte II (1974)', 'The Pianist']);
  assert.equal(offByBoth(streams[0]), false);
  assert.equal(typeof offByLabel(streams[0]), 'boolean');
});


test('selección mejorada: prioriza release técnico correcto sobre CAM/TS con muchos seeders', () => {
  const streams = [
    { infoHash: hash(91), title: 'Movie 2020 CAM 4K English', quality: '4K', seeders: 500, languages: ['en'], providers: ['torrentio'] },
    { infoHash: hash(92), title: 'Movie 2020 1080p WEB-DL English', quality: '1080p', seeders: 40, languages: ['en'], providers: ['torrentio'] },
  ];
  const picks = selectBestStreams(streams, { type: 'movie', label: 'Movie', year: 2020 });
  assert.equal(picks.find(p => p.pick === 'en')?.infoHash, hash(92));
});

test('selección mejorada: no inventa español por ausencia de idioma', () => {
  const streams = [
    { infoHash: hash(93), title: 'Movie 2020 1080p WEB-DL', quality: '1080p', seeders: 100, languages: [], providers: ['torrentio'] },
    { infoHash: hash(94), title: 'Movie 2020 1080p WEB-DL Castellano', quality: '1080p', seeders: 15, languages: ['es'], providers: ['torrentio'] },
  ];
  const picks = selectBestStreams(streams, { type: 'movie', label: 'Movie', year: 2020 });
  assert.equal(picks.find(p => p.pick === 'es')?.infoHash, hash(94));
});

test('selección mejorada: conserva ES y EN como releases distintos cuando existe alternativa', () => {
  const streams = [
    { infoHash: hash(95), title: 'Movie 2020 1080p WEB-DL Castellano English', quality: '1080p', seeders: 80, languages: ['es', 'en'], providers: ['torrentio'] },
    { infoHash: hash(96), title: 'Movie 2020 1080p WEB-DL English', quality: '1080p', seeders: 70, languages: ['en'], providers: ['torrentio'] },
  ];
  const picks = selectBestStreams(streams, { type: 'movie', label: 'Movie', year: 2020 });
  assert.equal(picks.find(p => p.pick === 'es')?.infoHash, hash(95));
  assert.equal(picks.find(p => p.pick === 'en')?.infoHash, hash(96));
});
