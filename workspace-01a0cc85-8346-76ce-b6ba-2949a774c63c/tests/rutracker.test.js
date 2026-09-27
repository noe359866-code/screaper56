/**
 * RuTracker adapter: everything is offline (no network, no browser).
 *
 * The three things that break this site are covered on purpose: cp1251
 * decoding, the authenticated session and the "only real pagination" rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RutrackerCrawler,
  RutrackerAuthError,
  RutrackerCaptchaError,
  RUTRACKER_DEFAULT_MIRRORS,
  RUTRACKER_DEFAULT_SEARCHES,
  absorbSetCookie,
  cookieHeaderOf,
  decodeHtmlBody,
  detectHtmlCharset,
  encodeWindows1251,
  isSessionCookieJar,
  languageHintsFromBody,
  looksLoggedIn,
  parseCookieJar,
  typeFromForumTitle
} from '../src/crawlers/rutracker.ts';
import { clearMirrorCache } from '../src/crawlers/mirrors.ts';
import { CRAWLER_REGISTRY } from '../src/crawlers/registry.ts';
import { loadConfig } from '../src/config/env.ts';
import { mockHttp, HASH } from './helpers.js';

const BASE = 'https://rutracker.org';
const FORUM = `${BASE}/forum`;
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=El+Camino&tr=udp%3A%2F%2Fbt.rutracker.org%2Fann`;

/** A session cookie jar in the exact format exported by browser extensions. */
const COOKIE_EXPORT = JSON.stringify([
  { domain: '.rutracker.org', hostOnly: false, httpOnly: false, name: 'bb_guid', path: '/forum/', value: '0CZUU830TNvZ' },
  { domain: '.rutracker.org', hostOnly: false, httpOnly: false, name: 'bb_ssl', path: '/forum/', value: '1' },
  {
    domain: '.rutracker.org',
    expirationDate: Math.floor(Date.now() / 1000) + 86_400,
    hostOnly: false,
    httpOnly: true,
    name: 'bb_session',
    path: '/forum/',
    secure: true,
    value: '0-55637203-cR0IHydXuosvjViyZspV'
  }
]);

const LOGGED_IN_INDEX = '<html><head><title>RuTracker.org</title></head><body>' +
  '<a href="profile.php?mode=viewprofile">BastianMillanBarber</a> ' +
  '<a href="login.php?logout=1">Выход [ BastianMillanBarber ]</a></body></html>';

function listing(extraRows = '', pager = '') {
  return `<html><head><meta charset="windows-1251"></head><body>
  <table class="forumline tablesort" id="tor-tbl"><tbody>
    <tr id="t-row-6466319" class="tCenter hl-tr">
      <td class="row1 t-ico"><a href="viewforum.php?f=7"><img src="i.png"></a></td>
      <td class="row1 t-title-col"><div class="t-title">
        <a data-topic_id="6466319" class="tLink" href="./viewtopic.php?t=6466319">El Camino (2019) BDRip 1080p Castellano</a>
      </div></td>
      <td class="row4 nowrap"><a href="tracker.php?f=7">Зарубежное кино</a></td>
      <td class="row4 small nowrap tor-size"><u>10.94&nbsp;GB</u></td>
      <td class="row1 small number-format"><b class="seedmed">42</b></td>
      <td class="row4 small number-format leechmed">7</td>
      <td class="row1 small number-format">1234</td>
      <td class="row4 nowrap"><u>14-Окт-24 12:00</u></td>
    </tr>
    ${extraRows}
  </tbody></table>${pager}</body></html>`;
}

