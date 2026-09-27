-- ---------------------------------------------------------------------------
-- Esquema mínimo de la tabla `torrents` para una base de datos NUEVA.
--
-- Compatible con:
--   * PostgreSQL 13+ (servidor propio, p. ej. una VM de Oracle Cloud)
--   * Supabase (SQL Editor)
--   * CockroachDB (Basic/Serverless o autogestionado)
--
-- Si ya tienes la tabla (p. ej. en Supabase) NO ejecutes este fichero: el
-- crawler lee las columnas reales con information_schema y solo escribe las
-- que existen. Para copiar datos entre servidores, ver docs/MIGRACION_BD.md.
--
-- El crawler no necesita triggers: pone `updated_at = now()` él mismo cuando
-- una fila cambia de verdad, así el DDL es idéntico en los tres motores.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS torrents (
  id               BIGSERIAL PRIMARY KEY,      -- en CockroachDB genera int64 no secuenciales (unique_rowid)
  info_hash        TEXT        NOT NULL,       -- BTIH v1, 40 hex en minúsculas
  title            TEXT        NOT NULL,
  type             TEXT        NOT NULL DEFAULT 'movie',
  imdb_id          TEXT,
  tmdb_id          BIGINT,
  kitsu_id         BIGINT,
  anilist_id       BIGINT,
  mal_id           BIGINT,
  season           INTEGER,
  episode          INTEGER,
  absolute_episode INTEGER,
  file_index       INTEGER,
  release_group    TEXT,
  quality          TEXT        NOT NULL DEFAULT 'Unknown',
  codec            TEXT,
  hdr_format       TEXT,
  audio            TEXT[]      NOT NULL DEFAULT '{}',
  subtitles        TEXT[]      NOT NULL DEFAULT '{}',
  channels         TEXT,
  size_bytes       BIGINT      NOT NULL DEFAULT 0,
  seeders          INTEGER     NOT NULL DEFAULT 0,  -- 0 = desconocido en filas nuevas; nunca se pisa un valor conocido con 0
  leechers         INTEGER     NOT NULL DEFAULT 0,
  source_tracker   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT torrents_info_hash_format CHECK (info_hash ~ '^[0-9a-f]{40}$'),
  CONSTRAINT torrents_type_allowed     CHECK (type IN ('movie', 'series', 'anime', 'documentary'))
);

-- Imprescindible: es la clave del UPSERT (ON CONFLICT (info_hash)).
CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique ON torrents (info_hash);

-- Consultas típicas de un addon/consumidor: por título IMDb y episodio.
CREATE INDEX IF NOT EXISTS torrents_imdb_episode_idx ON torrents (imdb_id, season, episode);

-- Para que otros procesos (enriquecimiento, limpieza) recorran lo reciente.
CREATE INDEX IF NOT EXISTS torrents_updated_at_idx ON torrents (updated_at);
