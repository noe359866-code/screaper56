# Auditoría de los once crawlers con cero resultados

Fecha: 2026-09-28. Alcance: los once adaptadores indicados, su transporte HTTP,
resolución de mirrors y pruebas de regresión. No se modificaron los dominios por
conjeturas ni se desactivó la validación TLS. No se escribió en Supabase.

## Correcciones

| Crawler | Revisión y cambios |
| --- | --- |
| torrentgalaxy | El parser acepta `xt` en cualquier posición del magnet y busca un enlace válido después de uno malformado. Antes solo seleccionaba el primer `magnet:?xt=`. |
| dontorrent | La paginación de catálogos detecta páginas repetidas por sus URLs, no por duplicados globales entre secciones: una página solapada ya no oculta la siguiente. Catálogos y fichas rechazan interstitials HTTP 200. |
| thepiratebay | Mismo fallo de selección de magnets corregido. Se mantiene la separación entre APiBay y los mirrors HTML. El helper JSON impide sustituir una respuesta de API por HTML del navegador. |
| elitetorrent | Revisados resolución, catálogos y errores de fichas; recibe las correcciones compartidas HTTP/mirrors. Sin cambios especulativos en selectores al no disponer de HTML real accesible. |
| magnetdl | Revisados búsqueda, paginación publicada y extracción de enlaces. Ya recorría los magnets hasta encontrar uno válido; no se duplicó esa corrección. Recibe los cambios compartidos. |
| rutracker | Revisados resolución, configuración de sesión y transporte de páginas. Se conserva la decodificación Windows-1251 y no se altera el manejo de credenciales. Añadida orientación específica al diagnóstico. Sin sesión real utilizada. |
| leech1337x | Ahora acepta enlaces de ficha absolutos o relativos con `/torrent/:id`, conservando restricciones de host/esquema/puerto y rechazando URLs con credenciales. |
| pelispanda | Entradas nulas, enlaces no textuales y colecciones anidadas malformadas ya no abortan todas las entregas válidas de una ficha. Las solicitudes de API indican explícitamente JSON. |
| wolftorrent | El catálogo HTML compartido rechaza páginas de bloqueo en lugar de contarlas como catálogos leídos. Recibe las mejoras HTTP/mirrors. El flujo interactivo de descargas no se verificó en vivo. |
| t0rrenta | La deduplicación de archivos usa la ruta completa: dos IDs distintos con el mismo nombre ya no se colapsan. Las firmas diferentes sobre la misma ruta siguen deduplicándose. Las tarjetas de imagen con espacios usan correctamente `alt` como título. |
| eztv | Los magnets del HTML ya no dependen de la clase CSS `magnet`. El helper JSON evita aceptar HTML renderizado como respuesta de API. |

### Transporte y mirrors compartidos

- Un 403/503 por sí solo no demuestra que exista un challenge Cloudflare. El
  navegador solo se considera si hay indicadores de challenge. Los 403 simples
  terminan sin reintentos; los 503 transitorios conservan su política de retry.
- Sin retries ante cancelación, ENOTFOUND, ciertos errores de configuración ni
  errores permanentes de certificado. EAI_AGAIN sigue siendo transitorio.
- El HTML obtenido mediante navegación GET no puede satisfacer una solicitud
  POST ni una petición declarada JSON.
- `Retry-After` distingue un valor numérico completo de una fecha.
- `MIRROR_PROBE_STAGGER_MS=0` ahora cumple lo documentado: sondeo secuencial.
- La prioridad del mirror en caché solo se reutiliza con la misma lista ordenada
  de candidatos. Cambiar BASE_URL/MIRRORS ya no queda oculto por una selección vieja.
- Los interstitials detectados en sondeos HTTP 200 se diagnostican como bloqueo,
  no simplemente como cambio de estructura HTML. El diagnóstico reconoce también
  errores SSL/certificado y añade orientación para EZTV, TPB y RuTracker.

## Verificación

- Base inicial: 252 pruebas pasando.
- Añadidas 31 pruebas en `tests/zero-results-regression.test.js`.
- Suite final: **283 pruebas pasando**, ninguna fallida.
- `npm run lint`, `npm run build` y `git diff --check`: correctos.
- `npm ci --ignore-scripts`: auditoría de dependencias informó 0 vulnerabilidades.

Las pruebas usan respuestas sintéticas/controladas. Comprueban las regresiones
sin depender de sitios externos, sesiones privadas, navegadores ni Supabase.
No equivalen a una confirmación de que el HTML publicado hoy siga siendo compatible.

## Comprobación de conectividad desde este entorno

Se hizo una petición GET por URL con curl, redirecciones limitadas a 3, timeout
máximo de 10 segundos y concurrencia máxima de 4, sin credenciales. Resultados:

| URL | Resultado |
| --- | --- |
| `https://torrentgalaxy.to/` | DNS: `Could not resolve host` |
| `https://dontorrent.moi/` | TLS: `SSL_ERROR_SYSCALL` |
| `https://thepiratebay10.org/search/test/1/99/200` | TLS: `SSL_ERROR_SYSCALL` |
| `https://www.elitetorrent.com/` | TLS: `SSL_ERROR_SYSCALL` |
| `https://magnetdl.co/download/movies/` | TLS: `SSL_ERROR_SYSCALL` |
| `https://rutracker.org/forum/index.php` | TLS: `SSL_ERROR_SYSCALL` |
| `https://1337x.la/` | TLS: `SSL_ERROR_SYSCALL` |
| `https://pelispanda.org/wp-json/wpreact/v1/movies?page=1` | TLS: `SSL_ERROR_SYSCALL` |
| `https://wolftorrent.com/peliculas` | TLS: `SSL_ERROR_SYSCALL` |
| `https://t0rrenta.org/` | TLS: `SSL_ERROR_SYSCALL` |
| `https://eztv1.xyz/api/get-torrents?limit=1` | TLS: `SSL_ERROR_SYSCALL` |

No se recibió una respuesta HTTP en estas comprobaciones. Esto **no prueba que
los sitios estén caídos globalmente**: pueden intervenir restricciones de salida,
DNS/TLS del runner o políticas del servidor. Tampoco verifica todos los mirrors
ni el endpoint independiente APiBay. No se pueden prometer resultados reales ni
comparar rendimiento de producción con los tiempos de la tabla original.

## Siguiente validación desde el runner de producción

Desde la carpeta que contiene `package.json`:

```sh
npm run lint
npm test
DIAGNOSE_TIMEOUT_MS=60000 npm run diagnose -- torrentgalaxy dontorrent thepiratebay elitetorrent magnetdl rutracker leech1337x pelispanda wolftorrent t0rrenta eztv
```

El diagnóstico existente no importa el repositorio Supabase y separa `ERROR`,
`TIMEOUT`, `EMPTY`, `FILTERED` y `OK`. Su timeout es por crawler, no global.
Configurar únicamente mirrors comprobados y permitidos con `<FUENTE>_BASE_URL`
o `<FUENTE>_MIRRORS`; para RuTracker, configurar la sesión localmente sin publicar
cookies/contraseñas. Si DNS/TLS falla, corregir primero conectividad. Si llega HTML
pero no hay registros, obtener una muestra sin secretos y contrastarla con los
selectores. `FILTERED` significa que hubo extracción pero no evidencia de idioma
aceptada; no se debe solucionar inventando idiomas o hashes.
