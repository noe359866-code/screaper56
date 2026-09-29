# Crawler asíncrono de metadatos torrent

Node.js 20+ / TypeScript. Adaptadores independientes para **20 fuentes**, normalización de
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
DRY_RUN=true TARGET_CRAWLERS=priority MAX_PAGES=1 npm start
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
| `pelispanda` | `pelispanda.ts` | API WordPress wpreact; películas, temporadas y episodios; calidad/idioma por descarga. Acepta entradas `.torrent` (descargando el metainfo para obtener el hash real) además de magnets. Seeders no publicados = `null`. |
| `leech1337x` | `leech1337x.ts` | Tablas `table-list`, ficha individual, etiquetas Category/Language con texto o elementos HTML; deduplicación de visitas entre búsquedas. |
| `torrentgalaxy` | `torrentgalaxy.ts` | Filas `tgxtablerow`, título de ficha sin concatenar comentarios, magnet o hash de iTorrents, tamaño por celda, seeders/leechers por clase y `torrent_file_url` solo si el enlace iTorrents lleva el mismo hash. La búsqueda no prueba el idioma. |
| `yts` | `yts.ts` | API v2 validada; torrents por calidad, idioma nativo (`es`, `es-419`, `es-ve`, `en-gb`, `pt-br`, …), canales de audio y hashes normalizados. No etiqueta francés como inglés. |
| `eztv` | `eztv.ts` | API `get-torrents` y fallback HTML `epinfo`, incluso si la API no está disponible al detectar el dominio. Temporada/episodio ausentes = `null`. |
| `thepiratebay` | `thepiratebay.ts` | APiBay (solo categorías de vídeo), búsquedas JSON, tablas HTML y paginación desde cero; ignora resultados centinela. En la fase HTML el tipo sale de la categoría de la fila y la ficha aporta IMDb y enlace `.torrent` del propio dominio. |
| `mejortorrent` | `mejortorrent.ts` | Detección de plantilla legacy/WordPress; descarga de metainfo con Referer y parser Bencode común. Sin contadores inventados. |
| `elitetorrent` | `elitetorrent.ts` | Fichas, acortador Base64/ROT13, magnets hex/Base32, URLs `.torrent` relativas con query y metadatos fuera del título. |
| `limetorrents` | `limetorrent.ts` | Tablas `table2`; localiza la columna de tamaño por contenido para que la antigüedad no desplace seeders/leechers; búsqueda POST con fallback GET. |
| `nyaa` | `nyaa.ts` | Tablas `torrent-list`, tamaños MiB/GiB, anime y categoría de subtítulos ingleses. Descarta audio, literatura, software e imágenes: una búsqueda `c=0_0` ya no los archiva como anime. MultiSubs no se convierte en audio español. |
| `wolftorrent` | `wolftorrent.ts` | Catálogos `/peliculas` y `/series`; fichas `/pelicula/:id` y `/serie/:id` (layout 2026 sin slug; el legacy `/:id/:slug` y las fichas `/serie/episodio/:id` siguen soportados); enlaces, atributos de descarga y URLs literales en botones. Fallback de clic normal con Playwright. |
| `sinsitio` | `sinsitio.ts` | Posts DLE `/<categoría>/<id>-<slug>.html`; decodifica `ddlUrl.php?url=<Base64>&name=...` hacia adjuntos públicos `index.php?do=download&id=...` o `engine/download.php?id=...`. Conserva variantes de calidad. |
| `rarbg` | `rarbg.ts` | **Nueva fuente.** Clones de RARBG (`rarbgproxy.to`): búsquedas `spanish/castellano/latino` y catálogos `/movies/`, `/tv/`, `/anime/`, `/documentaries/`; magnet, campo `Language:` y peers desde la ficha. XXX y categorías no-vídeo descartadas. Variables `RARBG_MIRRORS`, `RARBG_SEARCH`, `RARBG_CONCURRENCY`. |
| `magnetdl` | `magnetdl.ts` | **Nueva fuente.** `magnetdl.co`: búsquedas `/<letra>/<slug>/` y `/download/movies/`, `/download/tv/`; el magnet se lee de la fila o de `/single/:id`. Variables `MAGNETDL_MIRRORS`, `MAGNETDL_SEARCH`, `MAGNETDL_CONCURRENCY`. |
| `tokyotosho` | `tokyotosho.ts` | **Nueva fuente.** Tokyo Toshokan: filas `desc-top`/`desc-bot`, categorías Anime, Batch, Non-English y Drama más búsquedas; hentai/JAV/música/manga excluidos. Variables `TOKYOTOSHO_MIRRORS`, `TOKYOTOSHO_SEARCH`, `TOKYOTOSHO_CONCURRENCY`. |
| `t0rrenta` | `t0rrenta.ts` | **Nueva fuente.** Catálogo de portada y sitemap, fichas `/p/:id`, metainfo `.torrent` firmado descargado y validado para obtener el infohash real; conserva TMDB ID y variantes. Variables `T0RRENTA_BASE_URL`, `T0RRENTA_MIRRORS`, `T0RRENTA_CONCURRENCY`. |
| `estrenostorrent` | `estrenostorrent.ts` | **Nueva fuente.** Catálogos `/peliculas/` y `/series/`, fichas `/online/...` o `/serie-online/:id`, y enlaces `.torrent` del mismo sitio validados con el parser Bencode. Variables `ESTRENOSTORRENT_BASE_URL`, `ESTRENOSTORRENT_MIRRORS`, `ESTRENOSTORRENT_CONCURRENCY`. |
| `grantorrent` | `grantorrent.ts` | WordPress de películas. Requiere configurar un dominio verificado con `GRANTORRENT_BASE_URL` o `GRANTORRENT_MIRRORS`: el repositorio no incluye un host por defecto válido. Tarjetas con póster, detalle, idioma e IMDb; solo acepta magnets directos o `.torrent` del mismo sitio; no sigue acortadores. |
| `dontorrent` | `dontorrent.ts` | **Nueva fuente.** Catálogos `/peliculas`, `/series`, `/documentales` con paginación `?p=N`; fichas `/pelicula/:id/:slug` y `/serie/:id/:id/:slug`; tabla de episodios `1x02`; búsqueda POST opcional a `/buscar`; lista de dominios oficiales `/dominios` como reserva de espejos. |
| `rutracker` | `rutracker.ts` | **Nueva fuente (con sesión).** RuTracker.org: HTML en **Windows-1251**, sesión obligatoria (cookies exportadas o login con usuario/contraseña), búsquedas `tracker.php?nm=` y secciones `viewforum.php?f=`; el magnet se lee de `viewtopic.php?t=` y, si falta, del `dl.php?t=` autenticado. Variables en `.env.example`. |

