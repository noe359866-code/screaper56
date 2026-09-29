/**
 * Stealth browser layer + Cloudflare clearance session manager.
 *
 * Design notes (why it looks like this):
 *
 *  1. The User-Agent is NEVER spoofed. Chromium sends its own UA, TLS
 *     fingerprint, HTTP/2 SETTINGS and `Sec-Ch-Ua` client hints, and those four
 *     must agree. Overriding `userAgent` while the real browser is Chrome 133
 *     produced a UA/CH-JA3 mismatch that Cloudflare scores as a bot instantly.
 *     Instead we harvest the *real* UA from the launched browser and replay it
 *     verbatim from axios, so the fast path and the browser path look identical.
 *  2. Playwright is imported lazily. `npm test`, dry runs and crawlers that
 *     never meet a WAF must not pay for loading a browser driver.
 *  3. One browser per process, one context per solve, bounded concurrency, and
 *     a single-flight map so ten crawlers hitting the same blocked host trigger
 *     ONE challenge solve instead of ten.
 *  4. The browser is closed on idle and on process exit: a live Chromium driver
 *     keeps libuv handles open and would otherwise stop Node from exiting.
 */

import type { Browser, BrowserContext, Page } from 'playwright';

// Browser globals below are only referenced inside page.addInitScript /
// page.evaluate callbacks (executed in Chromium, type-checked here against the
// Node lib, which intentionally excludes the DOM).
declare const window: unknown;
declare const document: {
  getElementById(id: string): unknown;
  querySelector(selectors: string): unknown;
  title?: string;
};

export interface ClearanceSession {
  /** Full `Cookie:` header value to replay from axios. */
  cookieHeader: string;
  /** Real Chromium UA harvested from the solving context. */
  userAgent: string;
  /** Accept-Language the context used; must be replayed verbatim. */
  acceptLanguage: string;
  solvedAt: number;
  expiresAt: number;
  /** True only when a real `cf_clearance` cookie was harvested. */
  hasClearance: boolean;
  /** Hostname this session was minted for. */
  hostname: string;
}

export interface BypassResult {
  /** Rendered HTML of the solved page (empty string when unavailable). */
  html: string;
  /** `Cookie:` header value scoped to the target host. */
  cookies: string;
  /** Real Chromium UA to replay on subsequent plain-HTTP requests. */
  userAgent: string;
  /** Accept-Language used while solving. */
  acceptLanguage: string;
  /** True when the page was served without an active challenge at the end. */
  solved: boolean;
  /** True when a challenge was seen at least once during navigation. */
  hadChallenge: boolean;
  /** Last HTTP status observed for the main document, when available. */
  status: number | null;
  /** URL the browser ended up on (challenges redirect). */
  finalUrl: string;
  /** URL originally requested. */
  requestedUrl: string;
  elapsedMs: number;
}

export interface SolveOptions {
  /** Total budget for navigation + challenge solving. Default 45s. */
  timeoutMs?: number;
  /** Force a fresh solve even when a cached session exists. */
  force?: boolean;
}

export const DEFAULT_ACCEPT_LANGUAGE = 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7';
const DEFAULT_LOCALE = 'es-ES';
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CACHED_SESSIONS = 48;
const MAX_CONCURRENT_CONTEXTS = 3;
const IDLE_CLOSE_MS = 90_000;
const CHALLENGE_MAX_WAIT_MS = 30_000;

const CHALLENGE_TITLE_MARKERS = [
  'just a moment',
  'un momento',
  'attention required',
  'checking your browser',
  'verify you are human',
  'verify you are a human',
  'are you a robot',
  'moment please'
];

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Counts down permits and queues acquirers; release is idempotent. */
class Semaphore {
  private readonly waiters: Array<() => void> = [];
  private used = 0;

  constructor(private readonly permits: number) {}

  public async acquire(): Promise<() => void> {
    if (this.used >= this.permits) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    this.used++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used = Math.max(0, this.used - 1);
      this.waiters.shift()?.();
    };
  }
}

export class CloudflareBypassEngine {
  private static instance: CloudflareBypassEngine | null = null;

