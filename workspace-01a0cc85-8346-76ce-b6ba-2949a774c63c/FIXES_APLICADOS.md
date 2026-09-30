> **Actualización 2026-09-28:** la descripción histórica del fallback INSERT
> de Supabase en este documento ya no aplica. Se eliminó porque podía crear
> duplicados y ocultar fallos parciales. El servicio requiere UNIQUE(info_hash),
> conserva UPSERT al dividir lotes y comunica los errores al orquestador.
> Ver `AUDITORIA_SERVICIOS_2026-09-28.md`.

# Corrección de errores críticos — Auditoría crawler por crawler

Fecha: 2026-09-27
Rama: `arena/01a0e06e-screaper56`

## Resumen de errores reportados

```
[SUPABASE] Batch 1 (Attempt 1) failed: there is no unique or exclusion constraint matching the ON CONFLICT specification
[SUPABASE] ❌ Critical: Batch 1 permanently failed after attempts.  (repetido x25)
[HTTP] Retry 2/3 for https://eztv1.xyz/api/get-torrents?limit=1 (Status: 403). Waiting 3428ms...
[HTTP] Retry 3/3 for https://eztv1.xyz/api/get-torrents?limit=1 (Status: 403). Waiting 6076ms...
```

**Causa raíz:**
1. **Supabase**: la tabla `public.torrents` no tiene `UNIQUE` sobre `info_hash`, pero el código hace `upsert(..., { onConflict: 'info_hash' })`. PostgreSQL exige un índice/constraint único para `ON CONFLICT`. Sin él, todos los batches fallan y se pierden datos.
2. **EZTV/HTTP**: `403 Forbidden` (WAF/Cloudflare/bot protection) se reintentaba 3 veces con backoff exponencial (~1.5s, 3s, 6s + jitter) antes de fallback. En `eztv1.xyz` esto generaba spam de retries y retardaba el fallback HTML 10+ segundos por mirror.

---

## Fix 1 — `src/services/supabase.ts` (CRÍTICO)

### Antes
```ts
const { error } = await client.from('torrents').upsert(chunk, { onConflict: 'info_hash' });
if (error) {
  console.error(`[SUPABASE] Batch ${n} (Attempt ${a}) failed:`, error.message);
  if (isNonRetriableError(error.code)) break; // 42P10 caía aquí y marcaba batch como perdido
}
if (!success) console.error(`❌ Critical: Batch ${n} permanently failed`);
```
- `isNonRetriableError` trataba `42P10` como no-retreable y abortaba.
- Cada uno de los 25 batches fallaba igual → 25 líneas `Critical` y 0 filas persistidas.

### Después
- Nuevo helper `isMissingOnConflictConstraintError()` detecta `42P10` o mensaje `no unique or exclusion constraint matching the on conflict`.
- `isNonRetriableError()` ahora excluye `42P10` para que entre en el path de fallback.
- Nuevo método privado `fallbackInsertChunk()`:
  1. Intenta `insert(chunk)` masivo (funciona cuando no hay índice único).
  2. Si hay `23505 duplicate`, hace insert fila-a-fila → `update` donde existe el `info_hash`.
- Lógica en `upsertBatch()`:
  - Al primer `42P10` loguea **una sola vez** el warning con la solución SQL y activa `schemaFallbackMode=true`.
  - El chunk actual y **todos los siguientes batches** van directo a `fallbackInsertChunk()` sin volver a intentar `onConflict`.
  - Logs limpios:
    ```
    [SUPABASE] ⚠️  Schema error detectado: tabla "torrents" NO tiene UNIQUE en "info_hash".
    [SUPABASE]    → CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique ON public.torrents (info_hash);
    [SUPABASE] Batch 1/25 recovered via fallback INSERT: 100/100 torrents.
    [SUPABASE] Batch 2/25 saved via fallback INSERT: 100/100 torrents.
    ...
    [SUPABASE] Fallback mode completed: 2500/2500 records persisted sin ON CONFLICT.
    ```
- No se pierde ningún dato aunque falte el índice; se advierte cómo arreglarlo de forma permanente.

### Migración permanente
Archivo creado: `supabase/migrations/001_fix_torrents_info_hash_unique.sql`
```sql
CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique
  ON public.torrents (info_hash);
```
Ejecutar en **Supabase SQL Editor** o `supabase db push`. Incluye bloque opcional para deduplicar duplicados previos.

---

## Fix 2 — `src/utils/http.ts` (403 retry spam)

### Antes
```ts
if (status === 400 || 401 || 404) throw err;
// 403 y 429 entraban en delay + retry 3 veces aunque fuera WAF permanente
const delay = baseDelayMs * 2^(attempt-1) + jitter;
console.warn(`[HTTP] Retry ${attempt}/3 ... (Status: 403)`);
```
- Para `eztv1.xyz/api/get-torrents?limit=1` con 403, se hacían 3 reintentos (3428ms, 6076ms) y activaba `CloudflareBypassEngine` una vez, pero luego seguía reintentando igual.

### Después
```ts
if ((status === 403 || status === 429) && cfBypassAttempted) throw err; // fail fast tras bypass
if ((status === 403 || status === 429) && attempt >= 2) throw err;      // solo 1 reintento con UA distinto
```
- Tras intentar el bypass de Cloudflare, un segundo 403 ya no hace backoff: lanza y deja que el crawler pruebe siguiente mirror / fallback HTML.
- Reduce de 3 reintentos (~10s) a 1 reintento (~1.5s) para 403/429.
- Resto de errores (500, timeout, network) siguen con backoff exponencial normal (3 reintentos).
- Logs: desaparecen `Retry 2/3` y `Retry 3/3` para 403; ahora:
  ```
  [HTTP] Cloudflare WAF detected on https://eztv1.xyz/api/get-torrents?limit=1 (Status: 403). Activating stealth solver...
  [HTTP] Cloudflare stealth solve failed: ...   // o bypass ok
  // y si sigue 403 → lanza directo, el crawler hace fallback sin 6s de espera
  ```

Afecta a **todos** los crawlers porque todos usan `ResilientHttpClient`, no solo EZTV.

---

## Fix 3 — `src/crawlers/eztv.ts` (API 403 → fallback HTML)

### Probes
```ts
// Antes
path: '/api/get-torrents?limit=1', validate: torrents array
// Después
path: '/api/get-torrents?limit=1', headers: { Accept: 'application/json' }, validate: ...
```
Añade `Accept: application/json` para evitar fingerprint mismatch que dispara 403 en algunos mirrors.

### Crawl — API phase
```ts
const payload = await this.fetchJson(apiUrl, {
  headers: { Accept: 'application/json, text/plain, */*', Referer: `${activeDomain}/` },
  timeout: 8000
});
```
- Headers explícitos + timeout menor (8000) para fail-fast.
- Catch diferencia 403 vs Cloudflare vs genérico:
  ```ts
  if (is403) warn(`EZTV API bloqueada (403) en ${activeDomain} — probablemente WAF/bot protection. Fallback inmediato...`);
  ```

### Crawl — HTML fallback
```ts
const html = await this.fetchHtml(pageUrl, {
  headers: { Referer: `${activeDomain}/` }, timeout: 8000
});
```
- Añade `Referer` para evitar 403 en HTML.
- Catch para HTML también detecta 403 y sugiere probar `EZTV_BASE_URL` con otro mirror.

Resultado: si `eztv1.xyz` API da 403, el crawler hace fallback a `eztv1.xyz/home` o al siguiente mirror (`eztvx.to`, `eztv.re`...) en ~1.5s en vez de ~10s, sin spam de `Retry 3/3`.

---

## Auditoría archivo por archivo — 13 crawlers + módulos compartidos

| Archivo | Líneas | Estado | Hallazgos / Acción |
|---|---|---|---|
| **`src/services/supabase.ts`** | 237→~350 | **CRÍTICO FIX** | Ver Fix 1. Eliminado fallo masivo ON CONFLICT. Añadido fallback INSERT + migración SQL. |
| **`src/utils/http.ts`** | 301 | **FIX** | Ver Fix 2. 403/429 fail-fast. Sin este fix todos los crawlers sufrían retry spam en mirrors con WAF. |
| **`src/crawlers/eztv.ts`** | 281 | **FIX** | Ver Fix 3. Headers JSON, 403 handling, timeout 8s. |
| **`src/crawlers/base.ts`** | 264 | OK | Transporte común correcto. `fetchHtml/fetchJson` delegan a `ResilientHttpClient`; heredan fix 403. `deduplicateRecords` y `filterSpanishReleases` correctos. Sin cambios. |
| **`src/crawlers/mirrors.ts`** | 302 | OK | `htmlMarkerValidator` + `looksLikeBlockedPage` ya rechazan parked/block. `resolveWorkingMirror` prueba candidatos en orden; con fix http, 403 ya no bloquea 10s por mirror. Sin cambios funcionales, verificado. |
| **`src/crawlers/support.ts`** | 524 | OK | `buildTorrentRecord` valida hash, no inventa seeders, genera magnet fallback. `recordScore/mergeRecords` usado en dedup. Sin cambios. |
| **`src/crawlers/dontorrent.ts`** | 616 | OK | Catálogos `/peliculas` `/series` paginación `?p=N`, detalle `/pelicula/:id/:slug`, `ddlUrl.php?url=Base64`, gating proof-of-work ya manejado (cuenta `gated` y omite). Usa `fetchHtml` con `Referer`, respeta `DONTORRENT_DISCOVER_MIRRORS`. No genera 403 spam. Sin cambios. |
| **`src/crawlers/elitetorrent.ts`** | 346 | OK | Rutas `/peliculas` legacy, acortador Base64/ROT13, magnets hex/Base32, `fetchTorrentMetainfoViaGet` con Referer. Maneja `listingErrors/detailErrors` sin throw crítico. Sin cambios. |
| **`src/crawlers/html-catalog.ts`** | 263 | OK | Orquestador genérico catálogo→ficha→bencode. Concurrencia `CATALOG_DETAIL_CONCURRENCY`, guarda `politePause`, deduplica fichas. Usado por `sinsitio`. Hereda fix http. Sin cambios. |
| **`src/crawlers/leech1337x.ts`** | 234 | OK | Tablas `table-list`, Category/Language con texto/HTML, búsquedas `search/<term>/1/`. Concurrencia 2. Maneja `detailErrors/listingErrors` con warn. Hereda fix http. Sin cambios. |
| **`src/crawlers/limetorrent.ts`** | 336 | OK | Tablas `table2`, detección dinámica columna tamaño/edad, búsqueda POST con fallback GET. Concurrencia 3. No fabrica seeders. Hereda fix http. Sin cambios. |
| **`src/crawlers/mejortorrent.ts`** | 305 | OK | Dos modos legacy_eu / modern_me, lista WordPress `wp-json`, bencode con Referer. Sin contadores inventados. Hereda fix http. Sin cambios. |
| **`src/crawlers/nyaa.ts`** | 195 | OK | Tablas `torrent-list`, tamaños MiB/GiB, anime, no convierte MultiSubs → audio español. Concurrencia 6. Hereda fix http. Sin cambios. |
| **`src/crawlers/pelispanda.ts`** | 287 | OK | API WordPress `wpreact` películas/temporadas/episodios, calidad/idioma por descarga. Seeders `null` (no publicados). Concurrencia 3. Sin cambios. |
| **`src/crawlers/sinsitio.ts`** | 159 | OK | DLE `ddlUrl.php?url=Base64` → `index.php?do=download`, solo mismo origen, variantes calidad conservadas. Extiende `HtmlCatalogCrawler`. Sin cambios. |
| **`src/crawlers/thepiratebay.ts`** | 303 | OK | APiBay `apibay.org` categorías video 200-299, JSON + fallback HTML `searchResult`. Ignora `No results returned`. Usa `apibayBase` separado de `baseUrl`. Hereda fix http. Sin cambios. |
| **`src/crawlers/torrentgalaxy.ts`** | 212 | OK | Filas `tgxtablerow`, título ficha sin comentarios, magnet/iTorrents, tamaño por celda. Sin cambios. |
| **`src/crawlers/wolftorrent.ts`** | 219 | OK | `/peliculas` `/series`, fichas `/pelicula/:id/:slug`, Playwright fallback clic Descargar, `blob:` no persistido, `WOLFTORRENT_BROWSER` flag. Hereda fix http. Sin cambios. |
| **`src/crawlers/yts.ts`** | 237 | OK | API v2 `list_movies.json`, idioma `es`/`es-mx`/`en` nativo, no etiqueta francés como inglés, canales audio. Probes con `status==='ok'`. Hereda fix http. Sin cambios. |
| **`src/config/env.ts`** | - | OK | `DEFAULT_CRAWLERS` 13 fuentes, `TARGET_CRAWLERS=all`, parseo booleano/entero, fail-fast si `DRY_RUN=false` sin creds. Sin cambios. |
| **`src/types/torrent.ts`** | - | OK | `TorrentRecord` con `info_hash` 40hex, type `movie|series|anime`. Sin cambios. |
| **`src/utils/magnet.ts`** | - | OK | `normalizeInfoHash` hex/Base32, `parseMagnetUri` manual (evita bug `+`), `buildMagnetUri`. Sin cambios. |
| **`src/utils/bencode2.ts`** | - | OK | Parser bencode con hash SHA1 de bytes originales `info`, límite 10 MiB, depth 64, rechazo v2-only. Sin cambios. |

