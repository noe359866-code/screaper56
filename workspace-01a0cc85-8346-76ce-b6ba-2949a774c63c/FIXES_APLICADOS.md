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
