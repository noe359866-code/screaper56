/**
 * Shared mirror resolution layer for every crawler.
 *
 * Public torrent indexes rotate domains constantly: a hard-coded base URL is the
 * single most common reason an adapter silently returns zero records. This module
 * centralises that problem:
 *
 *   - Builds an ordered mirror pool from environment overrides + curated defaults.
 *   - Probes candidates with a short timeout and a *content* validator, so parked
 *     domains, ISP block pages and Cloudflare interstitials are never accepted.
 *   - Caches the winning mirror per crawler for the rest of the process run.
 *   - Reports every failure reason instead of throwing an opaque error.
 *
 * No mirror is endorsed or guaranteed here: the list is configuration, and the
 * operator decides which domains they are allowed to query.
 */

import { describeError } from './support.js';

export interface MirrorHttpResponse<T = unknown> {
  status: number;
  data: T;
}

export interface MirrorHttpClient {
  get<T = unknown>(url: string, config?: Record<string, unknown>): Promise<MirrorHttpResponse<T>>;
}

export interface MirrorLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface MirrorProbe {
  /** Path appended to the mirror origin, e.g. `/latest100`. Defaults to `/`. */
  path?: string;
  /** Accepts the mirror only when the payload really looks like the target site. */
  validate?: (data: unknown, context: { mirror: string; status: number }) => boolean;
  /** Short per-probe timeout; mirror probing must never block a whole run. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Human readable label used in logs. */
  label?: string;
  /**
   * Retries per probe. Probing must fail fast, so this defaults to `0`; a dead
   * domain should cost one short request, not three backoff rounds.
   */
  maxRetries?: number;
  /**
   * Whether a probe may escalate to the headless-browser Cloudflare solver.
   * Defaults to `false`: solving a challenge for a mirror we are merely
   * *testing* can burn 30 s per candidate. The real crawl requests still solve.
   */
  autoSolveCloudflare?: boolean;
}

export interface MirrorPoolInput {
  /** Crawler name, used for the cache key and the default env prefix. */
  name: string;
  /** Environment prefix, e.g. `DONTORRENT` -> DONTORRENT_BASE_URL / DONTORRENT_MIRRORS. */
  envPrefix?: string;
  defaults: readonly string[];
  /** Extra candidates discovered at runtime (for example from an official domain list). */
  extra?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface ResolveMirrorOptions {
  name: string;
  mirrors: readonly string[];
  http: MirrorHttpClient;
  probes?: readonly MirrorProbe[];
  logger?: MirrorLogger;
  /** How long a successful resolution is reused inside this process. */
  cacheTtlMs?: number;
  /** Hard cap on probed candidates so a 150-domain pool cannot stall a run. */
  maxCandidates?: number;
  /**
   * Returned instead of throwing when every probe fails. Use it for adapters that
   * can still try their normal flow (and fail with a richer message afterwards).
   */
  fallback?: string | null;
  /** Skip the in-process cache (used by tests). */
  useCache?: boolean;
  /**
   * Hedged probing: a candidate is launched, and if it has not produced a
   * verdict after this many milliseconds the next one is launched too. Fast
   * mirrors therefore cost exactly one request (polite), while a pool of dead
   * domains no longer serialises `candidates x timeout` seconds of waiting.
   * `0` disables hedging and probes strictly one at a time.
   */
  probeStaggerMs?: number;
}

export interface MirrorAttempt {
  mirror: string;
  reason: string;
}

export class MirrorResolutionError extends Error {
  public readonly attempts: MirrorAttempt[];

