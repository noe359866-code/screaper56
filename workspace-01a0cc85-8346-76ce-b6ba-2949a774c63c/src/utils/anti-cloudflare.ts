import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';

// Initialize the stealth plugin on Playwright's chromium launcher
chromium.use(stealthPlugin());

export interface ClearanceSession {
  cookieHeader: string;
  userAgent: string;
  solvedAt: number;
  expiresAt: number;
}

export class CloudflareBypassEngine {
  private static instance: CloudflareBypassEngine;
  private sessionCache = new Map<string, ClearanceSession>();
  private activeBrowser: Browser | null = null;

  private constructor() {}

  public static getInstance(): CloudflareBypassEngine {
    if (!CloudflareBypassEngine.instance) {
      CloudflareBypassEngine.instance = new CloudflareBypassEngine();
    }
    return CloudflareBypassEngine.instance;
  }

  /**
   * Retrieves cached clearance cookies for a domain if still valid (valid for up to 30 minutes).
   */
  public getCachedSession(url: string): ClearanceSession | null {
    try {
      const hostname = new URL(url).hostname;
      const session = this.sessionCache.get(hostname);
      if (session && Date.now() < session.expiresAt) {
        return session;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Solves a Cloudflare Turnstile / Managed Challenge and returns the rendered HTML along with clearance cookies.
   */
  public async solveAndFetch(url: string, timeoutMs = 45000): Promise<{ html: string; cookies: string; userAgent: string }> {
    console.log(`[ANTI-CLOUDFLARE] Engaging stealth browser session for: ${url}`);
    const hostname = new URL(url).hostname;

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      const browser = await this.getOrCreateBrowser();

      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

      context = await browser.newContext({
        userAgent,
        locale: 'es-ES,es',
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        permissions: ['geolocation'],
        extraHTTPHeaders: {
          'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"'
        }
      });

      page = await context.newPage();

      // Deep evasions injected into execution context
      await page.addInitScript(() => {
        // Strip webdriver flag
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // Mock window.chrome
        (globalThis as any).chrome = {
          runtime: {},
          loadTimes: () => {},
          csi: () => {},
          app: {}
        };

        // Mock plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });

        // Mock languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['es-ES', 'es', 'en-US', 'en']
        });
      });

      console.log(`[ANTI-CLOUDFLARE] Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      // Check if Cloudflare challenge is present
      const isChallengeActive = async () => {
        const title = (await page!.title()).toLowerCase();
        const content = (await page!.content()).toLowerCase();
        const hasChallengeIndicators = (
          title.includes('just a moment') ||
          title.includes('un momento') ||
          title.includes('checking your browser') ||
          content.includes('id="challenge-stage"') ||
          content.includes('id="challenge-error-title"') ||
          content.includes('enable javascript and cookies to continue')
        );
        const hasRealContent = content.includes('<table') || content.includes('magnet:?') || content.includes('<article');
        return hasChallengeIndicators && !hasRealContent;
      };

      if (await isChallengeActive()) {
        console.log('[ANTI-CLOUDFLARE] Cloudflare Managed Challenge / Turnstile detected. Attempting bypass...');

        const startTime = Date.now();
        const maxWaitTime = 10000;

        while (Date.now() - startTime < maxWaitTime) {
          if (!(await isChallengeActive())) {
            console.log('[ANTI-CLOUDFLARE] Challenge solved automatically without interaction!');
            break;
          }

          // Search frames for Turnstile widget
          const frames = page.frames();
          let clicked = false;

          for (const frame of frames) {
            const frameUrl = frame.url();
            if (frameUrl.includes('challenges.cloudflare.com') || frameUrl.includes('turnstile')) {
              try {
                // Find checkbox inside the frame
                const checkbox = await frame.$('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, span.mark');
                if (checkbox) {
                  console.log('[ANTI-CLOUDFLARE] Found Turnstile interactive element. Simulating natural click...');
                  const box = await checkbox.boundingBox();
                  if (box) {
                    // Humanized mouse movement with jitter
                    await page.mouse.move(box.x + box.width / 2 + (Math.random() * 4 - 2), box.y + box.height / 2 + (Math.random() * 4 - 2));
                    await page.waitForTimeout(200 + Math.random() * 300);
                    await page.mouse.down();
                    await page.waitForTimeout(50 + Math.random() * 100);
                    await page.mouse.up();
                    clicked = true;
                  }
                }
              } catch {
                // Ignore transient frame errors
              }
            }
          }

          if (clicked) {
            console.log('[ANTI-CLOUDFLARE] Turnstile clicked. Waiting for clearance resolution...');
            await page.waitForTimeout(3000);
            if (!(await isChallengeActive())) {
              console.log('[ANTI-CLOUDFLARE] Verification confirmed! Challenge passed.');
              break;
            }
          }

          await page.waitForTimeout(1500);
        }
      }

      // Collect cookies and HTML
      const rawCookies = await context.cookies();
      const cookieHeader = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');
      const html = await page.content();

      // Check for cf_clearance
      const hasClearance = rawCookies.some(c => c.name === 'cf_clearance');
      if (hasClearance) {
        console.log(`[ANTI-CLOUDFLARE] Successfully harvested cf_clearance cookie for ${hostname}!`);
        this.sessionCache.set(hostname, {
          cookieHeader,
          userAgent,
          solvedAt: Date.now(),
          expiresAt: Date.now() + 30 * 60 * 1000 // Valid for 30 minutes
        });
      }

      return {
        html,
        cookies: cookieHeader,
        userAgent
      };
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  private async getOrCreateBrowser(): Promise<Browser> {
    if (!this.activeBrowser || !this.activeBrowser.isConnected()) {
      this.activeBrowser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--no-first-run',
          '--no-zygote',
          '--window-size=1920,1080',
          '--disable-web-security'
        ]
      });
    }
    return this.activeBrowser;
  }

  public async close(): Promise<void> {
    if (this.activeBrowser) {
      await this.activeBrowser.close().catch(() => {});
      this.activeBrowser = null;
    }
  }
}
