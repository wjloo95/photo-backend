-- Migration 016: add width/height to photos
-- Needed by the frontend to render aspect-ratio-accurate placeholders while
-- the real image is still loading from Cloudinary.
--
-- Nullable, no DEFAULT: like base_path, the real dimensions aren't known
-- until the background processor uploads the file to Cloudinary and reads
-- them back. Unlike base_path there's no sensible '' placeholder for an
-- integer, so these stay NULL until the processor fills them in when it
-- flips status to 'ready'.
ALTER TABLE photos ADD COLUMN width INTEGER;
ALTER TABLE photos ADD COLUMN height INTEGER;
