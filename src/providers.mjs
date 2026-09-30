/**
 * Stremio addon sources used by the ingest Action.
 *
 * All four queryable addons expose the standard
 *   /stream/{movie|series}/{id}.json
 * contract. `tpb-adult-addon.click` is also registered by its manifest URL,
 * but its manifest exposes Porn catalogs (not IMDb movie/series streams), so
 * an IMDb watchlist cannot query it without inventing a title-to-content-ID
 * mapping. It is reported as manifest-only rather than silently importing
 * unrelated adult catalog results into public.torrents.
 */

export const PROVIDERS = {
  peerflix: {
    slug: 'peerflix',
    name: 'Peerflix',
    baseUrl: 'https://peerflix.mov',
    manifestUrl: 'https://peerflix.mov/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
  },
  torrentsdb: {
    slug: 'torrentsdb',
    name: 'TorrentsDB',
    baseUrl: 'https://torrentsdb.com',
    manifestUrl: 'https://torrentsdb.com/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
  },
  torrentio: {
    slug: 'torrentio',
    name: 'Torrentio',
    baseUrl: 'https://torrentio.strem.fun',
    manifestUrl: 'https://torrentio.strem.fun/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
  },
  piratebay: {
    slug: 'piratebay',
    name: 'ThePirateBay+',
    baseUrl: 'https://thepiratebay-plus.strem.fun',
    manifestUrl: 'https://thepiratebay-plus.strem.fun/manifest.json',
    types: ['movie', 'series'],
    queryable: true,
    adult: false,
    enabledByDefault: true,
  },
  tpbAdult: {
    slug: 'tpbAdult',
    aliases: ['tpb-adult', 'tpb_adult', 'adult'],
    name: 'TPB Adult',
    baseUrl: 'https://tpb-adult-addon.click',
    manifestUrl: 'https://tpb-adult-addon.click/manifest.json',
    types: ['Porn'],
    queryable: false,
    adult: true,
    enabledByDefault: false,
    note: 'Manifest registrado; solo expone catálogos Porn y no streams IMDb movie/series.',
  },
};

const PROVIDER_ALIASES = new Map(
  Object.values(PROVIDERS).flatMap(provider => [
    provider.slug,
    ...(provider.aliases || []),
    provider.name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
  ].map(alias => [alias.toLowerCase(), provider.slug]))
);

export function requestedProviderSlugs() {
  const raw = process.env.PROVIDERS;
  if (!raw || !raw.trim()) {
    return Object.values(PROVIDERS)
      .filter(provider => provider.enabledByDefault)
      .map(provider => provider.slug);
  }
  return [...new Set(raw.split(',').map(value => PROVIDER_ALIASES.get(value.trim().toLowerCase())).filter(Boolean))];
}

export function resolveEnabledProviders() {
  const requested = requestedProviderSlugs();
  return requested
    .map(slug => PROVIDERS[slug])
    .filter(provider => provider?.queryable && provider.types.length > 0);
}

export function resolveManifestOnlyProviders() {
  // Keep catalog-only manifests visible in reports even when they are not part
  // of the IMDb request list; they are registered sources, not silent crawlers.
  return Object.values(PROVIDERS).filter(provider => !provider.queryable);
}

export function allProviderManifestMetadata() {
  return Object.values(PROVIDERS).map(({ slug, name, baseUrl, manifestUrl, types, queryable, adult, note }) => ({
    slug, name, baseUrl, manifestUrl, types, queryable, adult, note: note || null,
  }));
}
