-- VantaHD / screaper56 - hardening de public.torrents
-- Compatible con la ingesta actual. No elimina datos.

ALTER TABLE public.torrents
  ADD COLUMN IF NOT EXISTS tmdb_id BIGINT,
  ADD COLUMN IF NOT EXISTS kitsu_id BIGINT,
  ADD COLUMN IF NOT EXISTS anilist_id BIGINT,
  ADD COLUMN IF NOT EXISTS mal_id BIGINT,
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'movie',
  ADD COLUMN IF NOT EXISTS absolute_episode INTEGER,
  ADD COLUMN IF NOT EXISTS release_group TEXT,
  ADD COLUMN IF NOT EXISTS hdr_format TEXT,
  ADD COLUMN IF NOT EXISTS channels TEXT,
  ADD COLUMN IF NOT EXISTS subtitles TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS codec TEXT;

-- La aplicación ya normaliza info_hash a minúsculas. Esta columna permite
-- mantener una clave canónica aunque en el futuro entre hash con mayúsculas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.torrents'::regclass
      AND attname = 'info_hash_clean'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE public.torrents
      ADD COLUMN info_hash_clean TEXT
      GENERATED ALWAYS AS (lower(trim(info_hash))) STORED;
  END IF;
END $$;

-- Normaliza filas antiguas antes de crear la unicidad.
UPDATE public.torrents
SET info_hash = lower(trim(info_hash))
WHERE info_hash IS NOT NULL
  AND info_hash <> lower(trim(info_hash));

-- Validación defensiva. Las filas inválidas no bloquean la migración.
CREATE INDEX IF NOT EXISTS idx_torrents_info_hash_clean
  ON public.torrents (info_hash_clean);

CREATE UNIQUE INDEX IF NOT EXISTS uq_torrents_info_hash_clean
  ON public.torrents (info_hash_clean)
  WHERE info_hash_clean IS NOT NULL
    AND info_hash_clean <> '';

CREATE INDEX IF NOT EXISTS idx_torrents_media_lookup
  ON public.torrents (imdb_id, type, season, episode, seeders DESC);

CREATE INDEX IF NOT EXISTS idx_torrents_tmdb_lookup
  ON public.torrents (tmdb_id, type)
  WHERE tmdb_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_torrents_anime_lookup
  ON public.torrents (anilist_id, mal_id, kitsu_id)
  WHERE anilist_id IS NOT NULL OR mal_id IS NOT NULL OR kitsu_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_torrents_quality
  ON public.torrents (quality, seeders DESC);

ALTER TABLE public.torrents
  DROP CONSTRAINT IF EXISTS torrents_type_check;

ALTER TABLE public.torrents
  ADD CONSTRAINT torrents_type_check
  CHECK (type IN ('movie', 'series', 'anime'));

ALTER TABLE public.torrents
  DROP CONSTRAINT IF EXISTS torrents_hash_format_check;

ALTER TABLE public.torrents
  ADD CONSTRAINT torrents_hash_format_check
  CHECK (info_hash_clean ~ '^[0-9a-f]{40}$');

ALTER TABLE public.torrents
  DROP CONSTRAINT IF EXISTS torrents_episode_range_check;

ALTER TABLE public.torrents
  ADD CONSTRAINT torrents_episode_range_check
  CHECK (
    (season IS NULL OR season >= 0)
    AND (episode IS NULL OR episode >= 0)
    AND (absolute_episode IS NULL OR absolute_episode >= 0)
    AND (file_index IS NULL OR file_index >= 0)
  );
