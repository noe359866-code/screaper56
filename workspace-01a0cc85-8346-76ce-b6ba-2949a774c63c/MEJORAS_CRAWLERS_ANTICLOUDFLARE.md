# Mejoras y correcciones: crawlers + anti-Cloudflare

**Rama:** `arena/01a0e2d2-screaper56` · **Fecha:** 27-09-2026
**Alcance:** los 15 adaptadores de `src/crawlers/`, los módulos compartidos
(`base.ts`, `support.ts`, `mirrors.ts`, `html-catalog.ts`), el transporte HTTP
(`src/utils/http.ts`), el motor anti-Cloudflare (`src/utils/anti-cloudflare.ts`),
la persistencia (`src/services/supabase.ts`), el orquestador (`src/index.ts`) y el
workflow de CI.

**Verificación:** `npm run lint` (tsc --noEmit) limpio, `npm run build` limpio y
**106 pruebas offline en verde** (74 previas + 32 nuevas en
`tests/hardening.test.js`). El entorno de trabajo no tiene salida de red, así que
**no se ha podido ejecutar una extracción en vivo**: la validación es de tipos,
pruebas con HTML/HTTP simulado y un humo del orquestador en `DRY_RUN=true`.

---

## 1. Motor anti-Cloudflare (`src/utils/anti-cloudflare.ts`)

Reescrito. Era el punto con más defectos graves del proyecto.

| # | Problema | Corrección |
|---|---|---|
| 1 | El singleton arrancaba Chromium en cuanto se importaba el módulo, aunque ninguna fuente lo necesitara. | **Arranque perezoso**: el navegador solo se lanza dentro de `solve()`. |
| 2 | Al convertir la importación del stealth a carga dinámica se pasó la **función** en vez de invocarla; `playwright-extra` la rechazaba con `Plugin is not derived from PuppeteerExtraPlugin` y **todas las evasiones quedaban desactivadas en silencio**. | Se invoca la fábrica antes de `chromium.use(...)`; el aviso desaparece. |
| 3 | N peticiones bloqueadas del mismo host abrían N contextos de navegador a la vez. | **Single-flight** por host: la primera resuelve y el resto espera su resultado. |
| 4 | No había caché de sesiones: cada 403 volvía a abrir el navegador aunque ya se tuviera una `cf_clearance` válida. | Caché con **TTL** (`CF_CLEARANCE_TTL_MS`, 30 min por defecto) y **LRU de 48 hosts**; una sesión con clearance corta el `solve()` en 0 ms. |
| 5 | Una clearance rechazada por el servidor se seguía reintentando durante todo su TTL. | `invalidateSession()` al recibir 403/503 con sesión de caché + `force: true` en la segunda escalada. |
| 6 | Sin límite de contextos concurrentes → agotamiento de RAM con varios crawlers a la vez. | **Semáforo** de contextos (`MAX_CONCURRENT_CONTEXTS`). |
| 7 | El navegador nunca se cerraba. | Cierre por inactividad (`CF_BROWSER_IDLE_CLOSE_MS`, 90 s) y `shutdown()` idempotente. |
| 8 | Al terminar, un Chromium huérfano podía dejar el proceso colgado. | `installCloudflareTeardownHooks()`: SIGINT / SIGTERM / `beforeExit` → `shutdown()`; `src/index.ts` lo instala y llama en `.finally()`. |
| 9 | Se devolvía un User-Agent fijo que no coincidía con el fingerprint del contexto real. Cloudflare vincula `cf_clearance` a UA + IP, así que la cookie **no servía** al reutilizarla por HTTP. | Se **cosecha el UA real** de la página (`page.evaluate(() => navigator.userAgent)`) y se devuelve junto con las cookies y `Accept-Language`. |
| 10 | El fallback de Wolf abría su propio navegador, duplicando Chromium en el mismo proceso. | `withPage()` público: **un único Chromium compartido** por proceso. |
| 11 | Sin Chromium instalado, el fallo era un stack críptico de Playwright. | Error accionable: ``Chromium is not installed, cannot solve <host>. Run `npx playwright install --with-deps chromium` ``. |

