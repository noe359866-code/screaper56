# 🎬 Peerflix Ingest

Web estática + GitHub Action para pegar una lista de IDs de IMDb, consultar
addons Stremio públicos y hacer **UPSERT en la tabla `public.torrents` existente
de Supabase**. La web que ya consume esa tabla no necesita cambios.

El crawler TypeScript/Playwright anterior y sus fuentes HTML fueron eliminados.
El único código de consulta es ahora este agregador de endpoints JSON Stremio:

- **Peerflix** — https://peerflix.mov/manifest.json
- **TorrentsDB** — https://torrentsdb.com/manifest.json
- **Torrentio** — https://torrentio.strem.fun/manifest.json
- **ThePirateBay+** — https://thepiratebay-plus.strem.fun/manifest.json
- **TPB Adult** — https://tpb-adult-addon.click/manifest.json (registrado como fuente de catálogo; ver la nota más abajo)

## Flujo

```text
web estática
  └─ PUT watchlist.txt + workflow_dispatch vía GitHub API
       └─ GitHub Actions: node src/fetch.mjs
            ├─ consulta /stream/movie|series/...json en los 4 addons IMDb
            ├─ normaliza Peerflix, Torrentio, TorrentsDB y TPB+
            ├─ fusiona streams repetidos por info_hash
            ├─ UPSERT public.torrents usando onConflict=info_hash
            └─ publica JSON del último resultado + GitHub Pages
```

Los providers que devuelven el mismo `info_hash` se fusionan en un solo
registro. Se combinan los trackers y se conservan todos los addons que lo
publicaron; los seeds, tamaño, título y calidad disponibles se eligen sin
inventar datos desconocidos.

## TPB Adult: por qué aparece como “manifest-only”

`tpb-adult-addon.click/manifest.json` no declara streams `movie`/`series` con
IDs IMDb. Declara catálogos de tipo `Porn`, con búsquedas que devuelven IDs
internos `jstrm:*`; una consulta `stream/Porn/tt...` no es una correspondencia
válida con una lista IMDb y puede devolver contenido no relacionado. Por eso
la URL queda registrada en `src/providers.mjs`, en `public/manifest.json` y en
el reporte, pero **no se importan resultados adultos aleatorios** en la tabla
`movie/series`. Los otros cuatro addons sí se consultan por cada IMDb ID.

## Puesta en marcha

1. En Settings → Pages selecciona **Source: GitHub Actions**.
2. En Settings → Secrets → Actions añade:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (solo Action, nunca en la web)
   - `TMDB_API_KEY` opcional, para expandir `tt…:sN` a todos los episodios.
3. Crea un PAT de GitHub limitado a este repo con:
   - Contents: Read & write
   - Actions: Read & write
   - Metadata: Read
4. Abre Pages y en **Ajustes** guarda owner, repo, PAT, rama, URL Supabase y
   clave pública anon. La clave anon se usa solamente para leer el dashboard;
   el service-role key se queda en el secret de Actions.
5. En **Ingestar lista** pega o sube el TXT y pulsa **Ingestar en la BD**.

La pestaña Ajustes permite activar/desactivar los cuatro providers consultables.
El workflow también admite manualmente:

```text
PROVIDERS=peerflix,torrentsdb,torrentio,piratebay
```

La UI envía ese valor como input `providers`. El default incluye los cuatro.
El input `dry_run=1` consulta y genera reportes, pero no escribe en Supabase.

## Formato de `watchlist.txt`

```text
tt0111161 Cadena perpetua (1994)
tt1375666 Inception (2010)
tt0944947:s1:e1 Juego de Tronos S01E01
tt0944947:s1 Juego de Tronos – Temporada 1 completa  # requiere TMDB_API_KEY
```

Se acepta un comentario después de `#`, el texto tras el ID es opcional y las
líneas de episodio concreto funcionan sin TMDB.

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
| `audio` | `language` y banderas/texto normalizados a ISO 639-1 |
| `subtitles` | tags `[ES-EN]`/`[Subs]` cuando aparecen |
| `size_bytes` | `sizebytes` o footer `💾` |
| `seeders` | `seed` o footer `👤`; si no aparece, queda desconocido |
| `release_group` | provider secundario que el addon muestra en el footer |
| `source_tracker` | slugs de addons que publicaron el hash |

No se envían columnas fuera del esquema existente. El magnet se construye para
la UI y los JSON Stremio con el hash y los trackers disponibles; no se escribe
una columna `magnet_url` porque la tabla existente no la necesita. El UPSERT
agrupa registros por conjunto de columnas y usa `defaultToNull: false`, por lo
que metadata desconocida no borra valores más ricos ya presentes.

## Estructura

| Ruta | Función |
|---|---|
| `src/providers.mjs` | Registro de las cinco URLs de manifest y providers consultables |
| `src/fetch.mjs` | Fetch JSON Stremio, normalización, merge, JSONs y reporte |
| `src/db.mjs` | Sanitización y UPSERT Supabase sobre `info_hash` |
| `public/index.html` / `public/app.js` / `public/styles.css` | Consola estática en español |
| `public/data/report.json` | Último reporte, providers, errores y estadísticas |
| `public/data/{movies,series}` | Streams agregados por título |
| `public/manifest.json` / `public/stream` | Addon Stremio personal del watchlist |
| `.github/workflows/static.yml` | Ejecución diaria y manual desde la consola |

## Comandos locales

```bash
npm install
npm test
npm run dev
FIXTURE_MODE=1 DRY_RUN=1 node src/fetch.mjs
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node src/fetch.mjs
```

`FIXTURE_MODE=1` no llama a Internet y sirve para validar la UI y el flujo de
merge. La Action real usa concurrencia baja, reintentos con backoff y solo
consume JSON público de los addons; no scrapea HTML ni arranca crawlers
adicionales.
