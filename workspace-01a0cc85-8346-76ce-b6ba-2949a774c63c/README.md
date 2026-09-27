# Crawler asíncrono de metadatos torrent

Node.js 20+ / TypeScript. Adaptadores independientes para **16 fuentes**, normalización de
infohash BTIH, filtrado de idiomas y UPSERT en Supabase. Solo descarga el metainfo
`.torrent` para calcular el hash; no descarga el contenido compartido por BitTorrent.
Usa únicamente fuentes y contenidos que tengas autorización para consultar.

## Ejecutar

Desde este directorio (el que contiene `package.json`):

```bash
npm ci
cp .env.example .env
npm run build
npm test

# Comprobar una fuente concreta sin escribir en la base de datos:
DRY_RUN=true TARGET_CRAWLERS=dontorrent MAX_PAGES=1 npm start
DRY_RUN=true TARGET_CRAWLERS=wolftorrent,sinsitio MAX_PAGES=1 npm start
```

El fallback de descarga con navegador de Wolf necesita Chromium:

```bash
npx playwright install chromium
# En un runner Linux, puede necesitar: npx playwright install --with-deps chromium
```

`npm run lint` comprueba tipos. `npm run dev` ejecuta el orquestador en modo watch;
**no implica dry-run**, configura `DRY_RUN=true` explícitamente.

## Arquitectura de `src/crawlers/`

| Módulo compartido | Responsabilidad |
|---|---|
| `mirrors.ts` | Pool ordenado de dominios (`<FUENTE>_BASE_URL` → `<FUENTE>_MIRRORS` → descubiertos → predeterminados), sondas con validador de **contenido** (rechaza dominios aparcados, páginas de bloqueo y retos de Cloudflare), caché del espejo activo por proceso y error detallado con el motivo de cada candidato. |
| `support.ts` | Logger con `LOG_LEVEL`, contadores por ejecución, presupuesto de tiempo, pausas de cortesía, resolución de URLs relativas, parseo de contadores, concurrencia acotada y **un único constructor de `TorrentRecord`** (valida el hash, nunca fabrica seeders y siempre genera un magnet válido). |
| `base.ts` | Transporte común (`fetchHtml`, `fetchJson`, metainfo por `getBuffer` o `GET arraybuffer` con límite de 10 MiB), resolución de espejos, deduplicación por infohash con fusión de campos y filtro de idioma. |
| `html-catalog.ts` | Recorrido genérico catálogo → ficha → descarga para las webs HTML (paginación publicada, deduplicación de fichas, concurrencia configurable). |

Ningún espejo está avalado: la lista es **configuración**, y quien ejecuta el crawler
decide qué dominios puede consultar. Cualquier fuente se puede fijar a un único
dominio con `<FUENTE>_BASE_URL`.

## Estrategia propia de cada web