Se conserva el límite ético existente: **no se automatizan CAPTCHAs interactivos ni
logins**; únicamente se espera a que el navegador supere el reto gestionado/Turnstile.

## 2. Transporte HTTP (`src/utils/http.ts`)

| # | Problema | Corrección |
|---|---|---|
| 1 | `Sec-CH-UA*` fijos que contradecían al User-Agent elegido → firma de bot. | `deriveClientHints()` los deriva del UA real (Chrome/Edge/macOS/Firefox=`null`). |
| 2 | `Accept-Encoding: zstd` anunciado en perfiles que no lo soportan. | Se omite. |
| 3 | Las respuestas binarias (`.torrent`, `arraybuffer`) se escaneaban buscando marcadores de reto haciendo `.includes()` sobre un Buffer. | `isScannable()`: solo se inspeccionan cuerpos de texto. |
| 4 | El backoff ignoraba `Retry-After` y martilleaba un 429. | Se respeta `Retry-After` (segundos y fecha HTTP). |
| 5 | Tras un bypass, el HTML resuelto se descartaba y se volvía a pedir la URL por HTTP. | `buildBypassResponse()` sirve el HTML resuelto como respuesta de la petición original cuando la URL coincide. |
| 6 | El reintento posterior al bypass salía **sin** las cookies ni el UA cosechados → 403 otra vez → bucle hasta agotar reintentos. | La sesión resuelta se **replaya** en el reintento (cookies + UA + `Accept-Language`). |
| 7 | Se rotaba el perfil de UA en cada reintento, rompiendo la coherencia cookie/UA. | `pickFreshProfile()` solo rota cuando no hay sesión vinculada. |
| 8 | Las banderas `maxRetries: 0` / `autoSolveCloudflare: false` de las sondas no se respetaban en todos los caminos. | Se respetan en todas las ramas (incluido el de error de red). |

## 3. Resolución de espejos (`src/crawlers/mirrors.ts`)

- **Sondado *hedged***: se lanza el candidato N+1 a los `MIRROR_PROBE_STAGGER_MS`
  (700 ms) sin esperar a que termine el N. Un pool de dominios muertos pasaba de
  `candidatos × timeout` a aproximadamente **un timeout**. Gana el índice de
  prioridad más bajo que responda, no el más rápido.
- Las sondas piden `maxRetries: 0` y `autoSolveCloudflare: false`; antes una sola
  sonda podía reintentar 3 veces con backoff y hasta abrir Chromium.
- `looksLikeBlockedPage()` ampliado con más marcas de WAF, dominios aparcados,
  muros de consentimiento y páginas que exigen JavaScript.
- `cancellableDelay()` respeta el `AbortSignal` (antes la pausa de cortesía era
  ininterrumpible y se comía el presupuesto de tiempo).
- El error de resolución enumera **cada candidato y su motivo**.

## 4. Kit compartido

- **`describeError()` centralizado en `support.ts`**: existían **14 copias idénticas**
  (`formatError` en 9 ficheros, `describe` en 6 y `describeError` en `mirrors.ts`) que
  ya empezaban a divergir. La versión común añade manejo de throwables que no son
  `Error` (`{ message }`, anidados, `null`) para que los logs no digan `[object Object]`.
- `support.ts` → `mapWithConcurrency` usa `allSettled` y marca `aborted` en el
  primer error: deja de repartir trabajo pero **nunca abandona un worker en vuelo**
  (antes una excepción podía colgar el pool para siempre). `politePause` cachea la
  lectura de `process.env`. `buildTorrentRecord` canonicaliza los tags de idioma y
  valida numéricos (seeders/leechers negativos o `NaN` → `null`; `size_bytes <= 0` → `null`).
- `language.ts` → `canonicalAudioTag()` / `canonicalSubtitleTag()`: **un idioma = un
  tag**. Antes `Spanish`, `ES` y `Español` podían convivir en el mismo registro.
- `base.ts` → `BlockedPageError`, `withBrowserPage()` (Chromium compartido),
  `close()` por crawler y `fetchHtml(..., { rejectBlocked })`.