### Auditoría del resto de fuentes: paginación publicada y campos recuperados

Todo el proyecto comparte ahora dos ayudas en `src/crawlers/support.ts`:

- **`sameHost(a, b)`**: compara hosts ignorando `www`, de modo que un espejo que
  alterna `www.` y dominio raíz deja de perder fichas (GranTorrent, Sinsitio).
- **`nextPaginationLink(html, url)`**: devuelve el siguiente listado **que la
  propia página publica** (`rel="next"`, «Next»/«»»/«siguiente», el número que
  avanza o el offset `start=`/`offset=`) y `null` en cualquier otro caso. Sustituye
  los bucles que adivinaban `?p=N` o `/page/N/`: los espejos que ignoran esos
  números volvían a servir la página 1, así que una sección de una sola página
  costaba `maxPages` peticiones idénticas.

Con esa base se corrigieron, fuente por fuente:

| Fuente | Problema corregido |
|---|---|
| `rarbg` | Tamaño/seeders/leechers se localizan **por contenido** (los espejos añaden o quitan la columna de fecha) y la ficha guarda el `.torrent` que publica. |
| `magnetdl` | El paginador solo reconocía «next»/números exactos: ahora sigue `rel=next`, flechas y la ruta numerada; la ficha `/single/:id` aporta el `.torrent` del propio sitio. |
| `limetorrents` | Los catálogos dejaron de pedir `/browse-torrents/.../2/` a ciegas y la ficha aporta IMDb y `.torrent`. |
| `thepiratebay` | La fase HTML deduce el tipo de la categoría de la fila (serie/anime/documental) y enriquece cada registro con la ficha. |
| `leech1337x` | El paginador publicado sustituye al número adivinado y se guarda el `.torrent` de la ficha cuando existe. |
| `nyaa` | Descarta audio, literatura, software e imágenes. |
| `torrentgalaxy` | Seeders/leechers por clase (`[class*="seed"]`) y `torrent_file_url` solo con hash coincidente. |
| `eztv` | El IMDb se lee de la fila, nunca de la página entera. |
| `yts` | `es-419`, `es-ve`, `en-gb`, `pt-br`… conservan su etiqueta de audio en vez de caer en «desconocido». |
| `mejortorrent` | El listado legacy recorre el paginador publicado y se detiene en la última página real. |
| `pelispanda` | Una página repetida termina la categoría (antes seguía hasta `maxPages`) y se aceptan entradas `.torrent`. |
| `grantorrent` | Tarjetas con o sin `www`, rutas `/pelicula/` de uno o dos segmentos, e IMDb de la ficha. |
| `sinsitio` | Posts y adjuntos `do=download` con `www` ↔ dominio raíz. |