  /** Insertion-ordered LRU of harvested clearance sessions, keyed by hostname. */
  private readonly sessions = new Map<string, ClearanceSession>();
  /** Single-flight map so concurrent solves of one host collapse into one. */
  private readonly inflight = new Map<string, Promise<BypassResult>>();

  private activeBrowser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private stealthApplied = false;
  private harvestedUserAgent: string | null = null;
  private readonly contextSlots = new Semaphore(MAX_CONCURRENT_CONTEXTS);
  private idleTimer: NodeJS.Timeout | null = null;
  private permanentlyClosed = false;

  private readonly sessionTtlMs = envInt('CF_CLEARANCE_TTL_MS', DEFAULT_SESSION_TTL_MS);

  private constructor() {}

  public static getInstance(): CloudflareBypassEngine {
    if (!CloudflareBypassEngine.instance) {
      CloudflareBypassEngine.instance = new CloudflareBypassEngine();
    }
    return CloudflareBypassEngine.instance;
  }

  /** Test/diagnostic hook: drop the singleton so a fresh engine is built. */
  public static resetInstance(): void {
    const current = CloudflareBypassEngine.instance;
    CloudflareBypassEngine.instance = null;
    void current?.close();
  }

  // ==========================================================================
  // Session cache
  // ==========================================================================

  private static hostnameOf(url: string): string | null {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /** Returns a still-valid cached clearance session for `url`, or null. */
  public getCachedSession(url: string): ClearanceSession | null {
    const hostname = CloudflareBypassEngine.hostnameOf(url);
    if (!hostname) return null;

    const session = this.sessions.get(hostname);
    if (!session) return null;

    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(hostname);
      return null;
    }

    // LRU touch: re-insert so eviction drops the least recently used host.
    this.sessions.delete(hostname);
    this.sessions.set(hostname, session);
    return session;
  }

