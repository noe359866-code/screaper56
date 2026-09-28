# Segunda revisión: los 20 crawlers registrados

Fecha: 2026-09-28. Se conservan las correcciones de los turnos anteriores.
Alcance: todos los adaptadores de `CRAWLER_REGISTRY`, transporte y utilidades
compartidas, pruebas offline y comprobación limitada de conectividad.
No se escribió en Supabase ni se usaron cuentas de trackers.

## Cobertura por fuente

Todos participan en una matriz generada desde el registro real: presupuestos de
páginas inválidos no hacen I/O, mirrors inaccesibles no devuelven éxito vacío y
helpers compartidos no inician peticiones/navegador después del deadline.
La suite previa de cada fuente continúa ejecutándose.

| Fuente | Revisión y resultado de esta ronda |
| --- | --- |
| pelispanda | API y estructura anidada; se conserva la tolerancia a entradas malformadas de la ronda anterior. Los 429/bloqueos/deadline ya no se consumen como una ficha o descarga simplemente omitida. |
| leech1337x | Listado → ficha, restricciones de URL y paginación. Se conservan las correcciones de enlaces absolutos. Los errores terminales se propagan. |
| torrentgalaxy | Magnets, fallback iTorrents y paginación. Se conserva la comprobación de hash del metainfo; bloqueo/rate-limit detiene el recorrido en lugar de probar todas las rutas restantes. |
| yts | API v2 y variantes por calidad. `language` no textual ya no lanza TypeError y descarta una página entera. Se mantiene el filtro de URLs del mirror. |
| eztv | API, fallback HTML y metadatos estructurados. No se intenta HTML tras un 429 terminal; una indisponibilidad ordinaria de API mantiene su fallback. |
| thepiratebay | APiBay y HTML independientes. `name` no textual ya no lanza por `.trim()`; se rechaza esa fila. Errores terminales no se ocultan como consultas vacías. |
| mejortorrent | Plantillas legacy/WordPress, links publicados y metainfo. Se rechazan URLs con credenciales; detectar plantilla no oculta un rate-limit. HTML bloqueado se rechaza por defecto. |
| elitetorrent | Fichas, decodificación y metainfo. Conserva los extractores existentes; bloqueos y 429 ya no se consumen en los catches de listado/ficha/descarga. |
| limetorrents | Búsqueda POST/GET, tablas y fichas. Un 429 en POST no desencadena más solicitudes por GET. Añadida comprobación de presupuesto antes del POST directo. |
| nyaa | La categoría por fila identifica subtítulos en búsquedas generales y prevalece sobre el endpoint. Los IDs de categoría excluyen audio/software/etc. aunque falte el texto del icono. Live-action episódico conserva tipo series. |
| wolftorrent | Dos metainfo que comparten cabecera bencode ya no colisionan: la identidad temporal de blobs usa SHA-256 de todo el buffer, no los primeros ocho bytes. No se publican URLs blob. |
| sinsitio | DLE, attachments y pipeline HTML heredado. Ya no se recurre implícitamente a un mirror que falló todas las sondas. Conserva decodificación Base64 y restricciones de enlaces. |
| dontorrent | Catálogos, búsqueda y descargas públicas. Presupuesto comprobado antes del POST; 429/bloqueos no se ocultan. No se modificó la decisión de omitir descargas protegidas por proof-of-work. |
| rarbg | Clones, categorías, fichas y paginación publicada. Reutiliza las correcciones compartidas y propaga fallos terminales; no se presupone disponible el RARBG original. |
| magnetdl | Filas, fichas y paginación restringida a la ruta. Conserva extracción del primer magnet válido; aborta ante errores terminales en vez de continuar otras rutas. |
| tokyotosho | Una fila sin `desc-bot` ya no toma estadísticas/descargas de la siguiente entrega. La categoría explícita prevalece sobre CSS genérico `category_0`; subtítulos ingleses se asignan por la categoría real. |
| grantorrent | Deduplica enlaces repetidos sin descargar el mismo archivo varias veces, fusiona su evidencia de idioma y no cuenta esos duplicados como enlaces protegidos. Conserva trackers y tamaño del metainfo y registra métricas de fichas/resultados. |
| rutracker | Se mantiene el tratamiento propio de captcha/rate-limit, sesión y Windows-1251. Añadida comprobación de presupuesto antes de las solicitudes directas de autenticación y metainfo. Sin login real. |
| t0rrenta | Tarjetas, sitemap y descargas firmadas revisados; mantiene deduplicación por ruta completa de la ronda previa. Los helpers ahora comprueban también el presupuesto antes del sitemap/metainfo. |
| estrenostorrent | Rutas de películas/series, paginación y descargas firmadas revisadas. Ya propagaba bloqueos y 429; ahora recibe la comprobación común de deadline. Sin cambios especulativos en selectores. |

## Cambios transversales

- `fetchHtml` rechaza interstitials HTTP 200 por defecto. Los adaptadores que
  toleran errores de una ficha siguen tolerando errores ordinarios, pero no
  ocultan `BlockedPageError`, 429 ni `CrawlerDeadlineError`.
- El pool compartido deja de repartir trabajo si una tarea falla y espera las
  tareas ya iniciadas (comportamiento existente, conservado). Se añade un techo
  de **32 workers por llamada** para evitar valores ambientales descontrolados.
  No es un límite global de todos los crawlers ni de todas las sondas de mirrors.