Nada de esto relaja las reglas del proyecto: los contadores desconocidos siguen
siendo `null`, no se inventa ningún infohash (un enlace `.torrent` se descarga y
se parsea), y un `.torrent` de otro dominio nunca se guarda como `torrent_file_url`.

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

### RuTracker: sesión, Windows-1251 y paginación real

RuTracker es un tracker privado: **todo lo que lee este adaptador es lo que ve
la cuenta configurada**. El crawler entra con las cookies de la sesión o con el
usuario y la contraseña del `.env`, recorre los listados a los que esa cuenta
tiene acceso y guarda el magnet que publica la propia ficha. No resuelve
CAPTCHAs, no salta retos ni evade límites de descarga: si el sitio responde con
una CAPTCHA, la ejecución se detiene y lo dice (`RutrackerCaptchaError`).

Cómo funciona cada pieza:

- **Credenciales.** `RUTRACKER_COOKIE_JSON` acepta el JSON que exportan las
  extensiones de navegador (el formato `{name, value, domain, ...}`), o bien un
  `Cookie:` en crudo en `RUTRACKER_COOKIES`; ambos admiten `@ruta/archivo.json`
  para no tener el secreto en la línea de comandos. Si las cookies caducan (o no
  hay ninguna), se usa `RUTRACKER_USERNAME`/`RUTRACKER_PASSWORD` con un POST al
  formulario real de `login.php`, codificado en cp1251 igual que lo envía el
  navegador. Sin sesión ni credenciales, el adaptador **falla con un mensaje
  accionable** en lugar de rastrear como anónimo (un rastreo anónimo no vería
  ningún magnet y parecería un parser roto).
- **Windows-1251.** El cuerpo se descarga como bytes y se decodifica con la
  codificación que declara la página: con UTF-8, los títulos en cirílico llegan
  como *mojibake* y los metadatos se pierden. Las búsquedas se codifican en
  cp1251 (`RUTRACKER_SEARCH_CHARSET=utf-8` para términos acentuados).
- **Paginación.** Solo se siguen los offsets `start=` que publica el paginador:
  una búsqueda de una sola página cuesta **una** petición, y una página repetida
  termina la ruta en vez de repetir la consulta.
- **Filtro previo de idioma.** Antes de gastar una petición por ficha se
  descartan los temas cuyo título no muestra español/inglés
  (`RUTRACKER_LANG_PREFILTER=false` para visitarlos todos; el filtro completo de
  idioma del orquestador se sigue aplicando a los registros resultantes).
- **Swarm y tamaño.** Se leen de la fila del listado (`td.tor-size`, `seedmed`,
  `leechmed`) y se completan con la ficha; nunca se inventan.

Variables: `RUTRACKER_BASE_URL`, `RUTRACKER_MIRRORS`, `RUTRACKER_USERNAME`,
`RUTRACKER_PASSWORD`, `RUTRACKER_COOKIE_JSON`, `RUTRACKER_COOKIES`,
`RUTRACKER_SEARCH`, `RUTRACKER_SEARCH_CHARSET`, `RUTRACKER_FORUMS`,
`RUTRACKER_ROUTES`, `RUTRACKER_SORT`, `RUTRACKER_CONCURRENCY`,
`RUTRACKER_LANG_PREFILTER`, `RUTRACKER_MIN_SEEDERS`.

```bash
# Comprobar la sesión y la extracción sin escribir en la base de datos:
DRY_RUN=true TARGET_CRAWLERS=rutracker MAX_PAGES=1 LOG_LEVEL=debug npm start
```

## Configuración

| Variable | Predeterminado | Uso |
|---|---|---|
| `DRY_RUN` | `false` | `true`: no escribe en Supabase ni requiere sus credenciales. |
| `TARGET_CRAWLERS` | `priority` | Fuentes en español + principales globales; `all` ejecuta las 20 o pasa una lista separada por comas. |
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

