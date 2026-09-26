import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';

// Activar plugin de evasión stealth
chromium.use(stealthPlugin());

export interface ClearanceSession {
  cookieHeader: string;
  userAgent: string;
  solvedAt: number;
  expiresAt: number;
}

export interface BypassResult {
  html: string;
  cookies: string;
  userAgent: string;
}

export class CloudflareBypassEngine {
  private static instance: CloudflareBypassEngine;
  private sessionCache = new Map<string, ClearanceSession>();
  private activeBrowser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  private readonly DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  private constructor() {}

  public static getInstance(): CloudflareBypassEngine {
    if (!CloudflareBypassEngine.instance) {
      CloudflareBypassEngine.instance = new CloudflareBypassEngine();
    }
    return CloudflareBypassEngine.instance;
  }

  /**
   * Obtiene las cookies de paso previo almacenadas en caché si aún son válidas.
   */
  public getCachedSession(url: string): ClearanceSession | null {
    try {
      const hostname = new URL(url).hostname;
      const session = this.sessionCache.get(hostname);

      if (session) {
        if (Date.now() < session.expiresAt) {
          return session;
        }
        this.sessionCache.delete(hostname);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Limpia entradas expiradas del caché de sesiones para liberar memoria.
   */
  public purgeExpiredSessions(): void {
    const now = Date.now();
    for (const [hostname, session] of this.sessionCache.entries()) {
      if (now >= session.expiresAt) {
        this.sessionCache.delete(hostname);
      }
    }
  }

  /**
   * Navega a la URL objetivo, resuelve desafíos de Cloudflare (Turnstile/Managed Challenge) y extrae contenido y cookies.
   */
  public async solveAndFetch(url: string, timeoutMs = 45000): Promise<BypassResult> {
    this.purgeExpiredSessions();

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`[ANTI-CLOUDFLARE] URL inválida provista: ${url}`);
    }

    console.log(`[ANTI-CLOUDFLARE] Iniciando sesión sigilosa para: ${hostname}`);

    let context: BrowserContext | null = null;

    try {
      const browser = await this.getOrCreateBrowser();

      context = await browser.newContext({
        userAgent: this.DEFAULT_USER_AGENT,
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

      const page: Page = await context.newPage();

      // Scripts de evasión ejecutados en la carga del contexto
      await page.addInitScript(() => {
        try {
          // Eliminar marca de webdriver de la manera estándar
          delete (Object.getPrototypeOf(navigator) as Record<string, unknown>).webdriver;
        } catch {}

        // Simular presencia del objeto chrome
        (window as unknown as { chrome: unknown }).chrome = {
          runtime: {},
          loadTimes: () => {},
          csi: () => {},
          app: {}
        };
      });

      console.log(`[ANTI-CLOUDFLARE] Navegando a ${url}...`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      // Verificación ligera del desafío Cloudflare sin parsear todo el HTML
      const isChallengeActive = async (): Promise<boolean> => {
        try {
          if (page.isClosed()) return false;

          const title = (await page.title()).toLowerCase();
          if (
            title.includes('just a moment') ||
            title.includes('un momento') ||
            title.includes('checking your browser')
          ) {
            return true;
          }

          const hasChallengeDOM = await page.evaluate(() => {
            return !!(
              document.getElementById('challenge-stage') ||
              document.getElementById('challenge-error-title') ||
              document.querySelector('iframe[src*="challenges.cloudflare.com"]')
            );
          });

          return hasChallengeDOM;
        } catch {
          return false;
        }
      };

      if (await isChallengeActive()) {
        console.log('[ANTI-CLOUDFLARE] Desafío Cloudflare/Turnstile detectado. Intentando bypass...');

        const startTime = Date.now();
        const maxWaitTime = Math.min(timeoutMs, 30000);

        while (Date.now() - startTime < maxWaitTime) {
          if (!(await isChallengeActive())) {
            console.log('[ANTI-CLOUDFLARE] Desafío resuelto automáticante.');
            break;
          }

          // Búsqueda de iframe Turnstile e interacción mediante Playwright locators
          const frames = page.frames();
          let interacted = false;

          for (const frame of frames) {
            if (frame.url().includes('challenges.cloudflare.com')) {
              try {
                const targetCheckbox = frame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, span.mark').first();

                if (await targetCheckbox.isVisible({ timeout: 500 })) {
                  console.log('[ANTI-CLOUDFLARE] Elemento interactivo Turnstile localizado. Simulando clic...');
                  
                  // Uso directo de .click() en el locator del frame para evitar descalces de coordenadas
                  await targetCheckbox.click({ delay: 50 + Math.random() * 50 });
                  interacted = true;
                  break;
                }
              } catch {
                // Ignorar errores transitorios durante el renderizado del iframe
              }
            }
          }

          if (interacted) {
            await page.waitForTimeout(2500);
            if (!(await isChallengeActive())) {
              console.log('[ANTI-CLOUDFLARE] Verificación completada con éxito.');
              break;
            }
          }

          await page.waitForTimeout(1000);
        }
      }

      // Tiempo de asentamiento para asegurar la propagación de la cookie
      await page.waitForTimeout(1000);

      const rawCookies = await context.cookies();
      const relevantCookies = rawCookies.filter((c) => {
        const domainClean = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain;
        return (
          hostname === domainClean ||
          hostname.endsWith('.' + domainClean) ||
          domainClean.endsWith('.' + hostname)
        );
      });

      const cookieHeader = relevantCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const html = await page.content();

      const hasClearance = rawCookies.some((c) => c.name === 'cf_clearance');

      if (hasClearance) {
        console.log(`[ANTI-CLOUDFLARE] Cookie cf_clearance cosechada para ${hostname}`);
        this.sessionCache.set(hostname, {
          cookieHeader: rawCookies.map((c) => `${c.name}=${c.value}`).join('; '),
          userAgent: this.DEFAULT_USER_AGENT,
          solvedAt: Date.now(),
          expiresAt: Date.now() + 30 * 60 * 1000 // Válida por 30 minutos
        });
      }

      return {
        html,
        cookies: cookieHeader,
        userAgent: this.DEFAULT_USER_AGENT
      };
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  /**
   * Garantiza la creación de una única instancia de Browser segura ante llamadas concurrentes.
   */
  private async getOrCreateBrowser(): Promise<Browser> {
    if (this.activeBrowser && this.activeBrowser.isConnected()) {
      return this.activeBrowser;
    }

    if (this.browserPromise) {
      return this.browserPromise;
    }

    this.browserPromise = (async () => {
      try {
        const browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-first-run',
            '--no-zygote',
            '--window-size=1920,1080'
          ]
        });

        this.activeBrowser = browser;
        return browser;
      } finally {
        this.browserPromise = null;
      }
    })();

    return this.browserPromise;
  }

  /**
   * Cierra el navegador activo y resetea las referencias.
   */
  public async close(): Promise<void> {
    if (this.activeBrowser) {
      await this.activeBrowser.close().catch(() => {});
      this.activeBrowser = null;
    }
    this.browserPromise = null;
  }
}
