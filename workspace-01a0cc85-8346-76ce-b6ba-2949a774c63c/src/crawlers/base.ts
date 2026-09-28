import { TorrentRecord } from '../types/torrent.js';
import { ResilientHttpClient, RequestOptions } from '../utils/http.js';
import { normalizeInfoHash } from '../utils/magnet.js';
import { hasValidSpanishRelease } from '../utils/language.js';
import { parseTorrentBuffer, ParsedTorrentFile } from '../utils/bencode2.js';
import { CloudflareBypassEngine } from '../utils/anti-cloudflare.js';
import {
  buildMirrorPool,
  looksLikeBlockedPage,
  MirrorProbe,
  resolveWorkingMirror
} from './mirrors.js';
import {
  CrawlerLogger,
  CrawlerMetrics,
  Deadline,
  mergeRecords,
  politePause,
  recordScore
} from './support.js';

/** Maximum metainfo size accepted from any source (hash calculation only). */
export const MAX_TORRENT_BYTES = 10 * 1024 * 1024;

/** Raised when a server answered 200 with a WAF/parked/interstitial page. */
export class BlockedPageError extends Error {
  constructor(public readonly url: string) {
    super(`Blocked or interstitial page served instead of content: ${url}`);
    this.name = 'BlockedPageError';
  }
}

export class CrawlerDeadlineError extends Error {
  constructor(name: string) {
    super(`[${name}] Crawler deadline exceeded`);
    this.name = 'CrawlerDeadlineError';
  }
}

/** Blocking and rate-limit responses must abort a source run, not look like empty pages. */
export function rethrowIfBlockedOrRateLimited(error: unknown): void {
  if (error instanceof BlockedPageError || error instanceof CrawlerDeadlineError) throw error;
  const response = (error as { response?: { status?: unknown } } | null)?.response;
  if (response?.status === 429) throw error;
}

export interface MirrorSetup {
  /** Curated fallbacks shipped with the adapter; env overrides always win. */
  defaults: readonly string[];
  /** Environment prefix, defaults to the uppercased crawler name. */
  envPrefix?: string;
  /** Content probes; the first mirror validating any probe is selected. */
  probes?: readonly MirrorProbe[];
  /** Runtime-discovered candidates appended after the configured ones. */
  extra?: readonly string[];
  /** When set, resolution never throws and this value is used as last resort. */
  fallback?: string | null;
  maxCandidates?: number;
}

export abstract class BaseCrawler {
  public abstract readonly name: string;

  // Optional: many adapters resolve a live mirror at runtime instead of pinning
  // a single domain. It is updated in place once a mirror has been selected so
  // the orchestrator can log which endpoint actually served the data.
  public baseUrl?: string;

  protected httpClient: ResilientHttpClient;
  protected readonly metrics: CrawlerMetrics = new CrawlerMetrics();

  private cachedLogger?: CrawlerLogger;
  private cachedDeadline?: Deadline;

  constructor() {
    this.httpClient = new ResilientHttpClient();
  }

  /** Prefixed logger (`LOG_LEVEL=debug|info|warn|error|silent`). */
  protected get log(): CrawlerLogger {
    if (!this.cachedLogger) {
      this.cachedLogger = new CrawlerLogger(this.name);
    }
    return this.cachedLogger;
  }

  /** Optional wall-clock budget shared by the whole adapter run. */
  protected get deadline(): Deadline {
    if (!this.cachedDeadline) {
      this.cachedDeadline = new Deadline();
    }
    return this.cachedDeadline;
  }

  /** Shared stealth-browser engine (one Chromium per process, never per page). */
  protected get bypassEngine(): CloudflareBypassEngine {
    return CloudflareBypassEngine.getInstance();
  }

  /**
   * Resets the runtime state for a new crawl execution run.
   */
  protected resetRunState(): void {
    this.cachedDeadline = new Deadline();
    this.metrics.reset();
  }

  /**
   * Releases anything this adapter keeps open. Called by the orchestrator after
   * every run so a browser-based adapter never leaks a Chromium process.
   */
  public async close(): Promise<void> {
    /* Overridden by adapters that own resources (see WolftorrentCrawler). */
  }

  /**
   * Main crawl execution method to be implemented by each dedicated target site module.
   */
  public abstract crawl(maxPages: number): Promise<TorrentRecord[]>;

  // ==========================================================================
  // Shared transport helpers
  // ==========================================================================

