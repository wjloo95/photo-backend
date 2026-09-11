-- Migration 015: move identity name from photographers.business_name to users.name
-- name is shared by both roles (photographers and clients), so it belongs on
-- users, not on the photographer-only profile table.

-- DEFAULT '' (not just NOT NULL) so this doesn't fail against a table that
-- already has rows — matches the pattern used for bio/profile_photo_url/
-- instagram_handle in migration 002.
ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';

ALTER TABLE photographers DROP COLUMN business_name;
