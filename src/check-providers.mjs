#!/usr/bin/env node
/**
 * Chequeo de salud de los addons Stremio registrados.
 *
 * Para cada addon descarga su manifest y pide streams de una película y un
 * episodio conocidos (con el mismo cliente HTTP y el mismo parser que la
 * ingesta), y muestra estado, latencia y torrents válidos. Sirve para ver de
 * un vistazo qué addon se ha caído o ha cambiado de formato.
 *
 *   npm run check-providers                      # todos los registrados
 *   PROVIDERS=torrentio,brazuca npm run check-providers
 *   STRICT=1 npm run check-providers             # sale con 1 si un addon por defecto falla
 *
 * En GitHub Actions escribe la tabla en el resumen del job.
 */

import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROVIDERS, DEFAULT_PROVIDER_SLUGS, resolveProviderSlugs } from '../public/lib/providers.js';
import { createJsonFetcher, describeError, fetchProviderStreams } from '../public/lib/pipeline.js';

export const PROBES = Object.freeze([
  Object.freeze({ kind: 'movie', imdbId: 'tt0111161', label: 'Cadena perpetua (1994)' }),
  Object.freeze({ kind: 'series', imdbId: 'tt0944947', season: 1, episode: 1, label: 'Juego de Tronos S01E01' }),
]);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'peerflix-static-bot/2.0',
];

async function timed(fn, now) {
  const started = now();
  try {
    return { ok: true, value: await fn(), ms: now() - started };
  } catch (err) {
    return { ok: false, error: describeError(err), ms: now() - started };
  }
}

/** Comprueba un addon: manifest + una consulta por cada sonda. */
export async function checkProvider(provider, { fetchJSON, probes = PROBES, now = () => Date.now() } = {}) {
  const manifest = await timed(() => fetchJSON(provider.manifestUrl, { retries: 1 }), now);
  const result = {
    slug: provider.slug,
    name: provider.name,
    queryable: Boolean(provider.queryable),
    enabledByDefault: Boolean(provider.enabledByDefault),
    manifest: manifest.ok
      ? { ok: true, ms: manifest.ms, version: manifest.value?.version ?? null }
      : { ok: false, ms: manifest.ms, error: manifest.error },
    probes: [],
  };
  if (!provider.queryable) return { ...result, status: manifest.ok ? 'manifest-only' : 'down' };

  for (const probe of probes) {
    const outcome = await timed(() => fetchProviderStreams(fetchJSON, provider, probe), now);
    result.probes.push(outcome.ok
      ? { kind: probe.kind, ok: true, ms: outcome.ms, streams: outcome.value.streams.length }
      : { kind: probe.kind, ok: false, ms: outcome.ms, error: outcome.error });
  }
  const answered = result.probes.filter(p => p.ok);
  const withStreams = answered.filter(p => p.streams > 0);
  // AniScraper solo tiene anime: responder vacío a estas sondas es normal.
  const emptyIsNormal = provider.slug === 'aniscraper';
  result.status = !answered.length
    ? 'down'
    : withStreams.length === result.probes.length || (emptyIsNormal && answered.length === result.probes.length)
      ? 'ok'
      : withStreams.length ? 'partial' : 'empty';
  return result;
}

const STATUS_ICON = { ok: '✅', partial: '🟡', empty: '⚪', down: '❌', 'manifest-only': '📄' };

export function healthToMarkdown(results) {
  const lines = [
    '## 🩺 Salud de los addons',
    '',
    `Sondas: ${PROBES.map(p => `${p.label} (\`${p.kind === 'movie' ? p.imdbId : `${p.imdbId}:${p.season}:${p.episode}`}\`)`).join(' · ')}`,
    '',
    '| | Addon | Por defecto | Manifest | Película | Episodio |',
    '|---|---|---|---|---|---|',
  ];
  const cell = probe => !probe ? '—' : probe.ok ? `${probe.streams} torrents · ${probe.ms} ms` : `❌ ${probe.error}`;
  for (const r of results) {
    const manifest = r.manifest.ok ? `v${r.manifest.version ?? '?'} · ${r.manifest.ms} ms` : `❌ ${r.manifest.error}`;
    const movie = r.probes.find(p => p.kind === 'movie');
    const series = r.probes.find(p => p.kind === 'series');
    lines.push(`| ${STATUS_ICON[r.status] || '?'} | ${r.name} \`${r.slug}\` | ${r.enabledByDefault ? 'sí' : 'no'} | ${manifest} | ${r.queryable ? cell(movie) : 'no se consulta'} | ${r.queryable ? cell(series) : 'no se consulta'} |`);
  }
  lines.push('');
  lines.push('✅ responde con torrents · 🟡 solo en parte · ⚪ responde vacío · ❌ caído · 📄 solo manifest');
  return lines.join('\n') + '\n';
}

async function main() {
  const slugs = process.env.PROVIDERS ? resolveProviderSlugs(process.env.PROVIDERS) : Object.keys(PROVIDERS);
  const fetchJSON = createJsonFetcher({
    timeoutMs: Number.parseInt(process.env.FETCH_TIMEOUT_MS || '', 10) || 20000,
    retries: 1,
    headers: attempt => ({ 'user-agent': USER_AGENTS[attempt % USER_AGENTS.length], accept: 'application/json,*/*' }),
  });
  const results = await Promise.all(slugs.map(slug => checkProvider(PROVIDERS[slug], { fetchJSON })));
  const markdown = healthToMarkdown(results);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);

  const failingDefaults = results.filter(r => DEFAULT_PROVIDER_SLUGS.includes(r.slug) && (r.status === 'down' || r.status === 'empty'));
  if (failingDefaults.length) {
    console.warn(`⚠️  Addons por defecto sin torrents: ${failingDefaults.map(r => r.slug).join(', ')}`);
    if (process.env.STRICT === '1') process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
