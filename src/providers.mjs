/**
 * Stremio addon sources used by the ingest Action.
 *
 * The registry itself lives in public/lib/providers.js so the static web app
 * (which can now process a watchlist in the browser, without any token) and
 * the Action share exactly the same list. This module only adds the parts
 * that read the environment (PROVIDERS=peerflix,torrentio,…).
 */

import {
  PROVIDERS,
  DEFAULT_PROVIDER_SLUGS,
  allProviderManifestMetadata,
  manifestOnlyProviders,
  queryableProviders,
  resolveProviderSlugs,
} from '../public/lib/providers.js';

export { PROVIDERS, DEFAULT_PROVIDER_SLUGS, allProviderManifestMetadata, resolveProviderSlugs };

export function requestedProviderSlugs(raw = process.env.PROVIDERS) {
  return resolveProviderSlugs(raw);
}

export function resolveEnabledProviders(raw = process.env.PROVIDERS) {
  return queryableProviders(requestedProviderSlugs(raw));
}

export function resolveManifestOnlyProviders() {
  // Keep catalog-only manifests visible in reports even when they are not part
  // of the IMDb request list; they are registered sources, not silent crawlers.
  return manifestOnlyProviders();
}
