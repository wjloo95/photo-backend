-- Migration 004: albums
-- An album is a collection of photos — either a client shoot or a portfolio.
-- access_expires_at is set to shoot_date + 3 years at creation time.
-- The warned_*_at columns track which expiry warning emails have been sent.

CREATE TYPE album_type AS ENUM ('shoot', 'portfolio');

CREATE TABLE albums (
  id                  UUID       PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id     UUID       NOT NULL REFERENCES photographers(user_id) ON DELETE CASCADE,
  -- client_id is nullable: portfolio albums belong to the photographer, not a client
  client_id           UUID       REFERENCES clients(user_id) ON DELETE SET NULL,
  -- thumbnail_photo_id is nullable: set after photos are uploaded
  thumbnail_photo_id  UUID,      -- FK added in 006 after photos table exists
  type                album_type NOT NULL,
  shoot_date          DATE       NOT NULL,
  access_expires_at   TIMESTAMPTZ NOT NULL,
  warned_90_at        TIMESTAMPTZ,
  warned_30_at        TIMESTAMPTZ,
  warned_7_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