- `index.ts` → hooks de cierre, `crawler.close()` en `finally`,
  `CloudflareBypassEngine.shutdown()` en `.finally()`, tiempo de pared total y
  resumen `Failed sources (N): ...`.
- `supabase.ts` → `pruneUndefined`, rescate fila a fila ante `23505`, concurrencia
  acotada (8), división del payload ante `413`/`54000` y lista explícita de códigos
  reintentables. **Corrección crítica:** los contadores desconocidos se **omiten**
  del payload; antes se escribía `0` y el `UPDATE` **sobrescribía** con ceros los
  seeders/leechers reales ya guardados.

## 5. Adaptadores

| Fuente | Correcciones |
|---|---|
| `wolftorrent` | Fallback de navegador sobre el Chromium compartido, tope por ejecución (`WOLFTORRENT_BROWSER_MAX`), cierre del navegador garantizado, `close()` y reinicio del presupuesto por ejecución. Los `blob:` no se guardan como URL pública. |
| `eztv` | **Paginación rota:** `/home` y `/page_1` son el mismo listado, y el código volvía a leer `/page_1` en vez de avanzar. Ahora se pide `/page_${N+1}` desde el índice 1. Temporada/episodio de la API por delante de la heurística del título; los especiales sobreviven. |
| `torrentgalaxy` | `page=0` devuelve vacío en espejos 1-based, lo que abortaba **todo** el endpoint. La página 0 usa el endpoint desnudo y las siguientes `?page=N`. `Referer` en los listados. |
| `leech1337x` | `continue` → `break` cuando una página solo aporta duplicados (antes agotaba todas las páginas). Regex de tamaño acepta `GiB`/`MiB`/`bytes`. `crawlDetail(row, mirror)` con `Referer`. Recuperación del infohash en hex desde el HTML crudo + métrica `hashRecovered`. |
| `thepiratebay` | Se ignora el dominio aparcado como `baseUrl` de origen; solo categorías de vídeo; resultados centinela descartados. |
| `yts` | Las URLs relativas de descarga se guardan **absolutas** (antes quedaban inservibles fuera del mirror). Audio por idioma nativo; el francés ya no se etiqueta como inglés. |
| `nyaa` | La categoría se lee del `title` del icono (`Live Action` → película): una búsqueda `c=0_0` ya no archiva todo como anime. MultiSubs se conserva como evidencia de **subtítulos**, nunca como audio español. Tamaños MiB/GiB. |
| `limetorrent` | La columna de tamaño se localiza por contenido, para que la antigüedad no desplace seeders/leechers; feeds de categorías mixtas ya no se fuerzan a `movie`; búsqueda POST con fallback GET; `politePause` en vez de `sleep` fijo. |
| `pelispanda` | Los valores falsy de subtítulos (`0`, `""`, `"no"`) ya no se leen como "tiene subtítulos". |
| `mejortorrent` | `isMejortorrentDownload()` restringe las descargas al origen del sitio o a literales `magnet:`/`.torrent` (antes se podía seguir cualquier enlace de la ficha). |
| `elitetorrent` | Se eliminó un bloque de fallback de idioma **muerto** (`detectLanguages` ya aplica el default de `ES_TRACKERS`) y se sustituyó por una sobrescritura explícita de `idioma`. Acortador Base64/ROT13, magnets hex/Base32, `.torrent` relativas con query. |
| `html-catalog` | `pageNumberIn()` devuelve `null` en la raíz y los llamadores aplican el default correcto (antes la página 1 se confundía con "sin número" y se repetía). `Referer` del sitio en los listados. Deduplicación de fichas que ya no oculta páginas. |
| `dontorrent` | Sin cambios de comportamiento: se mantiene el rechazo explícito del reto *proof-of-work* y del límite horario. Los enlaces protegidos se cuentan como `gated` y, si una ejecución no obtiene ningún infohash, el crawler **falla explicando el motivo**. |
| `sinsitio` | Decodificación de `ddlUrl.php?url=<Base64>` sin ejecutar scripts; solo adjuntos HTTP(S) del mismo origen. |
| `registry.ts` | Eliminado el alias `DivxTotalCrawler`, código muerto que heredaba `name = 'thepiratebay'` y contaminaba métricas y dedup. |
| `regex.ts` | Un año tras un guion (`Show-2019`) ya no se interpreta como episodio absoluto, y tampoco marca el título como anime. Un hint de película no puede ocultar una release episódica. `normalizeSource()` en vez de mayúsculas literales. |

