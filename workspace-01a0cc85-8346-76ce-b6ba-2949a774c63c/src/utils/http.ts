import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { CloudflareBypassEngine } from './anti-cloudflare.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0'
];

export function getRandomUserAgent(): string {
  const index = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[index];
}

export function getDefaultHeaders(): Record<string, string> {
  return {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
}

export interface HttpClientOptions {
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

    this.client = axios.create({
      timeout: options.timeoutMs ?? 20000,
      headers: getDefaultHeaders(),
      maxRedirects: 5,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Executes an HTTP request with automatic clearance cookie injection and exponential backoff.
   */
  public async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let attempt = 0;
    let lastError: unknown = null;
    const url = config.url || '';

    // Check if clearance session exists for this domain
    const clearanceEngine = CloudflareBypassEngine.getInstance();
    const cachedSession = clearanceEngine.getCachedSession(url);

    while (attempt <= this.maxRetries) {
      try {
        const mergedHeaders: Record<string, any> = {
          ...getDefaultHeaders(),
          ...(config.headers || {})
        };

        if (cachedSession) {
          mergedHeaders['Cookie'] = cachedSession.cookieHeader;
          mergedHeaders['User-Agent'] = cachedSession.userAgent;
        }

        const response = await this.client.request<T>({
          ...config,
          headers: mergedHeaders
        });

        // Check if response is a disguised Cloudflare 200 challenge page
        if (typeof response.data === 'string' && this.isCloudflareChallenge(response.data)) {
          throw new Error('Cloudflare Challenge encountered in 200 response');
        }

        return response;
      } catch (err: unknown) {
        lastError = err;
        attempt++;

        const isAxiosError = axios.isAxiosError(err);
        const status = isAxiosError ? err.response?.status : undefined;
        const responseData = isAxiosError && typeof err.response?.data === 'string' ? err.response.data : '';

        // If Cloudflare 403/503 is detected and autoSolve is enabled
        const isCloudflare = status === 403 || status === 503 || this.isCloudflareChallenge(responseData);

        if (isCloudflare && this.autoSolveCloudflare && url && attempt === 1) {
          console.warn(`[HTTP] Cloudflare WAF detected on ${url} (Status: ${status}). Activating stealth solver...`);
          try {
            const bypassResult = await clearanceEngine.solveAndFetch(url, 12000);
            if (bypassResult && bypassResult.html && !this.isCloudflareChallenge(bypassResult.html)) {
              console.log(`[HTTP] Cloudflare successfully bypassed for ${url}!`);
              return {
                data: bypassResult.html as unknown as T,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: config as any
              };
            }
          } catch (bypassErr: unknown) {
            const msg = bypassErr instanceof Error ? bypassErr.message : String(bypassErr);
            console.warn(`[HTTP] Cloudflare stealth solve attempt timed out or failed: ${msg}`);
          }
          // Do not do multiple retries on Cloudflare 403 if solve failed once; fail fast for mirror failover
          throw err;
        }

        if (attempt > this.maxRetries) break;

        // Skip permanent client errors
        if (status === 404 || status === 400 || status === 401 || status === 403) {
          throw err;
        }

        const delay = this.baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(`[HTTP] Retry ${attempt}/${this.maxRetries} for ${url} (Status: ${status || 'Network/Timeout'}). Waiting ${delay}ms...`);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private isCloudflareChallenge(html: string): boolean {
    if (!html) return false;
    const lower = html.toLowerCase();
    const hasChallengeIndicators = (
      lower.includes('<title>just a moment') ||
      lower.includes('<title>un momento') ||
      lower.includes('id="challenge-stage"') ||
      lower.includes('id="challenge-error-title"') ||
      lower.includes('enable javascript and cookies to continue')
    );
    const hasRealContent = lower.includes('<table') || lower.includes('magnet:?') || lower.includes('<article');
    return hasChallengeIndicators && !hasRealContent;
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