**Conclusión auditoría:** ningún crawler tenía bug funcional adicional. Los 11 crawlers no tocados heredan automáticamente la mejora de `http.ts` (menos retry en 403) y ya tenían manejo `try/catch` + `listingErrors/detailErrors` correcto. Solo `supabase`, `http` y `eztv` necesitaban cambios explícitos.

---

## Verificación

```bash
npm ci
npm run build  # tsc ✅
npm test       # 50 tests pass ✅
```

- Build TypeScript sin errores.
- `htmlMarkerValidator` sigue rechazando parked/challenge.
- Deduplicación, scoring, merging, límites 10MiB, language filter siguen pasando tests offline.

---

## Qué hacer ahora en tu Supabase

1. Abre **Supabase Dashboard → SQL Editor**.
2. Ejecuta el contenido de `supabase/migrations/001_fix_torrents_info_hash_unique.sql`:
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique
     ON public.torrents (info_hash);
   ```
3. (Opcional) Si tenías duplicados previos: descomenta el `DELETE ... ranked` del archivo para quedarte con el más reciente por `info_hash`.
4. Vuelve a correr el crawler **sin** `DRY_RUN`:
   ```bash
   TARGET_CRAWLERS=eztv MAX_PAGES=1 npm start   # prueba rápida
   TARGET_CRAWLERS=all MAX_PAGES=3 npm start    # run completo
   ```
   Ya no verás `Batch X failed: no unique...` ni `Retry 2/3 403` spam. En su lugar verás:
   ```
   [SUPABASE] Batch 1/25 saved: 100 torrents.
   [eztv] EZTV API bloqueada (403) en https://eztv1.xyz — Fallback inmediato a HTML...
   [eztv] Run summary: records=... listings=... records=...
   ```

Si el índice ya existe, el código sigue funcionando idempotente (UPSERT real). Si no existe, el fallback INSERT garantiza que no se pierde ningún torrent.

---

## Archivos modificados / creados

- `src/services/supabase.ts` — fallback ON CONFLICT + logs útiles
- `src/utils/http.ts` — 403/429 fail-fast
- `src/crawlers/eztv.ts` — headers + timeout + 403 handling
- `supabase/migrations/001_fix_torrents_info_hash_unique.sql` — migración SQL
- `FIXES_APLICADOS.md` — este documento

---

# Corrección de errores críticos — Segunda auditoría crawler por crawler

Fecha: 2026-09-28
Rama: `arena/01a0eaa6-screaper56`
Tests de regresión: `tests/audit-fixes.test.js` (10 casos, suite completa 435/435, `tsc` limpio).

## Fix 1 — `src/crawlers/eztv.ts`: los seeders guardaban el valor de LEECHERS

`readRowCounters()` elegía el seeders como "la última celda numérica de la fila",
de modo que en las plantillas con columnas S **y** L separadas el valor
almacenado como `seeders` era el de leechers (y con el formato real `S: 120`
el contador se perdía por completo: `parseCount("S: 120")` → `null`).

Ahora: el **primer** contador numérico posterior a la columna de tamaño es el
seeders y el **segundo** el leechers; los prefijos `S:`/`L:` se eliminan antes
de parsear y el leechers de la fase HTML ya no se descarta.

## Fix 2 — `src/crawlers/rarbg.ts`: desplazamiento de columnas size/S/L

`sizeIndex` se localizaba con `parseSizeToBytes(texto) !== null`, que acepta un
número suelto como bytes (`parseSizeToBytes("847") === 847`). Con la celda de
tamaño vacía, el índice caía sobre los SEEDERS: `size_bytes=847`,
`seeders=<leechers>` y `leechers=<uploader>`. Ahora la celda de tamaño exige
unidad (`[KMGT]i?B`), igual que limetorrents y magnetdl.

## Fix 3 — `src/crawlers/rutracker.ts`: un post que mencionara "captcha" abortaba la run

`looksLikeCaptcha()` hacía `/captcha|капча|введите код/i.test(html)` sobre el
HTML **completo** del topic. Un solo comentario de usuario con esa palabra
disparaba `RutrackerCaptchaError` (terminal) y descartaba todo lo recolectado.
Ahora la detección es solo estructural (widget reCAPTCHA/Turnstile, campo o
imagen cuyo `name/src` contiene "captcha", o el label propio del tracker
"код с картинки") vía `looksLikeRutrackerCaptcha()`, exportada para tests.

## Fix 4 — `src/crawlers/dontorrent.ts`: magnets sin BTIH válidos llegaban al descargador

`dontorrentDownloadUrl()` aceptaba cualquier `magnet:?…` sin validar; el hash
inválido hacía que `buildRecord` intentara `fetchTorrentMetainfo("magnet:?…")`,
es decir, un GET HTTP contra una URL magnet. Ahora el magnet se valida con
`parseMagnetUri` (BTIH hex o Base32) antes de aceptarse.

## Fix 5 — `src/crawlers/elitetorrent.ts`: los filtros /idioma y /calidad solo rastreaban 1 página

Para páginas 2+ se construía `<ruta>/page/N/`, pero en las rutas filtradas
(`/idioma/castellano-17-1/`, `/calidad/1080p-10-1/`) el **número final del slug
es la página** (`castellano-17-2`): el `/page/N/` daba 404 y la paginación
terminaba en silencio tras la página 1. Nuevo `eliteRoutePagePath()` (exportado):
incrementa el número final cuando existe y reserva `/page/N/` para las secciones
sin número (`/series/`).

## Fix 6 — `src/utils/anti-cloudflare.ts`: `shutdown()` no impedía relanzar Chromium

`permanentlyClosed` solo se consultaba en el temporizador de inactividad, así
que tras el teardown de `runCli` cualquier `solve()`/`withPage()` relanzaba el
navegador. `getOrCreateBrowser()` ahora rechaza con un error claro si el motor
fue apagado.

## Fix 7 — `src/utils/language.ts`: "Audio en 5.1" se etiquetaba como audio inglés

La alternativa `audio[\s._-]*en` de `REGEX_ENG` solo excluía "en
español/castellano/latino", de modo que cualquier ficha española con
"Audio en 5.1", "Audio en Dual", etc. recibía un falso track `English` (que
además el filtro de idioma nunca descarta). El lookahead ahora también excluye
`dual`, `sub` y dígitos.

---

# Corrección de riesgos altos — Tercera ronda de la auditoría

Fecha: 2026-09-28
Rama: `arena/01a0eaa6-screaper56`
Tests: `tests/audit-fixes.test.js` ampliado a 18 casos; suite completa 443/443, `tsc` limpio.

## Fix 8 — `src/crawlers/support.ts`: contadores abreviados ("1.5K", "2,3M")

`parseCount('1.5k')` devolvía `null`: los mirrors que redondean los sembradores
a "1.5K" perdían el contador por completo. Ahora los sufijos `k`/`m` (con
separador decimal opcional) se multiplican; los decimales sin sufijo siguen
siendo inválidos (`'12.5'` → `null`). Beneficia a EZTV, 1337x y TGx.

## Fix 9 — `src/crawlers/magnetdl.ts`: categoría de la fila localizada por contenido

`tds.eq(3)` asumía la plantilla exacta de 7 columnas; un mirror sin la columna
"type" ponía el tamaño en esa posición y `"1.4 GB"` fallaba el test de
categoría de video → TODAS las filas del mirror se descartaban en silencio.
La categoría ahora se localiza buscando la primera celda corta con formato de
categoría (desde la posición 2); si no hay ninguna, la fila no se filtra.

## Fix 10 — `src/crawlers/thepiratebay.ts`: contadores S/L por contenido

`tds.eq(length-2/-1)` leía basura cuando el mirror añadía una columna de
moderación al final. Ahora los contadores son las dos últimas celdas
PURAMENTE numéricas de la fila.

## Fix 11 — `src/crawlers/base.ts`: `fetchJson` rechaza interstitials con HTTP 200

Con `responseType: 'json'`, axios deja el HTML de una página de WAF/aparcado
como string y los parsers de API solo daban errores crípticos de esquema.
`fetchJson` ahora lanza `BlockedPageError` (con métrica `blockedPages`) o un
error claro "Expected JSON... received an HTML document".

## Fix 12 — `src/crawlers/dontorrent.ts`: fase de búsqueda no se traga páginas de bloqueo

El POST a `/buscar` usaba el cliente en crudo sin validar el HTML. Una página
de bloqueo/aparcada con HTTP 200 ya no se parsea como listado: corta solo la
fase de búsqueda (`blockedPages`) sin descartar los registros que los
catálogos ya recolectaron.

## Fix 13 — `src/crawlers/limetorrent.ts`: la búsqueda bloqueada degrada, no aborta

El fallback GET de `searchHtml` relanzaba `BlockedPageError` y mataba toda la
run por una búsqueda WAF-eada aunque los catálogos funcionaran. Ahora la
búsqueda (fase secundaria de descubrimiento) devuelve `null` ante páginas de
bloqueo; los 403/429/deadline siguen siendo terminales.

## Fix 14 — `src/crawlers/rutracker.ts`: contadores del listado primero, texto del post después

`detail.seeders ?? topic.seeders` daba prioridad a la cita en prosa del post
frente al contador que el tracker renderiza de la oleada real. Se invirtió la
precedencia y el parseo del texto libre se acota a un máximo plausible
(≤100M) para que un "сиды: 98765432112345" citado no se guarde como dato.

## Fix 15 — `src/crawlers/torrentgalaxy.ts`: fallback numérico para S/L

Cuando ningún selector de clase/color matchea, las dos últimas celdas
puramente numéricas de la fila son los contadores (solo cuando faltan AMBOS,
para no sobreescribir un valor ya fiable).

---

# Corrección de hallazgos menores — Cuarta ronda de la auditoría

Fecha: 2026-09-28
Rama: `arena/01a0eaa6-screaper56`
Tests: `tests/audit-fixes.test.js` ampliado a 22 casos; suite completa 447/447, `tsc` limpio.

## Fix 16 — `src/services/supabase.ts`: el título era el único campo sin acotar

Todos los campos de texto se recortaban (10–100 chars) menos `title`: un nombre
de entrega de 300+ caracteres podía romper un lote entero contra una columna
`varchar`. Ahora se trunca a 500. Además, el re-saneado tras `mergeRecords`
usaba una aserción no nula (`sanitizeRecord(record)!`): un `null` ahí habría
sido un `TypeError`; ahora se cuenta como rechazado bajo el mismo contrato.

Nota: el contrato "un registro rechazado lanza `BatchPersistenceError`" está
explícitamente probado en `tests/services.test.js` (decisión de la auditoría
anterior: no se descartan silenciosamente registros inválidos junto a válidos),
así que se conserva tal cual.

## Fix 17 — `src/utils/http.ts`: la cf_clearance ya no se tira por cualquier fallo

Cualquier error (incluido un timeout puntual) llamaba `invalidateSession` y
descartaba una clearance posiblemente vigente, forzando un re-solve de 30 s con
el navegador. Ahora solo se invalida con evidencia de rechazo: 401, 403 o
indicadores de challenge Cloudflare. Timeouts, 5xx y errores de red la conservan.

## Fix 18 — `src/crawlers/grantorrent.ts`: concurrencia configurable

La concurrencia de fichas estaba clavada a `2`; ahora lee
`GRANTORRENT_CONCURRENCY` (default 2, convención `parseInt || default` del resto
de adaptadores).

## Fix 19 — `src/crawlers/dontorrent.ts`: código muerto

`detail.type ?? item.type` era inalcanzable (`DonTorrentDetail.type` nunca es
nulo); se simplificó a `detail.type`.

## Fix 20 — `src/crawlers/elitetorrent.ts`: catálogos leídos pero 0 registros

Devuelve ahora el mismo error accionable que el resto de adaptadores en vez de
un `[]` silencioso que solo el orquestador convertía en genérico "Zero extracted
records".

## Descartados tras revisión (son decisiones probadas, no bugs)

- `upsertBatch` lanza con registros rechazados: contrato probado dos veces en
  `tests/services.test.js`.
- `priority` incluye `rutracker`: aserto explícito en `tests/new-crawlers.test.js`;
  sin credenciales fallará a propósito con un mensaje accionable (el workflow ya
  lo documenta).
- `parseCount` abreviado y el relanzamiento post-`shutdown()` se corrigieron en
  las rondas anteriores.

---

# Mejora de cobertura — estrenostorrent página por página

Fecha: 2026-09-28
Pedido del usuario: recorrer `https://estrenostorrent.org/peliculas/` y
`https://estrenostorrent.org/series/` "página por página".