## 6. CI (`.github/workflows/main.yml`)

- **Bug corregido:** `npx playwright install --with-deps chromium` se saltaba cuando
  la caché acertaba, pero la caché solo guarda `~/.cache/ms-playwright`: los paquetes
  apt **no** se restauran. En un runner con caché caliente el Chromium restaurado
  arrancaba sin `libnss3`/`libatk` y **todos los bypass fallaban**. Ahora
  `install-deps` se ejecuta siempre y la descarga del binario por separado.
- `actions/setup-node` con `cache: npm`; clave de caché sobre `package-lock.json`
  (antes usaba `package.json`, que no cambia al actualizar dependencias).
- Paso `npm run lint` explícito antes del build.
- Variables de cortesía y presupuesto en el paso de crawl:
  `MIRROR_PROBE_STAGGER_MS=700`, `CRAWLER_REQUEST_DELAY_MS=150`,
  `CRAWLER_TIME_BUDGET_MS=420000` (un espejo lento ya no puede comerse los 60 min).

## 7. Nuevas variables de entorno

Documentadas en `.env.example` y en el README:

| Variable | Predeterminado | Uso |
|---|---|---|
| `MIRROR_PROBE_STAGGER_MS` | `700` | Retardo *hedged* entre candidatos de espejo; `0` = secuencial estricto. |
| `CF_CLEARANCE_TTL_MS` | `1800000` | Vida útil local de una sesión `cf_clearance`. |
| `CF_BROWSER_IDLE_CLOSE_MS` | `90000` | Inactividad tras la que se cierra el Chromium compartido. |
| `WOLFTORRENT_BROWSER_MAX` | `25` | Tope de fichas resueltas con navegador por ejecución. |

## 8. Pruebas añadidas (`tests/hardening.test.js`, 32)

Anti-Cloudflare: corto-circuito de sesión cacheada (0 ms, sin navegador), expiradas
descartadas, caché acotada ≤ 48, `invalidateSession`, `solve(force:true)` no reutiliza
caché. HTTP: client hints derivados, sin `zstd`, replay de cookies+UA tras bypass, HTML
resuelto servido sin segunda petición, banderas de sonda, binarios no escaneados,
`Retry-After` en 429. Kit: `describeError` con throwables no-`Error` y circulares. Espejos: sondado hedged con victoria del índice más bajo, banderas
de sonda, más marcadores WAF/aparcado. Kit: canonicalización de tags, validación de
numéricos, `mapWithConcurrency` deja de repartir sin huérfanos. Regex: año tras guion,
hint de película. EZTV `/page_2`, YTS absolutas, TPB no aparcado, LimeTorrents mixto,
Nyaa MultiSubs, Pelispanda falsy, MejorTorrent filtro de descarga, `pageNumberIn`,
Supabase omite `null`, VOSE como subtítulo.

## 9. Límites reconocidos

- **Sin salida de red en el entorno de trabajo**: no se ha verificado extracción en
  vivo, disponibilidad de mirrors ni UPSERT real. Ejecuta primero
  `DRY_RUN=true TARGET_CRAWLERS=dontorrent MAX_PAGES=1 npm start` desde tu runner.
- El camino real de `solve()` con Chromium requiere una comprobación en vivo; lo
  probado offline es la caché, el single-flight, el teardown y el fallo accionable.
- No se automatizan CAPTCHAs interactivos, logins ni el botón PoW de DonTorrent. Los
  enlaces que solo se obtienen así siguen sin extraerse.
- Los mirrors cambian; la lista es configuración, no una garantía.
