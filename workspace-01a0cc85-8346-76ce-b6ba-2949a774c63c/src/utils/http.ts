import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosHeaders } from 'axios';
import { CloudflareBypassEngine, DEFAULT_ACCEPT_LANGUAGE } from './anti-cloudflare.js';
import type { ClearanceSession } from './anti-cloudflare.js';

/**
 * Modern User-Agent profiles. Client hints are DERIVED from the UA at request
 * time (see `deriveClientHints`) instead of being hand-written, so a bumped UA
 * can never drift out of sync with `Sec-Ch-Ua` again.
 */
export interface UserAgentProfile {
  userAgent: string;
  secChUa?: string;
  secChUaMobile: string;
  secChUaPlatform: string;
}

const USER_AGENT_PROFILES: readonly string[] = Object.freeze([
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
]);

/**
 * Builds the `Sec-Ch-Ua*` triple that the given UA would really send.
 * Firefox sends no client hints at all; Chromium sends the greased brand list.
 */
export function deriveClientHints(userAgent: string): Pick<UserAgentProfile, 'secChUa' | 'secChUaMobile' | 'secChUaPlatform'> | null {
  if (typeof userAgent !== 'string' || !userAgent) return null;
  // Firefox/Safari do not implement Client Hints; sending them is itself a tell.
  if (/Firefox\//i.test(userAgent) || (!/Chrome\//i.test(userAgent) && !/Chromium\//i.test(userAgent))) {
    return null;
  }

  const versionMatch = userAgent.match(/(?:Chrome|Chromium)\/(\d+)/i);
  const major = versionMatch ? Number.parseInt(versionMatch[1], 10) : 131;
  const edgeMatch = userAgent.match(/Edg\/(\d+)/i);

  // Chromium's greasy brand rotates the "Not" token with the major version.
  const greaseBrand = major % 4 === 0 ? '"Not_A Brand";v="8"' : '"Not?A_Brand";v="99"';
  const brands = edgeMatch
    ? [`"Microsoft Edge";v="${edgeMatch[1]}"`, `"Chromium";v="${major}"`, greaseBrand]
    : [`"Google Chrome";v="${major}"`, `"Chromium";v="${major}"`, greaseBrand];

  let platform = '"Windows"';
  if (/Macintosh|Mac OS X/i.test(userAgent)) platform = '"macOS"';
  else if (/(Android)/i.test(userAgent)) platform = '"Android"';
  else if (/(CrOS|Linux|X11)/i.test(userAgent)) platform = '"Linux"';

  return {
    secChUa: brands.join(', '),
    secChUaMobile: /Android|Mobile/i.test(userAgent) ? '?1' : '?0',
    secChUaPlatform: platform
  };
}

export function getRandomUserAgentProfile(): UserAgentProfile {
  const userAgent = USER_AGENT_PROFILES[Math.floor(Math.random() * USER_AGENT_PROFILES.length)];
  return toProfile(userAgent);
}

/** Builds a profile from any UA string, deriving consistent client hints. */
export function toProfile(userAgent: string): UserAgentProfile {
  const hints = deriveClientHints(userAgent);
  return {
    userAgent,
    secChUa: hints?.secChUa,
    secChUaMobile: hints?.secChUaMobile ?? '?0',
    secChUaPlatform: hints?.secChUaPlatform ?? '"Windows"'
  };
}

export function getRandomUserAgent(): string {
  return getRandomUserAgentProfile().userAgent;
}

/**
 * Generates dynamic, browser-consistent HTTP headers for a given User-Agent or profile.
 */
export function getHeadersForUserAgent(uaOrProfile: string | UserAgentProfile = getRandomUserAgentProfile()): Record<string, string> {
  const profile: UserAgentProfile = typeof uaOrProfile === 'string' ? toProfile(uaOrProfile) : uaOrProfile;

  const headers: Record<string, string> = {
    'User-Agent': profile.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
    // `zstd` is deliberately absent: the axios/node transport cannot decode it,
    // so advertising it made some mirrors answer with an unreadable body.
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };

  // Chromium-based Client Hints
  if (profile.secChUa) {
    headers['Sec-Ch-Ua'] = profile.secChUa;
    headers['Sec-Ch-Ua-Mobile'] = profile.secChUaMobile;
    headers['Sec-Ch-Ua-Platform'] = profile.secChUaPlatform;
  }

  return headers;
}

export class CloudflareChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareChallengeError';
  }
}

export interface HttpClientOptions extends AxiosRequestConfig {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  autoSolveCloudflare?: boolean;
}

