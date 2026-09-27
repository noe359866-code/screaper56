-- Fix crítico: falta de UNIQUE constraint en info_hash provoca:
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- Este índice permite que el UPSERT (onConflict: 'info_hash') funcione idempotente.
-- Ejecuta este archivo en Supabase SQL Editor (o vía `supabase db push`).

-- Opción 1: índice único (recomendado, no bloquea si la tabla ya tiene datos duplicados tras limpieza)
CREATE UNIQUE INDEX IF NOT EXISTS torrents_info_hash_unique
  ON public.torrents (info_hash);

-- Opción 2: constraint con nombre (equivalente, útil si prefieres ADD CONSTRAINT)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'torrents_info_hash_unique'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'torrents_info_hash_unique'
  ) THEN
    -- Si no existe índice, ya lo creamos arriba. Este bloque evita error si ya existe.
    NULL;
  END IF;
END$$;

-- Verificación: comprueba que el índice existe
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'torrents';

-- Limpieza opcional de duplicados previos (mantiene el más reciente por info_hash)
-- Descomenta si tienes duplicados y quieres deduplicar antes de crear el constraint como UNIQUE:
-- WITH ranked AS (
--   SELECT id, info_hash, ROW_NUMBER() OVER (PARTITION BY info_hash ORDER BY updated_at DESC NULLS LAST, id DESC) AS rn
--   FROM public.torrents
-- )
-- DELETE FROM public.torrents WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