/** A row with no Spanish/English evidence: the prefilter must drop it. */
const RUSSIAN_ROW = `<tr id="t-row-6466320" class="tCenter hl-tr">
  <td class="row1 t-title-col"><div class="t-title">
    <a class="tLink" href="./viewtopic.php?t=6466320">Русская версия фильма 2019 BDRip 1080p</a>
  </div></td>
  <td class="row4 nowrap"><a href="tracker.php?f=22">Наше кино</a></td>
  <td class="row4 small nowrap tor-size"><u>8.00&nbsp;GB</u></td>
  <td class="row1 small number-format"><b class="seedmed">5</b></td>
  <td class="row4 small number-format leechmed">1</td>
</tr>`;

const PAGER = `<div class="pagination"><a class="pg" href="tracker.php?nm=castellano&start=0">1</a>
  <a class="pg" href="tracker.php?nm=castellano&start=50">2</a>
  <a href="tracker.php?nm=castellano&start=50">След.</a></div>`;

function topic({ magnet = MAGNET, download = 'dl.php?t=6466319' } = {}) {
  return `<html><head><title>RuTracker.org :: El Camino</title></head><body>
  <h1 class="maintitle"><a id="topic-title" href="viewtopic.php?t=6466319">El Camino (2019) BDRip 1080p Castellano</a></h1>
  <div class="attach">${magnet ? `<a href="${magnet}">magnet link</a>` : ''}
    ${download ? `<a href="${download}">Скачать</a>` : ''}
    <span id="tor-size-humn">10.94 GB</span></div>
  <div class="post_body">Описание: фильм на испанском языке. Перевод: профессиональный (дублированный).</div>
  </body></html>`;
}

/**
 * Replaces the env block a test needs and restores it afterwards.
 * NOTE: it must `await fn()`; a bare `return fn()` would run the `finally`
 * (and restore the env) while the async body is still awaiting.
 */
async function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('RuTracker is a selectable target and exposes its mirror pool', () => {
  assert.equal(typeof CRAWLER_REGISTRY.rutracker, 'function');
  assert.ok(RUTRACKER_DEFAULT_MIRRORS.includes(BASE));
  assert.ok(RUTRACKER_DEFAULT_SEARCHES.includes('castellano'));

  withEnv({ DRY_RUN: 'true', TARGET_CRAWLERS: 'all' }, () => {
    assert.ok(loadConfig(true).targetCrawlers.includes('rutracker'));
  });
  withEnv({ DRY_RUN: 'true', TARGET_CRAWLERS: 'rutracker' }, () => {
    assert.deepEqual(loadConfig(true).targetCrawlers, ['rutracker']);
  });
});

test('Windows-1251: the body is decoded with the charset the page declares', () => {
  // "Зарубежное кино" in cp1251; UTF-8 decoding turns it into mojibake.
  const cyrillic = Buffer.from([0xC7, 0xE0, 0xF0, 0xF3, 0xE1, 0xE5, 0xE6, 0xED, 0xEE, 0xE5, 0x20, 0xEA, 0xE8, 0xED, 0xEE]);
  const page = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1251"></head><body>'), cyrillic, Buffer.from('</body></html>')]);

  assert.equal(detectHtmlCharset(page), 'windows-1251');
  assert.match(decodeHtmlBody(page), /Зарубежное кино/);

  const utf8 = Buffer.from('<html><head><meta charset="utf-8"></head><body>Castellano</body></html>');
  assert.equal(detectHtmlCharset(utf8), 'utf-8');
  assert.match(decodeHtmlBody(utf8), /Castellano/);
});

test('Windows-1251: search terms are encoded the way the site submits them', () => {
  assert.equal(encodeWindows1251('castellano'), 'castellano');
  // "Вход" -> the four cp1251 bytes of the submit button, not UTF-8 escapes.
  assert.equal(encodeWindows1251('Вход'), '%C2%F5%EE%E4');
  // "испанский" is native cp1251, never UTF-8 double-escaped.
  assert.equal(encodeWindows1251('испанский'), '%E8%F1%EF%E0%ED%F1%EA%E8%E9');
});