  /** Resolves the first mirror that actually serves the expected content. */
  protected async resolveMirror(setup: MirrorSetup): Promise<string> {
    const defaults = setup.defaults ?? [];
    const mirrors = buildMirrorPool({
      name: this.name,
      envPrefix: setup.envPrefix,
      defaults,
      extra: setup.extra
    });

    this.log.debug(`Mirror pool (${mirrors.length}): ${mirrors.join(', ')}`);

    const mirror = await resolveWorkingMirror({
      name: this.name,
      mirrors,
      http: { get: (url, config) => this.httpClient.get(url, this.requestWithinBudget(config)) },
      probes: setup.probes,
      logger: this.log,
      fallback: setup.fallback,
      maxCandidates: setup.maxCandidates
    });

    this.baseUrl = mirror;
    return mirror;
  }

  /** Prevent fresh requests once the cooperative run budget has expired. */
  protected requestWithinBudget(config: RequestOptions = {}): RequestOptions {
    const remaining = this.deadline.remainingMs;
    if (remaining <= 0) throw new CrawlerDeadlineError(this.name);
    return this.capTimeoutToBudget(config, remaining);
  }

  /** Clamp a request timeout to the remaining budget without ever throwing. */
  private capTimeoutToBudget(config: RequestOptions, remaining = this.deadline.remainingMs): RequestOptions {
    if (!Number.isFinite(remaining)) return config;
    const timeout = typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : 20_000;
    return { ...config, timeout: Math.max(1, Math.min(timeout, remaining)) };
  }

  /**
   * Budget check, courtesy pause, then the final timeout cap — in that order.
   *
   * The check runs BEFORE the pause on purpose. Pausing first meant a worker
   * that had just passed `deadline.expired` could expire during a multi-second
   * `CRAWLER_REQUEST_DELAY_MS` pause and throw `CrawlerDeadlineError`, which
   * is terminal and discarded every record the run had already collected.
   * A request that was admitted within budget now simply runs with whatever
   * time is left (and fails as an ordinary per-item timeout, not a run abort).
   */
  private async admitRequest(config: RequestOptions = {}): Promise<RequestOptions> {
    const admitted = this.requestWithinBudget(config);
    await politePause();
    return this.capTimeoutToBudget(admitted);
  }

  /**
   * GET returning HTML, with an explicit error when the payload is not HTML.
   * By default, a WAF/parked interstitial served with HTTP 200 raises
   * `BlockedPageError` instead of handing garbage to cheerio.
   */
  protected async fetchHtml(
    url: string,
    config: RequestOptions = {},
    options: { rejectBlocked?: boolean } = {}
  ): Promise<string> {
    const response = await this.httpClient.get<string>(url, await this.admitRequest(config));
    if (typeof response.data !== 'string') {
      throw new Error(`Expected HTML from ${url} but received ${typeof response.data}`);
    }
    if (options.rejectBlocked !== false && looksLikeBlockedPage(response.data)) {
      this.metrics.add('blockedPages');
      throw new BlockedPageError(url);
    }
    return response.data;
  }

  /** GET returning parsed JSON. */
  protected async fetchJson<T>(url: string, config: RequestOptions = {}): Promise<T> {
    const response = await this.httpClient.get<T>(url, await this.admitRequest({ responseType: 'json', ...config }));
    return response.data;
  }

  /**
   * GET returning the raw body as a Buffer (with the courtesy pause applied).
   *
   * Needed by adapters whose site is not UTF-8: decoding a Windows-1251 page
   * with the axios default text decoder turns every Cyrillic title into
   * mojibake, so the adapter must decode the bytes itself.
   */
  protected async fetchBytes(url: string, config: RequestOptions = {}): Promise<Buffer> {
    return this.httpClient.getBuffer(url, await this.admitRequest(config));
  }

  /**
   * Runs `task` with a page from the ONE shared stealth browser.
   * Adapters that need a real DOM must use this instead of launching their own
   * Chromium: launching per detail page spawned hundreds of browsers per run.
   */
  protected async withBrowserPage<T>(
    task: (page: import('playwright').Page) => Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    const config = this.requestWithinBudget({ timeout: timeoutMs });
    return this.bypassEngine.withPage(page => task(page), config.timeout);
  }

