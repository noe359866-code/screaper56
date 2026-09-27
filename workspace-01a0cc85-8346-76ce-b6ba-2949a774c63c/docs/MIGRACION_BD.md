# Migración de la base de datos (Supabase → Oracle Cloud / CockroachDB / cualquier PostgreSQL)

El crawler ya no depende de la API REST de Supabase. Con `DATABASE_URL` habla el
protocolo nativo de PostgreSQL (driver `pg`) y funciona igual contra Supabase,
CockroachDB o un servidor propio. **Cambiar de proveedor es cambiar una variable
de entorno**; el código, las pruebas y el workflow son los mismos.

## Cómo escribe ahora el crawler (importante si otro bot toca la misma tabla)

Cada lote va en una transacción con dos sentencias:

1. `UPDATE ... FROM (VALUES ...)` sobre las filas que ya existen, **solo si algo
   cambia de verdad**. Con la política por defecto (`DB_WRITE_POLICY=preserve`):
   - `seeders`, `leechers` y `size_bytes` se refrescan cuando el crawler los conoce;
     un valor desconocido (la fuente no lo publica) **nunca** pisa el último conocido.
   - El resto de columnas (`imdb_id`, `tmdb_id`, temporada, calidad, idiomas,
     título...) solo se **rellenan si están vacías**. Lo que tu bot de metadatos
     haya añadido o reparado se respeta.
   - `updated_at = now()` solo en filas que cambian. Las filas idénticas no se
     reescriben: menos tuplas muertas en Supabase, menos Request Units en Cockroach.
2. `INSERT ... ON CONFLICT (info_hash) DO NOTHING` para las filas nuevas. Si la
   tabla aún no tiene el índice único, cae automáticamente a `WHERE NOT EXISTS` y
   avisa cómo crearlo.