test('Cookies: browser export, header string, expired entries and set-cookie folding', () => {
  const fromExport = parseCookieJar(COOKIE_EXPORT);
  assert.deepEqual(fromExport, [
    ['bb_guid', '0CZUU830TNvZ'],
    ['bb_ssl', '1'],
    ['bb_session', '0-55637203-cR0IHydXuosvjViyZspV']
  ]);

  const jar = new Map(fromExport);
  assert.equal(isSessionCookieJar(jar), true);
  assert.equal(cookieHeaderOf(jar), 'bb_guid=0CZUU830TNvZ; bb_ssl=1; bb_session=0-55637203-cR0IHydXuosvjViyZspV');

  // A header string works too, and garbage never throws.
  assert.deepEqual(parseCookieJar('bb_session=abc; bb_ssl=1'), [['bb_session', 'abc'], ['bb_ssl', '1']]);
  assert.deepEqual(parseCookieJar('not json ['), []);
  assert.deepEqual(parseCookieJar(''), []);

  // An expired session is dropped: replaying it only looks like a broken parser.
  const expired = JSON.stringify([{ name: 'bb_session', value: 'old', expirationDate: 1 }]);
  assert.deepEqual(parseCookieJar(expired), []);

  // Login responses: only the cookie pair is stored, attributes are ignored.
  const fresh = new Map();
  assert.deepEqual(
    absorbSetCookie(fresh, ['bb_session=new-value; path=/forum/; HttpOnly', 'bb_ssl=1', 'garbage']),
    ['bb_session', 'bb_ssl']
  );
  assert.equal(fresh.get('bb_session'), 'new-value');
  assert.deepEqual(absorbSetCookie(new Map(), undefined), []);
});

test('Session: the "log out" control is what identifies a logged-in page', () => {
  assert.equal(looksLoggedIn(LOGGED_IN_INDEX, 'BastianMillanBarber'), true);
  assert.equal(looksLoggedIn('<html><body><a href="login.php">Вход</a></body></html>', 'nope'), false);
  assert.equal(looksLoggedIn('', 'x'), false);
});

test('Sections and descriptions map onto content types and language hints', () => {
  assert.equal(typeFromForumTitle('Зарубежное кино'), 'movie');
  assert.equal(typeFromForumTitle('Зарубежные сериалы (HD Video)'), 'series');
  assert.equal(typeFromForumTitle('Аниме'), 'anime');
  assert.equal(typeFromForumTitle('Документальные фильмы'), 'documentary');
  assert.equal(typeFromForumTitle('', 'series'), 'series');

  assert.deepEqual(languageHintsFromBody(''), []);
  assert.ok(languageHintsFromBody('Перевод: профессиональный (испанский язык)')[0].length > 0);
});

test('Listing: topic rows keep size, swarm counters, section and type', () => {
  const crawler = new RutrackerCrawler();
  const rows = crawler.parseListing(listing(RUSSIAN_ROW), `${FORUM}/tracker.php?nm=castellano`);

  assert.equal(rows.length, 2);
  const [movie] = rows;
  assert.equal(movie.topicId, '6466319');
  assert.equal(movie.url, `${FORUM}/viewtopic.php?t=6466319`);
  assert.equal(movie.title, 'El Camino (2019) BDRip 1080p Castellano');
  assert.equal(movie.seeders, 42);
  assert.equal(movie.leechers, 7);
  assert.equal(movie.sizeBytes, Math.round(10.94 * 1024 ** 3));
  assert.equal(movie.forumId, '7');
  assert.equal(movie.type, 'movie');

  const russian = rows[1];
  assert.equal(russian.type, 'movie'); // "Наше кино" -> movie
  assert.equal(russian.topicId, '6466320');
});

test('Listing: rows without a topic id or with an adult title are skipped', () => {
  const crawler = new RutrackerCrawler();
  const html = `<table><tr><td><a href="viewforum.php?f=7">No topic here</a></td></tr>
    <tr id="t-row-1"><td class="t-title-col"><a class="tLink" href="./viewtopic.php?t=1">Some XXX release</a></td></tr></table>`;
  assert.deepEqual(crawler.parseListing(html, `${FORUM}/tracker.php?nm=x`), []);
});