  /**
   * Downloads a `.torrent` metainfo file via GET ArrayBuffer and validates it.
   * `extraHeaders` is merged last so an authenticated adapter can attach its
   * session cookie (private trackers reject an anonymous `dl.php` request).
   */
  protected async fetchTorrentMetainfoViaGet(
    url: string,
    referer?: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<ParsedTorrentFile> {
    const response = await this.httpClient.get<ArrayBuffer | Buffer>(url, await this.admitRequest({
      responseType: 'arraybuffer',
      maxContentLength: MAX_TORRENT_BYTES,
      maxBodyLength: MAX_TORRENT_BYTES,
      headers: {
        Accept: 'application/x-bittorrent,application/octet-stream;q=0.9,*/*;q=0.5',
        ...(referer ? { Referer: referer } : {}),
        ...extraHeaders
      }
    }));

    const data = response.data;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const parsed = parseTorrentBuffer(buffer);
    if (!parsed) {
      throw new Error(`Response from ${url} is not valid v1/hybrid torrent metainfo`);
    }
    return parsed;
  }

  /**
   * Downloads a `.torrent` metainfo file (capped) and validates it.
   * `extraHeaders` is merged last so an authenticated adapter can attach its
   * session cookie (private trackers reject an anonymous `dl.php` request).
   */
  protected async fetchTorrentMetainfo(
    url: string,
    referer?: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<ParsedTorrentFile> {
    const buffer = await this.httpClient.getBuffer(url, await this.admitRequest({
      maxContentLength: MAX_TORRENT_BYTES,
      maxBodyLength: MAX_TORRENT_BYTES,
      headers: {
        Accept: 'application/x-bittorrent,application/octet-stream;q=0.9,*/*;q=0.5',
        ...(referer ? { Referer: referer } : {}),
        ...extraHeaders
      }
    }));
    const parsed = parseTorrentBuffer(buffer);
    if (!parsed) {
      throw new Error(`Response from ${url} is not valid v1/hybrid torrent metainfo`);
    }
    return parsed;
  }

  // ==========================================================================
  // Post-processing
  // ==========================================================================

  /**
   * UTILIDAD COMPARTIDA: elimina torrents duplicados por info_hash normalizado.
   * Cuando dos fuentes internas describen el mismo hash, se fusionan los campos
   * para conservar la información más completa (nunca se inventan valores).
   */
  public deduplicateRecords(records: TorrentRecord[]): TorrentRecord[] {
    if (!Array.isArray(records)) return [];

    const byHash = new Map<string, TorrentRecord>();

    for (const record of records) {
      if (!record || typeof record !== 'object' || !record.info_hash) continue;

      const hash = normalizeInfoHash(record.info_hash);
      if (!hash || /^0{40}$/.test(hash)) continue;

      const normalized: TorrentRecord = {
        ...record,
        info_hash: hash,
        audio: Array.isArray(record.audio) ? record.audio : [],
        subtitles: Array.isArray(record.subtitles) ? record.subtitles : []
      };

      const existing = byHash.get(hash);
      if (!existing) {
        byHash.set(hash, normalized);
        continue;
      }

      // Conserva el registro más rico como base y completa sus vacíos con el otro.
      const [primary, secondary] = recordScore(normalized) > recordScore(existing)
        ? [normalized, existing]
        : [existing, normalized];

      byHash.set(hash, mergeRecords(primary, secondary));
    }

    return [...byHash.values()];
  }

  /**
   * Filters discovered torrents enforcing the language rule kept by this project:
   * Spanish audio (Castellano or Latino) OR English audio OR Spanish/English subtitles.
   */
  public filterSpanishReleases(records: TorrentRecord[]): {
    accepted: TorrentRecord[];
    discarded: TorrentRecord[];
  } {
    const accepted: TorrentRecord[] = [];
    const discarded: TorrentRecord[] = [];

    if (!Array.isArray(records)) {
      return { accepted, discarded };
    }

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;

      const audio = Array.isArray(record.audio) ? record.audio : [];
      const subtitles = Array.isArray(record.subtitles) ? record.subtitles : [];

      if (hasValidSpanishRelease(audio, subtitles)) {
        accepted.push(record);
      } else {
        discarded.push(record);
      }
    }

    if (discarded.length > 0) {
      this.log.info(
        `Language filter: accepted ${accepted.length} records, discarded ${discarded.length} without Spanish/English evidence.`
      );
    } else if (accepted.length > 0) {
      this.log.info(`Language filter: all ${accepted.length} records passed.`);
    }

    return { accepted, discarded };
  }

  public diagnostics(): string {
    return this.metrics.toString();
  }

  /** One-line diagnostic printed at the end of every adapter run. */
  protected logRunSummary(records: TorrentRecord[]): void {
    this.log.info(`Run summary: records=${records.length} ${this.metrics.toString()}`);
  }
}
