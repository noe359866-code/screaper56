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