test('Pagination: only the offsets the pager publishes are followed', () => {
  const crawler = new RutrackerCrawler();
  const url = `${FORUM}/tracker.php?nm=castellano`;

  // "След." points at start=50.
  assert.equal(crawler.nextPage(listing('', PAGER), url), `${FORUM}/tracker.php?nm=castellano&start=50`);
  // Already on start=50 with the same pager: nothing further.
  assert.equal(crawler.nextPage(listing('', PAGER), `${url}&start=50`), null);
  // A single-page result publishes no offset at all.
  assert.equal(crawler.nextPage(listing(), url), null);
  // Numbered-only pager: 1 2 3 -> the closest offset above the current one.
  const numbered = '<a class="pg" href="tracker.php?nm=x&start=0">1</a>' +
    '<a class="pg" href="tracker.php?nm=x&start=50">2</a>' +
    '<a class="pg" href="tracker.php?nm=x&start=100">3</a>';
  assert.equal(crawler.nextPage(numbered, `${FORUM}/tracker.php?nm=x&start=50`), `${FORUM}/tracker.php?nm=x&start=100`);
});

test('Topic: magnet, dl.php link, declared size and language hints', () => {
  const crawler = new RutrackerCrawler();
  const url = `${FORUM}/viewtopic.php?t=6466319`;
  const detail = crawler.parseTopic(topic(), url);

  assert.equal(detail.title, 'El Camino (2019) BDRip 1080p Castellano');
  assert.equal(detail.magnetUrl, MAGNET);
  assert.equal(detail.torrentUrl, `${FORUM}/dl.php?t=6466319`);
  assert.equal(detail.sizeBytes, Math.round(10.94 * 1024 ** 3));
  assert.ok(detail.hints.length > 0);

  const withoutMagnet = crawler.parseTopic(topic({ magnet: '' }), url);
  assert.equal(withoutMagnet.magnetUrl, null);
  assert.equal(withoutMagnet.torrentUrl, `${FORUM}/dl.php?t=6466319`);
});

test('Full crawl: session check, one listing, one detail per kept topic', async () => {
  clearMirrorCache('rutracker');
  await withEnv({ RUTRACKER_COOKIE_JSON: COOKIE_EXPORT, RUTRACKER_SEARCH: 'castellano', RUTRACKER_FORUMS: '', RUTRACKER_ROUTES: '' }, async () => {
    const crawler = new RutrackerCrawler();
    const calls = mockHttp(
      crawler,
      url => (url.includes('index.php') ? LOGGED_IN_INDEX : listing(RUSSIAN_ROW)),
      url => Buffer.from(
        url.includes('index.php') ? LOGGED_IN_INDEX
          : url.includes('viewtopic.php') ? topic()
            : listing(RUSSIAN_ROW),
        'utf-8'
      )
    );

    const records = await crawler.crawl(1);

    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.info_hash, HASH);
    assert.equal(record.type, 'movie');
    assert.equal(record.seeders, 42);
    assert.equal(record.leechers, 7);
    assert.equal(record.source_url, `${FORUM}/viewtopic.php?t=6466319`);
    assert.equal(record.torrent_file_url, `${FORUM}/dl.php?t=6466319`);
    assert.match(record.magnet_url, new RegExp(HASH));
    assert.ok(record.audio.includes('Spanish'));
    assert.ok(record.size_bytes > 10 * 1024 ** 3);

    // The Russian row never cost a request: the title prefilter dropped it.
    assert.equal(calls.filter(url => url.includes('viewtopic.php')).length, 1);
    // Session check + one listing page; a single-page search costs no more.
    assert.equal(calls.filter(url => url.includes('tracker.php')).length, 1);
  });
  clearMirrorCache('rutracker');
});