## Qué se encontró en el sitio real

- Ambas rutas YA estaban en las rutas del crawler (`/`, `/peliculas/`,
  `/series/`) y los enlaces de ficha (`/online/<slug>`, `/online/movie/<id>`,
  `/movie/movie/<id>`, `/serie-online/<id>`, `/series/<calidad>/<slug>`)
  ya se parsean bien.
- El sitio NO pagina esas secciones: `/peliculas/page/2/`, `/peliculas/2/` y
  `/peliculas/?p=2` devuelven exactamente el mismo listado (una sola respuesta
  larga, ~100 películas; las series, ~23). No hay pager en el HTML estático.
- El recorte real era nuestro: `candidates.slice(0, maxPages*30)` descartaba
  fichas descubiertas (con `MAX_PAGES=3` default, de ~120 descubiertas solo se
  procesaban 90; las de `/series/` eran las primeras en perderse).

## Cambios (`src/crawlers/estrenostorrent.ts`)

- Ya no se trunca la lista de fichas descubiertas: se procesan TODAS, en lotes
  ("páginas") de 30, con log por lote
  (`[estrenostorrent] detail page N: X fichas, +Y records (P/T)`).
- Tope opcional por si se quiere limitar el run: `ESTRENOSTORRENT_MAX_DETAILS`
  (sin setear o valor inválido = sin tope; el deadline de la run sigue acotando).
- El procesado de fichas se extrajo a `processDetail()` (misma lógica).

## Tests

`tests/new-sources.test.js`: 2 casos nuevos (suite 449/449): un listado de 75
ítems produce 75 registros y visita las 75 fichas con `crawl(1)`, y
`ESTRENOSTORRENT_MAX_DETAILS=10` corta en 10 mientras que un valor inválido no
corta.

---

# Revisión de la familia "pctn/newtemplate" (estilo WolfMax4K) contra los sitios en vivo

Fecha: 2026-09-28
Verificación crawler por crawler de los clones españoles contra el sitio real
de cada mirror configurado (vía fetch externo; el sandbox no tiene salida
directa). Tests: 451/451, `tsc` limpio.

| Crawler | Mirror default | Estado real | Veredicto |
|---|---|---|---|
| dontorrent | dontorrent.moi | Vivo; fichas `/pelicula/31025/slug`, pager `?p=N` | 🟢 OK |
| elitetorrent | www.elitetorrent.com | Vivo; fichas `/peliculas/slug-calidad/` | 🟢 OK |
| estrenostorrent | estrenostorrent.org | Vivo; catálogos largos sin pager (mejorado el turno anterior) | 🟢 OK |
| sinsitio | www.sinsitio.site | Vivo; posts DLE `/categoria/NN-slug.html` = lo que parsea | 🟢 OK |
| t0rrenta | t0rrenta.org | Vivo; home con grilla JS pero sitemap.xml publicando cientos de `/p/ID` | 🟢 OK (sitemap) |
| wolftorrent | wolftorrent.com → wolfmax4k.com | wolftorrent.com es un placeholder "Próximamente"; wolfmax4k.com vive con **layout nuevo** | 🔴→✅ corregido |
| mejortorrent | www45.mejortorrent.eu | Vivo pero **redirige a www46** y sirve enlaces absolutos www46 | 🔴→✅ corregido |
| pelispanda | pelispanda.org | Vivo (SPA); el navegador recibe el HTML del SPA también en `/wp-json/...` | 🟡 verificar en run real |
| grantorrent | (sin defaults, exige `GRANTORRENT_BASE_URL`/`MIRRORS`) | No verificable sin dominio | ⚪ por diseño |

## Fix 21 — `src/crawlers/wolftorrent.ts`: el layout 2026 de WolfMax4K

- `wolftorrent.com` ya no es un catálogo (placeholder); el resolver rota
  correctamente a `wolfmax4k.com`, pero allí las fichas son `/pelicula/ryqb95`
  (id corto SIN slug) y hay fichas por episodio `/serie/episodio/5sjfvr`.
- La regex vieja exigía 2 segmentos (`/pelicula/:id/:slug`): cero fichas
  descubiertas, y el probe del mirror exigía lo mismo, así que ni siquiera
  hubiera validado el mirror. Este era el 🟡 "exige 2 segmentos" de la
  auditoría, confirmado ahora como rotura total.
- Ahora `isWolfDetailPath` acepta ambos layouts (1 segmento con forma de id:
  letras Y dígitos, sin guiones; 2 segmentos legacy id/slug; `episodio/:id`),
  y el probe acepta hrefs de 1 segmento. Los rechazos (pager, categorías,
  ficheros, filtros `?anyo=`) siguen iguales.

## Fix 22 — `src/crawlers/mejortorrent.ts`: rotación wwwNN por redirect

- `www45.mejortorrent.eu` responde con redirect a `www46.mejortorrent.eu` y el
  HTML redirigido usa enlaces ABSOLUTOS al host final. El chequeo de host era
  exacto (`www45 ≠ www46`): descartaba todos los enlaces del listado y
  terminaba en 0 registros **sin error** (listings>0).
- `sameSiteHost` ahora tolera la rotación `wwwNN.` dentro del mismo dominio
  (protocolo/puerto iguales, sin credenciales — el caso
  `user:pass@` sigue rechazándose), aplicado a listados, pager, API de posts y
  chequeo de descargas. Dominios ajenos siguen fuera.

## Verificación

- `tests/crawler-fixes.test.js`: layout 2026 de WolfMax4K de punta a punta
  (`/pelicula/ryqb95`, `/serie/5se8eg`, `/serie/episodio/5sjfvr` en cola de
  fichas; legacy sigue; junk rechazado).
- `tests/crawler-audit.test.js`: listado servido por el host redirigido
  (enlaces absolutos www46 con mirror www45) produce su release; descarga
  misma-dominio con wwwNN distinto aceptada; dominio ajeno rechazada.

