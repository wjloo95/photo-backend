-- Migration 002: photographers
-- Photographer profile. One-to-one with users where role = 'photographer'.
-- user_id is both the FK to users and the primary key of this table.

CREATE TYPE visibility_type AS ENUM ('public', 'private');

CREATE TABLE photographers (
  -- Using user_id as the PK (not a separate id) enforces the 1:1 relationship
  -- at the schema level. You cannot have two photographer rows for the same user.
  user_id          UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name    TEXT         NOT NULL,
  bio              TEXT         NOT NULL DEFAULT '',
  profile_photo_url TEXT        NOT NULL DEFAULT '',
  instagram_handle TEXT         NOT NULL DEFAULT '',
  visibility       visibility_type NOT NULL DEFAULT 'private'
);