test('Full crawl: pagination stops at maxPages and never repeats an offset', async () => {
  clearMirrorCache('rutracker');
  await withEnv({ RUTRACKER_COOKIE_JSON: COOKIE_EXPORT, RUTRACKER_SEARCH: 'castellano', RUTRACKER_FORUMS: '', RUTRACKER_ROUTES: '' }, async () => {
    const crawler = new RutrackerCrawler();
    const listingCalls = [];
    mockHttp(
      crawler,
      url => (url.includes('index.php') ? LOGGED_IN_INDEX : listing('', PAGER)),
      url => {
        if (url.includes('index.php')) return Buffer.from(LOGGED_IN_INDEX, 'utf-8');
        if (url.includes('viewtopic.php')) return Buffer.from(topic(), 'utf-8');
        listingCalls.push(url);
        // Page 2 keeps the pager: without maxPages the loop would run forever.
        return Buffer.from(listing('', PAGER), 'utf-8');
      }
    );

    await crawler.crawl(2);
    assert.deepEqual(listingCalls, [
      `${FORUM}/tracker.php?nm=castellano`,
      `${FORUM}/tracker.php?nm=castellano&start=50`
    ]);
  });
  clearMirrorCache('rutracker');
});

test('Full crawl: no magnet in the topic -> the dl.php metainfo is downloaded', async () => {
  clearMirrorCache('rutracker');
  const file = (await import('./helpers.js')).torrent('El Camino 2019 1080p Castellano');
  await withEnv({ RUTRACKER_COOKIE_JSON: COOKIE_EXPORT, RUTRACKER_SEARCH: 'castellano', RUTRACKER_FORUMS: '', RUTRACKER_ROUTES: '' }, async () => {
    const crawler = new RutrackerCrawler();
    mockHttp(
      crawler,
      url => (url.includes('index.php') ? LOGGED_IN_INDEX : listing()),
      url => {
        if (url.includes('index.php')) return Buffer.from(LOGGED_IN_INDEX, 'utf-8');
        if (url.includes('dl.php')) return file.buffer;
        if (url.includes('viewtopic.php')) return Buffer.from(topic({ magnet: '' }), 'utf-8');
        return Buffer.from(listing(), 'utf-8');
      }
    );

    const records = await crawler.crawl(1);
    assert.equal(records.length, 1);
    assert.equal(records[0].info_hash, file.hash);
    assert.equal(records[0].torrent_file_url, `${FORUM}/dl.php?t=6466319`);
  });
  clearMirrorCache('rutracker');
});

test('No credentials and no session: the adapter fails loudly instead of crawling anonymously', async () => {
  clearMirrorCache('rutracker');
  await withEnv({ RUTRACKER_COOKIE_JSON: undefined, RUTRACKER_COOKIES: undefined, RUTRACKER_USERNAME: undefined, RUTRACKER_PASSWORD: undefined }, async () => {
    const crawler = new RutrackerCrawler();
    mockHttp(crawler, () => '<html><title>RuTracker.org</title><a href="login.php">Вход</a></html>');
    await assert.rejects(crawler.crawl(1), RutrackerAuthError);
    await assert.rejects(crawler.crawl(1), /RUTRACKER_USERNAME|RUTRACKER_COOKIE_JSON/);
  });
  clearMirrorCache('rutracker');
});

test('A CAPTCHA is reported as such instead of being counted as a parsing error', async () => {
  clearMirrorCache('rutracker');
  await withEnv({ RUTRACKER_COOKIE_JSON: COOKIE_EXPORT, RUTRACKER_SEARCH: 'castellano', RUTRACKER_FORUMS: '', RUTRACKER_ROUTES: '' }, async () => {
    const crawler = new RutrackerCrawler();
    mockHttp(
      crawler,
      url => (url.includes('index.php') ? LOGGED_IN_INDEX : '<html>Введите код с картинки (captcha)</html>'),
      url => Buffer.from(
        url.includes('index.php')
          ? LOGGED_IN_INDEX
          : '<html><form><img src="captcha.php"><input name="cap_code">Введите код</form></html>',
        'utf-8'
      )
    );

    await assert.rejects(crawler.crawl(1), RutrackerCaptchaError);
  });
  clearMirrorCache('rutracker');
});