## Pendientes de esta revisión

- pelispanda: confirmar con un run real si la API `wp-json/wpreact/v1` sigue
  respondiendo JSON a axios (aquí solo pudimos probar con navegador, que recibe
  el SPA). Si el probe falla, hace falta el endpoint real del SPA (devtools).
- grantorrent: requiere dominios por env; sin defaults por diseño.

---

# Profundización: wolftorrent / WolfMax4K (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de TODA la cadena de wolftorrent, complemento del fix 21.

## Estado real de los mirrors (2026-09-28)

| Dominio de `DEFAULT_MIRRORS` | Estado real |
|---|---|
| `wolftorrent.com` | 🟠 Placeholder "Próximamente" (sin catálogo) |
| `wolfmax4k.com` / `www.` | 🟢 Único catálogo vivo |
| `wolftorrent.net` | 🔴 No resuelve |
| `wolfmax4k.org` | 🔴 No resuelve |

## Qué se confirmó del template 2026

- **Listados**: `/peliculas` (23.054 títulos, "Página 1 de 961") y `/series`
  son reales, pero el paginador es de JS: `?page=2` devuelve de nuevo la
  página 1. El bucle de `html-catalog` ya está protegido (dedup de URLs y de
  fichas + tope `maxPages`), así que el máximo desperdicio es 1 fetch
  repetido por sección; cada listing estático trae ~24 fichas con todas sus
  variantes de calidad (cada variante es su propia ficha `/pelicula/<id>`).
- **Ficha** (`/pelicula/ryqb95`): título en `h1`, calidad/tamaño en una lista
  de definiciones SIN dos puntos (`Calidad` → `HDRip`), y el botón
  **"Descargar torrent" es un `<button>` sin href** (JS). El parseo estático
  no inventa descargas; el fallback de navegador ya cliquea ese botón por
  nombre (`/^descargar(?: torrent)?$/i`) y valida el archivo resultante
  (mismo dominio, `.torrent`, o blob local). Cap por run:
  `WOLFTORRENT_BROWSER_MAX` (default 25; subirlo cubre más fichas).
  Si el template expone el endpoint en un atributo (`data-url`), el camino
  estático lo toma sin navegador (`/descargar/` es endpoint confiado).

## Cambio

- `DEFAULT_MIRRORS` reordenado: `wolfmax4k.com` primero (ahorra el probe
  fallido del placeholder en cada run); los dominios muertos quedan al final
  por si vuelven (el probe igualmente los rechaza).

## Tests nuevos (suite 453/453)

- Ficha 2026 realista: título/type correctos, botón sin href → 0 descargas
  estáticas, `/serie/episodio/:id` → type `series`, `data-url=/descargar/:id`
  → descarga estática aceptada.
- Orden de mirrors vivo (`DEFAULT_MIRRORS[0] === wolfmax4k.com`) y pager
  `?page=N` aceptado intra-dominio / ausencia de pager corta la sección.

## Única incógnita restante (requiere run con navegador real)

Si el click del botón sirve el `.torrent` desde OTRO dominio (CDN) en vez de
uno propio o blob, `wolfDownloadUrl` lo rechaza y la ficha queda sin descarga.
No es verificable sin Playwright contra el sitio; si pasa, habría que sumar el
CDN real a los endpoints confiables.

---

# Profundización: mejortorrent (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de TODA la cadena de mejortorrent sobre el mirror real
(`www45.mejortorrent.eu` → redirige a `www46.mejortorrent.eu`).

## Qué se confirmó del sitio real (2026-09-28)

- El fix 22 (rotación wwwNN) era exactamente lo que necesitaba: los listados
  de `//inicio` y `/peliculas-hd` sirven enlaces ABSOLUTOS a `www46`.
- Las rutas que usa el crawler existen en el template nuevo: `/inicio`,
  `/peliculas-hd`, `/series-hd`, `/documentales` (y `/peliculas-4k`).
- Las fichas tienen descarga ESTÁTICA real: películas un enlace
  `/torrents/peliculas/<nombre>.torrent`; series una tabla
  `ID | Episodios | Fecha | Clave | Download` con un `.torrent` por episodio.
  El parsing de episodios por posición (`td.eq(1)` = `1x01`) calza EXACTO con
  esa tabla — quedó protegido con un test con el markup real.
- Los catálogos NO tienen paginador estático (ventana por fechas); los filtros
  por letra/género son enlaces estáticos (`/series-hd/letter/a`,
  `/peliculas/genre/drama`) y NO se cuelan como fichas (verificado en test).
- Los índices completos `/peliculas` y `/series` existen ("Volver al índice"
  en cada ficha).

## Cambios (`src/crawlers/mejortorrent.ts`)

- Fix 23 — fallback del modo `modern_me`: desde el fix 11, una API
  `/wp-json/wp/v2/posts` que responde HTML (SPA/WAF, HTTP 200) lanza
  `BlockedPageError`, y el catch del modo WordPress lo RE-LANZABA: la corrida
  moría aunque el template legacy funcionara perfecto. Ahora ese error solo
  corta la fase API y cae al modo HTML (un mirror realmente bloqueado sigue
  levantando el error desde los fetch legacy, que usan rejectBlocked).
  429, deadline y demás errores siguen re-lanzándose.
- Nuevas rutas legacy: `/peliculas` y `/series` (índices completos por tipo),
  después de las ventanas recientes; el cupo `maxPages*35` sigue acotando.

## Tests nuevos (suite 455/455)

- Recorrido end-to-end del template 2026: portada legacy → listados con
  enlaces absolutos www46 → ficha de película con `/torrents/peliculas/…`
  (1 record, hash del metainfo real) → ficha de serie con la tabla real
  (3 episodios 1x01..1x03, season=1) → índices `/peliculas` y `/series`
  visitados → filtros `letter/`/`genre/` jamás pedidos.
- API de WordPress que responde página de WAF → la corrida cae al modo HTML y
  produce records (antes: error fatal).

---

# Profundización: The Pirate Bay (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de TODA la cadena de thepiratebay (apibay.org + 9 mirrors
HTML del pool).

## Estado real verificado (2026-09-28)

- **APiBay viva y exacta**: `data_top100_20N.json` y `q.php?q=castellano&cat=200`
  responden con el formato que `mapApibayItem` espera, con la dualidad real:
  precompilados traen números (`id: 38033514`, `category: 201`, imdb
  `"tt0113247"`) y `q.php` trae TODO como strings (`category: "201"`,
  `imdb: ""`). Cubierto con tests de ambas formas.
- **Pool de mirrors**: 7 de 9 vivos respondiendo el probe
  `/search/test/1/99/200` con la tabla `searchResult`:
  `tpb.party`, `thepiratebay10.org` (redirige a `.xyz`, el fetch lo sigue),
  `thehiddenbay.com`, `thepiratebay0.org`, `piratebay.live`,
  `pirateproxy.live` (redirige a `pirateproxylive.org`), `thepiratebay.zone`.
  FUERA: `pirate-bays.net` (aparcado, página de anuncios) y
  `tpb.skynetcloud.site` (muerto).
- **DOS variantes del template conviven** entre los mirrors, y el parser
  actual cubre ambas:
  - Clásica (tpb.party, thepiratebay10.xyz, pirateproxylive.org): categoría
    `Video > HD - TV shows`, columnas separadas de tamaño/S/L y uploader.
  - Minimalista (thehiddenbay, thepiratebay0, piratebay.live, thepiratebay.zone):
    celda de categoría con DOS enlaces (`Video` + `( HD - TV shows )`), sin
    columna de tamaño (va dentro de `detDesc`) y contadores `| 98 | 34 |` al
    final — exactamente el caso que protegió el fix 10 (últimas celdas
    numéricas).
- **Fichas**: `description.php?id=N` puede 404ear en algunos proxies, pero es
  inofensivo (los records del JSON ya traen imdb de apibay; los de la fase
  HTML usan `source_url` = `/torrent/ID/...`, que vive y publica el enlace
  IMDb — verificado con `tt32230839` en tpb.party).

## Cambios

- `DEFAULT_MIRRORS` depurado: fuera el dominio aparcado y el muerto;
  `tpb.party` primero (canónico, sin hop de redirect). El probe rechaza
  cualquier otro espejo que deje de hablar el dialecto TPB, así que la lista
  corta no reduce resiliencia real.

## Tests nuevos (suite 459/459)

- Fila clásica 2026 real → `series`, S/L 98/34, tamaño 2.13 GiB, hash
  lowercase, `source_url` mismo-sitio, magnets con trackers, sin
  `torrent_file_url` (las filas publican magnets, nunca .torrent).
- Fila minimalista 2026 real (2 enlaces de categoría, sin columna de tamaño)
  → record `series` y record `movie` con S/L de las últimas celdas numéricas.
- APiBay 2026: forma precompilada (números + imdb) y forma `q.php` (strings +
  imdb vacío → `null`, nunca fabricado).
- Higiene del pool: primer mirror `tpb.party`, sin los dominios muertos.

---

# Profundización: MagnetDL (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de TODA la cadena de magnetdl (pool de 4 dominios,
catálogos, fichas /single/:id y rutas de búsqueda por letra).

## Estado real del pool (2026-09-28)

| Dominio | Estado real |
|---|---|
| `magnetdl.app` | 🟢 **La mejor variante**: las filas traen `magnet:` REALES con trackers → cero fichas necesarias |
| `magnetdl.co` | 🟠 Vivo pero degradado: el icono de descarga enlaza a una página HTML en `.app` (no a un magnet) y la ficha solo imprime el hash |
| `www.magnetdl.com` | 🔴 Cloudflare 522 (origin caído; puede volver, el probe lo salta) |
| `magnetdl.org` | 🔴 Cloudflare 522 (mismo origin) |

## Fix 24 — la ficha `.co` nunca producía magnet

- En `magnetdl.co` el botón "Download" es un enlace HTTP a
  `magnetdl.app/single/:id` (OTRA página HTML, no metainfo): `sameMirrorSite`
  lo rechaza correctamente. La única fuente real es la celda impresa
  `Info Hash:</td><td>9C44…</td>`.
- El fallback por hash usaba un gap `[^0-9a-f]{0,40}` entre la etiqueta y el
  hash: imposible atravesar `</td><td>` porque la "d" de "td" ES un carácter
  hex → el fallback NUNCA matcheaba y toda ficha terminaba en `skipped`.
- Ahora se limpia el HTML (strip de tags) y se busca
  `info hash \D{0,80}? [0-9a-f]{40}` sobre el texto visible: el hash impreso
  se convierte en magnet (sin trackers, como manda la política del repo:
  nada fabricado).

