# 🎬 Peerflix Ingest

Web estática + GitHub Action que toman una lista de IDs de IMDb, consultan
addons Stremio públicos y se quedan con **solo 2 torrents por película o
episodio**: 🇪🇸 el mejor en español y 🇬🇧 el mejor en inglés, cada uno con los
mejores trackers. **Funciona sin ningún token ni clave.** Supabase, TMDB y el
token de GitHub son extras opcionales.

Addons consultados por IMDb:

- **Peerflix** — https://peerflix.mov/manifest.json
- **TorrentsDB** — https://torrentsdb.com/manifest.json
- **Torrentio** — https://torrentio.strem.fun/manifest.json
- **Ytztvio** — https://ytztvio.galacticcapsule.workers.dev/manifest.json
- **TorrentClaw** — https://torrentclaw.com/api/stremio/manifest.json
- **AniScraper** — https://c5541ffce7d3-aniscraper.baby-beamup.club/manifest.json (solo anime; para lo demás responde vacío)
- **StremThru Torz** — https://stremthru.13377001.xyz/stremio/torz/manifest.json (se consulta en modo P2P, sin debrid)
- **Brazuca Torrents** — https://94c8cb9f702d-brazuca-torrents.baby-beamup.club/manifest.json (doblado al portugués y anime)
- **ThePirateBay+** — https://thepiratebay-plus.strem.fun/manifest.json (**opcional**, desactivado por defecto; ver “Mejoras basadas en la última ingesta”)
- **TPB Adult** — https://tpb-adult-addon.click/manifest.json (solo registrado; ver la nota más abajo)

## Tres formas de usarlo, ninguna necesita token

| | Qué hace | Necesita |
|---|---|---|
| ⚡ **Procesar aquí** | Tu navegador consulta los addons y Cinemeta directamente (todos permiten CORS) con **el mismo código que la Action** (`public/lib/`). Según el tamaño de la lista, guarda en este navegador los 2 torrents de cada título. | Nada |
| ☁️ **Guardar en el repo / BD** | Sin token, la web abre un **Issue ya relleno** (`[ingest] …`). Al enviarlo, `issue-ingest.yml` reemplaza `watchlist.txt` y lanza la Action con el `GITHUB_TOKEN` automático. La Action publica los JSON y el addon Stremio, escribe en Supabase si está configurado y **responde en el Issue** con el resumen. | Ser el dueño o un colaborador del repo (sesión normal de GitHub) |
| ⏰ **Programado** | La Action corre cada día a las 04:00 UTC con el `watchlist.txt` del repo. | Nada |

Con un token opcional (fine-grained, solo este repo, *Contents* + *Actions* en
lectura/escritura), ☁️ actualiza `watchlist.txt` y lanza la Action
directamente, sin pasar por el Issue.

En **Ingestar → Guardar en el repo / BD** puedes elegir la política de series:
seguir una sola hasta completarla y procesar películas, seguir solo la serie
pendiente (sin películas ni descubrimiento) o procesar varias en paralelo.
También puedes activar la rotación de títulos nuevos y marcar por separado si
quieres descubrir películas y/o series; la rotación reemplaza la lista anterior
(salvo la serie activa). En la web el lote nuevo empieza en 10 títulos para que
la primera ejecución sea manejable. Sin activar esa opción, se procesa tal cual
la lista que pegaste. La rotación automática está desactivada por defecto tanto
al ejecutar el workflow como en la ejecución programada: elige `rotate_watchlist=1`
para una corrida manual. Para habilitarla en el cron, define explícitamente la
variable de Actions del repositorio `AUTO_WATCHLIST=1`; si no existe, el cron
conserva la lista sin rotarla.

El resto también funciona sin token:
- **Dashboard**:
  - 📦 lo publicado (`data/index.json` de la propia web);
  - 💻 lo procesado en este navegador;
  - 🗄 Supabase (solo si pones URL + anon key).

  Por cada título muestra su póster y los 2 torrents con su magnet. Se puede filtrar por texto, tipo, calidad o idioma, y exportar a magnets `.txt`, CSV o JSON, o copiar todos los magnets.
- **Cargar `watchlist.txt` del repo**: lo lee de `raw.githubusercontent.com`.
- **Historial**: API pública de GitHub (límite de 60 peticiones/hora sin token).
- **Repo**: se detecta solo, desde `data/index.json` o desde la URL `usuario.github.io/repo`.