test('Routes: searches, forums and raw paths are all supported', async () => {
  await withEnv({ RUTRACKER_SEARCH: 'castellano', RUTRACKER_FORUMS: '7, 22', RUTRACKER_ROUTES: '/forum/tracker.php?f=7&o=10' }, () => {
    const routes = new RutrackerCrawler().routes(BASE);
    assert.equal(routes.length, 4);
    assert.equal(routes[0].url, `${FORUM}/tracker.php?f=7&o=10`);
    assert.equal(routes[1].url, `${FORUM}/viewforum.php?f=7`);
    assert.equal(routes[2].url, `${FORUM}/viewforum.php?f=22`);
    assert.equal(routes[3].url, `${FORUM}/tracker.php?nm=castellano`);
  });

  await withEnv({ RUTRACKER_SEARCH: 'latino,испанский', RUTRACKER_FORUMS: '', RUTRACKER_ROUTES: '' }, () => {
    const routes = new RutrackerCrawler().routes(BASE);
    // cp1251, not UTF-8: that is what the site's own form submits.
    assert.equal(routes[0].url, `${FORUM}/tracker.php?nm=latino`);
    assert.equal(routes[1].url, `${FORUM}/tracker.php?nm=%E8%F1%EF%E0%ED%F1%EA%E8%E9`);
  });

  // Accented characters do not exist in cp1251: they fall back to UTF-8, so
  // RUTRACKER_SEARCH_CHARSET=utf-8 is the supported way to search them.
  await withEnv({ RUTRACKER_SEARCH: 'español', RUTRACKER_SEARCH_CHARSET: 'utf-8', RUTRACKER_FORUMS: '', RUTRACKER_ROUTES: '' }, () => {
    const routes = new RutrackerCrawler().routes(BASE);
    assert.equal(routes[0].url, `${FORUM}/tracker.php?nm=espa%C3%B1ol`);
  });
});

test('Language prefilter can be disabled and min-seeders is honoured', async () => {
  clearMirrorCache('rutracker');
  await withEnv({
    RUTRACKER_COOKIE_JSON: COOKIE_EXPORT,
    RUTRACKER_SEARCH: 'castellano',
    RUTRACKER_FORUMS: '',
    RUTRACKER_ROUTES: '',
    RUTRACKER_LANG_PREFILTER: 'false'
  }, async () => {
    const crawler = new RutrackerCrawler();
    const detailCalls = [];
    mockHttp(
      crawler,
      url => (url.includes('index.php') ? LOGGED_IN_INDEX : listing(RUSSIAN_ROW)),
      url => {
        if (url.includes('index.php')) return Buffer.from(LOGGED_IN_INDEX, 'utf-8');
        if (url.includes('viewtopic.php')) {
          detailCalls.push(url);
          return Buffer.from(topic(), 'utf-8');
        }
        return Buffer.from(listing(RUSSIAN_ROW), 'utf-8');
      }
    );

    const records = await crawler.crawl(1);
    // Both rows visited, both share the same magnet hash -> one record.
    assert.equal(detailCalls.length, 2);
    assert.equal(records.length, 1);
  });

  await withEnv({
    RUTRACKER_COOKIE_JSON: COOKIE_EXPORT,
    RUTRACKER_SEARCH: 'castellano',
    RUTRACKER_FORUMS: '',
    RUTRACKER_ROUTES: '',
    RUTRACKER_MIN_SEEDERS: '100'
  }, async () => {
    const crawler = new RutrackerCrawler();
    mockHttp(
      crawler,
      url => (url.includes('index.php') ? LOGGED_IN_INDEX : listing()),
      url => Buffer.from(
        url.includes('index.php') ? LOGGED_IN_INDEX
          : url.includes('viewtopic.php') ? topic()
            : listing(),
        'utf-8'
      )
    );
    // Every row has fewer than 100 seeders: nothing survives the filter.
    await assert.rejects(crawler.crawl(1), /no topic row|Spanish\/English/);
  });
  clearMirrorCache('rutracker');
});