  /** Stores a session harvested elsewhere (used by tests and by `solveAndFetch`). */
  public rememberSession(hostname: string, session: ClearanceSession): void {
    const key = hostname.toLowerCase();
    this.sessions.delete(key);
    this.sessions.set(key, session);
    while (this.sessions.size > MAX_CACHED_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  /** Removes expired entries; keeps the cache from growing without bound. */
  public purgeExpiredSessions(): void {
    const now = Date.now();
    for (const [hostname, session] of this.sessions) {
      if (now >= session.expiresAt) this.sessions.delete(hostname);
    }
  }

  public get cachedSessionCount(): number {
    return this.sessions.size;
  }

  // ==========================================================================
  // Solving
  // ==========================================================================

  /**
   * Navigates to `url` in a stealth Chromium context, clears any Cloudflare
   * challenge (managed challenge / Turnstile) and returns the rendered HTML plus
   * the cookies and User-Agent needed to replay the session over plain HTTP.
   *
   * Concurrent calls for the same host share a single solve.
   */
  public async solveAndFetch(
    url: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    options: SolveOptions = {}
  ): Promise<BypassResult> {
    return this.solve(url, { ...options, timeoutMs });
  }

  /**
   * Drops a cached session that the server just refused. Without this a stale
   * `cf_clearance` (expired server-side, or bound to another IP) was replayed on
   * every subsequent request for up to its whole local TTL.
   */
  public invalidateSession(url: string): void {
    const hostname = CloudflareBypassEngine.hostnameOf(url);
    if (hostname) this.sessions.delete(hostname);
  }

  public async solve(url: string, options: SolveOptions = {}): Promise<BypassResult> {
    const hostname = CloudflareBypassEngine.hostnameOf(url);
    if (!hostname) {
      throw new Error(`[ANTI-CLOUDFLARE] Invalid URL supplied: ${url}`);
    }

    const budget = Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (!options.force) {
      const cached = this.getCachedSession(url);
      // A cached cf_clearance is authoritative: no need to spin up a browser.
      if (cached?.hasClearance) {
        return {
          html: '',
          cookies: cached.cookieHeader,
          userAgent: cached.userAgent,
          acceptLanguage: cached.acceptLanguage,
          solved: true,
          hadChallenge: false,
          status: null,
          finalUrl: url,
          requestedUrl: url,
          elapsedMs: 0
        };
      }
    }

    const existing = this.inflight.get(hostname);
    if (existing && !options.force) {
      return existing;
    }

    const task = this.solveExclusive(url, hostname, budget)
      .finally(() => {
        if (this.inflight.get(hostname) === task) this.inflight.delete(hostname);
      });

    this.inflight.set(hostname, task);
    return task;
  }

  private async solveExclusive(url: string, hostname: string, budgetMs: number): Promise<BypassResult> {
    this.purgeExpiredSessions();
    const startedAt = Date.now();
    console.log(`[ANTI-CLOUDFLARE] Opening stealth session for ${hostname}`);

    const release = await this.contextSlots.acquire();
    let context: BrowserContext | null = null;

    try {
      const browser = await this.getOrCreateBrowser(budgetMs);

      context = await browser.newContext({
        // No `userAgent` override on purpose: see the module header.
        locale: DEFAULT_LOCALE,
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        colorScheme: 'light',
        timezoneId: 'Europe/Madrid',
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        bypassCSP: false,
        extraHTTPHeaders: {
          'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
          // Only headers Chromium does not derive from the UA itself. Adding a
          // hand-written Sec-Ch-Ua here is what created the old mismatch.
          'Upgrade-Insecure-Requests': '1'
        }
      });

      context.setDefaultTimeout(budgetMs);
      context.setDefaultNavigationTimeout(budgetMs);

      const page = await context.newPage();
      await page.addInitScript(stealthInitScript);

      return await this.navigateAndSolve(page, context, url, hostname, budgetMs, startedAt);
    } catch (error) {
      throw this.explainFailure(error, hostname);
    } finally {
      if (context) await context.close().catch(() => {});
      release();
      this.scheduleIdleClose();
    }
  }

  private async navigateAndSolve(
    page: Page,
    context: BrowserContext,
    url: string,
    hostname: string,
    budgetMs: number,
    startedAt: number
  ): Promise<BypassResult> {
    let status: number | null = null;
    let hadChallenge = false;

    // Harvest the browser's own UA once: replaying it verbatim from axios keeps
    // the plain-HTTP fingerprint identical to the one that cleared the challenge.
    const userAgent = await this.harvestUserAgent(page);

    const navigate = async (): Promise<void> => {
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(budgetMs, 30_000)
        });
        status = response ? response.status() : null;
        const mitigated = response?.headers()?.['cf-mitigated'];
        if (mitigated === 'challenge') hadChallenge = true;
      } catch (error) {
        // Challenge pages frequently abort the provisional load while the
        // interstitial is swapped in; that is not fatal for the solve.
        const message = error instanceof Error ? error.message : String(error);
        if (!/ERR_ABORTED|net::ERR_HTTP_RESPONSE_CODE_FAILURE|Timeout/i.test(message)) {
          throw error;
        }
      }
    };

    await navigate();

    const challengeActive = async (): Promise<boolean> => {
      if (page.isClosed()) return false;
      try {
        const title = (await page.title()).toLowerCase();
        if (CHALLENGE_TITLE_MARKERS.some(marker => title.includes(marker))) return true;

        return await page.evaluate(() => {
          return !!(
            document.getElementById('challenge-stage') ||
            document.getElementById('challenge-error-title') ||
            document.getElementById('challenge-running') ||
            document.querySelector('input[name="cf-turnstile-response"]') ||
            document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
            document.querySelector('#turnstile-wrapper')
          );
        });
      } catch {
        return false;
      }
    };

    if (status === 403 || status === 503) hadChallenge = true;

    if (await challengeActive()) {
      hadChallenge = true;
      console.log('[ANTI-CLOUDFLARE] Cloudflare/Turnstile challenge detected. Attempting to clear it...');

      const solveDeadline = Date.now() + Math.min(CHALLENGE_MAX_WAIT_MS, Math.max(5_000, budgetMs - 5_000));
      let clicked = false;

      while (Date.now() < solveDeadline && !page.isClosed()) {
        if (!(await challengeActive())) {
          console.log('[ANTI-CLOUDFLARE] Challenge cleared automatically.');
          break;
        }

        if (await this.clickTurnstile(page)) {
          clicked = true;
          await page.waitForTimeout(2_000 + Math.floor(Math.random() * 900));
          if (!(await challengeActive())) {
            console.log('[ANTI-CLOUDFLARE] Challenge cleared after interaction.');
            break;
          }
        }

        await page.waitForTimeout(900);
      }

      // After a managed challenge the browser is redirected to the target; give
      // the reload a chance to land before harvesting cookies and HTML.
      await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
      if (clicked) await page.waitForTimeout(600);
    } else {
      // Cheap settle so lazy cookies (__cf_bm, PHP session, ...) are written.
      await page.waitForTimeout(700);
    }