## Flujo

```text
watchlist (web ⚡ / Issue ☁️ / watchlist.txt ⏰)
  └─ public/lib/pipeline.js  (mismo código en el navegador y en la Action)
       ├─ Cinemeta (sin API key): título original, año, episodios de cada temporada (o de la serie completa)
       ├─ /stream/movie|series/…json en los 8 addons IMDb por defecto
       │    · una cola por addon: uno lento no frena a los demás
       │    · reintentos con backoff (red, 5xx; respeta Retry-After); 403 → otro User-Agent
       │    · HTTP 429: pausa ese addon (5 s, 10 s, 20 s… máx. 60 s) en vez de cortarlo
       │    · si un addon falla 3 veces seguidas para un tipo, se deja de consultar
       ├─ fusión por info_hash (trackers, addons, idiomas, seeds, tamaño…)
       ├─ 2 picks por título: 🇪🇸 mejor en español + 🇬🇧 mejor en inglés
       └─ magnets con los 10 mejores trackers
  Action (src/fetch.mjs):
       ├─ public/data/{movies,series}, index.json, report.json, progress.json
       │    · series largas: reanuda donde quedó (máx. MAX_EPISODES_PER_RUN)
       ├─ addon Stremio: manifest.json + /stream + catálogo “Mi watchlist”
       ├─ Supabase (opcional): UPSERT por info_hash
       ├─ resumen en el job y respuesta en el Issue
       └─ commit de public/ + GitHub Pages
```

## Solo 2 torrents por título: el mejor en español y el mejor en inglés

Los addons devuelven entre 60 y 220 torrents por película: packs de "IMDb Top
250", versiones en ruso o checo, CAMs, remux de 60 GB… Algunos traen hasta 160
trackers, muchos muertos. `public/lib/select.js` se queda, por cada película o
episodio, con **2 torrents distintos**:

| Hueco | Cuenta como candidato |
|---|---|
| 🇪🇸 **Español** (castellano o latino, da igual) | Peerflix, o `Castellano`/`Latino`/`Español`/`ESP`/`Dual-Lat`/🇪🇸/🇲🇽 como audio. `Sub Español`, `Spanish Subs` o `VOSE` son subtítulos y **no** cuentan. |
| 🇬🇧 **Inglés** | `English`/`ENG`/🇬🇧, o un release sin idioma y sin marcas extranjeras (Torrentio y TorrentsDB no ponen bandera al inglés). |

Dentro de cada hueco gana la mayor puntuación:

- **Calidad**: 4K ≈ 1080p > 720p > 480p.
  - La resolución escrita en el release manda: `RM4K (1080p…)` cuenta como 1080p.
  - También manda sobre lo que declara el addon: Peerflix marca "4K" releases de `wolfmax4k.com` que son `[Bluray 1080p]`.
  - Un **4K reescalado** (`4Kreescalado`, `upscaled`) puntúa por debajo de un 1080p.
- **Salud**: seeders en escala logarítmica, con tope en 100 (a partir de ahí ya
  va fluido). Con 0 seeders, fuerte penalización.
- **Contenido equivocado** (fuerte penalización):
  - **Otra película homónima**: el año del release no cuadra (±1) con el de Cinemeta o, si no se conoce, con el año que repite la mayoría de candidatos. Se ignoran los números que forman parte del título, como `Blade Runner 2049` o `1917`.
  - **Otro episodio o temporada**: se comprueban `S01E02`, `1x01`, `Cap.101`, `T4`, `Season 1-5`, `Temporada 1`… primero en el nombre del archivo y después en el título.
- **Otras penalizaciones**:
  - CAM/TS/screener;
  - packs y colecciones, o títulos que no tienen nada que ver (`IMDb Top 250`, `0peliculas series`…);
  - 3D;
  - subtítulos incrustados (HC);
  - archivos de más de 25 GB, y más aún si pasan de 40 GB.
- **Idioma**:
  - En español, un release en español (solo o dual con inglés) gana a un remux multi-idioma con pista española, y ambos a una 🇪🇸 perdida entre muchas banderas (suelen ser subtítulos).
  - En inglés, la versión original gana a los releases mezclados (MULTi, ITA-ENG, dual español-inglés…).

El pick en inglés nunca repite el torrent elegido en español. Si no hay
candidato para un idioma, ese hueco queda vacío: no se rellena con otro idioma
(el reporte lo marca como `missing`). En series no se penalizan los packs de
temporada porque `fileIdx` apunta al episodio.

