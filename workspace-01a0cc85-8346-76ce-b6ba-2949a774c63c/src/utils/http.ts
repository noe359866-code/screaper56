import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosHeaders } from 'axios';
import { CloudflareBypassEngine } from './anti-cloudflare.js';

/**
 * Modern User-Agent profiles with pre-aligned Sec-CH-UA Client Hints
 * to eliminate header fingerprint mismatches.
 */
export interface UserAgentProfile {
  userAgent: string;
  secChUa?: string;
  secChUaMobile: string;
  secChUaPlatform: string;
}

const USER_AGENT_PROFILES: UserAgentProfile[] = [
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"'
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"macOS"'
  },
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Linux"'
  },
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"'
  },
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    secChUa: '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"'
  }
];

export function getRandomUserAgentProfile(): UserAgentProfile {
  const index = Math.floor(Math.random() * USER_AGENT_PROFILES.length);
  return USER_AGENT_PROFILES[index];
}

export function getRandomUserAgent(): string {
  return getRandomUserAgentProfile().userAgent;
}

/**
 * Generates dynamic, browser-consistent HTTP headers for a given User-Agent or profile.
 */
export function getHeadersForUserAgent(uaOrProfile: string | UserAgentProfile = getRandomUserAgentProfile()): Record<string, string> {
  const profile: UserAgentProfile = typeof uaOrProfile === 'string'
    ? (USER_AGENT_PROFILES.find(p => p.userAgent === uaOrProfile) || {
        userAgent: uaOrProfile,
        secChUaMobile: '?0',
        secChUaPlatform: uaOrProfile.includes('Macintosh') ? '"macOS"' : uaOrProfile.includes('Linux') ? '"Linux"' : '"Windows"'
      })
    : uaOrProfile;

  const headers: Record<string, string> = {
    'User-Agent': profile.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
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

    this.client = axios.create({
      ...options,
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
      try {
        content = JSON.stringify(data);
      } catch {
        return false;
      }
    }

    if (!content) return false;
    const lower = content.toLowerCase();

    const hasChallengeIndicators = 
      lower.includes('<title>just a moment') ||
      lower.includes('<title>un momento') ||
      lower.includes('id="challenge-stage"') ||
      lower.includes('id="challenge-error-title"') ||
      lower.includes('enable javascript and cookies to continue') ||
      lower.includes('challenges.cloudflare.com/turnstile');

    const hasRealContent = 
      lower.includes('<table') || 
      lower.includes('magnet:?') || 
      lower.includes('<article') || 
      (lower.includes('"json"') && !lower.includes('challenge'));

    return hasChallengeIndicators && !hasRealContent;
  }

  /**
   * Executes HTTP requests with automatic clearance session injection, Cloudflare challenge detection, and exponential backoff.
   */
  public async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let attempt = 0;
    let lastError: unknown = null;

    const fullUrl = this.resolveFullUrl(config.url, config.baseURL);
    const clearanceEngine = CloudflareBypassEngine.getInstance();
    let cfBypassAttempted = false;

    while (attempt <= this.maxRetries) {
      try {
        const cachedSession = fullUrl ? clearanceEngine.getCachedSession(fullUrl) : null;
        const profile = cachedSession 
          ? { userAgent: cachedSession.userAgent, secChUaMobile: '?0', secChUaPlatform: '"Windows"' }
          : getRandomUserAgentProfile();

        const baseHeaders = getHeadersForUserAgent(profile);
        const requestHeaders = AxiosHeaders.from(config.headers || {});

        // Merge generated base headers without overwriting explicitly passed request headers
        Object.entries(baseHeaders).forEach(([key, value]) => {
          if (!requestHeaders.has(key)) {
            requestHeaders.set(key, value);
          }
        });

        if (cachedSession) {
          requestHeaders.set('Cookie', cachedSession.cookieHeader);
        }

        const response = await this.client.request<T>({
          ...config,
          headers: requestHeaders
        });

        // Detect hidden Cloudflare challenges inside HTTP 200 responses
        if (this.isCloudflareChallenge(response.data)) {
          throw new CloudflareChallengeError('Cloudflare Challenge detected in 200 OK response body');
        }

        return response;
      } catch (err: unknown) {
        lastError = err;
        attempt++;

        const isAxiosError = axios.isAxiosError(err);
        const status = isAxiosError ? err.response?.status : undefined;
        const responseData = isAxiosError ? err.response?.data : undefined;

        const isCloudflare = 
          err instanceof CloudflareChallengeError || 
          status === 403 || 
          status === 503 || 
          this.isCloudflareChallenge(responseData);

        // Attempt stealth bypass if Cloudflare WAF is encountered
        if (isCloudflare && this.autoSolveCloudflare && fullUrl && !cfBypassAttempted) {
          cfBypassAttempted = true;
          console.warn(`[HTTP] Cloudflare WAF detected on ${fullUrl} (Status: ${status || 'Challenge Page'}). Activating stealth solver...`);
          
          try {
            const bypassResult = await clearanceEngine.solveAndFetch(fullUrl, 30000);
            if (bypassResult && bypassResult.cookies) {
              console.log(`[HTTP] Cloudflare successfully bypassed for ${fullUrl}. Retrying request with clearance session...`);
              // Decrement attempt counter so the retry is not penalized
              attempt--;
              continue;
            }
          } catch (bypassErr: unknown) {
            const msg = bypassErr instanceof Error ? bypassErr.message : String(bypassErr);
            console.warn(`[HTTP] Cloudflare stealth solve failed: ${msg}`);
          }
        }

        if (attempt > this.maxRetries) break;

        // Immediately throw permanent HTTP client errors (excluding 403 which can be a CF soft-block)
        if (status === 400 || status === 401 || status === 404) {
          throw err;
        }

        const delay = this.baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(`[HTTP] Retry ${attempt}/${this.maxRetries} for ${fullUrl || config.url || 'endpoint'} (Status: ${status || 'Network/Timeout'}). Waiting ${delay}ms...`);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  public async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  public async getBuffer(url: string, config?: AxiosRequestConfig): Promise<Buffer> {
    const response = await this.request<ArrayBuffer>({
      ...config,
      method: 'GET',
      url,
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  }
}