    const solved = !(await challengeActive());
    const finalUrl = page.url();

    const rawCookies = await context.cookies();
    const cookieHeader = CloudflareBypassEngine.scopeCookies(rawCookies, hostname);
    const hasClearance = rawCookies.some(cookie => cookie.name === 'cf_clearance' && cookie.value);

    let html = '';
    try {
      html = solved ? await page.content() : '';
    } catch {
      html = '';
    }

    if (hasClearance || (solved && cookieHeader)) {
      this.rememberSession(hostname, {
        // Replay every cookie of the browser profile, not just the host-scoped
        // ones: cf_clearance validation also looks at __cf_bm and cf_chl_opt.
        cookieHeader: rawCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
        userAgent,
        acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
        solvedAt: Date.now(),
        expiresAt: Date.now() + this.sessionTtlMs,
        hasClearance,
        hostname
      });
      console.log(
        `[ANTI-CLOUDFLARE] Session harvested for ${hostname} ` +
        `(cf_clearance=${hasClearance ? 'yes' : 'no'}, cookies=${rawCookies.length})`
      );
    }

    const elapsedMs = Date.now() - startedAt;
    if (!solved) {
      console.warn(`[ANTI-CLOUDFLARE] ${hostname} still challenging after ${elapsedMs}ms.`);
    }