  constructor(name: string, attempts: MirrorAttempt[]) {
    const detail = attempts.map(a => `  - ${a.mirror}: ${a.reason}`).join('\n');
    super(
      `[${name}] No compatible mirror available (${attempts.length} candidates probed).\n${detail}\n` +
      `Set ${name.toUpperCase()}_BASE_URL or ${name.toUpperCase()}_MIRRORS to point at a domain you are allowed to query.`
    );
    this.name = 'MirrorResolutionError';
    this.attempts = attempts;
  }
}

interface CacheEntry {
  mirror: string;
  expiresAt: number;
}

const mirrorCache = new Map<string, CacheEntry>();

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CANDIDATES = 12;

/** Normalises a candidate into a comparable origin+path without a trailing slash. */
export function normalizeMirror(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (!url.hostname.includes('.')) return null;
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

/** Parses `a.com, b.com https://c.com` style env values into normalised mirrors. */
export function parseMirrorList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return dedupeMirrors(raw.split(/[,\s;]+/).map(normalizeMirror).filter((m): m is string => Boolean(m)));
}

export function dedupeMirrors(mirrors: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of mirrors) {
    const normalized = normalizeMirror(candidate);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

/**
 * Ordered candidate list: `<PREFIX>_BASE_URL` wins, then `<PREFIX>_MIRRORS`,
 * then runtime discoveries, then the curated defaults shipped with the adapter.
 */
export function buildMirrorPool(input: MirrorPoolInput): string[] {
  const env = input.env ?? process.env;
  const prefix = (input.envPrefix ?? input.name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const base = normalizeMirror(env[`${prefix}_BASE_URL`]);
  const configured = parseMirrorList(env[`${prefix}_MIRRORS`]);
  return dedupeMirrors([base, ...configured, ...(input.extra ?? []), ...input.defaults]);
}

export function clearMirrorCache(name?: string): void {
  if (name) mirrorCache.delete(name);
  else mirrorCache.clear();
}

export function getCachedMirror(name: string): string | null {
  const entry = mirrorCache.get(name);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    mirrorCache.delete(name);
    return null;
  }
  return entry.mirror;
}

export function rememberMirror(name: string, mirror: string, ttlMs = DEFAULT_CACHE_TTL_MS): void {
  mirrorCache.set(name, { mirror, expiresAt: Date.now() + ttlMs });
}

/** Cheap guard against block pages, parked domains and challenge interstitials. */
export function looksLikeBlockedPage(html: string): boolean {
  const lower = html.slice(0, 20000).toLowerCase();
  return (
    lower.includes('just a moment') ||
    lower.includes('un momento') ||
    lower.includes('checking your browser') ||
    lower.includes('id="challenge-stage"') ||
    lower.includes('cf-mitigated') ||
    lower.includes('attention required!') ||
    lower.includes('domain is for sale') ||
    lower.includes('domain for sale') ||
    lower.includes('buy this domain') ||
    lower.includes('this site can’t be reached') ||
    lower.includes('sitio bloqueado') ||
    lower.includes('acceso bloqueado') ||
    lower.includes('403 forbidden') ||
    lower.includes('access denied') ||
    lower.includes('request blocked') ||
    lower.includes('cf-browser-verification') ||
    lower.includes('/cdn-cgi/challenge-platform') ||
    lower.includes('ddos-guard') ||
    lower.includes('verify you are human') ||
    lower.includes('website is under maintenance') ||
    lower.includes('pagina no encontrada') ||
    lower.includes('website not available')
  );
}

/** Builds a validator that requires at least one marker and rejects block pages. */
export function htmlMarkerValidator(markers: readonly (string | RegExp)[]): MirrorProbe['validate'] {
  return (data: unknown): boolean => {
    // A short body can still be a valid (empty) listing, so the markers — not a
    // length heuristic — decide whether the mirror speaks the expected dialect.
    if (typeof data !== 'string' || data.length < 16) return false;
    if (looksLikeBlockedPage(data)) return false;
    return markers.some(marker =>
      typeof marker === 'string' ? data.toLowerCase().includes(marker.toLowerCase()) : marker.test(data)
    );
  };
}

function joinMirrorPath(mirror: string, path: string | undefined): string {
  if (!path || path === '/') return `${mirror}/`;
  return `${mirror}${path.startsWith('/') ? '' : '/'}${path}`;
}

const DEFAULT_PROBE_STAGGER_MS = 700;

/** Delay that can be cancelled so a resolved probe never leaves a live timer. */
function cancellableDelay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    resolveFn = resolve;
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
      resolveFn?.();
    }
  };
}