El preset `priority` concentra fuentes en español (`dontorrent`, `elitetorrent`,
`estrenostorrent`, `mejortorrent`, `pelispanda`, `sinsitio`, `t0rrenta`, `wolftorrent`)
y fuentes globales principales (`leech1337x`, `torrentgalaxy`, `yts`, `eztv`,
`thepiratebay`, `limetorrents`, `magnetdl`, `nyaa`, `rutracker`). `grantorrent`
requiere configurar un dominio vigente y se ejecuta de forma individual o con
`all`; `rarbg` y `tokyotosho` también siguen disponibles fuera del preset.

### Dominios y espejos

Cada fuente acepta dos variables, con el nombre del crawler en mayúsculas:

- `<FUENTE>_BASE_URL`: fija un único dominio, que se prueba antes que ningún otro.
- `<FUENTE>_MIRRORS`: lista separada por comas que sustituye a los espejos
  predeterminados del adaptador.

Ejemplos: `DONTORRENT_MIRRORS`, `WOLFTORRENT_BASE_URL`, `SINSITIO_MIRRORS`,
`NYAA_BASE_URL`, `ELITETORRENT_BASE_URL`, `MEJORTORRENT_MIRRORS`,
`LIMETORRENTS_BASE_URL`, `TORRENTGALAXY_MIRRORS`, `THEPIRATEBAY_MIRRORS`,
`APIBAY_BASE_URL`, `YTS_MIRRORS`, `EZTV_MIRRORS`, `LEECH1337X_MIRRORS`,
`PELISPANDA_MIRRORS`, `T0RRENTA_BASE_URL`, `ESTRENOSTORRENT_BASE_URL`.

Concurrencia y búsquedas por fuente: `DONTORRENT_CONCURRENCY`,
`ELITETORRENT_CONCURRENCY`, `MEJORTORRENT_CONCURRENCY`, `LIMETORRENTS_CONCURRENCY`,
`LEECH1337X_CONCURRENCY`, `PELISPANDA_CONCURRENCY`, `T0RRENTA_CONCURRENCY`,
`ESTRENOSTORRENT_CONCURRENCY`, `DONTORRENT_SECTIONS`,
`DONTORRENT_SEARCH`, `DONTORRENT_CDN_HOSTS`, `DONTORRENT_DISCOVER_MIRRORS`,
`LIMETORRENTS_SEARCH`, `THEPIRATEBAY_SEARCH` y las variables `RUTRACKER_*`
de la sección anterior (sesión, búsquedas, foros y concurrencia). Todas están
documentadas en `.env.example`.

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
respuestas HTTP simuladas específicas de las 17 fuentes, más pruebas unitarias de
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
El schedule y la opción manual predeterminada usan `priority`: fuentes en español y
fuentes globales principales (incluye RuTracker). Puedes escoger una fuente individual
o `all` para las 20. Instala dependencias con `npm ci`, compila y ejecuta las pruebas
antes de crawlear.
Configura las claves de Supabase como secretos del repositorio para escritura real,
y `RUTRACKER_USERNAME` + `RUTRACKER_PASSWORD` (o `RUTRACKER_COOKIE_JSON`) para la
fuente autenticada. El workflow ya pasa `secrets.RUTRACKER_COOKIE_JSON` a la variable
de entorno del mismo nombre; no hace falta editar el YAML ni subir el JSON al repo.

Para cargar el JSON de cookies en GitHub:

1. Abre **Settings → Secrets and variables → Actions → New repository secret**.
   Usa un secreto del repositorio; el workflow actual no declara un GitHub Environment.
2. Usa exactamente `RUTRACKER_COOKIE_JSON` como nombre.
3. Pega como valor el JSON exportado completo, por ejemplo
   `[{"name":"bb_session","value":"...","domain":".rutracker.org"},{"name":"bb_guid","value":"...","domain":".rutracker.org"}]`.
   Pega el contenido JSON literal: sin comillas extra alrededor y sin `@ruta/archivo`.
4. Guarda el secreto y ejecuta el workflow manualmente con `priority`, `all` o
   `rutracker`.

Las cookies son credenciales de sesión: no las publiques en logs, issues ni commits;
pueden caducar y habrá que reemplazarlas por una exportación nueva. Tanto `priority`
como `all` incluyen RuTracker: sin una cookie válida o usuario/contraseña configurados,
ese adaptador se marca como error y el job termina con código distinto de cero.
Para probar sin tocar Supabase, marca `dry_run` o selecciona `rutracker` y configura
`DRY_RUN=true` localmente.