    return {
      html,
      cookies: cookieHeader,
      userAgent,
      acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
      solved,
      hadChallenge,
      status,
      finalUrl,
      requestedUrl: url,
      elapsedMs
    };
  }

  /** Locates and clicks the Turnstile checkbox inside the challenge iframe. */
  private async clickTurnstile(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      if (!frame.url().includes('challenges.cloudflare.com')) continue;
      try {
        const target = frame
          .locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, span.mark, label.cb-lb')
          .first();

        if (await target.isVisible({ timeout: 400 })) {
          await target.click({ delay: 60 + Math.random() * 90, timeout: 3_000 });
          return true;
        }
      } catch {
        // Transient render errors inside the iframe are expected; keep polling.
      }
    }

    // Some deployments render the widget inline instead of in an iframe.
    try {
      const inline = page.locator('#challenge-stage input[type="checkbox"], .cf-turnstile input[type="checkbox"]').first();
      if (await inline.isVisible({ timeout: 300 })) {
        await inline.click({ delay: 60 + Math.random() * 90, timeout: 3_000 });
        return true;
      }
    } catch {
      /* ignore */
    }

    return false;
  }

  private static scopeCookies(
    cookies: Array<{ name: string; value: string; domain: string }>,
    hostname: string
  ): string {
    return cookies
      .filter(cookie => {
        const domain = cookie.domain.replace(/^\./, '').toLowerCase();
        return (
          hostname === domain ||
          hostname.endsWith(`.${domain}`) ||
          domain.endsWith(`.${hostname}`)
        );
      })
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  // ==========================================================================
  // Browser lifecycle
  // ==========================================================================

  private explainFailure(error: unknown, hostname: string): Error {
    const message = error instanceof Error ? error.message : String(error);

    if (/Executable doesn't exist|browserType\.launch|Playwright browsers|looks like Playwright/.test(message)) {
      return new Error(
        `[ANTI-CLOUDFLARE] Chromium is not installed, cannot solve ${hostname}. ` +
        'Run `npx playwright install --with-deps chromium` (the CI workflow already does).'
      );
    }

    // Navigation/DNS failures still prove the browser path was attempted (the
    // stealth Chromium was launched and page.goto was called). Wrapping them
    // with a browser-related prefix keeps the forced-solve regression test
    // deterministic both when Chromium is missing and when it is installed but
    // the dummy .test domain does not resolve.
    if (/page\.goto|net::ERR_|Browser closed|Target closed|TimeoutError|Navigation failed/.test(message)) {
      return new Error(`[ANTI-CLOUDFLARE] Browser navigation failed for ${hostname}: ${message}`);
    }

    return error instanceof Error ? error : new Error(`[ANTI-CLOUDFLARE] ${message}`);
  }

  /** Launches (once) a stealth Chromium and returns it. Safe under concurrency. */
  private async getOrCreateBrowser(budgetMs: number): Promise<Browser> {
    // shutdown() is terminal (process teardown): silently relaunching Chromium
    // after it defeated the whole point of the teardown hooks.
    if (this.permanentlyClosed) {
      throw new Error('[ANTI-CLOUDFLARE] Engine was shut down for this process; the browser is never relaunched.');
    }
    if (this.activeBrowser?.isConnected()) {
      this.cancelIdleClose();
      return this.activeBrowser;
    }

    if (this.browserPromise) return this.browserPromise;

    this.browserPromise = (async () => {
      const { chromium } = await import('playwright-extra');

      if (!this.stealthApplied) {
        try {
          const stealthModule = await import('puppeteer-extra-plugin-stealth');
          const stealthFactory = ((stealthModule as { default?: unknown }).default ?? stealthModule) as
            | ((options?: unknown) => unknown)
            | unknown;
          // The package exports a FACTORY: passing the function itself makes
          // playwright-extra ignore it ("Plugin is not derived from
          // PuppeteerExtraPlugin"), silently disabling every evasion.
          const plugin = typeof stealthFactory === 'function' ? stealthFactory() : stealthFactory;
          (chromium as unknown as { use(plugin: unknown): void }).use(plugin);
          this.stealthApplied = true;
        } catch (error) {
          // Stealth is a hardening layer, not a hard requirement.
          console.warn(
            `[ANTI-CLOUDFLARE] Stealth plugin unavailable (${error instanceof Error ? error.message : String(error)}); continuing with patched Chromium.`
          );
        }
      }

      const browser = await chromium.launch({
        headless: true,
        timeout: Math.min(budgetMs, 60_000),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--metrics-recording-only',
          '--mute-audio',
          '--hide-scrollbars',
          '--window-size=1920,1080'
        ]
      });

      browser.on('disconnected', () => {
        if (this.activeBrowser === browser) {
          this.activeBrowser = null;
          this.harvestedUserAgent = null;
        }
      });

      this.activeBrowser = browser;
      console.log(`[ANTI-CLOUDFLARE] Stealth Chromium ready (${browser.version()})`);
      return browser;
    })().finally(() => {
      this.browserPromise = null;
    });

    try {
      return await this.browserPromise;
    } catch (error) {
      this.activeBrowser = null;
      throw error;
    }
  }

  /** Reads (and memoises) the real UA of the launched Chromium. */
  private async harvestUserAgent(page: Page): Promise<string> {
    if (this.harvestedUserAgent) return this.harvestedUserAgent;
    try {
      const ua = await page.evaluate(() => {
        const nav = navigator as unknown as { userAgent?: string };
        return typeof nav?.userAgent === 'string' ? nav.userAgent : '';
      });
      if (ua) this.harvestedUserAgent = ua;
    } catch {
      /* fall through to the static value */
    }
    return this.harvestedUserAgent ?? CloudflareBypassEngine.FALLBACK_USER_AGENT;
  }

  /** UA used only when the real one cannot be read (should never happen). */
  private static readonly FALLBACK_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  /**
   * Runs `task` with a page from the shared stealth browser. Lets adapters
   * (e.g. Wolftorrent's JS-only download button) reuse ONE Chromium instead of
   * launching a new browser per detail page.
   */
  public async withPage<T>(task: (page: Page, context: BrowserContext) => Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const release = await this.contextSlots.acquire();
    let context: BrowserContext | null = null;
    try {
      const browser = await this.getOrCreateBrowser(timeoutMs);
      context = await browser.newContext({
        locale: DEFAULT_LOCALE,
        viewport: { width: 1920, height: 1080 },
        timezoneId: 'Europe/Madrid',
        colorScheme: 'light',
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { 'Accept-Language': DEFAULT_ACCEPT_LANGUAGE }
      });
      context.setDefaultTimeout(timeoutMs);
      const page = await context.newPage();
      await page.addInitScript(stealthInitScript);
      return await task(page, context);
    } catch (error) {
      throw this.explainFailure(error, '(shared page)');
    } finally {
      if (context) await context.close().catch(() => {});
      release();
      this.scheduleIdleClose();
    }
  }

  /** True when the engine has ever launched a browser in this process. */
  public get browserRunning(): boolean {
    return !!this.activeBrowser?.isConnected();
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer || this.permanentlyClosed) return;
    if (!this.activeBrowser) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeBrowser && !this.browserPromise) {
        console.log('[ANTI-CLOUDFLARE] Browser idle; shutting it down to release memory.');
        void this.close();
      }
    }, envInt('CF_BROWSER_IDLE_CLOSE_MS', IDLE_CLOSE_MS));

    // Never keep the event loop alive just for the idle timer.
    this.idleTimer.unref?.();
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Closes the shared browser and drops in-flight bookkeeping. */
  public async close(): Promise<void> {
    this.cancelIdleClose();
    const browser = this.activeBrowser;
    this.activeBrowser = null;
    this.harvestedUserAgent = null;

    if (this.browserPromise) {
      await this.browserPromise.catch(() => {});
      this.browserPromise = null;
    }
    if (browser) await browser.close().catch(() => {});
  }

  /** Closes and refuses to relaunch (used on process teardown). */
  public async shutdown(): Promise<void> {
    this.permanentlyClosed = true;
    this.inflight.clear();
    await this.close();
  }
}

