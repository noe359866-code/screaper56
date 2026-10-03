/**
 * Registro de addons Stremio: lo comparten la GitHub Action (Node) y la web
 * (navegador), así que no puede depender de `process` ni del DOM.
 *
 * Los addons consultables exponen el contrato estándar
 *   /stream/{movie|series}/{id}.json
 * `baseUrl` puede incluir un segmento de configuración (StremThru Torz).
 * MediaFusion y Comet (ElfHosted) quedan registrados pero sin consultar: sin
 * debrid no devuelven torrents.
 * `tpb-adult-addon.click` queda registrado por su manifest, pero solo expone
 * catálogos Porn (no streams IMDb movie/series): una watchlist IMDb no puede
 * consultarlo sin inventar un mapeo título → ID, así que se informa como
 * "manifest-only" en vez de importar resultados adultos no relacionados.
 */

export const PROVIDERS = Object.freeze({
  peerflix: Object.freeze({
    slug: 'peerflix',
    name: 'Peerflix',
    baseUrl: 'https://peerflix.mov',
    manifestUrl: 'https://peerflix.mov/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: 'Fuente principal (contenido en español)',
  }),
  torrentsdb: Object.freeze({
    slug: 'torrentsdb',
    name: 'TorrentsDB',
    baseUrl: 'https://torrentsdb.com',
    manifestUrl: 'https://torrentsdb.com/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: 'Agrega YTS, EZTV, 1337x, RARGB, Nyaa, TPB, Kat, TTL, Rutracker…',
  }),
  torrentio: Object.freeze({
    slug: 'torrentio',
    name: 'Torrentio',
    baseUrl: 'https://torrentio.strem.fun',
    manifestUrl: 'https://torrentio.strem.fun/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: 'Agrega YTS, EZTV, RARGB, 1337x, TPB, TGx, MagnetDL, Nyaa, MejorTorrent…',
  }),
  piratebay: Object.freeze({
    slug: 'piratebay',
    name: 'ThePirateBay+',
    baseUrl: 'https://thepiratebay-plus.strem.fun',
    manifestUrl: 'https://thepiratebay-plus.strem.fun/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: 'TPB directo',
  }),
  ytztvio: Object.freeze({
    slug: 'ytztvio',
    name: 'Ytztvio',
    baseUrl: 'https://ytztvio.galacticcapsule.workers.dev',
    manifestUrl: 'https://ytztvio.galacticcapsule.workers.dev/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: 'YTS + EZTV',
  }),
  torrentclaw: Object.freeze({
    slug: 'torrentclaw',
    name: 'TorrentClaw',
    baseUrl: 'https://torrentclaw.com/api/stremio',
    manifestUrl: 'https://torrentclaw.com/api/stremio/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: '30+ fuentes verificadas (TrueSpec), incluye fuentes ES/LATAM',
    // La 1.ª línea del título es una puntuación ("🔵 65/100 · 👤 579"); el
    // release real está en behaviorHints.filename. "🌐 1080p" del name no es
    // una fuente: la fuente/grupo va en "🏷️ YIFY".
    titleFromFilename: true,
    sourceBadge: '🏷️',
  }),
  aniscraper: Object.freeze({
    slug: 'aniscraper',
    name: 'AniScraper',
    baseUrl: 'https://c5541ffce7d3-aniscraper.baby-beamup.club',
    manifestUrl: 'https://c5541ffce7d3-aniscraper.baby-beamup.club/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: 'Anime: Nyaa, AnimeTosho, AniRena, TsukiHime (responde vacío si no es anime)',
    titleFromFilename: true,
    sourceBadge: '⚙️',
  }),
  stremthru: Object.freeze({
    slug: 'stremthru',
    aliases: ['torz', 'stremthru-torz', 'stremthru_torz'],
    name: 'StremThru Torz',
    // El manifest exige configuración (configurationRequired). Se consulta con
    // la configuración pública P2P, sin debrid ni token:
    //   base64('{"stores":[{"c":"p2p","t":""}]}')
    baseUrl: 'https://stremthru.13377001.xyz/stremio/torz/eyJzdG9yZXMiOlt7ImMiOiJwMnAiLCJ0IjoiIn1dfQ==',
    manifestUrl: 'https://stremthru.13377001.xyz/stremio/torz/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
    description: 'Base de torrents colaborativa (modo P2P, sin debrid)',
    // "⚙️" es el grupo del release y "🌐" los idiomas; el indexador va en "🔍".
    titleFromFilename: true,
    sourceBadge: '🔍',
  }),
  mediafusion: Object.freeze({
    slug: 'mediafusion',
    name: 'MediaFusion',
    baseUrl: 'https://mediafusion.elfhosted.com',
    manifestUrl: 'https://mediafusion.elfhosted.com/manifest.json',
    types: ['movie', 'series'],
    queryable: false,
    adult: false,
    enabledByDefault: false,
    description: 'ElfHosted: sin configurar no devuelve torrents; necesita una configuración cifrada (normalmente con debrid).',
    note: 'Manifest registrado; la instancia ElfHosted responde {"streams":[]} sin configuración y su configuración va cifrada por el servidor.',
  }),
  comet: Object.freeze({
    slug: 'comet',
    name: 'Comet',
    baseUrl: 'https://comet.elfhosted.com',
    manifestUrl: 'https://comet.elfhosted.com/manifest.json',
    types: ['movie', 'series'],
    queryable: false,
    adult: false,
    enabledByDefault: false,
    description: 'ElfHosted: las búsquedas sin debrid están desactivadas.',
    note: 'Manifest registrado; ElfHosted responde "Non-debrid searches disabled on ElfHosted" sin un debrid configurado.',
  }),
  tpbAdult: Object.freeze({
    slug: 'tpbAdult',
    aliases: ['tpb-adult', 'tpb_adult', 'adult'],
    name: 'TPB Adult',
    baseUrl: 'https://tpb-adult-addon.click',
    manifestUrl: 'https://tpb-adult-addon.click/manifest.json',
    types: ['Porn'],
    queryable: false,
    adult: true,
    enabledByDefault: false,
    description: 'Solo catálogo Porn; su manifest no ofrece streams movie/series por IMDb, por eso no se mezcla en la ingesta.',
    note: 'Manifest registrado; solo expone catálogos Porn y no streams IMDb movie/series.',
  }),
});