function envProbeStagger(): number {
  const raw = Number.parseInt(process.env.MIRROR_PROBE_STAGGER_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PROBE_STAGGER_MS;
}

interface CandidateOutcome {
  index: number;
  mirror: string;
  accepted: boolean;
  elapsedMs: number;
  label?: string;
  attempts: MirrorAttempt[];
}

/**
 * Probes candidates and returns the highest-priority mirror that answers with
 * content the adapter recognises. Never throws for a single bad mirror.
 *
 * Candidates are launched in priority order with hedging (see
 * `probeStaggerMs`): a healthy first mirror is probed exactly once, but a pool
 * of dead domains resolves in ~`timeout` instead of `candidates x timeout`.
 * A lower-index candidate always wins over a higher-index one, even when it
 * answers later.
 */
export async function resolveWorkingMirror(options: ResolveMirrorOptions): Promise<string> {
  const {
    name,
    http,
    logger,
    probes = [{}],
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    fallback,
    useCache = true,
    probeStaggerMs = envProbeStagger()
  } = options;

  const pool = dedupeMirrors(options.mirrors);
  if (!pool.length) {
    if (fallback !== undefined && fallback !== null) return normalizeMirror(fallback) ?? fallback;
    throw new MirrorResolutionError(name, [{ mirror: '(empty pool)', reason: 'No candidates configured' }]);
  }

  const cached = useCache ? getCachedMirror(name) : null;
  const ordered = cached ? dedupeMirrors([cached, ...pool]) : pool;
  const candidates = ordered.slice(0, Math.max(1, maxCandidates));

  const probeCandidate = async (mirror: string, index: number): Promise<CandidateOutcome> => {
    const attempts: MirrorAttempt[] = [];

    for (const probe of probes) {
      const target = joinMirrorPath(mirror, probe.path);
      const startedAt = Date.now();
      try {
        logger?.debug?.(`Probing ${target}${probe.label ? ` (${probe.label})` : ''}...`);
        const response = await http.get(target, {
          timeout: probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          headers: probe.headers,
          // Probing must never escalate to the headless browser nor grind
          // through backoff rounds; the real crawl requests still do.
          maxRetries: probe.maxRetries ?? 0,
          autoSolveCloudflare: probe.autoSolveCloudflare ?? false
        });
        const accepted = probe.validate
          ? probe.validate(response.data, { mirror, status: response.status })
          : response.status >= 200 && response.status < 400;

        if (accepted) {
          return { index, mirror, accepted: true, elapsedMs: Date.now() - startedAt, label: probe.label, attempts };
        }
        attempts.push({ mirror: target, reason: `Unexpected payload (status ${response.status})` });
      } catch (error) {
        attempts.push({ mirror: target, reason: describeError(error) });
      }
    }

    return { index, mirror, accepted: false, elapsedMs: 0, attempts };
  };

  const inflight: Array<Promise<CandidateOutcome>> = [];
  const outcomes = new Map<number, CandidateOutcome>();
  let winner: CandidateOutcome | null = null;

  const record = (outcome: CandidateOutcome): void => {
    outcomes.set(outcome.index, outcome);
    if (!outcome.accepted) {
      logger?.warn(
        `Mirror unavailable: ${outcome.mirror} (${outcome.attempts.at(-1)?.reason ?? 'unexpected payload'}). Trying next candidate...`
      );
      return;
    }
    if (!winner || outcome.index < winner.index) winner = outcome;
  };

  for (let index = 0; index < candidates.length; index++) {
    if (winner) break;

    const task = probeCandidate(candidates[index], index);
    inflight.push(task);
    task.then(record, () => { /* probeCandidate never rejects */ });

    const delay = cancellableDelay(Math.max(0, probeStaggerMs));
    await Promise.race([task, delay.promise]);
    delay.cancel();

    if (!winner) logger?.debug?.(`No verdict yet from ${candidates[index]}; hedging the next candidate.`);
  }

  // Only candidates that can still beat the current winner are worth waiting for.
  const pending = inflight.filter((_task, index) => !winner || index < winner.index);
  await Promise.allSettled(pending);

  if (winner) {
    const outcome = winner as CandidateOutcome;
    logger?.info(
      `Active mirror: ${outcome.mirror} (${outcome.elapsedMs}ms${outcome.label ? `, ${outcome.label}` : ''})`
    );
    if (useCache) rememberMirror(name, outcome.mirror, cacheTtlMs);
    return outcome.mirror;
  }

  const attempts: MirrorAttempt[] = candidates
    .map((_mirror, index) => outcomes.get(index)?.attempts ?? [{ mirror: _mirror, reason: 'Probe did not complete' }])
    .flat();

  if (fallback !== undefined && fallback !== null) {
    const resolved = normalizeMirror(fallback) ?? fallback;
    logger?.warn(`No mirror passed validation; continuing with ${resolved} so the adapter can report a precise error.`);
    return resolved;
  }

  throw new MirrorResolutionError(name, attempts);
}

/**
 * Extracts mirror candidates from an "official domains" page.
 * Only hostnames matching the expected brand pattern are accepted, so an ad or a
 * shortener published on the same page never enters the pool.
 */
export function extractBrandMirrors(html: string, hostPattern: RegExp, limit = 40): string[] {
  if (typeof html !== 'string' || !html) return [];
  const found: string[] = [];
  for (const match of html.matchAll(/https?:\/\/[a-z0-9.-]+(?:\/[^\s"'<>]*)?/gi)) {
    const normalized = normalizeMirror(match[0]);
    if (!normalized) continue;
    let hostname: string;
    try {
      hostname = new URL(normalized).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!hostPattern.test(hostname)) continue;
    found.push(`https://${hostname}`);
    if (found.length >= limit * 4) break;
  }
  return dedupeMirrors(found).slice(0, limit);
}