## Ajustes

- Pool reordenado: `magnetdl.app` primero (filas con magnet → la corrida
  resuelve TODO desde el listing, sin pedir una sola ficha); `.co` de
  respaldo; `.com`/`.org` al final por si el origin vuelve.
- `MAGNETDL_SEARCH` default ahora vacío: el esquema de búsqueda del sitio
  matchea slugs de TÍTULOS exactos (`/h/house-of-dragon-s02e05-2160p/`), así
  que los términos de idioma default (`spanish`, `castellano`, `latino`)
  respondían 404 SIEMPRE (verificado: `/s/spanish/` y `/c/castellano/` = 404
  nginx) — 3 pedidos muertos por corrida. La ruta por letra queda disponible
  vía `MAGNETDL_SEARCH=<slug-de-título>`.

## Tests nuevos (suite 462/462)

- Fila real de `.app` → magnet con trackers cosechado del listing, S/L/tamaño
  correctos, sin tocar la ficha.
- Ficha real degradada de `.co` → el hash impreso se convierte en magnet a
  través del markup de tabla; el enlace HTML del hermano jamás se guarda como
  `torrent_file_url`.
- Pool vivo (`.app` primero) + una corrida default sin `MAGNETDL_SEARCH` solo
  pide `/download/movies/` y `/download/tv/` (cero rutas de letra).

---

# Profundización: RuTracker (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de la cadena de rutracker (pool de 5 dominios oficiales,
probe, acceso de invitados, formularios y contrato de sesión). Tracker
privado: la cadena autenticada completa no es runnable sin credenciales, así
que lo verificable en vivo se verificó y el resto quedó fijado por tests.

## Estado real verificado (2026-09-28)

- `rutracker.org` y `rutracker.net` 🟢 vivas, foro completo, markup idéntico
  (los fixtures de la suite `tLink`/`tor-size`/`seedmed`/`leechmed`/`a.pg`
  siguen siendo el markup real).
- `rutracker.nl` 🟠 responde HTTP 500 (servidor vivo, sitio roto hoy);
  `rutracker.me` y `rutracker.cc` no respondieron desde esta red. Los cinco
  dominios siguen en el pool a propósito: el probe pregunta uno por uno y se
  queda con el primero sano (ahora documentado en el JSDoc con la fecha).
- **`tracker.php?nm=…` anónimo redirige a `login.php?redirect=…`**: los
  invitados ya no pueden ni buscar. El adapter ya lo modelaba bien (falla
  explícito con `RutrackerAuthError` antes de crawler anónimo) — verificado
  en vivo que el redirect existe tal cual.

## Fix 25 — sesión muerta a mitad de corrida: fallo inmediato y con causa real

- Antes: cuando `bb_session` expiraba durante la fase de fichas, cada
  `tracker.php`/`viewtopic.php`/`dl.php` devolvía la página del formulario de
  login; el parser la leía como un listing vacío o como "sin magnet" → la
  corrida entera se gastaba en `skipped` silenciosos y el error final
  *adivinaba* ("The session is probably no longer attached").
- Ahora `looksLikeRutrackerLoginPage()` detecta el formulario de forma
  estructural (form con `action=…login.php` + campo `login_username`, nunca
  en una página con logout): `fetchForumPage` y la descarga de metainfo
  lanzan `RutrackerAuthError` con la causa exacta, y ese error es terminal
  (`isTerminalRutrackerError`) → la corrida para en la primera respuesta de
  login, sin quemar el presupuesto de fichas.
- La recuperación NO se rompe: si hay `RUTRACKER_USERNAME`/`PASSWORD`,
  `ensureSession` captura ese error en su chequeo inicial, descarta la
  cookie muerta y loguea por credenciales (test que fija ese camino).

## Tests nuevos (suite 466/466)

- Detección estructural del formulario (positivo real, negativos: página
  logueada, listing, error de login, vacío).
- Sesión muerta a mitad de corrida → `RutrackerAuthError` "bb_session is no
  longer valid" con EXACTAMENTE 1 request de listing y 0 fichas pedidas.
- `dl.php` respondiendo el formulario → rechazo con la causa real (antes:
  "not valid v1/hybrid torrent metainfo").
- Cookie muerta + credenciales válidas → re-login cp1251 → corrida completa
  produce el record (camino de recuperación intacto).

---

# Profundización: YTS (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de TODA la cadena de yts (pool de 8 dominios, API v2,
shape real del payload, queries default). El crawler es 100% JSON API, sin
fase HTML.

## Estado real del pool (2026-09-28)

| Dominio | Estado real |
|---|---|
| `yts.gg` | 🟢 **El que sirve**: API v2 completa (movie_count 77478, uploads del día) |
| `movies-api.accel.li` | 🟢 **Nuevo base oficial del API** (anunciado en el propio payload, `@meta.migration`), payload idéntico |
| `yts.lt` / `yts.am` | 🟠 Vivos pero **redirigen a yts.gg** |
| `yts.mx` | 🟡 canónico; no respondió desde esta red (bloquea IPs de datacenter; el probe lo salta) — se mantiene |
| `yts.do` / `yts.pm` | 🔴 API → 404 HTML |
| `yts.rs` | 🔴 API rota (`Cannot read property 'moviesPerPage' of undefined`) |
| `yts.nz` / `yts.homes` | 🔴 sin respuesta (con evidencia de que la familia SÍ es alcanzable desde esta red) |

- **Shape verificado**: hash UPPERCASE (el mapper lo normaliza), `size_bytes`
  numérico, `seeds`/`peers` numéricos, `language` de dos letras (`nl`, `en`…),
  `imdb_code` "tt…", URLs de película y de torrent **absolutas** en el dominio
  que sirve el contenido (`yts.gg`).
- `query_term=spanish` sigue vivo (busca por TÍTULO: 12 resultados); se
  mantiene en las queries default.

## Fix 26 — los mirrors que redirigen tiraban TODAS las URLs de descarga

- `resolveMirror` devuelve el dominio configurado (p.ej. `yts.lt`), pero el
  payload (served por `yts.gg` tras el redirect) publica URLs absolutas en
  `yts.gg` → `trustedYtsUrl` las rechazaba TODAS: cada record salía con
  `torrent_file_url: null` y `source_url` degradada al fallback del slug.
- Ahora la corrida adopta, una sola vez y con log, el **origen que el propio
  payload publica** (host de la primera `movie.url` absoluta) como base de
  confianza: requests al dominio de API sondeado, URLs al origen real del
  contenido. Funciona para `.lt`/`.am` (redirect) y para `accel.li` (base
  API-only). Si el payload usa URLs relativas, todo queda como antes.
- Pool reordenado: `yts.gg` primero (el que sirve, sin hop), `yts.mx`
  canónico de reserva, `accel.li` (base nueva oficial), `.lt`/`.am` al final;
  fuera `do/rs/pm/nz/homes` con evidencia negativa.

## Tests nuevos (suite 469/469)

- Payload REAL de yts.gg (2026-09-28) → 2 records: hash uppercase→lowercase,
  `imdb_id` tt1319699, size_bytes/seeds/peers numéricos, quality/channels del
  API, audio `[]` para `language: "nl"` (nada inventado), magnets sin `tr=`.
- Escenario redirect (`yts.lt`→otro origen): el origen del payload se adopta →
  `torrent_file_url` y `source_url` apuntan al sitio real; los requests
  quedan en el dominio configurado.
- Higiene del pool: `yts.gg` primero, sin los 5 dominios muertos/rotos.
- El test de "URLs relativas" ahora fija su propio dominio (antes dependía
  implícitamente del orden del pool).

---

# Profundización: 1337x (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de TODA la cadena de leech1337x (pool de 10 dominios,
rutas sort-search + populares, fichas, paginación). Cadenas completas
verificadas contra las páginas reales de 2026.

## Estado real del pool (2026-09-28)

| Dominio | Estado real |
|---|---|
| `1337x.la` | 🟢 **Cadena completa verificada**: `/sort-search/spanish/seeders/desc/1/` con filas frescas, paginación publicada, fichas con magnet |
| `1337xx.to` | 🟢 Listado real (mismos ids de contenido que .la, plantilla nueva) |
| `1337x.st` | 🟢 Listado real (plantilla clásica) |
| `x1337x.ws` | 🟢 Listado real (plantilla clásica) |
| `1337xxx.to` | 🟢 Listado real (plantilla nueva) |
| `1337x.to` | 🟠 Canónico vivo, pero `/popular-movies` respondió "Bad category." ese día (queda como fallback; el probe decide) |
| `1377x.to` | ⚪ Oficial según el hub; inalcanzable desde esta red (queda; el probe lo salta) |
| `www.1337x.tw` / `1337xto.to` | 🔴 Son hubs/puertas de dominios: categorías 404 o apuntan a OTROS dominios — fuera |
| `x1337x.eu`, `x1337x.se`, `1337x.is`, `1337x.gd` | 🔴 Proxies viejos sin evidencia — fuera |

La propia página del hub (`1337x.la/about`) publica la lista de dominios
oficiales actual: `1377x.to, 1337x.tw, 1337xto.to, 1337xx.to, 1337xxx.to,
1337x.is, 13377x.tw` — el pool nuevo adopta los que sirven listados reales.

## Cadena verificada contra el markup real (sin cambios de código)

- Probe "first accepted wins": la plantilla nueva convirtió la portada en un
  hub SIN tabla de torrents, pero el segundo probe (`/popular-movies`) sí es
  un listado real → el mirror se acepta igual. El diseño de dos probes ya lo
  cubría.
- `sort-search` sigue vivo con paginación publicada exactamente del formato
  `/sort-search/<term>/seeders/desc/2/` que `sameListingRoute` espera.
- **Fichas**: magnet público para anónimos con dn + 8 trackers reales, mapa
  de detalles (Category/Language/Total size/Seeders/Leechers), Infohash
  impreso (fallback por hash disponible) y enlace IMDb. El botón "Torrent
  Download" es un ancla `#` y los espejos (torrage/btcache) son
  third-party → `torrent_file_url: null` correctamente (nada inventado).
- La variante clásica de `.st`/`.ws` pega el contador de descargas a la
  celda de tamaño (`"1.5 GB2218"`) y suelta badges numéricos fuera del
  anchor: el parser de tamaño (por regex) y el de título (solo texto del
  anchor) ya lo manejan — fijado con tests.

## Cambios

- Pool depurado con evidencia: `[1337x.la, 1337xx.to, 1337x.st, x1337x.ws,
  1337xxx.to, 1337x.to, 1377x.to]` (7 dominios, 5 verificados con listado
  real). Fuera los 2 hubs y los 4 proxies viejos sin evidencia.