/**
 * Per-request overrides. Mirror probing uses
 * `{ autoSolveCloudflare: false, maxRetries: 0 }` so a dead domain costs one
 * short request instead of a 30 s headless-browser solve.
 */
export interface RequestOptions extends AxiosRequestConfig {
  autoSolveCloudflare?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
}

const CHALLENGE_MAX_BODY_SCAN = 400_000;

export class ResilientHttpClient {
  private client: AxiosInstance;
  private maxRetries: number;
  private baseDelayMs: number;
  private autoSolveCloudflare: boolean;

  constructor(options: HttpClientOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1500;
    this.autoSolveCloudflare = options.autoSolveCloudflare ?? true;

    const timeout = options.timeoutMs ?? options.timeout ??
      (Number(process.env.REQUEST_TIMEOUT_MS) >= 1000 ? Number(process.env.REQUEST_TIMEOUT_MS) : 20000);

    const { timeoutMs: _ignoredTimeout, ...rest } = options;

    this.client = axios.create({
      ...rest,
      timeout,
      maxRedirects: 5,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Safely resolves a complete URL using the native URL parser, handling relative paths and custom baseURLs.
   */
  private resolveFullUrl(configUrl?: string, configBaseUrl?: string): string {
    const relativeOrAbsolute = configUrl || '';
    const base = configBaseUrl || this.client.defaults.baseURL || '';

    if (!relativeOrAbsolute) return base;
    if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;

    if (base) {
      try {
        const formattedBase = base.endsWith('/') ? base : `${base}/`;
        return new URL(relativeOrAbsolute.replace(/^\/+/, ''), formattedBase).href;
      } catch {
        return `${base.replace(/\/+$/, '')}/${relativeOrAbsolute.replace(/^\/+/, '')}`;
      }
    }

    return relativeOrAbsolute;
  }

  /**
   * Cheap pre-filter: a Cloudflare interstitial is always small HTML/text, never
   * a binary body. Skipping buffers and parsed JSON removes a `JSON.stringify`
   * of every API payload from the hot path.
   */
  private static isScannable(response: AxiosResponse | undefined): boolean {
    if (!response) return false;
    const responseType = response.config?.responseType;
    if (responseType === 'arraybuffer' || responseType === 'stream' || responseType === 'blob' || responseType === 'document') {
      return false;
    }
    const data = response.data;
    if (typeof data === 'string') return data.length <= CHALLENGE_MAX_BODY_SCAN;
    // axios leaves `responseType: 'json'` payloads as strings when the body was
    // really an HTML interstitial, so objects never need scanning.
    return false;
  }

  /**
   * Detects Cloudflare challenge pages regardless of response data type (String, Buffer, or Object).
   */
  private isCloudflareChallenge(data: unknown): boolean {
    if (!data) return false;

    let content = '';
    if (typeof data === 'string') {
      content = data;
    } else if (Buffer.isBuffer(data)) {
      content = data.toString('utf-8');
    } else if (typeof data === 'object') {
      // Only used for error payloads, which are small; never for hot 200 paths.
      try {
        content = JSON.stringify(data);
      } catch {
        return false;
      }
    }

    if (!content) return false;
    const lower = content.slice(0, CHALLENGE_MAX_BODY_SCAN).toLowerCase();

    const hasChallengeIndicators =
      lower.includes('<title>just a moment') ||
      lower.includes('<title>un momento') ||
      lower.includes('<title>attention required') ||
      lower.includes('id="challenge-stage"') ||
      lower.includes('id="challenge-running"') ||
      lower.includes('id="challenge-error-title"') ||
      lower.includes('enable javascript and cookies to continue') ||
      lower.includes('challenges.cloudflare.com/turnstile') ||
      lower.includes('cf-turnstile') ||
      lower.includes('checking your browser before accessing') ||
      lower.includes('cf_chl_opt') ||
      lower.includes('/cdn-cgi/challenge-platform');

    if (!hasChallengeIndicators) return false;

    const hasRealContent =
      lower.includes('magnet:?xt=urn:btih:') ||
      lower.includes('<article') ||
      lower.includes('torrent-list') ||
      lower.includes('tgxtablerow') ||
      lower.includes('table-list') ||
      (lower.includes('<table') && !lower.includes('challenge-stage'));

    return !hasRealContent;
  }

  /** `Retry-After` in seconds (number or HTTP-date), capped to a sane maximum. */
  private static retryAfterMs(headers: unknown): number | null {
    const raw = (headers as Record<string, string> | undefined)?.['retry-after'];
    if (!raw) return null;

    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 60_000);

    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
    return null;
  }

  /** True when the two URLs identify the same document (hash ignored). */
  private static sameDocument(a: string, b: string): boolean {
    try {
      const left = new URL(a);
      const right = new URL(b);
      left.hash = '';
      right.hash = '';
      return left.href === right.href;
    } catch {
      return false;
    }
  }

  /**
   * Executes HTTP requests with automatic clearance session injection, Cloudflare
   * challenge detection and exponential backoff.
   */
  public async request<T = unknown>(config: RequestOptions = {}): Promise<AxiosResponse<T>> {
    const {
      autoSolveCloudflare: autoSolveOverride,
      maxRetries: maxRetriesOverride,
      baseDelayMs: baseDelayOverride,
      ...axiosConfig
    } = config;

    const maxRetries = Math.max(0, Math.min(maxRetriesOverride ?? this.maxRetries, 6));
    const baseDelayMs = Math.max(0, baseDelayOverride ?? this.baseDelayMs);
    const autoSolve = autoSolveOverride ?? this.autoSolveCloudflare;

    const fullUrl = this.resolveFullUrl(axiosConfig.url, axiosConfig.baseURL);
    const clearanceEngine = CloudflareBypassEngine.getInstance();

    /** Cookies/UA harvested by the stealth browser during this request. */
    let bypass: ClearanceSession | null = null;
    let bypassAttempts = 0;
    const usedUserAgents = new Set<string>();

    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= maxRetries) {
      // Disabling Cloudflare handling also disables replaying any previously
      // cached clearance; the caller's own Cookie header must remain authoritative.
      const session: ClearanceSession | null = autoSolve
        ? bypass ?? (fullUrl ? clearanceEngine.getCachedSession(fullUrl) : null)
        : null;

      const profile: UserAgentProfile = session
        ? toProfile(session.userAgent)
        : this.pickFreshProfile(usedUserAgents);
      usedUserAgents.add(profile.userAgent);

      const baseHeaders = getHeadersForUserAgent(profile);
      if (session) baseHeaders['Accept-Language'] = session.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE;

      const requestHeaders = AxiosHeaders.from((axiosConfig.headers || {}) as Record<string, string>);

      // Merge generated base headers without overwriting explicitly passed request headers
      Object.entries(baseHeaders).forEach(([key, value]) => {
        if (!requestHeaders.has(key)) {
          requestHeaders.set(key, value);
        }
      });

      if (session?.cookieHeader) {
        // Cookies are credentials, not preferences: they always win over a
        // stale caller-supplied Cookie header.
        requestHeaders.set('Cookie', session.cookieHeader);
      }

      try {
        const response = await this.client.request<T>({
          ...axiosConfig,
          headers: requestHeaders
        });

        // Detect hidden Cloudflare challenges inside HTTP 200 responses
        if (ResilientHttpClient.isScannable(response) && this.isCloudflareChallenge(response.data)) {
          throw new CloudflareChallengeError('Cloudflare Challenge detected inside a 200 OK response body');
        }

        return response;
      } catch (err: unknown) {
        lastError = err;
        attempt++;

        // A cached clearance the server just rejected is dead: forget it so the
        // next request to this host does not replay the same stale cookie.
        if (session && session !== bypass) {
          clearanceEngine.invalidateSession(fullUrl);
        }

        const isAxiosError = axios.isAxiosError(err);
        const status = isAxiosError ? err.response?.status : undefined;
        const responseData = isAxiosError ? err.response?.data : undefined;
        const isTimeout = isAxiosError && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT');

        const isCloudflare =
          err instanceof CloudflareChallengeError ||
          status === 403 ||
          status === 503 ||
          (isAxiosError && err.response?.headers?.['cf-mitigated'] === 'challenge') ||
          this.isCloudflareChallenge(responseData);

        // --------------------------------------------------------------
        // Stealth escalation
        // --------------------------------------------------------------
        if (isCloudflare && autoSolve && fullUrl && bypassAttempts < 2) {
          bypassAttempts++;
          console.warn(
            `[HTTP] Cloudflare WAF on ${fullUrl} (status: ${status ?? 'challenge page'}). ` +
            `Activating stealth solver (attempt ${bypassAttempts}/2)...`
          );

          try {
            // The second escalation forces a fresh solve: reusing the cached
            // clearance that the server has just refused would loop forever.
            const bypassResult = await clearanceEngine.solveAndFetch(fullUrl, 30_000, {
              force: bypassAttempts > 1
            });

            if (bypassResult) {
              // The browser may already hold the rendered document: return it
              // instead of paying for a second (probably blocked) request.
              const shortCircuit = this.buildBypassResponse<T>(bypassResult, fullUrl, axiosConfig);
              if (shortCircuit) return shortCircuit;

              if (bypassResult.cookies || bypassResult.userAgent) {
                bypass = {
                  cookieHeader: bypassResult.cookies ?? '',
                  userAgent: bypassResult.userAgent ?? profile.userAgent,
                  acceptLanguage: bypassResult.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE,
                  solvedAt: Date.now(),
                  expiresAt: Date.now() + 30 * 60 * 1000,
                  hasClearance: /cf_clearance=/.test(bypassResult.cookies ?? ''),
                  hostname: ''
                };
                console.log(`[HTTP] Clearance session captured for ${fullUrl}; retrying with the browser fingerprint.`);
                // The retry is a fresh opportunity, not a penalised attempt.
                attempt--;
                continue;
              }
            }
          } catch (bypassErr: unknown) {
            const msg = bypassErr instanceof Error ? bypassErr.message : String(bypassErr);
            console.warn(`[HTTP] Cloudflare stealth solve failed: ${msg}`);
          }
        }

        if (attempt > maxRetries) break;

        // Permanent client errors: never retried.
        if (status === 400 || status === 401 || status === 404 || status === 410 || status === 422) {
          throw err;
        }

        // 403/429 spam reduction: once the stealth solver has been tried, a
        // second refusal means the mirror really blocks us. Fail fast so the
        // crawler moves on to the next mirror / HTML fallback.
        if ((status === 403 || status === 429) && bypassAttempts > 0) {
          throw err;
        }
        // Even without Cloudflare, 403/429 do not benefit from 3 backoff rounds
        // with the same UA: allow a single retry with a different profile.
        if ((status === 403 || status === 429) && attempt >= 2) {
          throw err;
        }

        const backoff = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        const retryAfter = isAxiosError ? ResilientHttpClient.retryAfterMs(err.response?.headers) : null;
        const delay = status === 429 && retryAfter !== null ? retryAfter : backoff;

        console.warn(
          `[HTTP] Retry ${attempt}/${maxRetries} for ${fullUrl || axiosConfig.url || 'endpoint'} ` +
          `(status: ${status ?? (isTimeout ? 'Timeout' : 'Network')}). Waiting ${delay}ms...`
        );
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Turns a solved browser navigation into an axios-shaped response when the
   * caller asked for HTML/text and the browser really landed on the same URL.
   */
  private buildBypassResponse<T>(
    bypassResult: { html?: string; finalUrl?: string; solved?: boolean },
    fullUrl: string,
    axiosConfig: AxiosRequestConfig
  ): AxiosResponse<T> | null {
    const html = bypassResult.html;
    if (!html || bypassResult.solved === false) return null;

    const responseType = axiosConfig.responseType;
    if (responseType && responseType !== 'text') return null;
    if (!ResilientHttpClient.sameDocument(bypassResult.finalUrl ?? '', fullUrl)) return null;
    if (!/^\s*</.test(html) || this.isCloudflareChallenge(html)) return null;

    console.log(`[HTTP] Serving ${fullUrl} from the stealth browser (${html.length} bytes).`);
    return {
      data: html as T,
      status: 200,
      statusText: 'OK (stealth browser)',
      headers: {},
      config: axiosConfig as AxiosResponse<T>['config'],
      request: {}
    };
  }

  /** Picks a profile that has not been used yet during this request. */
  private pickFreshProfile(usedUserAgents: Set<string>): UserAgentProfile {
    if (usedUserAgents.size >= USER_AGENT_PROFILES.length) return getRandomUserAgentProfile();

    for (let tries = 0; tries < 8; tries++) {
      const profile = getRandomUserAgentProfile();
      if (!usedUserAgents.has(profile.userAgent)) return profile;
    }
    return getRandomUserAgentProfile();
  }

  public async get<T = unknown>(url: string, config?: RequestOptions): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  public async getBuffer(url: string, config?: RequestOptions): Promise<Buffer> {
    const response = await this.request<ArrayBuffer>({
      ...config,
      method: 'GET',
      url,
      responseType: 'arraybuffer'
    });
    const data = response.data as ArrayBuffer | Buffer | undefined;
    if (Buffer.isBuffer(data)) return data;
    return Buffer.from(data ?? new ArrayBuffer(0));
  }
}