- El presupuesto se comprueba antes de los fetch compartidos, sondas y apertura
  de páginas de navegador. El timeout de una nueva petición se reduce al tiempo
  restante cuando corresponde.
- **Sigue siendo un presupuesto cooperativo**, no cancelación dura de todo el
  proceso: reintentos internos, backoff, callbacks de navegador o solicitudes ya
  iniciadas pueden excederlo. El diagnóstico en proceso hijo y el timeout de CI
  siguen siendo los límites externos.
- `absoluteHttpUrl` rechaza credenciales embebidas, incluidas las heredadas de la
  URL base. Las restricciones existentes de host/esquema/puerto permanecen.
- `parseCount` rechaza enteros inseguros, fracciones y separadores malformados
  (`1,5` ya no se convierte en 15). Mantiene 0 y separadores de miles válidos.
- `describeError` detecta ciclos entre objetos de error anidados en lugar de
  provocar recursión infinita al intentar escribir el diagnóstico.
- Se completaron las recomendaciones operativas de diagnóstico para las 20
  fuentes. No se añadieron mirrors especulativos ni se deshabilitó TLS.

## Pruebas

Nueva suite: `tests/all-crawlers-second-audit.test.js`.

- **95 pruebas nuevas**: 60 de matriz (3 por cada uno de los 20 adaptadores),
  19 de rate-limit después de seleccionar mirror y 16 de regresiones concretas.
- RuTracker conserva su suite específica de rate-limit/captcha/autenticación;
  no se sustituyó su manejo especializado por el de las fuentes públicas.
- **410 pruebas totales pasando**, sin fallidas.
- `npm run lint`, `npm run build`, `npm test` y `git diff --check` correctos.
- Ocho expectativas antiguas se actualizaron al error específico correcto:
  siete páginas bloqueadas ahora conservan `BlockedPageError` y Sinsitio informa
  `MirrorResolutionError` sin intentar un mirror no verificado. No se eliminaron
  esas pruebas ni se convirtió el fallo en un éxito vacío.
- Browser, streams y HTTP se simulan en las regresiones; no implican que la
  plantilla actual de cada web haya sido validada en vivo.

## Comprobación de conectividad

Una petición GET por URL, timeout de 10 s, máximo de tres redirecciones y cuatro
peticiones concurrentes, sin cookies, autenticación ni navegador.

| Fuente / endpoint comprobado | Resultado desde este entorno |
| --- | --- |
| pelispanda.org/wp-json/wpreact/v1/movies?page=1 | TLS: SSL_ERROR_SYSCALL |
| 1337x.la/ | TLS: SSL_ERROR_SYSCALL |
| torrentgalaxy.to/ | DNS: no resuelve |
| yts.mx/api/v2/list_movies.json?limit=1 | DNS: no resuelve |
| eztv1.xyz/api/get-torrents?limit=1 | TLS: SSL_ERROR_SYSCALL |
| thepiratebay10.org/search/test/1/99/200 | TLS: SSL_ERROR_SYSCALL |
| www45.mejortorrent.eu/ | TLS: SSL_ERROR_SYSCALL |
| www.elitetorrent.com/ | TLS: SSL_ERROR_SYSCALL |
| limetorrent.store/latest100 | TLS: SSL_ERROR_SYSCALL |
| nyaa.si/?c=1_2 | TLS: SSL_ERROR_SYSCALL |
| wolftorrent.com/peliculas | TLS: SSL_ERROR_SYSCALL |
| www.sinsitio.site/ | TLS: SSL_ERROR_SYSCALL |
| dontorrent.moi/ | TLS: SSL_ERROR_SYSCALL |
| rarbgproxy.to/movies/ | TLS: SSL_ERROR_SYSCALL |
| magnetdl.co/download/movies/ | TLS: SSL_ERROR_SYSCALL |
| www.tokyotosho.info/?cat=1 | TLS: SSL_ERROR_SYSCALL |
| rutracker.org/forum/index.php | TLS: SSL_ERROR_SYSCALL |
| t0rrenta.org/ | TLS: SSL_ERROR_SYSCALL |
| estrenostorrent.org/peliculas/ | TLS: SSL_ERROR_SYSCALL |
| grantorrent | Sin dominio predeterminado verificado; requiere configuración |

Las 19 peticiones terminaron sin respuesta HTTP. Esto no demuestra caída global
ni verifica todos los mirrors o APIs alternativas: puede haber restricciones de
salida/DNS/TLS en el entorno. No se obtuvo HTML actual para contrastar selectores.

Para validar desde el runner autorizado de producción, ejecutar desde la carpeta
con `package.json`:

```sh
npm run build
npm test
# Todas las fuentes del registro, aisladas por proceso y sin escrituras en DB:
DIAGNOSE_TIMEOUT_MS=60000 npm run diagnose
```

Configurar GranTorrent y la sesión RuTracker localmente, sin publicar secretos.
Si el diagnóstico vuelve a fallar en DNS/TLS, resolver conectividad antes de
cambiar parsers. Los fallos terminales de un crawl se notifican como error; no se
promete persistir sus registros parciales como si fuera una ejecución completa.
