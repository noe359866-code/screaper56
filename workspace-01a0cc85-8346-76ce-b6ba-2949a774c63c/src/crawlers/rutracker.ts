import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { BaseCrawler, MAX_TORRENT_BYTES } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { ParsedTorrentFile, parseTorrentBuffer } from '../utils/bencode2.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages, hasValidLanguageRelease } from '../utils/language.js';
import { parseSizeToBytes, parseTorrentTitle } from '../utils/regex.js';
import { htmlMarkerValidator } from './mirrors.js';
import {
  absoluteHttpUrl,
  buildTorrentRecord,
  cleanText,
  dedupeStrings,
  describeError,
  isBlockedTitle,
  mapWithConcurrency,
  parseCount,
  politePause,
  qualityOf
} from './support.js';

/**
 * RuTracker.org adapter (private tracker, authenticated).
 *
 * Everything it reads is public *inside* an account: the crawler only logs in
 * with the credentials (or the session cookies) the operator configures, walks
 * the search/browse listings it is allowed to see and stores the magnet/hash
 * the topic itself publishes. No CAPTCHA is solved, no challenge is bypassed
 * and no rate-limit evasion is attempted: when RuTracker answers with a
 * CAPTCHA or a "too many requests" page the adapter stops and says so.
 *
 * Three things make this site different from the other adapters:
 *
 *   1. **Windows-1251.** Every page is served in cp1251, so the body is fetched
 *      as bytes and decoded with `TextDecoder` instead of letting the HTTP
 *      client assume UTF-8 (otherwise every Cyrillic title is mojibake).
 *   2. **Session required.** `viewtopic.php` only renders the magnet link when
 *      the request carries a valid `bb_session`. Credentials or an exported
 *      cookie jar are therefore mandatory (see `ensureSession`).
 *   3. **Only real pagination.** Listings end when the page stops publishing a
 *      `start=` offset larger than the current one; offsets are never guessed,
 *      so a single-page search costs exactly one request.
 */

/** Forum path prefix shared by every RuTracker route. */
export const RUTRACKER_FORUM_PREFIX = '/forum';

/** Official domains; override with RUTRACKER_BASE_URL / RUTRACKER_MIRRORS. */
export const RUTRACKER_DEFAULT_MIRRORS: readonly string[] = [
  'https://rutracker.org',
  'https://rutracker.net',
  'https://rutracker.nl',
  'https://rutracker.me',
  'https://rutracker.cc'
];

/**
 * Default `nm=` searches: RuTracker titles carry the Latin release tags.
 * Kept ASCII (or Cyrillic) on purpose: those characters exist in cp1251, so the
 * query is encoded exactly as the site's own form would submit it.
 */
export const RUTRACKER_DEFAULT_SEARCHES: readonly string[] = [
  'castellano',
  'espanol',
  'latino',
  'испанский'
];

/** Characters of a topic body scanned for language evidence. */
const BODY_SCAN_LIMIT = 1600;

export interface RutrackerRoute {
  url: string;
  type: ContentType;
  label: string;
}

export interface RutrackerTopic {
  topicId: string;
  url: string;
  title: string;
  sizeBytes: number | null;
  seeders: number | null;
  leechers: number | null;
  forumId: string | null;
  forumTitle: string | null;
  type: ContentType;
}

export interface RutrackerTopicDetail {
  title: string;
  magnetUrl: string | null;
  torrentUrl: string | null;
  sizeBytes: number | null;
  seeders: number | null;
  leechers: number | null;
  hints: string[];
}

/** Raised when the tracker answers with a CAPTCHA instead of the requested page. */
export class RutrackerCaptchaError extends Error {
  constructor(public readonly url: string) {
    super(`RuTracker answered with a CAPTCHA for ${url}: the account must be verified manually.`);
    this.name = 'RutrackerCaptchaError';
  }
}

/** Raised when no usable session can be established (no credentials or login refused). */
export class RutrackerAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RutrackerAuthError';
  }
}

/** Raised for HTTP 429 or an explicit rate-limit page; the crawl stops immediately. */
export class RutrackerRateLimitError extends Error {
  constructor(public readonly url: string) {
    super(`RuTracker rate limit reached for ${url}; stopping this run without bypassing it.`);
    this.name = 'RutrackerRateLimitError';
  }
}

const RATE_LIMIT_PATTERN =
  /too many requests|rate limit|request limit exceeded|слишком много запрос|частые запросы/i;

function responseStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' ? status : null;
}

function responseBody(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const body = (error as { response?: { data?: unknown } }).response?.data;
  if (Buffer.isBuffer(body)) return decodeHtmlBody(body);
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return decodeHtmlBody(Buffer.from(body));
  return '';
}

function looksLikeRateLimitPage(html: string): boolean {
  return Boolean(html) && RATE_LIMIT_PATTERN.test(html.slice(0, 4096));
}

// ============================================================================
// Windows-1251 helpers
// ============================================================================

/**
 * Reverse table built at module load by decoding every byte with the platform
 * decoder, so no 128-entry hand-written table can drift out of sync.
 */
const CP1251_BYTE_OF: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  try {
    const decoder = new TextDecoder('windows-1251');
    for (let byte = 0; byte < 256; byte++) {
      const char = decoder.decode(new Uint8Array([byte]));
      // Undefined cp1251 slots decode to U+FFFD; the first byte that maps to a
      // real character wins, and U+FFFD is never stored.
      if (char && char !== '�' && !map.has(char)) map.set(char, byte);
    }
  } catch {
    /* No ICU support: callers fall back to UTF-8 encoding. */
  }
  return map;
})();