| TARGET_CRAWLERS | Archivo en `src/crawlers/` | Tratamiento específico |
|---|---|---|
| `pelispanda` | `pelispanda.ts` | API WordPress wpreact; películas, temporadas y episodios; calidad/idioma por descarga. Seeders no publicados = `null`. |
| `leech1337x` | `leech1337x.ts` | Tablas `table-list`, ficha individual, etiquetas Category/Language con texto o elementos HTML; deduplicación de visitas entre búsquedas. |
| `torrentgalaxy` | `torrentgalaxy.ts` | Filas `tgxtablerow`, título de ficha sin concatenar comentarios, magnet o hash de iTorrents, tamaño por celda. La búsqueda no prueba el idioma. |
| `yts` | `yts.ts` | API v2 validada; torrents por calidad, idioma nativo `es`/`es-mx`/`en`, canales de audio y hashes normalizados. No etiqueta francés como inglés. |
| `eztv` | `eztv.ts` | API `get-torrents` y fallback HTML `epinfo`, incluso si la API no está disponible al detectar el dominio. Temporada/episodio ausentes = `null`. |
| `thepiratebay` | `thepiratebay.ts` | APiBay (solo categorías de vídeo), búsquedas JSON, tablas HTML y paginación desde cero; ignora resultados centinela. |
| `mejortorrent` | `mejortorrent.ts` | Detección de plantilla legacy/WordPress; descarga de metainfo con Referer y parser Bencode común. Sin contadores inventados. |
| `elitetorrent` | `elitetorrent.ts` | Fichas, acortador Base64/ROT13, magnets hex/Base32, URLs `.torrent` relativas con query y metadatos fuera del título. |
| `limetorrents` | `limetorrent.ts` | Tablas `table2`; localiza la columna de tamaño por contenido para que la antigüedad no desplace seeders/leechers; búsqueda POST con fallback GET. |
| `nyaa` | `nyaa.ts` | Tablas `torrent-list`, tamaños MiB/GiB, anime y categoría de subtítulos ingleses. MultiSubs no se convierte en audio español. |
| `wolftorrent` | `wolftorrent.ts` | Catálogos `/peliculas` y `/series`; fichas `/pelicula/:id/:slug` y `/serie/:id/:slug`; enlaces, atributos de descarga y URLs literales en botones. Fallback de clic normal con Playwright. |
| `sinsitio` | `sinsitio.ts` | Posts DLE `/<categoría>/<id>-<slug>.html`; decodifica `ddlUrl.php?url=<Base64>&name=...` hacia adjuntos públicos `index.php?do=download&id=...` o `engine/download.php?id=...`. Conserva variantes de calidad. |
| `rarbg` | `rarbg.ts` | **Nueva fuente.** Clones de RARBG (`rarbgproxy.to`): búsquedas `spanish/castellano/latino` y catálogos `/movies/`, `/tv/`, `/anime/`, `/documentaries/`; magnet, campo `Language:` y peers desde la ficha. XXX y categorías no-vídeo descartadas. Variables `RARBG_MIRRORS`, `RARBG_SEARCH`, `RARBG_CONCURRENCY`. |
| `magnetdl` | `magnetdl.ts` | **Nueva fuente.** `magnetdl.co`: búsquedas `/<letra>/<slug>/` y `/download/movies/`, `/download/tv/`; el magnet se lee de la fila o de `/single/:id`. Variables `MAGNETDL_MIRRORS`, `MAGNETDL_SEARCH`, `MAGNETDL_CONCURRENCY`. |
| `tokyotosho` | `tokyotosho.ts` | **Nueva fuente.** Tokyo Toshokan: filas `desc-top`/`desc-bot`, categorías Anime, Batch, Non-English y Drama más búsquedas; hentai/JAV/música/manga excluidos. Variables `TOKYOTOSHO_MIRRORS`, `TOKYOTOSHO_SEARCH`, `TOKYOTOSHO_CONCURRENCY`. |
| `dontorrent` | `dontorrent.ts` | **Nueva fuente.** Catálogos `/peliculas`, `/series`, `/documentales` con paginación `?p=N`; fichas `/pelicula/:id/:slug` y `/serie/:id/:id/:slug`; tabla de episodios `1x02`; búsqueda POST opcional a `/buscar`; lista de dominios oficiales `/dominios` como reserva de espejos. |

### DonTorrent: qué se extrae y qué no

Se leen únicamente los enlaces que la web publica en HTML plano: magnets, ficheros
`.torrent` del propio dominio o de su CDN (`DONTORRENT_CDN_HOSTS`, por defecto
`doncdn.com`) y manejadores del mismo origen (`/descargar/...`, `/download/...`).
Los valores literales de `data-*`, `href` y las cadenas o `atob('...')` que aparecen
dentro de `onclick` se leen como texto: **nunca se ejecuta JavaScript de la página**.

Las plantillas actuales protegen la descarga con un reto *proof-of-work* que se
valida contra su propia API, además de un límite de descargas por hora. Este
adaptador **no resuelve, emula ni evita** ese reto, no automatiza CAPTCHAs y no
inventa URLs de CDN a partir del ID de la ficha. Cuando una ficha solo ofrece el
botón protegido, la entrada se cuenta como `gated` y se omite; si una ejecución
completa no obtiene ningún infohash válido, el crawler **falla explicando el
motivo** en lugar de devolver una lista vacía. DonTorrent tampoco publica
seeders/leechers: esos campos quedan en `null`.

### Wolftorrent: botones JavaScript

Si no aparecen enlaces estáticos, se abre la ficha en un navegador normal y se
escucha su evento de descarga tras pulsar **Descargar**. El navegador siempre se
cierra; el buffer se valida como metainfo. Los enlaces `blob:` no se guardan como
URLs públicas. Se puede desactivar con `WOLFTORRENT_BROWSER=false`.

No se automatizan logins ni CAPTCHA en este adaptador. Si el botón devuelve un
ZIP, HTML, un login o un formato no compatible, se avisa y no se inventa un hash.