test('Login: credentials are posted in cp1251 and the returned session is kept', async () => {
  clearMirrorCache('rutracker');
  await withEnv({
    RUTRACKER_COOKIE_JSON: undefined,
    RUTRACKER_COOKIES: 'bb_guid=anon',
    RUTRACKER_USERNAME: 'BastianMillanBarber',
    RUTRACKER_PASSWORD: 'V$JX4G3&&zVc;jq',
    RUTRACKER_SEARCH: 'castellano',
    RUTRACKER_FORUMS: '',
    RUTRACKER_ROUTES: ''
  }, async () => {
    const crawler = new RutrackerCrawler();
    const requests = [];
    crawler.httpClient = {
      get: async () => ({ status: 200, data: LOGGED_IN_INDEX }),
      getBuffer: async url => Buffer.from(
        url.includes('index.php') ? LOGGED_IN_INDEX
          : url.includes('viewtopic.php') ? topic()
            : listing(),
        'utf-8'
      ),
      request: async options => {
        requests.push(options);
        if (options.method === 'POST') {
          return {
            status: 302,
            headers: { 'set-cookie': ['bb_session=fresh-session; path=/forum/; HttpOnly', 'bb_ssl=1'] },
            data: ''
          };
        }
        return { status: 200, headers: {}, data: '<form action="login.php"></form>' };
      }
    };

    const records = await crawler.crawl(1);

    const post = requests.find(request => request.method === 'POST');
    assert.ok(post, 'the account must be logged in when no session cookie is valid');
    assert.equal(post.url, `${FORUM}/login.php`);
    assert.equal(
      post.data,
      'login_username=BastianMillanBarber&login_password=V%24JX4G3%26%26zVc%3Bjq&login=%C2%F5%EE%E4&redirect=index.php'
    );
    assert.equal(post.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(post.validateStatus(), true, 'the 302 must not be treated as an error');
    assert.equal(post.maxRedirects, 0, 'the redirect carries the session cookie');

    // The new session replaced the anonymous cookie for every following request.
    assert.match(crawler.cookieHeader(), /bb_session=fresh-session/);
    assert.equal(records.length, 1);
  });
  clearMirrorCache('rutracker');
});

test('Login refused: the adapter fails with advice instead of crawling anonymously', async () => {
  clearMirrorCache('rutracker');
  await withEnv({
    RUTRACKER_COOKIE_JSON: undefined,
    RUTRACKER_COOKIES: undefined,
    RUTRACKER_USERNAME: 'BastianMillanBarber',
    RUTRACKER_PASSWORD: 'wrong',
    RUTRACKER_SEARCH: 'castellano',
    RUTRACKER_FORUMS: '',
    RUTRACKER_ROUTES: ''
  }, async () => {
    const crawler = new RutrackerCrawler();
    crawler.httpClient = {
      // The mirror probe only checks that the domain really is RuTracker.
      get: async () => ({ status: 200, data: LOGGED_IN_INDEX }),
      getBuffer: async () => Buffer.from('<html>Вход</html>', 'utf-8'),
      // Login answered 200 with the form again: no session cookie was issued.
      request: async () => ({ status: 200, headers: {}, data: '<html>Неверный пароль</html>' })
    };

    await assert.rejects(crawler.crawl(1), /Login was refused/);
  });
  clearMirrorCache('rutracker');
});