Cada pick lleva además su **ficha técnica**, sacada del nombre:
- origen (BluRay, WEB-DL, REMUX…);
- códec (HEVC, AVC, AV1);
- HDR (DV, HDR10, HDR10+);
- audio (Atmos, TrueHD, DTS-HD, DD+, AC3…) y canales.

**Trackers**: cada magnet (y `sources` en el addon Stremio) lleva solo los
mejores trackers públicos de
[ngosang/trackerslist](https://github.com/ngosang/trackerslist) (`trackers_best.txt`).
Van primero los que el torrent ya anunciaba y luego el resto de la lista, hasta
`MAX_TRACKERS` (10 por defecto). Se descarga la lista del día; si falla, se usa
la copia integrada.

## Mejoras basadas en la última ingesta

Se revisó `public/data/report.json` de la última ejecución (159 consultas) y
se corrigió lo que fallaba de verdad. **Ese 159 es el resultado publicado de esa
corrida, no un límite**: el lote automático ahora tiene como objetivo hasta
1000 entradas del watchlist por ejecución. Los JSON existentes no se regeneran
hasta la siguiente ejecución de la Action. Las series completas se expanden a
episodios, por lo que el `total` de consultas puede superar 1000.

| Problema observado | Cambio |
|---|---|
| **Ytztvio**: HTTP 403 en todas las consultas (6 errores y 153 omitidas), pero responde bien desde un navegador | El User-Agent de navegador va primero y, si un addon da 403, se reintenta **una vez** con el siguiente User-Agent |
| **TorrentsDB**: 3 × HTTP 429 y después 56 consultas omitidas por el cortocircuito | Un 429 ya no cuenta como fallo: pausa solo ese addon (Retry-After o 5 s → 10 s → 20 s…, máx. 60 s) y sigue. Solo se corta tras 9 avisos seguidos. Además, TorrentsDB usa 2 consultas a la vez como máximo |
| **ThePirateBay+**: ~6 s por consulta y 14 streams en 159 consultas; aparecía en 4 de 254 picks y **ninguno era solo suyo** (Torrentio y TorrentsDB ya indexan TPB) | Desactivado por defecto, con timeout de 10 s. Se puede activar en ⚙️ Ajustes o con `PROVIDERS=…,piratebay` |
| Una cola común de 4 consultas para todos los addons: el más lento frenaba al resto | Cada addon tiene su propia cola (`concurrency` en `providers.js`, o `FETCH_CONCURRENCY`) |
| TMDB/OMDb y temporadas de respaldo se consultaban de una en una; los JSON se escribían secuencialmente y los datos anteriores se borraban antes de consultar | Pool concurrente acotado para metadatos/temporadas, escrituras paralelas limitadas y limpieza posterior a la pipeline; si esta se aborta antes de acabar, se conserva el último estado publicado |
| AniScraper a veces tarda hasta el 504 de Cloudflare | Timeout propio de 12 s |
| **OMDb**: HTTP 401 en los 100 títulos (100 avisos que tapaban todo lo demás) | Con una API key inválida (401/403) se avisa **una vez** (“revisa el Secret `OMDB_API_KEY`”) y se sigue sin OMDb. Lo mismo con TMDB. Los avisos repetidos se agrupan en el resumen (`… (×100)`) |

`perProviderStats` incluye ahora `picks` (torrents publicados en los que aparece
cada addon), `uniquePicks` (los que **solo** él encontró: si es 0, quitarlo no
cambiaría el resultado) y `rateLimited` (avisos 429). El resumen del job los
muestra en la tabla “Addons consultados”.

### Salud de los addons

```bash
npm run check-providers                       # todos los addons registrados
PROVIDERS=torrentio,brazuca npm run check-providers
STRICT=1 npm run check-providers              # sale con error si cae uno por defecto
```

Prueba cada addon con *Cadena perpetua* (`tt0111161`) y *Juego de Tronos*
S01E01 (`tt0944947:1:1`) con el mismo cliente y parser que la ingesta, y muestra
manifest, latencia y torrents válidos (✅ ok · 🟡 en parte · ⚪ vacío · ❌ caído).
El workflow **Salud de los addons** (`providers-health.yml`) lo ejecuta a mano o
cada lunes y deja la tabla en el resumen del job; solo lee, no hace commits.

## Metadatos sin API key: Cinemeta

`https://v3-cinemeta.strem.io/meta/{movie|series}/{imdbId}.json` es el addon
oficial de metadatos de Stremio y no necesita clave. Se usa para:

- **Expandir series completas** (`tt0944947` sin `:sN`): si el ID es una serie,
  se ingesta de una sola vez con **todas las temporadas y episodios ya
  emitidos** (sin tener que ir añadiendo episodios sueltos). Los especiales
  (temporada 0) y los episodios futuros se descartan.
- **Expandir temporadas completas** (`tt0944947:s1`): da todos los episodios ya
  emitidos. Antes esto exigía `TMDB_API_KEY`, que ahora solo es un respaldo opcional.
- **Nombrar los episodios**: `Juego de Tronos S01E02 – The Kingsroad`.
- **Avisar de etiquetas equivocadas en el watchlist**, por ejemplo:
  > `tt0253474: la etiqueta “El Padrino. Parte II (1974)” no cuadra: en IMDb es “The Pianist (2003)”`
- **Avisar si un ID es una serie** escrita como película, o al revés.
- **Mejorar la selección**: con el título original de IMDb (mejor detección de packs y títulos ajenos) y con el año (películas homónimas).

Si Cinemeta no responde (3 fallos seguidos), se sigue sin metadatos. `CINEMETA=0`
lo desactiva.

## Addon Stremio personal

Instala `https://<usuario>.github.io/<repo>/manifest.json` en Stremio y verás:

- el **catálogo “Mi watchlist · ES + EN”** (películas y series, con pósters);
- en cada título de tu watchlist, **solo 2 streams**: `🇪🇸 Español 1080p` y
  `🇬🇧 Inglés 4K`, con su ficha técnica, seeders y tamaño.

Además, `behaviorHints.bingeGroup` hace que el siguiente episodio siga en el mismo idioma.

## TPB Adult: por qué aparece como “manifest-only”

`tpb-adult-addon.click/manifest.json` no declara streams `movie`/`series` con
IDs IMDb. Declara catálogos de tipo `Porn`, con búsquedas que devuelven IDs
internos `jstrm:*`. Una consulta `stream/Porn/tt...` no es una correspondencia
válida con una lista IMDb y puede devolver contenido no relacionado. Por eso la
URL queda registrada en `public/lib/providers.js`, en `public/manifest.json` y
en el reporte, pero **no se importan resultados adultos aleatorios**. Los nueve
addons consultables sí se piden por cada IMDb ID.

## Formatos de TorrentClaw, StremThru Torz y AniScraper

Estos tres addons no siguen el formato de Torrentio. Por eso tienen dos opciones
en `public/lib/providers.js`, que `parseStremioStream` respeta:

- `titleFromFilename`: el release se lee de `behaviorHints.filename`, porque la
  primera línea del título son badges. TorrentClaw empieza con la puntuación
  (`🔵 65/100 · 👤 579`) y Torz con `💿 BluRay REMUX`. Así un `👤 720` no se toma
  por una resolución.
- `sourceBadge`: indica qué badge marca la fuente. En TorrentClaw es `🏷️`
  (`🌐 1080p` es la calidad), en Torz `🔍` (`⚙️` es el grupo y `🌐` los
  idiomas) y en AniScraper `⚙️`.

Además, para todos los addons:

- **Tamaño**: `💾`/`📏` (archivo), luego `behaviorHints.videoSize` y, por
  último, `📦` (pack de Torz).
- **Seeders**: `👤` o `🌱`.
- **Idiomas**: las líneas `💬 …` son subtítulos y no cuentan como audio.

StremThru Torz exige configuración (`configurationRequired`). Se consulta con
la configuración pública P2P `{"stores":[{"c":"p2p","t":""}]}` en base64, que
ya va incluida en su `baseUrl`. No hace falta token ni debrid.

## Solo addons sin registro

Todos los addons consultados funcionan **sin cuenta, sin debrid y sin token**.
Se descartaron los que exigen registrarse:

- **MediaFusion** y **Comet** (ElfHosted): sin debrid no devuelven torrents.
  Comet responde “Non-debrid searches disabled on ElfHosted” y MediaFusion
  `{"streams":[]}`.
- **Intelligent Debrid Search** (`intell-debridsearch.nepiraw.com`): solo busca
  en *tu* nube de debrid y exige la API key de RealDebrid, AllDebrid, TorBox,
  etc. Sin ella responde `{"streams":[]}`.

**Brazuca Torrents** es P2P y no necesita cuenta. Su primera línea es el
título traducido (“Um Sonho de Liberdade”), así que el release se lee del
archivo. Todo lo que no viene de sus fuentes de anime (EraiRaws, NyaaSi) está
doblado al portugués y se marca con `pt` (`defaultLanguages`). Así un “Dual
Audio” PT + original nunca ocupa el hueco 🇬🇧.

## Descubrimiento: anime, documentales y más

Con la rotación automática del watchlist, cada lote **reserva huecos para
géneros prioritarios**, por defecto anime y documentales. El tamaño predeterminado
es de hasta **1000 entradas por ejecución** (`WATCHLIST_BATCH_SIZE`, máximo 1000):

- **La mitad del lote**, con 1 título por género. En un lote de 8 películas
  entran 1 película de anime y 1 documental. Si el lote es de 1 (la serie que
  se sigue hasta terminarla), se alterna entre anime, documental y una serie
  general.
- **Anime** = catálogo `Animation` de Cinemeta con país **Japón**. Cinemeta no
  tiene género “Anime”, y así no entran los dibujos occidentales.
- **Documentales** = catálogo `Documentary`.
- Se recorren los listados Popular y Featured del género, paginados hasta 500,
  y la página cambia en cada ejecución para no repetir títulos.
- En `watchlist.txt` se marcan con un comentario:
  `tt0245429 Spirited Away (2001)  # Anime`.
- **“Y más”**: el resto del lote sale de los años (1935–2099) y de los rankings,
  que ahora incluyen **todos los géneros de Cinemeta**: acción, comedia,
  terror, ciencia ficción, familia, historia, deporte, western, reality… Se
  omiten Talk-Show y Game-Show, que tienen miles de episodios.
- Con `TMDB_API_KEY`, TMDB también consulta primero anime
  (`with_genres=16&with_original_language=ja`) y documentales
  (`with_genres=99`).
- Para encontrar los streams de anime ya están AniScraper (Nyaa, AnimeTosho…)
  y las fuentes EraiRaws/NyaaSi de Brazuca.

Los géneros prioritarios se cambian con `DISCOVERY_GENRES`, o con el campo
**genres** de *Run workflow*:

- `anime,documentales` *(por defecto)*;
- `anime,documentales,terror,ciencia-ficcion`;
- `0` para ninguno.

Acepta los nombres de Cinemeta (`Horror`, `Sci-Fi`, `Family`…) o alias en
español (`terror`, `familia`, `infantil`, `comedia`…).

## Puesta en marcha

1. **Settings → Pages → Source: GitHub Actions.** Es imprescindible: hoy el repo
   tiene configurado el modo antiguo (“Deploy from a branch” sobre `/docs`, que
   no existe) y cada push lanza un “pages build and deployment” que falla.
2. Haz merge de esta rama en `main`. Los workflows de Issues solo se disparan
   desde la rama por defecto.
3. Opcional, en **Settings → Secrets → Actions**:
   - `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`, para escribir en la tabla
     `torrents`. El service-role key nunca va a la web.
   - `TMDB_API_KEY`: respaldo para expandir temporadas si Cinemeta falla.

Ya está: abre `https://<usuario>.github.io/<repo>/`. En **Ajustes** todo es
opcional (repo autodetectado, token, Supabase, proveedores, Cinemeta y
concurrencia).

### Supabase (opcional)

**Ver títulos en la web no significa que estén guardados en la BD:**

- **⚡ Procesar aquí** guarda solo en el `localStorage` del navegador.
- **📦 Publicado** lee los JSON de GitHub Pages, no la tabla de Supabase.
- La URL + **anon key de Ajustes solo sirven para leer** la tabla en el
  Dashboard. Para escribir, configura `SUPABASE_URL` y
  `SUPABASE_SERVICE_ROLE_KEY` en **Settings → Secrets and variables → Actions**
  del repositorio. Nunca pongas la service-role key en la web ni en el chat.
- Usa **☁️ Guardar en el repo / BD** con **Dry-run desactivado** (`dry_run=0`).
  `DRY_RUN=1`, `DRY_RUN_DB=1`, `FIXTURE_MODE=1` y `REPROCESS=1` no escriben.

El Dashboard, el resumen de la Action y el Issue distinguen **guardados** de
**preparados sin escribir**. En `report.json`, `db.inserted` cuenta solo hashes
cuya escritura fue confirmada (nuevos o actualizados); `db.prepared` cuenta
candidatos válidos únicos. Si se omite la escritura, `db.skipReason` distingue
`dry-run` de `missing-credentials` y `db.missingCredentials` enumera únicamente
los nombres de los Secrets que faltan, nunca sus valores. Los reportes antiguos
con `db.dryRun: true` usaban `inserted` para una simulación: **esas filas no se
guardaron**.

Si Supabase rechaza la escritura, los JSON y el reporte se publican igualmente,
pero el paso final `Verificar resultado de Supabase` marca la Action como
**fallida** y no cierra el Issue como completado. `npm run fetch` también valida
el resultado. Supabase sin configurar sigue siendo un modo válido de solo JSON,
con una advertencia explícita.

Si Supabase devuelve `42P10`, la tabla no tiene una restricción UNIQUE en
`info_hash`, así que `ON CONFLICT` es imposible. La Action lo detecta y cambia
sola a **select + insert de los nuevos + update de los existentes**. Aun así
conviene añadir la restricción para volver al UPSERT nativo:

```sql
ALTER TABLE public.torrents ADD CONSTRAINT torrents_info_hash_key UNIQUE (info_hash);
```

Si la tabla no tiene las columnas `codec`, `hdr_format` o `channels` (o rechaza
sus valores), se reintenta sin ellas. La carga no borra filas anteriores: el
origen 🗄 Supabase del Dashboard muestra también las de ingestas antiguas.

### Seguridad del modo Issue

- Solo actúa si el título empieza por `[ingest]` y el autor es `OWNER`, `MEMBER` o
  `COLLABORATOR`. Los Issues de desconocidos se ignoran.
- El cuerpo del Issue se lee desde `GITHUB_EVENT_PATH` en `src/issue-bridge.mjs`
  y nunca se interpola en la shell.
- Solo pasan líneas IMDb canónicas: `tt1234567[:sN[:eN]] etiqueta`, con la etiqueta
  sin backticks ni caracteres de control y de 200 caracteres como máximo.
- `dry_run` solo acepta 0/1, `providers` solo slugs conocidos y el número de Issue
  se valida como numérico.

## Formato de `watchlist.txt`

```text
tt0111161 Cadena perpetua (1994)
tt1375666 Inception (2010)
tt0944947 Juego de Tronos                          # serie completa: todas las temporadas y episodios
tt0944947:s1:e1 Juego de Tronos S01E01
tt0944947:s1 Juego de Tronos – Temporada 1 completa   # sin API key (Cinemeta)
```

Un ID de serie escrito sin `:sN` se expande a **todas las temporadas y
episodios ya emitidos de una sola vez** (Cinemeta, sin API key): ya no hace
falta ir poniendo los episodios uno a uno. Se acepta un comentario después de
`#` y el texto tras el ID es opcional. Las líneas repetidas, y los episodios
que se solapan con una temporada o serie completa, se consultan una sola vez.
Cargar una lista desde la web **reemplaza por completo** `watchlist.txt`.

## Series largas: historial de progreso y reanudación

Las series con muchos episodios no caben en una sola ejecución, así que la
ingesta **guarda dónde quedó cada serie** y sigue desde ahí:

- `public/data/progress.json` guarda, por serie: episodios hechos
  (`done/total`), **última temporada y episodio ingeridos** (`lastSeason` /
  `lastEpisode`) y por dónde sigue (`nextSeason` / `nextEpisode`). El
  dashboard lo muestra en el panel “📺 Por dónde van las series” y el resumen
  de la Action (y del Issue) incluye la misma tabla.
- **Sigue una sola serie hasta terminarla** (`FOLLOW_SERIES=1` por defecto):
  en vez de acumular decenas de series a la vez avanzando 1 episodio de cada
  una, cada ejecución dedica **todos los episodios del lote**
  (`MAX_EPISODES_PER_RUN`, 60 por defecto) a **una única serie activa**
  (`activeSeries` en `progress.json`) y no empieza otra serie hasta que esa
  termina al 100 %. Cuando se completa, la siguiente corrida pasa
  automáticamente a la siguiente serie pendiente en cola (o descubre 1 nueva).
- En **Ingestar → Guardar en el repo / BD** y en **Run workflow** (`static.yml`)
  puedes elegir:
  - `follow_series = 1` *(por defecto)*: sigue **1 sola serie activa** hasta
    terminarla, mientras procesa las películas de la lista;
  - `follow_series = only`: solo procesa una serie activa cada vez y no mezcla
    películas ni descubre contenido nuevo; cuando termina, puede continuar con
    otra serie que ya estuviera pendiente;
  - `follow_series = 0`: reparte los episodios entre varias series a la vez;
  - `series_id`: opcionalmente indica el IMDb ID (ej. `tt0411008`) de la serie
    concreta que quieres fijar y seguir hasta terminarla;
  - `rotate_watchlist=0` por defecto: no sustituye la lista ni descubre títulos.
    Con `rotate_watchlist=1`, reemplaza el lote anterior con entradas no vistas;
    `discover_movies=0` y/o `discover_series=0` eligen qué tipos nuevos añadir.
    En el modo `only` no hay descubrimiento automático.
- Los episodios ya ingeridos (claves `tt…:sN:eN` de `seen.json`) nunca se
  vuelven a consultar. Si salen episodios nuevos de una serie en emisión, se
  detectan y se ingieren automáticamente.
- Los episodios pedidos a mano (`tt…:s1:e1`) nunca se omiten, aunque ya estén
  en el historial.

## Variables

| Variable | Default | Uso |
|---|---|---|
| `AUTO_WATCHLIST` | `0` | `1` = opt-in: descubre títulos nuevos y reemplaza el lote anterior (excepto la serie activa) |
| `WATCHLIST_BATCH_SIZE` | `1000` en la Action (máximo `1000`) | Entradas del watchlist por lote; solo se usa con `AUTO_WATCHLIST=1`; las series se expanden a episodios y pueden aumentar el total consultado |
| `PROVIDERS` | los 8 por defecto (todos menos `piratebay`) | Addons a consultar (slugs separados por comas) |
| `DRY_RUN` | `0` | `1` = no escribe en Supabase |
| `CINEMETA` | `1` | `0` = sin metadatos |
| `TMDB_API_KEY` | — | Opcional: respaldo para expandir temporadas |
| `OMDB_API_KEY` | — | Opcional: verifica título/año y añade la nota IMDb (si es inválida, se avisa una vez y se ignora) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | Opcionales: UPSERT en `public.torrents` |
| `MAX_TRACKERS` | `10` | Trackers por magnet (1–50) |
| `FOLLOW_SERIES` | `1` | `1` = seguir 1 sola serie a la vez hasta terminarla (+ películas); `only` = solo continuar la serie activa sin películas ni descubrimiento; `0` = varias series a la vez |
| `DISCOVERY_MOVIES` | `1` | `0` = no añadir películas al descubrimiento automático |
| `DISCOVERY_SERIES` | `1` | `0` = no añadir series al descubrimiento automático |
| `DISCOVERY_GENRES` | `anime,documentales` | Géneros con hueco reservado en cada lote del watchlist automático (`0` = ninguno) |
| `SERIES_ID` | — | Opcional: IMDb ID (`tt…`) de la serie a seguir hasta terminarla |
| `MAX_EPISODES_PER_RUN` | `60` | Episodios expandidos como máximo por ejecución (las series largas reanudan donde quedaron; `0` = sin límite) |
| `TRACKERS_URL` | `trackers_best.txt` de ngosang | Vacío = solo la copia integrada |
| `FETCH_CONCURRENCY` / `FETCH_TIMEOUT_MS` | `4` / `15000` | Consultas simultáneas por addon (1–16; algunos providers limitan más) / timeout en ms (1000–120000); valores inválidos usan el default |
| `BREAKER_THRESHOLD` | `3` | Errores seguidos de un addon antes de dejar de consultarlo |
| `REPROCESS` | `0` | `1` = vuelve a elegir sobre `public/data` ya publicado, sin red |
| `FIXTURE_MODE` | `0` | `1` = respuestas falsas, sin red (sobrescribe `public/`) |

`report.json` e `index.json` incluyen:
- por título: `candidateCount`, `streamCount` (máx. 2), `picks` (con magnet y ficha), `missing`, `warnings` y `errors`;
- a nivel global: `totalCandidates`, `totalStreams`, `picks`, `warnings`, `perProviderStats` (respuestas, errores, avisos 429, omitidas, streams, picks aportados, picks únicos y latencia media), `meta` (Cinemeta), `db` (modo usado) y `repository`.

## Mapeo a `public.torrents`

| Columna | Origen normalizado |
|---|---|
| `info_hash` | `stream.infoHash`, lowercase y validado como 40 hex |
| `title` | primera línea de `title` o `description` del addon |
| `type` | `movie` o `series` según la consulta |
| `imdb_id` | ID IMDb de la watchlist |
| `season`, `episode` | partes `:sN:eN` |
| `file_index` | `fileIdx` |
| `quality` | `4K`, `1080p`, `720p` o `480p` cuando aparece |
| `codec`, `hdr_format`, `channels` | ficha técnica del release (si la tabla tiene esas columnas) |
| `audio` | `language` y banderas/texto normalizados a ISO 639-1; el idioma del pick va primero |
| `subtitles` | tags `[ES-EN]`/`[Subs]` cuando aparecen |
| `size_bytes` | `sizebytes` o footer `💾` |
| `seeders` | `seed` o footer `👤`; si no aparece, queda desconocido |
| `release_group` | provider secundario que el addon muestra en el footer |
| `source_tracker` | slugs de addons que publicaron el hash |

El magnet (con los mejores trackers) se construye para la web y el addon
Stremio. No se escribe una columna `magnet_url`. Los registros se agrupan por
conjunto de columnas y se usa `defaultToNull: false`, por lo que la metadata
desconocida no borra valores más ricos ya presentes.

## Estructura

| Ruta | Función |
|---|---|
| `public/lib/providers.js` | Registro de addons (compartido web/Action) |
| `public/lib/parse.js` | Watchlist, normalización de streams, idiomas, calidad, ficha técnica, fusión |
| `public/lib/select.js` | Elige el mejor en español y en inglés; año/episodio; trackers |
| `public/lib/meta.js` | Cinemeta: metadatos y episodios sin API key |
| `public/lib/watchlist.js` | Rotación del watchlist, historial `seen`, descubrimiento de títulos |
| `public/lib/progress.js` | Historial por serie (última temporada/episodio) y reanudación |
| `public/lib/pipeline.js` | HTTP con reintentos, cortocircuito por addon, orquestación, streams publicables |
| `public/lib/issue.js` | Construye e interpreta el Issue de ingesta |
| `public/lib/format.js` | CSV, lista de magnets y resumen Markdown |
| `public/lib/persistence.js` | Estado de escritura de BD compartido por web y Action |
| `src/check-db.mjs` | Hace fallar la ejecución si Supabase rechazó la escritura |
| `src/fetch.mjs` | CLI de la Action: escribe `public/`, addon Stremio y Supabase |
| `src/db.mjs` | Sanitización y UPSERT Supabase (con alternativa si falta UNIQUE) |
| `src/issue-bridge.mjs` | Issue → `watchlist.txt` (modo sin token) |
| `src/summary.mjs` | Resumen para el job y para responder en el Issue |
| `src/check-providers.mjs` | Chequeo de salud de los addons (`npm run check-providers`) |
| `public/index.html` / `public/app.js` / `public/styles.css` | Web estática en español (módulo ES, sin build) |
| `public/data/…` | Último reporte, los 2 picks por título y `progress.json` (por dónde va cada serie) |
| `public/manifest.json` / `public/stream` / `public/catalog` | Addon Stremio personal |
| `.github/workflows/static.yml` | Ingesta diaria, manual o pedida por Issue; responde en el Issue |
| `.github/workflows/issue-ingest.yml` | Puente Issue → `watchlist.txt` → ingesta |
| `.github/workflows/providers-health.yml` | Chequeo de salud de los addons (manual o semanal, solo lectura) |

## Comandos locales

```bash
npm install
npm test
npm run dev                  # http://localhost:4173 (⚡ Procesar aquí funciona desde el navegador)
npm run fetch                # ingesta real (Supabase solo si hay credenciales)
npm run reprocess            # re-elige sobre public/data sin red (tras cambiar criterios)
npm run check-providers      # ¿qué addons responden ahora mismo?
FIXTURE_MODE=1 DRY_RUN=1 node src/fetch.mjs   # sin red; ¡sobrescribe public/ con datos falsos!
```

La web entiende también los `public/data` del formato antiguo (todos los
streams, sin picks): calcula los 2 picks en el navegador hasta que la Action
vuelva a publicar.