## Diagnóstico de extracción (sin Supabase)

Desde la carpeta que contiene `package.json`:

```bash
npm ci
npm run diagnose                    # los 20 adaptadores, una página por ruta
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
TypeScript. El sondeo de red de los 17 adaptadores con 8 segundos por fuente terminó
en `TIMEOUT` entre errores de red y reintentos; **no se ha confirmado extracción en
vivo ni disponibilidad de los dominios** con ese sondeo.

### Fallos de fuentes y espejos (diagnóstico)

`Failed sources` ahora imprime la causa fatal y una recomendación específica para
cada fuente. `npm run diagnose -- leech1337x pelispanda torrentgalaxy
elitetorrent limetorrents wolftorrent dontorrent magnetdl rarbg` ejecuta cada
adaptador sin Supabase y devuelve `diagnosis.kind` (`dns`, `network`, `blocked`,
`layout`, `empty`, `timeout`, `download` o `unknown`) y `diagnosis.advice`.
Un `TIMEOUT` no prueba que los selectores estén rotos; primero comprobar DNS/TLS
**desde el runner**. Los mirrors configurables son `NOMBRE_MIRRORS` y
`NOMBRE_BASE_URL`; un dominio sugerido no garantiza accesibilidad ni autorización.
Pelispanda, MagnetDL, RARBG y WolfTorrent no continúan con un espejo que no haya
pasado la sonda de contenido; no intentan resolver CAPTCHAs interactivos ni saltar
las restricciones de descarga.

**GranTorrent:** no hay un dominio predeterminado verificado ni se ha confirmado
la disponibilidad o plantilla actual del sitio. Configura `GRANTORRENT_BASE_URL`
o `GRANTORRENT_MIRRORS` antes de ejecutarlo o diagnosticarlo. Si una ficha solo
publica un acortador opaco, el adaptador la cuenta como `gated` y no inventa un
magnet ni un hash.

### Control de errores e identificación de torrents

El resumen clasifica el error original antes de acortar el texto de salida; en
particular, un espejo con DNS fallido y otro que agotó el tiempo se informa como
fallo mixto de red. También se registra un fallo de `close()` si ocurre durante
la limpieza, sin confundirlo con una ejecución exitosa. La identificación v1
solo admite `urn:btih:` válido (hex o Base32): rechaza `urn:btmh:` de v2,
infohash todo ceros y magnets con `xt` BTIH contradictorios. Los metainfo
`.torrent` con campos de piezas malformados tampoco se aceptan.

## Persistencia segura y pruebas del orquestador

El servicio requiere un índice/constraint **UNIQUE(info_hash)**. Ante un error de
esquema ya no hace INSERT a ciegas: falla con diagnóstico y el CLI devuelve código
1. Los lotes fallidos pueden dejar otros lotes ya guardados; no es una transacción
global. Los metadatos ausentes se agrupan por columnas para no borrar valores
conocidos en los UPSERT mixtos. Comprueba los defaults del esquema antes de usarlo.

En `DRY_RUN=true`, `Upserted` es **0** y `Would upsert` muestra los registros que se
habrían enviado. Los errores de persistencia parcial quedan en el resumen.
`DRY_RUN`, los enteros de configuración y la lista de fuentes se validan de forma
estricta; los typos no se convierten silenciosamente en otro modo de ejecución.

`index.ts` se puede importar sin arrancar el scraper; `main` acepta configuración,
repositorio y registro de crawlers para pruebas offline. La suite prueba también
el transporte Supabase con fetch simulado, sin credenciales reales.

Detalles, límites de esquema y cambios respecto al antiguo fallback:
[AUDITORIA_SERVICIOS_2026-09-28.md](AUDITORIA_SERVICIOS_2026-09-28.md).

### Segunda auditoría de las 20 fuentes

La matriz de regresión se genera desde `CRAWLER_REGISTRY`, con pruebas comunes
para todos los adaptadores y casos específicos de extracción. Ver
[AUDITORIA_TODOS_CRAWLERS_2026-09-28.md](AUDITORIA_TODOS_CRAWLERS_2026-09-28.md)
para las correcciones, los límites cooperativos y los resultados de conectividad.
Bloqueos y HTTP 429 ya no se confunden con catálogos vacíos recuperables.