## Tests nuevos (suite 472/472)

- Ficha real 2026 (magnet con trackers + details map + IMDb + botón `#`) →
  record `series`, S/L 824/283, tamaño desde el listing (no el contador de
  descargas), `torrent_file_url` null, IMDb tt6468322, audio Spanish desde el
  título aunque el campo Language del sitio diga English.
- Fila clásica de `.st` → título limpio (badge fuera del anchor), 1.5 GB con
  el contador pegado, S/L 2218/565.
- Higiene del pool: los 5 verificados quedan, los 6 muertos/hub fuera.

---

# Profundización: SinSitio (foco exclusivo)

Fecha: 2026-09-28
Verificación en vivo de TODA la cadena de sinsitio (pool de 4 dominios,
portada, secciones, fichas, attachments DLE, paginación). La 7ª lo había
marcado 🟢: esta ronda confirmó la cadena contra el markup de hoy.

## Estado real del pool (2026-09-28)

| Dominio | Estado real |
|---|---|
| `www.sinsitio.site` | 🟢 DLE completo: portada con posts frescos (septiembre 2026), secciones `/dvdrip-bdrip/` y `/series/` vivas con pager publicado |
| `sinsitio.site` | 🟢 vivo (301 → www; mismo sitio) |
| `www.sinsitio.info` | 🔴 sin respuesta (fetch + curl) — fuera |
| `sinsitio.online` | 🔴 sin respuesta (fetch + curl) — fuera |

## Cadena verificada contra el markup real (sin cambios de código)

- **Probe**: portada con posts `/N-slug.html` ✓ (el marcador esperado).
- **Fichas**: el enlace de descarga real es exactamente
  `ddlUrl.php?url=<base64(%2F/%3D escapados)>&name=<título release>`; el
  base64 de hoy decodifica a `index.php?do=download&id=69707` (attachment DLE
  público con id numérico) — la forma que `decodeSinsitioDownload` espera,
  verbatim.
- **Attachment**: un pedido directo SIN Referer devuelve la ficha otra vez
  (DLE rebota al post) — es exactamente por eso que `fetchTorrentMetainfo`
  envía el Referer de la ficha; el camino del crawler es el correcto.
- **Paginación**: `/series/` publica pager DLE con URLs `/series/page/2/` y
  texto "Adelante"; el matcher actual lo sigue (número 2 = actual+1 dentro de
  `.navigation`) — fijado con test del markup real.
- 1 calidad por post (un solo ddlUrl por ficha); los comentarios (reales,
  activos) quedan excluidos por `#dle-comments-list` como ya diseñado.

## Cambios

- Pool depurado: `[www.sinsitio.site, sinsitio.site]` con JSDoc de live-check.
  Fuera `sinsitio.info` y `sinsitio.online` (muertos con doble evidencia).

## Tests nuevos (suite 476/476)

- El href ddlUrl.php VERBATIM de la ficha de hoy (id 69707) decodifica al
  attachment público; relativo y absoluto.
- E2E con anatomía real (portada + ficha + comentarios): record con título
  del `name=` param, `torrent_file_url` = attachment, `source_url` = ficha y
  **el Referer del pedido de descarga es la ficha** (la evidencia en vivo del
  rebote de DLE).
- Pager DLE real (`/series/page/2/` + "Adelante") seguido desde `.navigation`.
- Higiene del pool: solo el par www/apex vivo.

---

# Profundización: mejortorrent (foco exclusivo)

Fecha: 2026-09-29
Verificación en vivo de TODA la cadena de mejortorrent sobre los mirrors reales
(los probes locales del sandbox no tienen salida de red — fallan hasta
example.com — así que la verificación se hizo contra el sitio directamente).

## Estado real del pool (2026-09-29)

| Dominio | Estado real |
|---|---|
| `www45.mejortorrent.eu` | 🟢 Vivo: 301 → `www46` (entry point con rotación) |
| `www46.mejortorrent.eu` | 🟢 Vivo: plantilla legacy 2026 completa |
| `mejortorrent.me` | 🟢 Vivo: plantilla WordPress; `/wp-json/wp/v2/posts` responde |
| `mejortorrent.wtf` | 🟠 Cloudflare 1005 (ASN de salida baneado) — depende de la IP |
| `mejortorrent.app` | 🔴 Cloudflare 522 (origin caído; puede volver) |
| `www.mejortorrent.icu` | 🔴 NXDOMAIN |
| `mejortorrent1.com` | 🔴 Aparcado (parking de anuncios → ww17.mejortorrent1.com) |
| `mejortorrents.net` | 🔴 NXDOMAIN |
| `mejortorrent.nz` | 🔴 NXDOMAIN |
| `www50.mejortorrent.eu` | 🔴 NXDOMAIN (la rotación wwwNN ya no lo sirve) |

## Qué se confirmó de la plantilla legacy (www45 → www46)

- Las 7 rutas que recorre el crawler siguen vivas y con el formato exacto:
  `/inicio`, `/peliculas-hd`, `/series-hd`, `/peliculas`, `/series`,
  `/peliculas-4k`, `/documentales` — enlaces ABSOLUTOS al front activo (www46),
  que es lo que `sameSiteHost` ya normaliza (fix 22).
- Sin paginador estático en los listados (el pie va directo al banner WARP);
  la ventana por fechas corta el recorrido — ya cubierto por los tests.
- Ficha de película: descarga ESTÁTICA `/torrents/peliculas/<nombre>.torrent`
  verificada con la ficha real `31040/Las-catadoras-del-Hitler`.
- Ficha de serie: tabla `ID | Episodios | Fecha | Clave | Download` con un
  `.torrent` por episodio — `td.eq(1)` = `1x01` calza con el parser de
  episodios, verificado con `serie/130307` (3 episodios 1x01..1x03).
- Filtros `letter/` y `genre/` presentes y jamás aceptados como fichas.

## Qué se confirmó del modo WordPress (mejortorrent.me)

- La API `/wp-json/wp/v2/posts?page=1` responde con `link` por post
  (verificado con el post real `patrulla-nocturna`).
- Las fichas publican `.torrent` estático en
  `/wp-content/uploads/2026/09/<slug>-(torrentNN).torrent` del MISMO dominio →
  lo acepta `isMejortorrentDownload` sin cambios.

## Cambios (`src/crawlers/mejortorrent.ts`)

- Pod del pool: fuera `www.mejortorrent.icu`, `mejortorrent1.com` (aparcado),
  `mejortorrents.net`, `mejortorrent.nz` y `www50.mejortorrent.eu` (NXDOMAIN).
  Dentro `www46.mejortorrent.eu` (front directo actual, sin hop de redirect).
  El primer puesto sigue siendo `www45` (entry point con rotación, que es lo
  que mockean los tests existentes); `wtf`/`app` quedan al final por si el
  ASN ban o el origin 522 se levantan.
- El probe de portada acepta `wp-content` además de `wp-json` y
  `href=/pelicula|serie/`: la portada .me publica carteles en
  `wp-content/uploads` y slugs sin `/pelicula/`, sin necesidad del link tag
  wp-json. Es el mismo conjunto de marcas que ya usa `detectTemplate`.

## Tests nuevos (suite 478/478)

- Higiene del pool: primer mirror `www45`, fuera los 5 dominios muertos o
  aparcados, dentro `www46` y `mejortorrent.me`, pool ≤ 6.
- Portada WordPress que SOLO publica `wp-content` (sin link wp-json ni rutas
  `/pelicula/`): los fronts .eu responden HTML sin marcas → el probe acepta
  `.me`, la API lista los posts y el `.torrent` publicado se descarga con
  bencode → record movie con el hash real.

# Profundización: RuTracker — ronda 2 (foco exclusivo)

Fecha: 2026-09-29
Revisión de la cadena entera del crawler de RuTracker tras la ronda anterior
(que fijó sesión, CAPTCHA y paginación). Esta ronda encontró y arregló el
bug que dejaba muerta la búsqueda `испанский` de los defaults.

## Estado real del pool (2026-09-29)

- `rutracker.org` 🟢 y `rutracker.net` 🟢: índice de invitados completo
  («Регистрация · Вход» + navegación `viewforum`/`viewtopic`) — re-verificado
  hoy.
- `rutracker.me` responde HTTP 500 (ayer no respondía); `rutracker.nl` no
  responde hoy (ayer devolvía 500); `rutracker.cc` no responde. Los cinco
  siguen en el pool a propósito: un 5xx o una respuesta sin red lo descarta
  el probe (el fetch lanza antes de llegar a la validación) y el primer
  dominio sano gana.
- `tracker.php?nm=` de invitado sigue redirigiendo a `login.php?redirect=`
  (acceso login-only, la corrida corre autenticada) — sin cambios.

## El bug: `detectLanguages` no entendía ruso (cascada completa)

- `RUTRACKER_DEFAULT_SEARCHES` incluye `испанский` y `LANG_HINT_PATTERN`
  extrae hints `испанск` del cuerpo del post, pero
  `detectLanguages('Фильм (2024) [WEB-DL] (испанский язык)')` devolvía
  `{audio: [], subtitles: []}`: `src/utils/language.ts` tenía SOLO aliases
  latinos (`spanish|castellano|…`), cero patrones cirílicos.
- Cascada: el prefiltro de idioma descartaba todo título cirílico → el
  término `испанский` no llegaba a pedir ni una página, y cualquier fila que
  colaba moría después en `filterSpanishReleases` (`base.ts` →
  `hasValidLanguageRelease`, que descarta `audio: []`).
- `languageHintsFromBody` capturaba los hints cirílicos bien (2 snippets),
  pero al volver por `detectLanguages` se parseaban a `[]`: la extracción
  funcionaba, el parseo no.

## Cambio principal (`src/utils/language.ts`)

- `detectLanguages` reconoce ahora evidencia cirílica CON contexto:
  - Audio: «испанский язык/дубляж», «звучание испанское», «оригинальный
    звук: испанский», «на испанском» → `Spanish`; los análogos «английский»
    → `English`. La regla latino-vs-castellano de las etiquetas latinas se
    reutiliza en la rama cirílica.
  - Subtítulos: «английские субтитры» / «субтитры: испанские» → `Sub_EN` /
    `Sub_ES`, y esa redacción se excluye del scan de audio («английские
    субтитры» no es audio inglés).
  - Trampas evitadas a propósito: el adjetivo solo NO es evidencia
    («испанская империя», «Русская версия» → `[]`) y «перевод с испанского»
    nombra la FUENTE de un doblaje ruso (el audio que trae la release no es
    español) → también `[]`.
