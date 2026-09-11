-- Migration 005: photos
-- Metadata record for a single photo. The actual image bytes live in Cloudinary.
--
-- base_path convention: all three variants are derived from this single field:
--   {base_path}/original.jpg
--   {base_path}/standard.jpg
--   {base_path}/thumbnail.jpg
--
-- status starts as 'processing' when the upload job is queued,
-- transitions to 'ready' once Cloudinary confirms processing is complete.

CREATE TYPE photo_status AS ENUM ('processing', 'ready');

CREATE TABLE photos (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  base_path   TEXT         NOT NULL,
  status      photo_status NOT NULL DEFAULT 'processing',
  uploaded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