El backend legado por REST (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`)
sobreescribía **todas** las columnas en cada pasada, incluidos los `imdb_id` a
`NULL`, deshaciendo el trabajo de cualquier otro proceso. Sigue disponible, pero
solo se usa si `DATABASE_URL` está vacío.

Las filas que tu bot **elimina** pueden reaparecer si la fuente las sigue
publicando; es inherente a un crawler. Si quieres que un borrado sea definitivo,
lo limpio es una tabla `torrents_blacklist(info_hash)` que el bot rellene y el
crawler consulte antes de insertar; pídelo cuando lo necesites.

## Paso 0 — Hoy mismo, sin cambiar de proveedor

Apunta el nuevo backend a tu Supabase actual. Misma base de datos, misma tabla:

1. Dashboard → **Connect** → *Session pooler* (puerto 5432). El host directo
   `db.<ref>.supabase.co` es solo IPv6 y **GitHub Actions no tiene IPv6**.
   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
2. Si la conexión falla con *self-signed certificate in certificate chain*,
   descarga la CA en *Project Settings → Database → SSL certificate* y ponla en
   `DATABASE_SSL_CA` (ruta o contenido PEM; en un secreto de Actions pega el PEM).
3. Comprueba conexión, tabla, índice único, filas y tamaño real:
   ```bash
   npm run db:check
   npm run db:check -- --sample 5
   ```
   Ese informe responde la pregunta previa a cualquier migración: **cuántas filas
   tienes y cuántos bytes ocupa cada una**. Con este esquema, 500 MB son del orden
   de 700 k–1 M de torrents; si estás muy por debajo y aun así cerca del límite,
   revisa las tuplas muertas y los índices que reporta el script antes de migrar.
4. Prueba en seco y luego una fuente en real:
   ```bash
   DRY_RUN=true  TARGET_CRAWLERS=yts MAX_PAGES=1 npm start
   DRY_RUN=false TARGET_CRAWLERS=yts MAX_PAGES=1 npm start
   ```
   La última línea del resumen muestra `DB writes: N new, N updated, N unchanged, N failed`.
5. En GitHub: crea el secreto `DATABASE_URL` (y `DATABASE_SSL_CA` si hizo falta).
   Los secretos `SUPABASE_*` pueden quedarse: se ignoran cuando hay `DATABASE_URL`.

## Opción A — PostgreSQL propio en Oracle Cloud (VM Ampere A1)

Es la opción con más espacio (hasta ~150 GB útiles) y la más limpia para este
proyecto si **el crawler corre en la misma VM**: la base de datos escucha solo en
`localhost`, nada queda expuesto a internet y desaparecen el límite de 60 minutos
de Actions y la reinstalación de Chromium en cada ejecución.

### A.1 Servidor (Ubuntu 22.04/24.04 arm64)

```bash
sudo apt update && sudo apt install -y postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE USER torrents WITH PASSWORD '<password-larga>';"
sudo -u postgres psql -c "CREATE DATABASE torrents OWNER torrents;"
psql "postgresql://torrents:<password>@127.0.0.1:5432/torrents" -f sql/schema.sql
```

Solo si algo externo (un addon en otra máquina, GitHub Actions) debe conectarse:
`listen_addresses='*'` en `postgresql.conf`, una línea `hostssl` en `pg_hba.conf`
con `scram-sha-256`, TLS activado, y abrir el 5432 **tanto** en la *Security List*
de la VCN de Oracle **como** en el firewall de la imagen (`iptables`/`nft`, que en
las imágenes de Oracle bloquea todo salvo SSH; es el tropiezo clásico). Para
GitHub Actions no se pueden fijar IPs de origen: usa contraseña larga, TLS y
`fail2ban`, o mejor, no expongas nada y ejecuta el crawler en la VM.

### A.2 Copiar los datos desde Supabase

Vía CSV, explícita y compatible con cualquier destino (incluido CockroachDB):

```bash
# 1) Exportar desde Supabase (pooler en modo sesión). Ajusta la lista de columnas
#    a las que tenga tu tabla; `npm run db:check` las enumera.
psql "$SUPABASE_URL_SESSION" -c "\copy (SELECT info_hash, title, type, imdb_id, tmdb_id, kitsu_id, anilist_id, mal_id, season, episode, absolute_episode, file_index, release_group, quality, codec, hdr_format, audio, subtitles, channels, size_bytes, seeders, leechers, source_tracker, created_at, updated_at FROM public.torrents ORDER BY id) TO 'torrents.csv' CSV HEADER"

# 2) Importar en el destino (misma lista de columnas).
psql "$DATABASE_URL" -c "\copy torrents (info_hash, title, type, imdb_id, tmdb_id, kitsu_id, anilist_id, mal_id, season, episode, absolute_episode, file_index, release_group, quality, codec, hdr_format, audio, subtitles, channels, size_bytes, seeders, leechers, source_tracker, created_at, updated_at) FROM 'torrents.csv' CSV HEADER"

# 3) Verificar
DATABASE_URL="$DATABASE_URL" npm run db:check
```

Si prefieres reproducir la tabla de Supabase tal cual (mismos tipos, enums,
índices extra), usa `pg_dump --schema=public --no-owner --no-privileges` y
`pg_restore`, revisando los errores de objetos propios de Supabase (políticas
RLS, `auth.*`), que no aplican fuera.

### A.3 Crawler en la VM (en lugar de GitHub Actions)

```bash
# Node 22 arm64 + Chromium para el fallback de Wolftorrent
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
git clone <tu-repo> && cd <carpeta-con-package.json>
npm ci && npx playwright install --with-deps chromium && npm run build
cp .env.example .env   # DATABASE_URL=postgresql://torrents:<password>@127.0.0.1:5432/torrents, DRY_RUN=false
```

`/etc/systemd/system/torrent-indexer.service`:
```ini
[Unit]
Description=Torrent metadata indexer
After=postgresql.service
[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/<carpeta-con-package.json>
EnvironmentFile=/home/ubuntu/<carpeta-con-package.json>/.env
ExecStart=/usr/bin/node dist/index.js
TimeoutStartSec=3h
```
`/etc/systemd/system/torrent-indexer.timer`:
```ini
[Unit]
Description=Run the torrent indexer every 6 hours
[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
RandomizedDelaySec=15m
Persistent=true
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now torrent-indexer.timer
journalctl -u torrent-indexer -n 100 --no-pager
```

### A.4 Copias de seguridad (obligatorio en Oracle)

Oracle puede reclamar instancias gratuitas que considere ociosas y hay casos de
cuentas cerradas sin aviso. Sin copia fuera de la VM, eso significa perder todos
los torrents. Volcado diario cifrado al Object Storage (20 GB gratis) con `cron`:

```bash
# /etc/cron.daily/torrents-backup (chmod +x). Requiere `oci` CLI configurado o rclone.
#!/bin/sh
set -e
F=/tmp/torrents-$(date +%F).sql.gz
pg_dump "postgresql://torrents:<password>@127.0.0.1:5432/torrents" | gzip > "$F"
oci os object put --bucket-name torrents-backups --file "$F" --force
rm -f "$F"
```

Para reducir el riesgo de reclamación por inactividad (CPU/red/memoria por debajo
del 20 % durante 7 días), la opción documentada por Oracle es pasar la cuenta a
*Pay As You Go*: sigue costando $0 dentro de los límites Always Free, pero exige
tarjeta cobrable, así que pon una alerta de presupuesto de $1.

## Opción B — CockroachDB Basic (10 GiB gestionados)

1. Crea un clúster **Basic** (región cercana a `us-east`, donde corren los runners
   de Actions) y un usuario SQL. Copia la cadena *General connection string*; ya
   incluye `sslmode=verify-full`.
2. `psql "$DATABASE_URL" -f sql/schema.sql` (el DDL es compatible: `BIGSERIAL`
   genera int64 no secuenciales, `TEXT[]` y `ON CONFLICT` funcionan igual).
3. Copia los datos con el CSV del apartado A.2 (`\copy ... FROM` funciona en
   Cockroach) o con `IMPORT INTO torrents (...) CSV DATA ('https://...')`.
4. `npm run db:check` y una fuente en real. Los errores de serialización `40001`
   propios de Cockroach se reintentan solos (lote completo, con espera).
5. Vigila los Request Units en la consola las primeras semanas: el crawler
   consume pocos millones al mes; lo que dispara el consumo son consultas sin
   índice desde un consumidor público. Tras los créditos de prueba hace falta
   tarjeta para conservar los $15/mes gratuitos.

## Volver atrás

Cambia `DATABASE_URL` al valor anterior (o bórralo y deja `SUPABASE_*` para el
backend legado). No hay migraciones de código que deshacer.

## Verificación de esta entrega

- 87 pruebas sin conexión (`npm test`), 13 de ellas nuevas para la capa de base
  de datos: introspección de columnas y casts (enum, varchar, arrays), políticas
  `preserve`/`overwrite`, fallback sin índice único, reintento de `40001`,
  errores no reintentables, TLS por URL/variables y selección de backend.
- Prueba en vivo contra un PostgreSQL 18 real: inserción, re-crawl con metadatos
  ajenos intactos y contadores refrescados, filas idénticas sin reescritura (misma
  `xmin`), política `overwrite`, tabla con `ENUM`, columnas de menos y sin índice
  único.
- **No se ha podido probar contra CockroachDB desde este entorno** (sin salida a
  su descarga). Las sentencias usan solo SQL que Cockroach documenta como
  compatible (`UPDATE ... FROM`, `ON CONFLICT DO NOTHING`, `IS DISTINCT FROM`,
  `cardinality`, `information_schema`); la primera ejecución real conviene
  hacerla con `TARGET_CRAWLERS=yts MAX_PAGES=1`.