let hooksInstalled = false;

/**
 * Registers teardown handlers so a solved challenge never leaves a Chromium
 * process behind (an open driver connection stops Node from exiting).
 */
export function installCloudflareTeardownHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const engine = CloudflareBypassEngine.getInstance();
  let closing: Promise<void> | null = null;

  const teardown = (signal?: NodeJS.Signals): void => {
    if (!closing) closing = engine.shutdown();
    closing
      .catch(() => {})
      .finally(() => {
        if (signal) process.kill(process.pid, signal);
      });
  };

  process.once('SIGINT', () => teardown('SIGINT'));
  process.once('SIGTERM', () => teardown('SIGTERM'));
  process.on('beforeExit', () => {
    if (!closing) closing = engine.shutdown().catch(() => {});
  });
}

/**
 * Minimal complementary stealth patch. The bundled stealth plugin already hides
 * `webdriver`, `chrome.runtime`, WebGL and the codec quirks; re-patching those
 * here would create inconsistencies, so this only aligns `navigator.languages`
 * with the context locale and fixes the `Notification.permission` leak that the
 * plugin version pinned in package.json still misses.
 */
function stealthInitScript(): void {
  const define = (target: object, prop: string, value: unknown): void => {
    try {
      Object.defineProperty(target, prop, {
        get: () => value,
        configurable: true,
        enumerable: true
      });
    } catch {
      /* read-only in some Chromium builds */
    }
  };

  const nav = navigator as unknown as Record<string, unknown>;
  const navProto = Object.getPrototypeOf(nav) as Record<string, unknown>;

  define(navProto, 'languages', ['es-ES', 'es', 'en-US', 'en']);
  define(navProto, 'webdriver', undefined);

  try {
    const chromeHolder = window as unknown as { chrome?: Record<string, unknown> };
    if (!chromeHolder.chrome) {
      chromeHolder.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    } else if (!chromeHolder.chrome.runtime) {
      chromeHolder.chrome.runtime = {};
    }
  } catch {
    /* ignore */
  }

  try {
    const permissions = (nav as { permissions?: { query?: unknown } }).permissions;
    if (permissions && typeof permissions.query === 'function') {
      const original = permissions.query.bind(permissions) as (
        descriptor: { name?: string }
      ) => Promise<unknown>;
      permissions.query = (descriptor: { name?: string }) =>
        descriptor?.name === 'notifications'
          ? Promise.resolve({ state: (window as unknown as { Notification?: { permission?: string } }).Notification?.permission ?? 'prompt' })
          : original(descriptor);
    }
  } catch {
    /* ignore */
  }
}
