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

/**
 * Generates dynamic headers matching the provided User-Agent to prevent fingerprint mismatch.
 */
export function getHeadersForUserAgent(ua: string = getRandomUserAgent()): Record<string, string> {
  const isFirefox = ua.includes('Firefox');
  const isEdge = ua.includes('Edg/');
  const isMac = ua.includes('Macintosh') || ua.includes('Mac OS X');
  const isLinux = ua.includes('Linux') && !ua.includes('Android');

  const platform = isMac ? '"macOS"' : isLinux ? '"Linux"' : '"Windows"';
  
  const headers: Record<string, string> = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  // Firefox does not use Chromium Client Hints
  if (!isFirefox) {
    const match = ua.match(/Chrome\/(\d+)/);
    const major = match ? match[1] : '126';
    const brand = isEdge ? 'Microsoft Edge' : 'Google Chrome';
    
    headers['Sec-Ch-Ua'] = `"Not/A)Brand";v="8", "Chromium";v="${major}", "${brand}";v="${major}"`;
    headers['Sec-Ch-Ua-Mobile'] = '?0';
    headers['Sec-Ch-Ua-Platform'] = platform;
  }

  headers['Sec-Fetch-Dest'] = 'document';
  headers['Sec-Fetch-Mode'] = 'navigate';
  headers['Sec-Fetch-Site'] = 'none';
  headers['Sec-Fetch-User'] = '?1';
  headers['Upgrade-Insecure-Requests'] = '1';

  return headers;
}

class CloudflareChallengeError extends Error {}

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

    const initialUA = getRandomUserAgent();

    this.client = axios.create({
      ...options,
      timeout: options.timeoutMs ?? options.timeout ?? (Number(process.env.REQUEST_TIMEOUT_MS) >= 1000 ? Number(process.env.REQUEST_TIMEOUT_MS) : 20000),
      headers: getHeadersForUserAgent(initialUA),
      maxRedirects: 5,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Safely resolves a URL, supporting both absolute URLs and relative paths with Axios baseURL.
   */
  private resolveFullUrl(url?: string): string {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    const baseURL = this.client.defaults.baseURL || '';
    if (baseURL) {
      return `${baseURL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
    }
    return url;
  }

  /**
   * Executes an HTTP request with automatic clearance cookie injection and exponential backoff.
   */
  public async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let attempt = 0;
    let lastError: unknown = null;
    
    const fullUrl = this.resolveFullUrl(config.url);
    const clearanceEngine = CloudflareBypassEngine.getInstance();

    while (attempt <= this.maxRetries) {
      try {
        // Fetch cached session for this domain if available
        const cachedSession = fullUrl ? clearanceEngine.getCachedSession(fullUrl) : null;
        
        // Use cached UA if session exists, otherwise generate a fresh aligned header set
        const activeUA = cachedSession ? cachedSession.userAgent : getRandomUserAgent();
        const baseHeaders = getHeadersForUserAgent(activeUA);

        const mergedHeaders: Record<string, any> = {
          ...baseHeaders,
          ...(config.headers || {})
        };

        if (cachedSession) {
          mergedHeaders['Cookie'] = cachedSession.cookieHeader;
        }

        const response = await this.client.request<T>({
          ...config,
          headers: mergedHeaders
        });

        // Check if response is a disguised Cloudflare 200 challenge page
        if (typeof response.data === 'string' && this.isCloudflareChallenge(response.data)) {
          throw new CloudflareChallengeError('Cloudflare Challenge encountered in 200 response');
        }

        return response;
      } catch (err: unknown) {
        lastError = err;
        attempt++;

        const isAxiosError = axios.isAxiosError(err);
        const status = isAxiosError ? err.response?.status : undefined;
        const responseData = isAxiosError && typeof err.response?.data === 'string' ? err.response.data : '';

        // Check if it's a Cloudflare block (403, 503 or 200 challenge page)
        const isCloudflare = err instanceof CloudflareChallengeError || status === 403 || status === 503 || this.isCloudflareChallenge(responseData);

        if (isCloudflare && this.autoSolveCloudflare && fullUrl && attempt === 1) {
          console.warn(`[HTTP] Cloudflare WAF detected on ${fullUrl} (Status: ${status || 'Challenge Page'}). Activating stealth solver...`);
          try {
            const bypassResult = await clearanceEngine.solveAndFetch(fullUrl, 30000);
            if (bypassResult && bypassResult.cookies) {
              console.log(`[HTTP] Cloudflare successfully bypassed for ${fullUrl}! Retrying original request with new clearance session...`);
              // Restart loop or continue immediately to let the next iteration pick up the cached session
              continue; 
            }
          } catch (bypassErr: unknown) {
            const msg = bypassErr instanceof Error ? bypassErr.message : String(bypassErr);
            console.warn(`[HTTP] Cloudflare stealth solve attempt failed: ${msg}`);
          }
        }

        if (attempt > this.maxRetries) break;

        // Skip retrying permanent client errors (except 403 which might be CF)
        if (status === 400 || status === 401 || status === 404) {
          throw err;
        }

        const delay = this.baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(`[HTTP] Retry ${attempt}/${this.maxRetries} for ${fullUrl || config.url} (Status: ${status || 'Network/Timeout'}). Waiting ${delay}ms...`);
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
      lower.includes('enable javascript and cookies to continue') ||
      lower.includes('challenges.cloudflare.com/turnstile')
    );
    const hasRealContent = lower.includes('<table') || lower.includes('magnet:?') || lower.includes('<article') || lower.includes('"json"');
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
