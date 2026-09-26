# Crawler asíncrono de metadatos torrent

Node.js 20+ / TypeScript. Adaptadores independientes para **12 fuentes**, normalización de
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

# Comprobar las nuevas fuentes sin escribir en la base de datos:
DRY_RUN=true TARGET_CRAWLERS=wolftorrent,sinsitio MAX_PAGES=1 npm start
```

El fallback de descarga con navegador de Wolf necesita Chromium:

```bash
npx playwright install chromium
# En un runner Linux, puede necesitar: npx playwright install --with-deps chromium
```

`npm run lint` comprueba tipos. `npm run dev` ejecuta el orquestador en modo watch;
**no implica dry-run**, configura `DRY_RUN=true` explícitamente.

## Estrategia propia de cada web

| TARGET_CRAWLERS | Archivo en `src/crawlers/` | Tratamiento específico |
|---|---|---|
| `pelispanda` | `pelispanda.ts` | API WordPress wpreact; películas, temporadas y episodios; calidad/idioma por descarga. Seeders no publicados = `null`. |
| `leech1337x` | `leech1337x.ts` | Tablas `table-list`, ficha individual, etiquetas Category/Language con texto o elementos HTML; deduplicación de visitas entre búsquedas. |
| `torrentgalaxy` | `torrentgalaxy.ts` | Filas `tgxtablerow`, título de ficha sin concatenar comentarios, magnet o hash de iTorrents, tamaño por celda. La búsqueda no prueba el idioma. |
| `yts` | `yts.ts` | API v2 validada; torrents por calidad, idioma nativo `es`/`es-mx`/`en`, canales de audio y hashes normalizados. No etiqueta francés como inglés. |
| `eztv` | `eztv.ts` | API `get-torrents` y fallback HTML `epinfo`, incluso si la API no está disponible al detectar el dominio. Temporada/episodio ausentes = `null`. |
| `thepiratebay` | `thepiratebay.ts` | APiBay (solo categorías de vídeo), tablas HTML y paginación desde cero; ignora resultados centinela. |
| `mejortorrent` | `mejortorrent.ts` | Plantillas legacy y WordPress; descarga de metainfo con Referer y parser Bencode común. Sin contadores inventados. |
| `elitetorrent` | `elitetorrent.ts` | Fichas, acortador Base64/ROT13, magnets hex/Base32, URLs `.torrent` relativas con query y metadatos fuera del título. |
| `limetorrents` | `limetorrent.ts` | Tablas `table2`; distingue la columna de antigüedad de tamaño, seeders y leechers; fallback de hash en ficha. |
| `nyaa` | `nyaa.ts` | Tablas `torrent-list`, tamaños MiB/GiB, anime y categoría de subtítulos ingleses. MultiSubs no se convierte en audio español. |
| `wolftorrent` | `wolftorrent.ts` | Catálogos `/peliculas` y `/series`; fichas `/pelicula/:id/:slug` y `/serie/:id/:slug`; enlaces, atributos de descarga y URLs literales en botones. Fallback de clic normal con Playwright. |
| `sinsitio` | `sinsitio.ts` | Posts DLE `/<categoría>/<id>-<slug>.html`; decodifica `ddlUrl.php?url=<Base64>&name=...` hacia adjuntos públicos `index.php?do=download&id=...` o `engine/download.php?id=...`. Conserva variantes de calidad. |

Los dos adaptadores nuevos comparten únicamente el transporte en `html-catalog.ts`:
concurrencia de dos fichas, enlaces relativos, paginación publicada por la web,
protección contra bucles, deduplicación y validación de metainfo. Sus rutas y
selectores permanecen en archivos separados. No se siguen anuncios ni se inventan
endpoints a partir de IDs.

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
| `SUPABASE_URL` | — | Necesario si `DRY_RUN=false`. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Necesario si `DRY_RUN=false`; guardar en `.env` local o secretos de Actions. |
| `WOLFTORRENT_BASE_URL` | `https://wolftorrent.com/` | Dominio de Wolf. |
| `SINSITIO_BASE_URL` | `https://www.sinsitio.site/` | Dominio de Sinsitio. |
| `WOLFTORRENT_BROWSER` | `true` | Fallback de navegador; `false` para extracción estática únicamente. |

También se conservan `NYAA_BASE_URL`, `ELITETORRENT_BASE_URL`,
`MEJORTORRENT_BASE_URL` y `LIMETORRENTS_BASE_URL`.

## Validación y límites

- Parser Bencode único en `utils/bencode2.ts`: hash SHA-1 de los **bytes originales**
  del diccionario `info` de raíz, tamaños multifichero, trackers, comprobaciones de
  límites/profundidad y rechazo de descargas dañadas. `bencode.ts` conserva la API
  de compatibilidad. Metainfo v2-only no es compatible con el esquema BTIH v1.
- Los registros se deduplican con infohash normalizado de 40 caracteres hexadecimales.
- El filtro existente acepta **español o inglés**, en audio o subtítulos; pese al
  nombre histórico `hasValidSpanishRelease`, no es un filtro exclusivo de español.
  También conserva los tags genéricos Multi-Subs/Subtitulado. Algunos adaptadores
  antiguos tienen heurísticas de idioma por fuente; las nuevas fuentes y Nyaa no
  asignan inglés automáticamente cuando no hay evidencia. Un registro de idioma
  desconocido puede descubrirse pero quedar descartado antes del UPSERT.
- Seeders/leechers desconocidos no se fabrican en Pelispanda, MejorTorrent ni las
  fuentes nuevas. La capa de persistencia existente convierte valores desconocidos
  a sus defaults de base de datos.
- Las descargas de metainfo de las nuevas fuentes, EliteTorrent y MejorTorrent se
  limitan a 10 MiB. No se extraen ni se ejecutan ficheros descargados.
- Ningún espejo está garantizado: un sitio puede cambiar de plantilla, cerrar,
  limitar solicitudes o requerir autenticación. Los adaptadores nuevos emiten
  diagnóstico y fallan explícitamente si no consiguen ningún torrent válido.
  El orquestador aísla errores por fuente y muestra el resumen `Errors`.

## Pruebas y verificación

`npm test` ejecuta pruebas **sin conexión y sin Supabase**, con HTML sintético y
respuestas HTTP simuladas específicas de las 12 fuentes. Incluye descargas DLE,
Base64, episodios, variantes, paginación cíclica, fallback API→HTML, tamaños,
idiomas, hashes, metainfo corrupto y normalización. Los fixtures documentan rutas
observadas, pero **no son capturas completas de las webs ni certifican disponibilidad**.
El clic real de Playwright de Wolf requiere una comprobación en vivo.

En esta revisión (26-09-2026) se pudieron consultar las páginas públicas de
Wolftorrent y Sinsitio mediante la herramienta de lectura web, incluyendo las
rutas de fichas y el enlace DLE codificado de Sinsitio. La conexión HTTPS directa
del entorno de ejecución falló con `SSL_ERROR_SYSCALL`: **no se ha verificado una
extracción completa en vivo ni el UPSERT real**. Ejecuta primero el dry-run de una
página desde tu runner y revisa `Discovered`, `Accepted OK` y `Errors`.

## GitHub Actions

El workflow `.github/workflows/main.yml` se ejecuta cada seis horas o manualmente.
Permite elegir las 12 fuentes, incluidas Wolftorrent y Sinsitio; `all` incluye ambas.
Instala dependencias con `npm ci`, compila y ejecuta las pruebas antes de crawlear.
Configura las claves de Supabase como secretos del repositorio para escritura real.