- Detalle que costó un debugging: `\w` en JS es ASCII-only, así que
  «испанск\w*» no comía las declinaciones («испанский/испанские/испанского»).
  Todas las ramas usan un sufijo `[\wа-яё]*`.

## Cambio secundario (`src/crawlers/rutracker.ts`)

- El probe de mirror exige MARCA + dialecto del foro vía
  `looksLikeRutrackerForumPage()` (exportado): `rutracker` Y
  (`viewtopic|viewforum|login.php|login_username`), con
  `looksLikeBlockedPage` vetando antes. Antes,
  `htmlMarkerValidator([/rutracker/i, …])` con `.some()` aceptaba cualquiera
  de las dos marcas POR SEPARADO (riesgo latente: una 200-OK que no es el
  foro — error/mantenimiento — podía resolver como mirror ganador). Verificado
  en vivo: el índice de invitado de .org/.net trae ambas marcas, y un muro
  de login trae `login.php`/`login_username`.
- JSDoc del pool actualizado con los estados de 2026-09-29 (composición del
  pool sin cambios).

## Tests nuevos (suite 481/481)

- `utils.test.js`: matriz de 11 casos cirílicos — audio con etiqueta, subs
  ganando al audio, adjetivo solo, fuente de traducción, título ruso neutro.
- `rutracker.test.js`: crawl completo con `RUTRACKER_SEARCH=испанский` — la
  fila «(испанский язык, русские субтитры)» pide su ficha y produce
  `audio: [Spanish]` mientras «Русская версия» sigue sin costar requests; y
  el probe: marca+dialecto ✓, muro de login ✓, marca sola ✗, dialecto sin
  marca ✗, challenge con ambas marcas ✗.

# Profundización: wolftorrent / WolfMax4K — ronda 2 (foco exclusivo)

Fecha: 2026-09-29
Segunda pasada sobre la cadena completa de wolftorrent, con la evidencia en
vivo del día. Ronda con DOS fallos graves que la ronda anterior no podía ver
(sus fixtures de test usaban ids con dígitos y títulos «Castellano», así que
la suite estaba verde mientras el sitio real se caía a la mitad).

## Estado real del pool (2026-09-29)

| Dominio de `DEFAULT_MIRRORS` | Estado real |
|---|---|
| `wolfmax4k.com` | 🟢 Único catálogo vivo: `/peliculas` 23.055 títulos / 961 páginas, `/series` 14.974 / 624, subidas del propio día |
| `www.wolfmax4k.com` | 🟢 Redirige al apex (mismo catálogo; `isSameDomain` lo tolera) |
| `wolftorrent.com` | 🟠 Placeholder «Próximamente» (sin catálogo; el probe lo rechaza) |
| `wolftorrent.net` | 🔴 No responde |
| `wolfmax4k.org` | 🔴 No responde |

Sin cambios de composición: el orden ya arranca por el catálogo vivo.

## Cadena verificada hoy (sin cambios de código)

- **Listados**: ids slugless en TODAS las variantes de calidad (cada
  variante es su propia ficha), sin enlace de paginación publicado (pager de
  JS, protegido por dedup + `maxPages`), `www` → apex. El marcador del probe
  (`href="/pelicula|[a-z0-9]`) está presente en el `/peliculas` en vivo.
- **Ficha**: título en `h1`, campos en lista de definiciones `dt`/`dd` SIN
  dos puntos («Calidad» → `dd` «HDRip»), botón **«Descargar torrent» sin
  href** → el fallback de navegador sigue siendo load-bearing para la
  mayoría de fichas (camino estático solo si el template expone `data-*`).
  Enlaces de compartir (facebook/x/whatsapp) rechazados por
  `wolfDownloadUrl` ✓.

## Fix grave 1 — los ids SOLO-LETRA eran descartados (~mitad del catálogo)

- `WOLF_ID_SEGMENT` exigía letras Y dígitos (muestras del fix-21:
  `ryqb95`, `5se8eg`). El listado en vivo (2026-09-29) está lleno de ids
  solo-letra: `rytkrd`, `rx3whk`, `rwtzzg`, `ucufem` (serie), `ucv3nr`
  (episodio)… **32 de 69 ids únicos de la primera página de `/peliculas`
  (~46%)** eran rechazados en silencio por `isWolfDetailPath` → ni siquiera
  se pedía su ficha.
- Ahora: `[a-z0-9]{4,20}` CON al menos una letra. Siguen rechazados los
  digit-only (`/pelicula/2026`), los slugs con guiones
  (`/pelicula/mortal-kombat-ii`) y las palabras de listado
  (`/peliculas/estrenos` → `WOLF_LISTING_SEGMENTS`).

## Fix grave 2 — `audio: []`: la ficha NO publica fila de idioma

- La ficha en vivo solo tiene «Calidad/Tamaño/Añadido»; títulos como
  «Normal»; los nombres de torrent de escena no garantizan etiqueta de
  idioma. `html-catalog` construye el record con
  `detectLanguages(context, [], false)` → `audio: []` →
  `filterSpanishReleases` (`index.ts`) **descartaba cada record en
  producción** («No Spanish/English records found to upsert»).
- `REGEX_ES_TRACKERS` YA listaba `wolftorrent`… pero la regla vivía dentro
  de `if (inferDefaults)` (step 6) y los adaptadores html-catalog llaman con
  `inferDefaults=false` → el mecanismo «sitio puramente español ⇒ Spanish»
  estaba cableado pero inalcanzable.
- Arreglo en dos puntas:
  - `language.ts`: la regla del tracker español se aplica TAMBIÉN en modo
    explícito, solo cuando no hay evidencia (la evidencia explícita de los
    pasos 1–5 gana: un título «(Latino)» sigue siendo SOLO Latino, sin
    dual-tag). El default English sigue gated a `inferDefaults`.
  - `wolftorrent.ts`: `wolfReleaseHints()` añade el marcador `wolftorrent`
    a los hints (parseDetail Y el fallback de navegador de
    `discoverDownloads`).

## Fix 3 — «Calidad» sin dos puntos: el quality no llegaba al record

- `spanishReleaseHints` exige `etiqueta:` con dos puntos; la ficha real
  escribe `dt` «Calidad» + `dd` «1080p» sin nada entre ellos → el hint no
  se extraía y `record.quality` quedaba null en la mayoría de fichas
  (las de 720p/1080p/4K, que son la mayoría).
- `wolfReleaseHints` canoniza las filas `dt`/`dd` con las etiquetas
  conocidas (`Calidad`, `Idioma`, `Audio`, `Subtítulos`, `Formato`,
  `Resolución`) a «Calidad: 1080p» → llega a `parseTorrentTitle`. Un
  «HDRip» solo da quality null, consistente con el modelo resolution-only
  de todo el proyecto.

## Tests nuevos (suite 483/483)

- `utils.test.js`: marcador de sitio en modo explícito (`wolftorrent` →
  Spanish; «(Latino)» gana y NO se contamina con Spanish; sin marcador el
  modo explícito sigue intacto).
- `spanish-catalog.test.js`: e2e con la forma REAL de la ficha (h1 «Normal»,
  `dt`/`dd` sin dos puntos, sin fila de idioma, torrent de escena sin
  etiqueta) → `audio: ['Spanish']`, `quality: '1080p'` y
  `filterSpanishReleases` acepta el record.
- `crawler-fixes.test.js`: ids solo-letra aceptados (`rytkrd`, `rwtzzg`),
  `/pelicula/2026` sigue rechazado.
- `new-crawlers.test.js`: los hints del camino del navegador llevan el
  marcador del sitio.

## Incógnita abierta (sin cambios)

- Sigue sin ser verificable sin Playwright real si el click del botón
  «Descargar torrent» sirve el `.torrent` desde un CDN de OTRO dominio
  (hoy `wolfDownloadUrl` lo rechazaría: sería el único caso que pierde
  descargas). Todo lo demás de la cadena quedó fijado por tests.

# Profundización: SinSitio — ronda 2 (foco exclusivo)

Fecha: 2026-09-29
Segunda pasada sobre la cadena DLE de sinsitio con evidencia en vivo del día
(portada, ambas secciones, ficha de película clásica y ficha de serie). La
ronda anterior (2026-09-28) había verificado ddlUrl/Referer/pager; esta
encontró el mismo fallo de idioma que wolftorrent, con su caso en vivo.

## Estado real del pool (2026-09-29)

| Dominio | Estado real |
|---|---|
| `www.sinsitio.site` | 🟢 DLE completo: portada con subidas del día, `/dvdrip-bdrip/` y `/series/` vivos con pager publicado (`/series/page/2/` + «Adelante») |
| `sinsitio.site` | 🟢 301 → www (mismo sitio; el par www/apex sigue intacto) |
| `www.sinsitio.info` | 🔴 sin respuesta — sigue fuera |
| `sinsitio.online` | 🔴 sin respuesta — sigue fuera |

Sin cambios de composición: `[www.sinsitio.site, sinsitio.site]` sigue siendo
el pool correcto.

## Cadena verificada hoy

- **Portada**: posts `/N-slug.html` frescos ✓ (marcador del probe presente).
  El bloque de comentarios de la portada enlaza posts reales de otras
  categorías (`/bluray/`, `/cine-clsico-de-todos-los-tiempos/`,
  `/series-que-ya-son-clasicos/`, `/estrenos/`) — todos vídeo (template
  `flat-cinema`), así que el parseo amplio no mete basura no-vídeo.
- **Ficha de serie** (`/series/34972-crookhaven-t1.html`): UN post con **un
  `ddlUrl.php` POR EPISODIO** (7 enlaces 1x1…1x7), cada uno con su
  `name=Crookhaven%201xN%20Hdtv%20Xvid%20Castellano`. El bucle del parser
  ya los recoge todos; la ronda anterior solo había mirado posts de
  película (1 ddlUrl).
- **Ficha de película** (`/cine-clsico-.../35920-…`): `name=El Rostro
  Impenetrable 1961marlon Brando Mkv` — ver abajo, el caso del bug.
- **Descarga**: el base64 sigue decodificando a
  `index.php?do=download&id=N` público (ids actuales 67974…69715) y el
  ping-pong sin Referer de DLE no cambió (el adaptador ya envía el Referer
  de la ficha, fijado con test).

## El bug: posts SIN ninguna etiqueta de idioma morían en el filtro

- Evidencia en vivo (2026-09-29): la ficha clásica publica
  `name=El Rostro Impenetrable 1961marlon Brando Mkv` — **ni el `h1`, ni el
  `name=`, ni el cuerpo llevan Castellano/Latino/Inglés** — y los títulos de
  listado de `/series/` («Crookhaven T1», «Possession T1») tampoco. El
  idioma del sitio REAL solo aparece cuando el uploader lo escribe en el
  `name=` («…Hdtv Xvid Castellano»), que es costumbre suya, no una
  garantía de la plantilla.