### Sinsitio: adjuntos DLE

El parámetro `url` se decodifica sin ejecutar scripts. Solo se aceptan adjuntos
HTTP(S) del mismo origen, IDs numéricos y `.torrent` públicos (además de magnets).
El nombre de cada adjunto se usa para no mezclar un BDrip con una versión 1080p.
Los enlaces de comentarios y bloques `.related` se excluyen de las descargas.

## Configuración

| Variable | Predeterminado | Uso |
|---|---|---|
| `DRY_RUN` | `false` | `true`: no escribe en Supabase ni requiere sus credenciales. |
| `TARGET_CRAWLERS` | `all` | Todas las fuentes o lista separada por comas; rechaza nombres desconocidos. |
| `MAX_PAGES` | `3` | Máximo de páginas **por sección/búsqueda**, no total global. |
| `REQUEST_TIMEOUT_MS` | `20000` | Timeout HTTP; las sondas de espejos usan límites más cortos. |
| `CRAWLER_CONCURRENCY` | `2` | Crawlers simultáneos; cada adaptador limita sus propias fichas. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` o `silent`; cada línea lleva el nombre del adaptador. |
| `CRAWLER_REQUEST_DELAY_MS` | `0` | Pausa de cortesía (con jitter) entre peticiones de un mismo crawler. |
| `CRAWLER_TIME_BUDGET_MS` | `0` | Presupuesto por crawler; al agotarse devuelve lo recolectado en vez de seguir paginando. |
| `CATALOG_DETAIL_CONCURRENCY` | `2` | Fichas en paralelo en los catálogos HTML compartidos. |
| `SUPABASE_URL` | — | Necesario si `DRY_RUN=false`. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Necesario si `DRY_RUN=false`; guardar en `.env` local o secretos de Actions. |
| `WOLFTORRENT_BROWSER` | `true` | Fallback de navegador; `false` para extracción estática únicamente. Usa el Chromium compartido del anti-Cloudflare. |
| `WOLFTORRENT_BROWSER_MAX` | `25` | Tope de fichas resueltas con navegador por ejecución. |
| `MIRROR_PROBE_STAGGER_MS` | `700` | Retardo *hedged* entre candidatos de espejo (0 = secuencial estricto). |
| `CF_CLEARANCE_TTL_MS` | `1800000` | Vida útil local de una sesión `cf_clearance` cosechada. |
| `CF_BROWSER_IDLE_CLOSE_MS` | `90000` | Inactividad tras la que se cierra el Chromium compartido. |

### Dominios y espejos

Cada fuente acepta dos variables, con el nombre del crawler en mayúsculas:

- `<FUENTE>_BASE_URL`: fija un único dominio, que se prueba antes que ningún otro.
- `<FUENTE>_MIRRORS`: lista separada por comas que sustituye a los espejos
  predeterminados del adaptador.

Ejemplos: `DONTORRENT_MIRRORS`, `WOLFTORRENT_BASE_URL`, `SINSITIO_MIRRORS`,
`NYAA_BASE_URL`, `ELITETORRENT_BASE_URL`, `MEJORTORRENT_MIRRORS`,
`LIMETORRENTS_BASE_URL`, `TORRENTGALAXY_MIRRORS`, `THEPIRATEBAY_MIRRORS`,
`APIBAY_BASE_URL`, `YTS_MIRRORS`, `EZTV_MIRRORS`, `LEECH1337X_MIRRORS`,
`PELISPANDA_MIRRORS`.

Concurrencia y búsquedas por fuente: `DONTORRENT_CONCURRENCY`,
`ELITETORRENT_CONCURRENCY`, `MEJORTORRENT_CONCURRENCY`, `LIMETORRENTS_CONCURRENCY`,
`LEECH1337X_CONCURRENCY`, `PELISPANDA_CONCURRENCY`, `DONTORRENT_SECTIONS`,
`DONTORRENT_SEARCH`, `DONTORRENT_CDN_HOSTS`, `DONTORRENT_DISCOVER_MIRRORS`,
`LIMETORRENTS_SEARCH` y `THEPIRATEBAY_SEARCH`. Todas están documentadas en
`.env.example`.

## Validación y límites

- Parser Bencode único en `utils/bencode2.ts`: hash SHA-1 de los **bytes originales**
  del diccionario `info` de raíz, tamaños multifichero, trackers, comprobaciones de
  límites/profundidad y rechazo de descargas dañadas. `bencode.ts` conserva la API
  de compatibilidad. Metainfo v2-only no es compatible con el esquema BTIH v1.
- Los registros se deduplican con infohash normalizado de 40 caracteres hexadecimales;
  si dos fuentes internas describen el mismo hash, se **fusionan** los campos y se
  conserva el registro más completo, sin inventar valores.
- El filtro existente acepta **español o inglés**, en audio o subtítulos; pese al
  nombre histórico `hasValidSpanishRelease`, no es un filtro exclusivo de español.
  También conserva los tags genéricos Multi-Subs/Subtitulado. Las pistas de la
  fuente (por ejemplo, que DonTorrent publique principalmente castellano) solo se
  aplican cuando el título no trae ninguna etiqueta de idioma explícita. Un registro
  de idioma desconocido puede descubrirse pero quedar descartado antes del UPSERT.
- Seeders/leechers desconocidos **no se fabrican** en ninguna fuente: quedan en
  `null` (DonTorrent, Pelispanda, MejorTorrent, EliteTorrent, LimeTorrents y el
  catálogo HTML de EZTV no los publican). La capa de persistencia existente
  convierte valores desconocidos a sus defaults de base de datos.
- Las descargas de metainfo se limitan a 10 MiB. No se extraen ni se ejecutan
  ficheros descargados.
- Ningún espejo está garantizado: un sitio puede cambiar de plantilla, cerrar,
  limitar solicitudes o requerir autenticación. La resolución de espejos valida el
  contenido antes de aceptar un dominio y, si ninguno responde, el error enumera
  cada candidato y su motivo. Los adaptadores fallan explícitamente cuando no
  consiguen ningún torrent válido. El orquestador aísla errores por fuente y
  muestra el resumen `Errors`.

## Pruebas y verificación

`npm test` ejecuta **106 pruebas sin conexión y sin Supabase**, con HTML sintético y
respuestas HTTP simuladas específicas de las 16 fuentes, más pruebas unitarias de
los módulos compartidos (`mirrors.ts`, `support.ts`): precedencia del pool de
dominios, rechazo de páginas aparcadas o con reto, caché del espejo activo,
concurrencia acotada, fusión de duplicados y construcción de registros. Incluye
descargas DLE, Base64, `atob` literal, episodios, variantes, paginación cíclica,
fallback API→HTML, tamaños, idiomas, hashes, metainfo corrupto y normalización.
Los fixtures documentan rutas observadas, pero **no son capturas completas de las
webs ni certifican disponibilidad**. El clic real de Playwright de Wolf requiere
una comprobación en vivo.

En esta revisión (26-09-2026) se pudieron consultar las páginas públicas de
DonTorrent (`/peliculas`, fichas de película y serie, `/dominios`), Wolftorrent y
Sinsitio mediante la herramienta de lectura web. La conexión HTTPS directa del
entorno de ejecución falló con `SSL_ERROR_SYSCALL`: **no se ha verificado una
extracción completa en vivo ni el UPSERT real**, y en DonTorrent no se pudo
comprobar qué proporción de fichas expone un enlace estático frente al botón con
proof-of-work. Ejecuta primero el dry-run de una página desde tu runner y revisa
`Discovered`, `Accepted OK` y `Errors`.

## Anti-Cloudflare

`src/utils/anti-cloudflare.ts` expone un único `CloudflareBypassEngine` por proceso.
Resuelve retos gestionados y Turnstile en un Chromium sigiloso y devuelve el HTML
renderizado junto con las cookies y el User-Agent cosechados, para que el resto de
peticiones al mismo host se repliquen por HTTP normal sin volver a abrir el navegador.

- **Arranque perezoso**: ningún navegador se lanza hasta que hace falta; si Chromium no
  está instalado el error indica el comando exacto (`npx playwright install --with-deps chromium`).
- **Single-flight**: N peticiones bloqueadas por el mismo host comparten UNA resolución;
  el resto espera su resultado en lugar de abrir N contextos.
- **Caché de sesiones con TTL y LRU** (48 hosts): una `cf_clearance` válida corta
  cualquier intento posterior de abrir el navegador. Si el servidor la rechaza,
  `invalidateSession` la olvida y la siguiente escalada fuerza una resolución nueva.
- **Semaforo de contextos** y cierre del navegador tras `CF_BROWSER_IDLE_CLOSE_MS` de
  inactividad; `installCloudflareTeardownHooks()` lo cierra en SIGINT/SIGTERM/`beforeExit`
  para que la ejecución no quede colgada con un Chromium huérfano.
- El stealth plugin se registra **invocando su fábrica**; pasar la función sin invocar
  hace que `playwright-extra` lo ignore en silencio y desactiva todas las evasiones.
- Nunca se automatizan CAPTCHAs interactivos ni logins: solo se espera a que el propio
  navegador del usuario supere el reto gestionado.

## GitHub Actions

El workflow `.github/workflows/main.yml` se ejecuta cada seis horas o manualmente.
Instala las dependencias de sistema de Playwright **siempre** (`install-deps`), aunque
el binario de Chromium venga de caché: el caché solo guarda `~/.cache/ms-playwright`,
no los paquetes apt, y saltarse ese paso dejaba el navegador restaurado sin
`libnss3`/`libatk` y todos los bypass fallaban.
Permite elegir las 16 fuentes, incluida DonTorrent; `all` las incluye todas.
Instala dependencias con `npm ci`, compila y ejecuta las pruebas antes de crawlear.
Configura las claves de Supabase como secretos del repositorio para escritura real.

## Diagnóstico de extracción (sin Supabase)

Desde la carpeta que contiene `package.json`:

```bash
npm ci
npm run diagnose                    # los 16 adaptadores, una página por ruta
npm run diagnose -- --spanish        # DonTorrent, MejorTorrent, EliteTorrent, Pelispanda, Wolf y Sinsitio
npm run diagnose -- dontorrent nyaa  # selección explícita
DIAGNOSE_TIMEOUT_MS=180000 npm run diagnose -- --spanish
```

No importa el repositorio de Supabase ni escribe registros. Usa las variables
`*_BASE_URL` y `*_MIRRORS` existentes. Cada crawler se ejecuta secuencialmente en
un proceso aislado, con un límite duro de 60 segundos por defecto (incluidos
reintentos y navegador). En Linux se termina el grupo de procesos al agotarlo.
Devuelve métricas, mirror, extraídos, aceptados y descartados cuando finaliza.

- `OK`: hay registros que pasan el filtro de idioma existente (español **o inglés**).
- `EMPTY`: no se extrajo nada; no equivale a que no haya novedades.
- `FILTERED`: se extrajeron registros, pero todos fueron descartados por idioma.
- `ERROR`: fallo de mirror, API, catálogo o descarga; ver mensaje y métricas.
- `TIMEOUT`: no terminó dentro del presupuesto; no demuestra que el sitio esté caído.

Cualquier resultado distinto de `OK` devuelve código 1 para facilitar alertas.
El indexador principal también marca como error una extracción totalmente vacía.

### Tratamiento específico de catálogos españoles

DonTorrent, MejorTorrent, EliteTorrent, WolfTorrent y Sinsitio comparten lectura de
URLs literales en botones `data-*` y `onclick`/`atob`, además de los enlaces normales.
Cada adaptador conserva su validación de destinos. Se leen campos etiquetados de
idioma, subtítulos, calidad y formato, evitando navegación y recomendaciones;
Wolf y Sinsitio ya no dependen únicamente del título para ese contexto.
No se ejecuta JavaScript extraído ni se inventan infohashes.

MejorTorrent admite magnets sin descargar `.torrent`, detecta más marcas de
WordPress y prueba catálogos HTML si la API no ofrece posts. EliteTorrent continúa
paginando aunque la primera página repita enlaces de la portada. DonTorrent no
incluye música/juegos de la portada como películas.

**Límites:** no se añaden automatizaciones de CAPTCHA, login ni del botón PoW de
DonTorrent. Los enlaces que solo se obtienen así siguen sin extraerse. El fallback
HTML de MejorTorrent requiere rutas reconocidas; no garantiza compatibilidad con
cualquier clon de WordPress. Los mirrors cambian y deben verificarse en el entorno
de despliegue.

Validación de esta revisión: pruebas locales con respuestas simuladas y compilación
TypeScript. El sondeo de red de los 16 adaptadores con 8 segundos por fuente terminó
en `TIMEOUT` entre errores de red y reintentos; **no se ha confirmado extracción en
vivo ni disponibilidad de los dominios** con ese sondeo.
