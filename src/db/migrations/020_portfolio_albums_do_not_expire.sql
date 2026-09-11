-- Migration 020: only shoot albums expire
--
-- access_expires_at was NOT NULL for every album, so portfolio albums were
-- given shoot_date + 3 years like everyone else and swept up by the same
-- deletion pipeline. That was a modeling error rather than a policy: expiry
-- exists because a *client's* access to their shoot is time-limited. A
-- portfolio album belongs to the photographer, has no client_id by design
-- (migration 004), and has nobody to warn — so the three warning emails went
-- nowhere and the album was permanently deleted anyway.
--
-- NULL now means "never expires", which is what makes this self-enforcing:
-- both expiry queries filter on `access_expires_at <= ...` / `< NOW()`, and a
-- NULL comparison yields NULL rather than TRUE, so portfolio albums drop out
-- of the warning and deletion pipelines without either query changing.

ALTER TABLE albums ALTER COLUMN access_expires_at DROP NOT NULL;

-- Clear the meaningless values already on portfolio rows. The warned_*_at
-- columns go too: if the pipeline ever warned one of these albums, that
-- timestamp records a warning about an expiry that is no longer going to
-- happen.
UPDATE albums
SET access_expires_at = NULL,
    warned_90_at      = NULL,
    warned_30_at      = NULL,
    warned_7_at       = NULL
WHERE type = 'portfolio';

-- The invariant, in the database rather than in a route handler: a shoot album
-- always has an expiry, a portfolio album never does. Without this, "portfolio
-- albums don't expire" is a convention that holds only as long as every future
-- INSERT remembers it, and the three-valued-logic exclusion above quietly stops
-- protecting anything the moment one row disagrees.
ALTER TABLE albums
  ADD CONSTRAINT albums_expiry_matches_type CHECK (
    (type = 'shoot'     AND access_expires_at IS NOT NULL) OR
    (type = 'portfolio' AND access_expires_at IS NULL)
  );