- Cascada (idéntica a wolftorrent): `html-catalog` construye con
  `detectLanguages(context, [], false)` → `audio: []` →
  `filterSpanishReleases` (`index.ts`) descartaba esos records en
  producción. `sinsitio` YA estaba en `REGEX_ES_TRACKERS`, pero el
  marcador no estaba en el contexto de ningún record.
- **Fix**: `parseDetail` inyecta el marcador `sinsitio` en los hints
  (`dedupeStrings([...spanishReleaseHints($), 'sinsitio'])`). Gracias al
  hoist de la ronda wolftorrent, el marcador aplica también en modo
  explícito y SOLO cuando no hay evidencia: un `name=` con «Castellano» o
  «Latino» sigue mandando (la evidencia explícita gana, sin dual-tag).

## Ruido observado (sin código a propósito)

- El post-hilo «Haz Tu Pedido Aquí» (`/estrenos/19619-…`) se enlaza desde
  la portada y los comentarios: cuesta UN fetch y no produce record (sin
  ddlUrl). Filtrarlo exigiría reglas por slug — no vale la fragilidad.

## Tests nuevos (suite 485/485)

- `spanish-catalog.test.js`: e2e con la anatomía REAL de la ficha clásica
  (h1 + `name=` sin idioma en ningún sitio) → `audio: ['Spanish']` y
  `filterSpanishReleases` acepta (estaba en rojo: `audio: []`).
- `spanish-catalog.test.js`: e2e de la ficha de serie en vivo — UN post, 2
  episodios con sus propios `ddlUrl`/`name=` → 2 records, `season: [1,1]`,
  `episode: [1,2]`, tipo `series`, audio Spanish.
- Aserción actualizada: el e2e previo «language from ficha» ahora espera
  `audio: ['Spanish']` (marcador) manteniendo `subtitles: ['Sub_ES']`
  («Subtítulos: Español» explícito sigue ganando el slot de subtítulos).

## Profundización: YTS + 1337x — ronda 3 (2026-09-29)

Verificación en vivo de la cadena completa, día de la ronda:

- **YTS**: `yts.gg/api/v2/list_movies.json` 🟢 (`status: ok`, movie_count
  77479; `@meta.migration` sigue anunciando el cambio de base con sunset
  2026-04-10 — **ya vencido** — y todo payload publica «Base URL moving to
  movies-api.accel.li»). `movies-api.accel.li` 🟢 con catálogo idéntico
  (mismos ids y URLs absolutas de yts.gg → el fix-26 del origen del payload
  lo absorbe). `query_term=cidade` devuelve películas `language: "pt"`
  (p. ej. «Cidade dos Homens», id 55761).
- **1337x**: la portada `/` sigue siendo un hub «1337x Domains» sin
  `table-list` ni `/torrent/` (el probe la rechaza correctamente);
  `/popular-movies` 🟢 con tabla real cuyas filas enlazan
  `/torrent/<id>/<slug>/` — **ambos markers presentes**; ficha de
  «The Rush» (torrent/6727753) con la anatomía conocida: magnet con
  trackers, campo `Language` del sitio (`English`), infohash impreso,
  «Torrent Download» = `#` + torrage/btcache third-party.

### Fix 1 — YTS: el pool arranca por la base oficial anunciada

- `@meta.migration` declara sunset **2026-04-10** (pasado) y gg sigue
  publicando el anuncio en cada payload; accel.li servía catálogo idéntico
  en vivo. `DEFAULT_MIRRORS` pasa a
  `[movies-api.accel.li, yts.gg, yts.mx, yts.lt, yts.am]`. El probe decide:
  si accel.li cae, se rotación a gg como hasta ahora.

### Fix 2 — Idioma: dos pasadas explícito/por-defecto en ambos crawlers

- **Fallo en vivo**: `ytsLanguageHints('pt') → ['portuguese']` no es una
  etiqueta de audio conocida ni está en `REGEX_OTHER_FOREIGN` (solo
  `french|german|hindi|…|mandarin`), así que el default inglés etiquetaba
  las películas `language: "pt"` como inglesas; el clearing previo
  (`nativeLanguage && !langHints.length`) no actuaba porque los hints eran
  no vacíos. En 1337x, la ficha con campo `Language: Italian` (valor del
  formulario de subida) caía en el mismo default.
- **Fix (idéntico en `yts.ts` y `leech1337x.ts`)**: dos pasadas —
  pass 1 con `detectLanguages(..., false)` (solo evidencia explícita:
  etiquetas del título + hints del campo); el pass 2 con default corre
  SOLO cuando el campo estructurado (`movie.language` / `Language:`) está
  ausente o la pass 1 ya produjo audio. Un campo no inglés/español con
  título sin etiquetas → `audio: []` → descartado en el registro.
- **Por qué NO se amplió `REGEX_OTHER_FOREIGN`**: cada palabra añadida
  también vive en títulos de películas ENGLISH reales («The Italian Job»,
  «Dutch») y acabaría descartándolas. La evidencia estructurada (campo del
  API/ficha) es precisa y con blast radius cero para otros crawlers.

### Fix 3 — 1337x: el probe exige AMBOS markers de listing

- Los probes declaraban `[table-list, href…/torrent/]`, pero
  `htmlMarkerValidator` acepta con `.some()` (cualquiera basta): una
  página con UN marker (tabla vacía o enlace suelto) se aceptaba y
  congelaba la rotación en el dialecto equivocado. Precedente: fix idéntico
  en rutracker (`97cda74`).
- **Fix**: `looksLike1337xListing` local exportado (`.every()` + veto
  `looksLikeBlockedPage`), como en rutracker. `htmlMarkerValidator` NO se
  toca: lo comparten 6 crawlers más (fuera del foco de la ronda).
- El mock de auditoría de paginación ahora responde a la portada con un
  listing realista (tabla + fila `/torrent/`), como la plantilla clásica.

### Tests nuevos (suite 488/488, tsc limpio)

- `existing-crawlers.test.js`: YTS `language: "pt"` → `audio: []` y
  `hasValidLanguageRelease` descarta (estaba en rojo con `['English']`).
- `existing-crawlers.test.js`: YTS pool con `movies-api.accel.li` primero
  (estaba en rojo con `yts.gg`).
- `existing-crawlers.test.js`: `looksLike1337xListing` — ambos markers ✓,
  solo tabla ✗, solo enlaces ✗, hub ✗ (estaba en rojo: no exportado).
- `existing-crawlers.test.js`: 1337x `Language: Italian` + título plano →
  `audio: []`; guardas: campo `English` → `['English']`; `DUAL` + campo
  `English` → conserva ambos tracks (los 3 escenarios en rojo antes).
- `crawler-audit.test.js`: mock del probe de portada ahora sirve un
  listing con fila `/torrent/` (necesario bajo el validator estricto).

## Profundización: 1337x — ronda 4 (2026-09-30)

Verificación en vivo de la cadena completa (solo 1337x):

- **`1337x.la` 🟢 end-to-end**: `/sort-search/spanish/seeders/desc/1/`
  (20 filas reales + paginador `>>` → `/desc/2/` misma ruta),
  `/sort-search/dual%20audio/…` 🟢, `/popular-tv` 🟢, fichas de detalle
  con la anatomía conocida (magnet con trackers, `Language` del sitio,
  infohash impreso, «Torrent Download» = `#` + torrage/btcache).
- **Exclusión XXX verificada en vivo**: la ficha de «Spanish Senoritas…
  XXX» publica `Category: XXX` → `EXCLUDED_CATEGORY` la descarta antes de
  cualquier otro análisis ✓ (no entró nada al índice).
- **Pool (7 dominios)**: todos los mirrors canónicos sirven hoy una landing
  de búsqueda o hub de dominios en `/` — sin markers —, así que **probe1
  rechaza siempre y probe2 (`/popular-movies`) decide**: `1337xx.to`,
  `1337x.st` (clásica con tamaño pegado `1.9 GB2376`), `x1337x.ws`,
  `1337xxx.to` y `1337x.to` responden. **`1337x.to` se RECUPERÓ** del
  «Bad category.» del 28: sus popular routes sirven listado real hoy.
  `1337xto.to` — anunciado en los hubs como «newest alternative domain» —
  sigue 404 (Apache) → la poda se mantiene. `1377x.to` sigue inalcanzable.
  El anuncio del header de `.la` («1337x» → `www.13377x.com`) es una
  landing SEO sin tabla ni `/torrent/` → el probe la rechaza, no entra.
- **Paginación**: el paginador publicado de `dual audio`/`spanish` apunta
  a `/sort-search/<término>/seeders/desc/<N>/` (misma ruta → gana sobre el
  guess, como ya cubre el test del pager).

### Fix — el badge ⭐ final no ensucia el título

- **Fallo en vivo (2 instancias)**: filas y h1 imprimen
  `Money.Heist.S04.COMPLETE.SPANISH.720p.NF.WEBRip.x264-GalaxyTV ⭐`
  (el `dn=` del magnet lo arrastra), mientras el slug de la URL
  (`…-x264-GalaxyTV/`) y la lista de archivos del propio torrent imprimen
  el nombre sin estrella; segunda instancia `…Dual.YG⭐` con slug `…-YG/`.
  Es un badge decorativo de 1337x, no parte del release: guardarlo ensuciaba
  `title` y rompía el cruce de títulos con otras fuentes. Al final del
  nombre también interfería con la detección de truncado (`...⭐` no
  terminaba en `...`).
- **Fix**: `stripDecoration()` quita `⭐`/`🌟` finales y se aplica en tres
  puntos: título de fila (antes de `isBlockedTitle` y de la lógica de
  truncado), heading de la ficha y el título final (cubre el fallback por
  `displayName` del magnet).

### Doc de pool (sin cambios de composición)

- JSDoc de `DEFAULT_MIRRORS` y comentario del test de pool actualizados con
  el estado del 2026-09-30 (recuperación de `.to`, 404 de `1337xto.to`,
  comportamiento probe1-hub/probe2-decide).

### Tests nuevos (suite 489/489, tsc limpio)

- `existing-crawlers.test.js`: fila con `⭐` → `title` sin estrella; fila
  truncada (`…GalaxyTV ...`) + h1 con estrella → resuelve al nombre completo
  sin estrella (estaba en rojo: ambos conservaban `⭐`).
- Test de pool re-titulado con la fecha de verificación de hoy; asserts de
  membresía sin cambios.
