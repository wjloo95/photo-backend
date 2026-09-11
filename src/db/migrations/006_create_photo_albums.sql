-- Migration 006: photo_albums (join table) + album thumbnail FK
-- Links photos to albums. A photo can belong to multiple albums.
-- Composite primary key on (photo_id, album_id) prevents duplicate entries.
--
-- Also adds the thumbnail_photo_id FK to albums now that photos exists.

CREATE TABLE photo_albums (
  photo_id UUID        NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  album_id UUID        NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_cover BOOLEAN     NOT NULL DEFAULT FALSE,
  PRIMARY KEY (photo_id, album_id)
);

-- Add the FK constraint deferred from migration 004.
-- Albums couldn't reference photos until the photos table existed.
ALTER TABLE albums
  ADD CONSTRAINT albums_thumbnail_photo_id_fkey
  FOREIGN KEY (thumbnail_photo_id) REFERENCES photos(id) ON DELETE SET NULL;