export const DEFAULT_PROVIDER_SLUGS = Object.freeze(
  Object.values(PROVIDERS).filter(p => p.queryable && p.enabledByDefault).map(p => p.slug)
);

const PROVIDER_ALIASES = new Map(
  Object.values(PROVIDERS).flatMap(provider => [
    provider.slug,
    ...(provider.aliases || []),
    provider.name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
  ].map(alias => [alias.toLowerCase(), provider.slug]))
);

/**
 * "peerflix, TorrentsDB" o ['peerflix', 'torrentio'] → slugs válidos, sin
 * duplicados y en el orden pedido. Vacío/ausente = los providers por defecto.
 */
export function resolveProviderSlugs(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const cleaned = list.map(value => String(value ?? '').trim()).filter(Boolean);
  if (!cleaned.length) return [...DEFAULT_PROVIDER_SLUGS];
  return [...new Set(cleaned.map(value => PROVIDER_ALIASES.get(value.toLowerCase())).filter(Boolean))];
}

/** Providers que de verdad se pueden consultar por IMDb, en el orden de `slugs`. */
export function queryableProviders(slugs) {
  return slugs
    .map(slug => PROVIDERS[slug])
    .filter(provider => provider?.queryable && provider.types.length > 0);
}

/** Manifests registrados que no se consultan (solo catálogo). */
export function manifestOnlyProviders() {
  return Object.values(PROVIDERS).filter(provider => !provider.queryable);
}

export function allProviderManifestMetadata() {
  return Object.values(PROVIDERS).map(({ slug, name, baseUrl, manifestUrl, types, queryable, adult, note }) => ({
    slug, name, baseUrl, manifestUrl, types, queryable, adult, note: note || null,
  }));
}
