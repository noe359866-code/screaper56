import { TorrentRecord } from '../types/torrent.js';
import { ResilientHttpClient } from '../utils/http.js';
import { normalizeInfoHash } from '../utils/magnet.js';
import { hasValidSpanishRelease } from '../utils/language.js';
import { parseTorrentBuffer, ParsedTorrentFile } from '../utils/bencode2.js';
import {
  buildMirrorPool,
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
  protected readonly metrics = new CrawlerMetrics();

  private cachedLogger?: CrawlerLogger;
  private cachedDeadline?: Deadline;

  constructor() {
    this.httpClient = new ResilientHttpClient();
  }

  /** Prefixed logger (`LOG_LEVEL=debug|info|warn|error|silent`). */
  protected get log(): CrawlerLogger {
    if (!this.cachedLogger) this.cachedLogger = new CrawlerLogger(this.name);
    return this.cachedLogger;
  }

  /** Optional wall-clock budget shared by the whole adapter run. */
  protected get deadline(): Deadline {
    if (!this.cachedDeadline) this.cachedDeadline = new Deadline();
    return this.cachedDeadline;
  }

  protected resetRunState(): void {
    this.cachedDeadline = new Deadline();
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
    const mirrors = buildMirrorPool({
      name: this.name,
      envPrefix: setup.envPrefix,
      defaults: setup.defaults,
      extra: setup.extra
    });

    this.log.debug(`Mirror pool (${mirrors.length}): ${mirrors.join(', ')}`);

    const mirror = await resolveWorkingMirror({
      name: this.name,
      mirrors,
      http: this.httpClient,
      probes: setup.probes,
      logger: this.log,
      fallback: setup.fallback,
      maxCandidates: setup.maxCandidates
    });

    this.baseUrl = mirror;
    return mirror;
  }

  /** GET returning HTML, with an explicit error when the payload is not HTML. */
  protected async fetchHtml(url: string, config: Record<string, unknown> = {}): Promise<string> {
    await politePause();
    const response = await this.httpClient.get<string>(url, config);
    if (typeof response.data !== 'string') {
      throw new Error(`Expected HTML from ${url} but received ${typeof response.data}`);
    }
    return response.data;
  }

  /** GET returning parsed JSON. */
  protected async fetchJson<T>(url: string, config: Record<string, unknown> = {}): Promise<T> {
    await politePause();
    const response = await this.httpClient.get<T>(url, config);
    return response.data;
  }

  /**
   * Same as `fetchTorrentMetainfo` but through `GET` + `responseType: arraybuffer`,
   * for sites whose download handler needs the regular request pipeline.
   */
  protected async fetchTorrentMetainfoViaGet(url: string, referer?: string): Promise<ParsedTorrentFile> {
    await politePause();
    const response = await this.httpClient.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_TORRENT_BYTES,
      maxBodyLength: MAX_TORRENT_BYTES,
      headers: {
        Accept: 'application/x-bittorrent,application/octet-stream;q=0.9,*/*;q=0.5',
        ...(referer ? { Referer: referer } : {})
      }
    });
    const parsed = parseTorrentBuffer(Buffer.from(response.data as ArrayBuffer));
    if (!parsed) throw new Error(`Response from ${url} is not valid v1/hybrid torrent metainfo`);
    return parsed;
  }

  /**
   * Downloads a `.torrent` metainfo file (capped) and validates it.
   * Only the info dictionary is hashed; nothing is extracted or executed.
   */
  protected async fetchTorrentMetainfo(url: string, referer?: string): Promise<ParsedTorrentFile> {
    await politePause();
    const buffer = await this.httpClient.getBuffer(url, {
      maxContentLength: MAX_TORRENT_BYTES,
      maxBodyLength: MAX_TORRENT_BYTES,
      headers: {
        Accept: 'application/x-bittorrent,application/octet-stream;q=0.9,*/*;q=0.5',
        ...(referer ? { Referer: referer } : {})
      }
    });
    const parsed = parseTorrentBuffer(buffer);
    if (!parsed) throw new Error(`Response from ${url} is not valid v1/hybrid torrent metainfo`);
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
    const byHash = new Map<string, TorrentRecord>();

    for (const record of records) {
      if (!record || !record.info_hash) continue;

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

      // Keep the richer record as the base, then fill its gaps with the other one.
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

    for (const record of records) {
      if (hasValidSpanishRelease(record.audio, record.subtitles)) {
        accepted.push(record);
      } else {
        discarded.push(record);
      }
    }

    // En lugar de hacer "spam" en la consola 1000 veces, mostramos un resumen analítico.
    if (discarded.length > 0) {
      this.log.info(
        `Language filter: accepted ${accepted.length} records, discarded ${discarded.length} without Spanish/English evidence.`
      );
    } else if (accepted.length > 0) {
      this.log.info(`Language filter: all ${accepted.length} records passed.`);
    }

    return { accepted, discarded };
  }

  /** One-line diagnostic printed at the end of every adapter run. */
  protected logRunSummary(records: TorrentRecord[]): void {
    this.log.info(`Run summary: records=${records.length} ${this.metrics.toString()}`);
  }
}