/** True when this runtime can decode Windows-1251 (Node >= 18 with full ICU). */
export function supportsWindows1251(): boolean {
  return CP1251_BYTE_OF.size > 0;
}

function hasWindows1251(): boolean {
  try {
    new TextDecoder('windows-1251');
    return true;
  } catch {
    return false;
  }
}

/**
 * Percent-encodes `text` using the site's own Windows-1251 charset, which is
 * what the browser sends for a form rendered inside a cp1251 document.
 * Characters with no cp1251 slot fall back to UTF-8 percent-escapes.
 */
const UNRESERVED = /^[A-Za-z0-9._~-]$/;

export function encodeWindows1251(text: string): string {
  let out = '';
  const encodable = CP1251_BYTE_OF.size > 0;
  for (const char of text) {
    if (UNRESERVED.test(char)) {
      out += char;
      continue;
    }
    const byte = encodable ? CP1251_BYTE_OF.get(char) : undefined;
    out += byte === undefined
      ? encodeURIComponent(char)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Reads `charset=` from the first bytes of an HTML document (`utf-8` by default). */
export function detectHtmlCharset(buffer: Buffer): string {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const meta = head.match(/<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i)?.[1]
    ?? head.match(/<meta[^>]+content=["'][^"']*charset=([a-z0-9_-]+)/i)?.[1];
  if (!meta) return 'utf-8';
  if (/^(windows-1251|cp1251|win-1251|x-cp1251)$/i.test(meta)) return 'windows-1251';
  if (/^(koi8-r|koi8)$/i.test(meta)) return 'koi8-r';
  return 'utf-8';
}

/** Decodes an HTML body with its declared charset (never throws on unknown labels). */
export function decodeHtmlBody(buffer: Buffer): string {
  if (!Buffer.isBuffer(buffer)) return typeof buffer === 'string' ? buffer : '';
  const charset = detectHtmlCharset(buffer);
  if (charset !== 'utf-8' && !hasWindows1251()) {
    return buffer.toString('utf-8');
  }
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

// ============================================================================
// Cookie jar
// ============================================================================

/** Shape of a cookie exported by browser extensions ("Cookie-Editor" style). */
export interface RutrackerCookieExport {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expirationDate?: number;
}

/**
 * Builds `name=value` pairs from either format an operator is likely to paste:
 * a raw `Cookie:` header string, or the JSON array exported by a browser
 * extension (entries from other domains are ignored, and expired ones dropped).
 */
const RUTRACKER_COOKIE_ROOTS = ['rutracker.org', 'rutracker.net', 'rutracker.nl', 'rutracker.me', 'rutracker.cc'] as const;

function isRutrackerCookieDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  return RUTRACKER_COOKIE_ROOTS.some(root => normalized === root || normalized.endsWith(`.${root}`));
}

function isSafeCookiePair(name: string, value: string): boolean {
  // Cookie names are HTTP tokens; values must not be able to inject another
  // header or cookie pair when placed into Axios' Cookie header.
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[;\x00-\x1F\x7F]/.test(value);
}

/** Resolve only URLs on the page's exact origin before attaching account cookies. */
function sameOriginHttpUrl(value: string, base: string): string | null {
  const resolved = absoluteHttpUrl(value, base);
  if (!resolved) return null;
  try {
    const target = new URL(resolved);
    const origin = new URL(base);
    if (target.username || target.password || origin.username || origin.password) return null;
    return target.origin === origin.origin ? resolved : null;
  } catch {
    return null;
  }
}

export function parseCookieJar(raw: string, now = Date.now()): [string, string][] {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const pairs: [string, string][] = [];
    for (const entry of parsed as RutrackerCookieExport[]) {
      if (!entry || typeof entry !== 'object') continue;
      const { name, value, domain } = entry as RutrackerCookieExport;
      if (typeof name !== 'string' || typeof value !== 'string' || !value) continue;
      const cleanName = name.trim();
      if (!isSafeCookiePair(cleanName, value)) continue;
      // Browser exports can include cookies for every open site. Never forward
      // unrelated credentials to the tracker, even if the user pasted a full jar.
      if (typeof domain === 'string' && domain.trim() && !isRutrackerCookieDomain(domain)) continue;
      // A session cookie already expired is worse than no cookie: it triggers a
      // "please log in" page that looks like a template change.
      const expires = typeof entry.expirationDate === 'number' ? entry.expirationDate * 1000 : null;
      if (expires !== null && expires <= now) continue;
      pairs.push([cleanName, value]);
    }
    return pairs;
  }

  const pairs: [string, string][] = [];
  for (const rawPair of trimmed.split(/;\s*/)) {
    const separator = rawPair.indexOf('=');
    if (separator <= 0) continue;
    const name = rawPair.slice(0, separator).trim();
    const value = rawPair.slice(separator + 1).trim();
    if (!value || !isSafeCookiePair(name, value)) continue;
    pairs.push([name, value]);
  }
  return pairs;
}

/** Serialises the jar into a `Cookie:` header value. */
export function cookieHeaderOf(jar: ReadonlyMap<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Folds a `set-cookie` response header into the jar. Unknown/failed values are
 * ignored so a malformed header can never wipe a working session.
 */
export function absorbSetCookie(jar: Map<string, string>, setCookie: unknown): string[] {
  const stored: string[] = [];
  const raw = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  for (const entry of raw) {
    const pair = String(entry).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!isSafeCookiePair(name, value)) continue;
    if (/^(?:expires|path|domain|max-age|secure|httponly|samesite)$/i.test(name)) continue;
    jar.set(name, value);
    stored.push(name);
  }
  return stored;
}

/** True when the jar holds the cookies a logged-in RuTracker session needs. */
export function isSessionCookieJar(jar: ReadonlyMap<string, string>): boolean {
  return Boolean(jar.get('bb_session') || jar.get('bb_data'));
}

/** True when a rendered page shows an explicit authenticated account control. */
export function looksLoggedIn(html: string, _username = ''): boolean {
  if (typeof html !== 'string' || !html) return false;
  // Merely seeing the configured username is not proof of authentication: it
  // may still be echoed in a login form or an old topic post.
  return /login\.php\?logout=1/i.test(html) || /logged-in-username/i.test(html);
}

/** Map a RuTracker section title onto the project's content types. */
export function typeFromForumTitle(title: string | null | undefined, fallback: ContentType = 'movie'): ContentType {
  const text = (title ?? '').toLowerCase();
  if (!text) return fallback;
  if (/аниме|anime|мультсериал/i.test(text)) return 'anime';
  if (/сериал|serial|телепередач|тв-програм/i.test(text)) return 'series';
  if (/документальн|документалист|научно-популярн/i.test(text)) return 'documentary';
  if (/кино|фильм|мультфильм|видео/i.test(text)) return 'movie';
  return fallback;
}

/** Keeps only the language-relevant phrases of a (Russian) release description. */
const LANG_HINT_PATTERN =
  /(castellano|espa[ñn]ol|espanol|latino|ingles|ingl[eé]s|english|sub\s?es|sub\s?en|subs?\s?(?:espa[ñn]ol|latino|ingles)|vose|vo\s?se|испанск|английск|многоголос|двухголос|одноголос|subtitul[oa]d)/gi;

export function languageHintsFromBody(text: string, limit = 6): string[] {
  if (!text) return [];
  const hints: string[] = [];
  for (const match of text.matchAll(LANG_HINT_PATTERN)) {
    const start = Math.max(0, (match.index ?? 0) - 40);
    const snippet = cleanText(text.slice(start, (match.index ?? 0) + 80));
    if (snippet) hints.push(snippet);
    if (hints.length >= limit) break;
  }
  return dedupeStrings(hints);
}

// ============================================================================
// Crawler
// ============================================================================

/**
 * Authenticated RuTracker crawler: cp1251 decoding, real pagination, and one
 * `viewtopic.php` visit per topic to read the magnet the page publishes.
 */
export class RutrackerCrawler extends BaseCrawler {
  public readonly name = 'rutracker';
  public baseUrl: string;

  /** Cookie jar shared by every request of this adapter instance. */
  private readonly cookies = new Map<string, string>();
  private sessionCheckedFor: string | null = null;
  private loggedIn = false;

  private readonly detailConcurrency = Math.max(
    1,
    Number.parseInt(process.env.RUTRACKER_CONCURRENCY || '2', 10) || 2
  );

  constructor() {
    super();
    this.baseUrl = process.env.RUTRACKER_BASE_URL || RUTRACKER_DEFAULT_MIRRORS[0];
    this.loadConfiguredCookies();
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  private get username(): string {
    return (process.env.RUTRACKER_USERNAME || process.env.RUTRACKER_LOGIN || '').trim();
  }

  private get password(): string {
    return (process.env.RUTRACKER_PASSWORD || '').trim();
  }

  /** Skip topics whose title shows no Spanish/English evidence (no request spent). */
  private get languagePrefilter(): boolean {
    const raw = (process.env.RUTRACKER_LANG_PREFILTER || 'true').trim().toLowerCase();
    return !(raw === 'false' || raw === '0' || raw === 'no');
  }

  /** Dead swarms are noise for an indexer: `RUTRACKER_MIN_SEEDERS=1` drops them. */
  private get minSeeders(): number {
    const parsed = Number.parseInt(process.env.RUTRACKER_MIN_SEEDERS || '0', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private get searchTerms(): string[] {
    const raw = process.env.RUTRACKER_SEARCH ?? RUTRACKER_DEFAULT_SEARCHES.join(',');
    return raw.split(/[,\n]+/).map(term => term.trim()).filter(Boolean);
  }

  /**
   * Charset used to encode `nm=` (`windows-1251`, the site default, or `utf-8`).
   * cp1251 has no `ñ`, `í`, `ã`...: those characters fall back to UTF-8 escapes,
   * which RuTracker cannot decode, so a term containing them should be spelled
   * without accents or the charset should be switched to `utf-8`.
   */
  private get searchCharset(): string {
    const raw = (process.env.RUTRACKER_SEARCH_CHARSET || 'windows-1251').trim().toLowerCase();
    return raw === 'utf-8' || raw === 'utf8' ? 'utf-8' : 'windows-1251';
  }

  /** Percent-encodes a search term the way the site's own form submits it. */
  private encodeSearchTerm(term: string): string {
    return this.searchCharset === 'utf-8' ? encodeURIComponent(term) : encodeWindows1251(term);
  }

  /** Routes: `RUTRACKER_ROUTES` (raw), `RUTRACKER_FORUMS` (f=NN) and searches. */
  public routes(mirror: string): RutrackerRoute[] {
    const base = mirror.replace(/\/+$/, '');
    const routes: RutrackerRoute[] = [];

    const raw = (process.env.RUTRACKER_ROUTES || '')
      .split(/[,\n]+/).map(value => value.trim()).filter(Boolean);
    for (const path of raw) {
      let routeUrl: URL;
      try {
        routeUrl = new URL(path, `${base}/`);
      } catch {
        throw new Error('[rutracker] Invalid RUTRACKER_ROUTES entry.');
      }
      // These requests carry the account's Cookie header. An absolute custom
      // route must therefore stay on the selected mirror's exact origin.
      const mirrorUrl = new URL(base);
      if (
        routeUrl.origin !== mirrorUrl.origin ||
        routeUrl.username || routeUrl.password ||
        mirrorUrl.username || mirrorUrl.password
      ) {
        throw new Error('[rutracker] Refusing cross-origin RUTRACKER_ROUTES entries and credentialed URLs.');
      }
      routes.push({ url: routeUrl.href, type: 'movie', label: `ruta ${path}` });
    }

    const forums = (process.env.RUTRACKER_FORUMS || '')
      .split(/[,\s]+/).map(value => value.trim()).filter(value => /^\d+$/.test(value));
    for (const forumId of forums) {
      routes.push({
        url: `${base}${RUTRACKER_FORUM_PREFIX}/viewforum.php?f=${forumId}`,
        type: 'movie',
        label: `foro ${forumId}`
      });
    }

    const sort = (process.env.RUTRACKER_SORT || '').trim();
    for (const term of this.searchTerms) {
      // The form lives in a cp1251 document, so the browser would send cp1251.
      const query = `nm=${this.encodeSearchTerm(term)}`;
      routes.push({
        url: `${base}${RUTRACKER_FORUM_PREFIX}/tracker.php?${query}${sort ? `&${sort}` : ''}`,
        type: 'movie',
        label: `búsqueda ${term}`
      });
    }

    return routes;
  }

  private loadConfiguredCookies(): void {
    const sources = [
      this.parseCookieSource(process.env.RUTRACKER_COOKIE_JSON),
      this.parseCookieSource(process.env.RUTRACKER_COOKIES)
    ];
    let loaded = 0;
    for (const pairs of sources) {
      for (const [name, value] of pairs) {
        // The freshest source wins: an exported cookie jar is more recent than
        // a hand-typed header, but a login below always overwrites the session.
        if (this.cookies.has(name) && /^(bb_session|bb_data)$/i.test(name) && loaded) continue;
        this.cookies.set(name, value);
        loaded++;
      }
    }
    if (loaded) {
      this.log.debug(`Loaded ${loaded} configured cookie(s); session cookie present: ${isSessionCookieJar(this.cookies)}.`);
    }
  }

  private parseCookieSource(raw: string | undefined): [string, string][] {
    if (!raw) return [];
    const expanded = raw.trim().startsWith('@')
      ? this.readCookieFile(raw.slice(1).trim())
      : raw;
    return parseCookieJar(expanded);
  }

  /** `RUTRACKER_COOKIE_JSON=@secrets/rutracker.cookies.json` keeps secrets off the CLI. */
  private readCookieFile(path: string): string {
    if (!path) return '';
    try {
      return readFileSync(path, 'utf-8');
    } catch (error) {
      this.log.warn(`Cookie file ${path} could not be read: ${describeError(error)}`);
      return '';
    }
  }

  // --------------------------------------------------------------------------
  // Session
  // --------------------------------------------------------------------------

  /** The `Cookie:` header value sent with every request of this adapter. */
  public cookieHeader(): string {
    return cookieHeaderOf(this.cookies);
  }

  /**
   * Guarantees a logged-in session for `mirror`, in this order:
   *   1. reuse the configured cookies when the site still reports a session;
   *   2. otherwise log in with RUTRACKER_USERNAME / RUTRACKER_PASSWORD.
   *
   * Throws `RutrackerAuthError` (or `RutrackerCaptchaError`) with actionable
   * advice instead of crawling anonymously: an anonymous run reads zero magnets
   * and looks exactly like a broken parser.
   */
  private async ensureSession(mirror: string): Promise<void> {
    if (this.sessionCheckedFor === mirror && this.loggedIn) return;

    const indexUrl = `${mirror.replace(/\/+$/, '')}${RUTRACKER_FORUM_PREFIX}/index.php`;
    if (isSessionCookieJar(this.cookies)) {
      try {
        const html = await this.fetchForumPage(indexUrl);
        if (looksLoggedIn(html, this.username)) {
          this.loggedIn = true;
          this.sessionCheckedFor = mirror;
          this.log.info(`Session cookie accepted by ${mirror}.`);
          return;
        }
        this.log.warn('Configured RuTracker cookies are no longer valid; logging in again.');
        this.cookies.delete('bb_session');
      } catch (error) {
        if (error instanceof RutrackerCaptchaError || error instanceof RutrackerRateLimitError) throw error;
        this.log.warn(`Session check failed for ${indexUrl}: ${describeError(error)}`);
      }
    }

    if (!this.username || !this.password) {
      throw new RutrackerAuthError(
        '[rutracker] No active session and no credentials configured. ' +
        'Set RUTRACKER_USERNAME + RUTRACKER_PASSWORD, or export the logged-in cookies as ' +
        'RUTRACKER_COOKIE_JSON / RUTRACKER_COOKIES ("bb_session" is the important one).'
      );
    }

    const ok = await this.login(mirror);
    if (!ok) {
      throw new RutrackerAuthError(
        '[rutracker] Login was refused (wrong credentials, CAPTCHA or a blocked IP). ' +
        'Open the site in a browser, solve the CAPTCHA if asked, and refresh ' +
        'RUTRACKER_COOKIE_JSON with the new bb_session cookie.'
      );
    }

    this.loggedIn = true;
    this.sessionCheckedFor = mirror;
  }

  /**
   * Real form login: GET the login page (to pick up `bb_guid`/`bb_ssl`), then
   * POST the four fields the form sends, encoded in the site's cp1251 charset.
   * The 302 is captured with `validateStatus: () => true` + `maxRedirects: 0`
   * because its `Set-Cookie` headers *are* the session.
   */
  private async login(mirror: string): Promise<boolean> {
    const base = mirror.replace(/\/+$/, '');
    const loginUrl = `${base}${RUTRACKER_FORUM_PREFIX}/login.php`;

    try {
      // The anonymous `bb_guid`/`bb_ssl` cookies come with this page and must
      // be sent back with the POST, exactly as a browser would.
      this.requestWithinBudget();
      const page = await this.httpClient.request({
        method: 'GET',
        url: loginUrl,
        headers: this.authHeaders(base, `${base}${RUTRACKER_FORUM_PREFIX}/index.php`),
        validateStatus: () => true,
        maxRedirects: 0,
        maxRetries: 1,
        autoSolveCloudflare: false
      });
      const loginPageHtml = typeof page?.data === 'string' ? page.data : '';
      if (page?.status === 429 || looksLikeRateLimitPage(loginPageHtml)) {
        this.metrics.add('rateLimited');
        throw new RutrackerRateLimitError(loginUrl);
      }
      if (this.looksLikeCaptcha(loginPageHtml)) {
        this.metrics.add('captcha');
        throw new RutrackerCaptchaError(loginUrl);
      }
      absorbSetCookie(this.cookies, page?.headers?.['set-cookie']);
    } catch (error) {
      if (error instanceof RutrackerCaptchaError || error instanceof RutrackerRateLimitError) throw error;
      this.log.debug(`Login page unavailable (${describeError(error)}); posting anyway.`);
    }

    const body = [
      `login_username=${encodeWindows1251(this.username)}`,
      `login_password=${encodeWindows1251(this.password)}`,
      `login=${encodeWindows1251('Вход')}`,
      `redirect=index.php`
    ].join('&');

    let response;
    try {
      this.requestWithinBudget();
      response = await this.httpClient.request<string>({
        method: 'POST',
        url: loginUrl,
        data: body,
        headers: {
          ...this.authHeaders(base, loginUrl),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': base
        },
        validateStatus: () => true,
        maxRedirects: 0,
        maxRetries: 1,
        autoSolveCloudflare: false
      });
    } catch (error) {
      this.metrics.add('loginErrors');
      this.log.warn(`Login POST failed: ${describeError(error)}`);
      return false;
    }

    const stored = absorbSetCookie(this.cookies, response?.headers?.['set-cookie']);
    this.metrics.add('loginAttempts');
    this.log.debug(`Login POST -> ${response?.status}; cookies set: ${stored.join(', ') || 'none'}.`);

    const payload = typeof response?.data === 'string' ? response.data : '';
    if (response?.status === 429 || looksLikeRateLimitPage(payload)) {
      this.metrics.add('rateLimited');
      throw new RutrackerRateLimitError(loginUrl);
    }
    if (this.looksLikeCaptcha(payload)) {
      this.metrics.add('captcha');
      throw new RutrackerCaptchaError(loginUrl);
    }

    if (!isSessionCookieJar(this.cookies)) return false;

    // Trust nothing: confirm the session really is attached to the account.
    try {
      const html = await this.fetchForumPage(`${base}${RUTRACKER_FORUM_PREFIX}/index.php`);
      if (this.looksLikeCaptcha(html)) {
        this.metrics.add('captcha');
        throw new RutrackerCaptchaError(loginUrl);
      }
      return looksLoggedIn(html, this.username);
    } catch (error) {
      if (error instanceof RutrackerCaptchaError || error instanceof RutrackerRateLimitError) throw error;
      this.log.warn(`Login verification failed: ${describeError(error)}`);
      return false;
    }
  }

  private authHeaders(base: string, referer: string): Record<string, string> {
    return {
      Referer: referer,
      Origin: base,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {})
    };
  }

  private looksLikeCaptcha(html: string): boolean {
    if (typeof html !== 'string' || !html) return false;
    return /captcha|капча|введите\s+код|g-recaptcha/i.test(html) && !/logout=1/i.test(html);
  }

  /** Releases the session when the adapter is torn down (see `BaseCrawler.close`). */
  public override async close(): Promise<void> {
    this.sessionCheckedFor = null;
  }

  // --------------------------------------------------------------------------
  // Transport
  // --------------------------------------------------------------------------

  /** Authenticated, charset-aware HTML fetch. */
  private async fetchForumPage(url: string): Promise<string> {
    const safeUrl = sameOriginHttpUrl(url, this.baseUrl);
    if (!safeUrl) throw new Error('Refusing an authenticated RuTracker request outside the selected origin.');

    let buffer: Buffer;
    try {
      buffer = await this.fetchBytes(safeUrl, {
        autoSolveCloudflare: false,
        headers: {
          Referer: `${this.baseUrl.replace(/\/+$/, '')}${RUTRACKER_FORUM_PREFIX}/`,
          ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {})
        }
      });
    } catch (error) {
      const body = responseBody(error);
      if (this.looksLikeCaptcha(body)) {
        this.metrics.add('captcha');
        throw new RutrackerCaptchaError(safeUrl);
      }
      if (responseStatus(error) === 429 || looksLikeRateLimitPage(body)) {
        this.metrics.add('rateLimited');
        throw new RutrackerRateLimitError(safeUrl);
      }
      throw error;
    }

    const html = decodeHtmlBody(buffer);
    if (this.looksLikeCaptcha(html)) {
      this.metrics.add('captcha');
      throw new RutrackerCaptchaError(safeUrl);
    }
    if (looksLikeRateLimitPage(html)) {
      this.metrics.add('rateLimited');
      throw new RutrackerRateLimitError(safeUrl);
    }
    return html;
  }

  // --------------------------------------------------------------------------
  // Parsing
  // --------------------------------------------------------------------------

  /**
   * One listing page (`tracker.php?nm=` or `viewforum.php?f=`) -> topics.
   * Rows are recognised by their topic link, not by a hard-coded table class,
   * so a template change costs a log line instead of a whole empty run.
   */
  public parseListing(html: string, pageUrl: string, defaultType: ContentType = 'movie'): RutrackerTopic[] {
    const $ = cheerio.load(html);
    const topics: RutrackerTopic[] = [];
    const seen = new Set<string>();

    $('tr').each((_, el) => {
      const row = $(el);
      const anchor = row.find('a.tLink, a.topic-title, a[href*="viewtopic.php?t="]').first();
      const href = anchor.attr('href');
      if (!href) return;

      const topicId = href.match(/[?&]t=(\d+)/)?.[1] ?? null;
      if (!topicId || seen.has(topicId)) return;

      const title = cleanText(anchor.text());
      if (!title || isBlockedTitle(title)) return;

      // Topic pages receive the logged-in Cookie header; reject external hrefs.
      const url = sameOriginHttpUrl(href, pageUrl);
      if (!url) return;

      seen.add(topicId);

      const sizeCell = cleanText(row.find('.tor-size, td.tor-size, td[class*="size"]').first().text());
      const seedCell = cleanText(row.find('.seedmed, td.seedmed, b.seedmed, .seeders, td[class*="seed"]').first().text());
      const leechCell = cleanText(row.find('.leechmed, td.leechmed, .leechers, td[class*="leech"]').first().text());

      const forumAnchor = row.find('a[href*="viewforum.php?f="], a[href*="tracker.php?f="]').first();
      const forumHref = forumAnchor.attr('href') || '';
      const forumTitle = cleanText(forumAnchor.text());
      const forumId = forumHref.match(/[?&]f=(\d+)/)?.[1] ?? null;

      const seeders = parseCount(seedCell);
      topics.push({
        topicId,
        url,
        title,
        sizeBytes: parseSizeToBytes(sizeCell.replace(/\s+/g, '')),
        seeders,
        leechers: parseCount(leechCell),
        forumId,
        forumTitle: forumTitle || null,
        type: typeFromForumTitle(forumTitle, defaultType)
      });
    });

    return topics;
  }

  /**
   * Next listing URL, or `null` when the page publishes no further offset.
   * RuTracker paginates with `start=`; offsets are read from the pager, never
   * synthesised, so a one-page result costs a single request.
   */
  public nextPage(html: string, currentUrl: string): string | null {
    const $ = cheerio.load(html);
    let current: URL;
    try {
      current = new URL(currentUrl);
    } catch {
      return null;
    }

    const currentStarts = current.searchParams.getAll('start');
    if (currentStarts.length > 1) return null;
    const currentStartRaw = currentStarts[0] || '0';
    if (!/^\d+$/.test(currentStartRaw)) return null;
    const currentStart = Number(currentStartRaw);
    if (!Number.isSafeInteger(currentStart)) return null;

    const queryWithoutStart = (url: URL): string => JSON.stringify(
      [...url.searchParams.entries()]
        .filter(([key]) => key !== 'start')
        .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
    );
    const currentQuery = queryWithoutStart(current);

    const candidates: { href: string; start: number; label: string }[] = [];
    $('a.pg[href], .pagination a[href], .pagination2 a[href], a[href*="start="]').each((_, el) => {
      const anchor = $(el);
      const href = anchor.attr('href') || '';
      if (!/start=/i.test(href)) return;

      // Pagination is fetched with the account cookie, so it must stay on the
      // exact origin and listing route; same-host checks could leak credentials.
      const target = sameOriginHttpUrl(href, currentUrl);
      if (!target) return;

      try {
        const parsed = new URL(target);
        if (parsed.pathname !== current.pathname || queryWithoutStart(parsed) !== currentQuery) return;
        const targetStarts = parsed.searchParams.getAll('start');
        if (targetStarts.length !== 1 || !/^\d+$/.test(targetStarts[0])) return;
        const start = Number(targetStarts[0]);
        if (!Number.isSafeInteger(start) || start <= currentStart) return;
        candidates.push({ href: target, start, label: cleanText(anchor.text()) });
      } catch {
        return;
      }
    });

    if (!candidates.length) return null;

    // 1. "След." / "Next" / arrows: the pager's own pointer to the next page.
    const relNext = candidates.find(candidate => /след|next|›|»|>|→/i.test(candidate.label));
    if (relNext) return relNext.href;

    // 2. Otherwise the closest offset above the current one (1,2,3 -> 2,3).
    let smallest = candidates[0];
    for (const candidate of candidates) {
      if (candidate.start < smallest.start) smallest = candidate;
    }
    return smallest.href;
  }

  /**
   * One `viewtopic.php?t=NNN` page -> magnet, `dl.php` link and language hints.
   * The magnet is what the site publishes for logged-in users; nothing is built
   * from the topic id.
   */
  public parseTopic(html: string, url: string): RutrackerTopicDetail {
    const $ = cheerio.load(html);

    const title = cleanText(
      $('a#topic-title').first().text() ||
      $('h1.maintitle a').first().text() ||
      $('h1.maintitle').first().text() ||
      $('h1').first().text() ||
      $('title').first().text()
    ).replace(/^RuTracker\.org\s*[·|:-]\s*/i, '');

    const magnetUrl = $('a[href]').toArray()
      .map(el => cleanText($(el).attr('href') || ''))
      .find(href => /^magnet:/i.test(href) && Boolean(parseMagnetUri(href))) ?? null;

    let torrentUrl: string | null = null;
    for (const el of $('a[href]').toArray()) {
      const href = $(el).attr('href') || '';
      if (!/dl\.php/i.test(href)) continue;
      // Never send the authenticated session cookie to a third-party host.
      torrentUrl = sameOriginHttpUrl(href, url);
      if (torrentUrl) break;
    }

    const sizeText = cleanText(
      $('#tor-size-humn, .tor-size, #tor-size, td[class*="size"]').first().text()
    );
    const sizeBytes = parseSizeToBytes(sizeText.replace(/\s+/g, ''));

    // `body` would win a plain comma selector (it is the first node in document
    // order) and turn the whole page into the "description".
    const bodyNode = $('.post_body, .postbody, td.post-body, #topic_main').first();
    const pageText = cleanText(bodyNode.length ? bodyNode.text() : $('body').text());
    const seeders = parseCount(pageText.match(/(?:сиды|раздают|seeders?)\D{0,12}(\d[\d\s.,]*)/i)?.[1] ?? null);
    const leechers = parseCount(pageText.match(/(?:личи|качают|leechers?)\D{0,12}(\d[\d\s.,]*)/i)?.[1] ?? null);

    return {
      title,
      magnetUrl,
      torrentUrl,
      sizeBytes,
      seeders,
      leechers,
      hints: languageHintsFromBody(pageText.slice(0, BODY_SCAN_LIMIT))
    };
  }

  // --------------------------------------------------------------------------
  // Crawl
  // --------------------------------------------------------------------------

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    this.resetRunState();
    this.log.info(`Starting RuTracker crawl (maxPages=${maxPages})...`);

    const mirror = await this.resolveMirror({
      envPrefix: 'RUTRACKER',
      defaults: RUTRACKER_DEFAULT_MIRRORS,
      fallback: null,
      probes: [
        {
          path: `${RUTRACKER_FORUM_PREFIX}/index.php`,
          label: 'portada del foro',
          timeoutMs: 10000,
          validate: htmlMarkerValidator([/rutracker/i, /viewtopic\.php|login\.php|viewforum\.php/i])
        }
      ]
    });

    this.baseUrl = mirror;

    await this.ensureSession(mirror);

    const routes = this.routes(mirror);
    if (!routes.length) {
      throw new Error(
        '[rutracker] No route configured: set RUTRACKER_SEARCH, RUTRACKER_FORUMS or RUTRACKER_ROUTES.'
      );
    }

    const topics = new Map<string, RutrackerTopic>();
    for (const route of routes) {
      if (this.deadline.expired) break;
      await this.collectRoute(route, maxPages, topics);
    }

    if (!topics.size) {
      throw new Error(
        `[rutracker] ${routes.length} route(s) read on ${mirror} but no topic row was found. ` +
        'Check the session (RUTRACKER_USERNAME/PASSWORD or RUTRACKER_COOKIE_JSON) and the search terms.'
      );
    }

    const candidates = this.applyLanguagePrefilter([...topics.values()]);
    this.log.info(`Discovered ${topics.size} topics; ${candidates.length} kept for detail extraction.`);

    if (!candidates.length) {
      throw new Error(
        `[rutracker] ${topics.size} topics found but none shows Spanish/English evidence in its title. ` +
        'Widen RUTRACKER_SEARCH or set RUTRACKER_LANG_PREFILTER=false to inspect every topic.'
      );
    }

    const nested = await mapWithConcurrency(candidates, this.detailConcurrency, async topic => {
      if (this.deadline.expired) return [];
      try {
        return await this.crawlTopic(topic);
      } catch (error) {
        if (error instanceof RutrackerCaptchaError || error instanceof RutrackerRateLimitError) throw error;
        this.metrics.add('detailErrors');
        this.log.warn(`Topic failed ${topic.url}: ${describeError(error)}`);
        return [];
      }
    });

    const records = this.deduplicateRecords(nested.flat());
    this.logRunSummary(records);

    if (!records.length) {
      throw new Error(
        `[rutracker] ${candidates.length} topics read but no magnet/torrent produced a valid infohash ` +
        `(captcha=${this.metrics.get('captcha')}, downloadErrors=${this.metrics.get('downloadErrors')}). ` +
        'The session is probably no longer attached to the account.'
      );
    }

    return records;
  }

  /** Walks one route following only the pagination the pages publish. */
  private async collectRoute(
    route: RutrackerRoute,
    maxPages: number,
    sink: Map<string, RutrackerTopic>
  ): Promise<void> {
    let listUrl: string | null = route.url;
    const visited = new Set<string>();
    // Fingerprint of the topic ids served by the previous page of this route.
    let previousSignature = '';

    for (let page = 0; listUrl && page < maxPages; page++) {
      if (this.deadline.expired || visited.has(listUrl)) break;
      visited.add(listUrl);

      try {
        const html = await this.fetchForumPage(listUrl);
        this.metrics.add('listings');

        if (this.looksLikeCaptcha(html)) {
          this.metrics.add('captcha');
          throw new RutrackerCaptchaError(listUrl);
        }

        const topics = this.parseListing(html, listUrl, route.type);
        if (!topics.length) break;

        // An offset ignored by the template brings the very same page back:
        // stop instead of spending the account quota on identical requests.
        const signature = topics.map(topic => topic.topicId).sort().join(',');
        if (signature === previousSignature) {
          this.log.debug(`${route.label} page ${page + 1} repeated the previous listing. Ending route.`);
          break;
        }
        previousSignature = signature;

        let added = 0;
        for (const topic of topics) {
          if (sink.has(topic.topicId)) continue;
          if (this.minSeeders > 0 && (topic.seeders ?? 0) < this.minSeeders) continue;
          sink.set(topic.topicId, topic);
          added++;
        }
        this.log.debug(`${route.label} page ${page + 1}: ${topics.length} rows (${added} new).`);

        listUrl = this.nextPage(html, listUrl);
      } catch (error) {
        if (error instanceof RutrackerCaptchaError || error instanceof RutrackerRateLimitError) throw error;
        this.metrics.add('listingErrors');
        this.log.warn(`Route ${route.label} failed at ${listUrl}: ${describeError(error)}`);
        break;
      }
    }
  }

  /**
   * Drops topics whose title shows no Spanish/English evidence before spending
   * one request each on `viewtopic.php`. The orchestrator still applies the
   * full language filter to the resulting records.
   */
  private applyLanguagePrefilter(topics: RutrackerTopic[]): RutrackerTopic[] {
    if (!this.languagePrefilter) return topics;

    const kept: RutrackerTopic[] = [];
    for (const topic of topics) {
      const detected = detectLanguages(topic.title, [], false);
      if (hasValidLanguageRelease(detected.audio, detected.subtitles)) {
        kept.push(topic);
      } else {
        this.metrics.add('languageSkipped');
      }
    }
    return kept;
  }

  /** Authenticated torrent download without the shared client's WAF bypass path. */
  private async fetchRutrackerMetainfo(url: string, referer: string): Promise<ParsedTorrentFile> {
    const safeUrl = sameOriginHttpUrl(url, referer);
    if (!safeUrl) throw new Error('Refusing an authenticated torrent request outside the topic origin.');

    await politePause();
    const cookie = this.cookieHeader();
    let buffer: Buffer;
    try {
      this.requestWithinBudget();
      buffer = await this.httpClient.getBuffer(safeUrl, {
        autoSolveCloudflare: false,
        maxContentLength: MAX_TORRENT_BYTES,
        maxBodyLength: MAX_TORRENT_BYTES,
        headers: {
          Accept: 'application/x-bittorrent,application/octet-stream;q=0.9,*/*;q=0.5',
          Referer: referer,
          ...(cookie ? { Cookie: cookie } : {})
        }
      });
    } catch (error) {
      const body = responseBody(error);
      if (this.looksLikeCaptcha(body)) {
        this.metrics.add('captcha');
        throw new RutrackerCaptchaError(safeUrl);
      }
      if (responseStatus(error) === 429 || looksLikeRateLimitPage(body)) {
        this.metrics.add('rateLimited');
        throw new RutrackerRateLimitError(safeUrl);
      }
      throw error;
    }

    const htmlLike = buffer.subarray(0, 256).toString('latin1').trimStart().startsWith('<');
    if (htmlLike) {
      const html = decodeHtmlBody(buffer);
      if (this.looksLikeCaptcha(html)) {
        this.metrics.add('captcha');
        throw new RutrackerCaptchaError(safeUrl);
      }
      if (looksLikeRateLimitPage(html)) {
        this.metrics.add('rateLimited');
        throw new RutrackerRateLimitError(safeUrl);
      }
    }

    const metainfo = parseTorrentBuffer(buffer);
    if (!metainfo) {
      throw new Error(`Response from ${safeUrl} is not valid v1/hybrid torrent metainfo`);
    }
    return metainfo;
  }

  private async crawlTopic(topic: RutrackerTopic): Promise<TorrentRecord[]> {
    const html = await this.fetchForumPage(topic.url);
    this.metrics.add('details');

    if (this.looksLikeCaptcha(html)) {
      this.metrics.add('captcha');
      throw new RutrackerCaptchaError(topic.url);
    }

    const detail = this.parseTopic(html, topic.url);
    const title = cleanText(detail.title || topic.title);
    if (!title || isBlockedTitle(title)) return [];

    let infoHash: string | null = null;
    let trackers: string[] = [];
    let sizeBytes = detail.sizeBytes ?? topic.sizeBytes;
    let magnetUrl = detail.magnetUrl;

    if (magnetUrl) {
      const parsed = parseMagnetUri(magnetUrl);
      infoHash = parsed?.infoHash ?? null;
      trackers = parsed?.trackers ?? [];
      if (!infoHash) magnetUrl = null;
    }

    if (!infoHash && detail.torrentUrl) {
      try {
        const metainfo = await this.fetchRutrackerMetainfo(detail.torrentUrl, topic.url);
        this.metrics.add('downloads');
        infoHash = metainfo.infoHash;
        if (!sizeBytes && metainfo.sizeBytes > 0) sizeBytes = metainfo.sizeBytes;
        if (!trackers.length) trackers = metainfo.trackers;
      } catch (error) {
        if (error instanceof RutrackerCaptchaError || error instanceof RutrackerRateLimitError) throw error;
        this.metrics.add('downloadErrors');
        this.log.debug(`Metainfo download failed for ${detail.torrentUrl}: ${describeError(error)}`);
      }
    }

    if (!infoHash) {
      this.metrics.add('skipped');
      this.log.debug(`${topic.url}: the topic publishes no magnet and the .torrent could not be read.`);
      return [];
    }

    const meta = parseTorrentTitle(title, topic.type);
    const context = dedupeStrings([title, ...detail.hints]).join(' ');
    const languages = detectLanguages(context, [], false);

    const record = buildTorrentRecord({
      title,
      type: meta.type,
      infoHash,
      magnetUrl,
      torrentFileUrl: detail.torrentUrl,
      sourceUrl: topic.url,
      trackers,
      audio: languages.audio,
      subtitles: languages.subtitles,
      meta,
      quality: qualityOf(meta),
      sizeBytes,
      seeders: detail.seeders ?? topic.seeders ?? null,
      leechers: detail.leechers ?? topic.leechers ?? null,
      sourceTracker: trackers[0] ?? null
    });

    if (!record) return [];
    this.metrics.add('records');
    return [record];
  }

  protected override resetRunState(): void {
    super.resetRunState();
    // A new run on a new mirror must re-check the session.
    this.sessionCheckedFor = null;
  }
}

export default RutrackerCrawler;
