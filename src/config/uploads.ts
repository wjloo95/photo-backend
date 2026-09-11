/**
 * src/config/uploads.ts
 *
 * Shared filesystem convention for where uploaded photo files are staged
 * before they've been sent to Cloudinary.
 *
 * Two otherwise-unrelated places need to agree on this exact path:
 *   - routes/albums.ts writes here via multer's diskStorage, then renames
 *     each temp file so its filename on disk *is* its photo id
 *   - jobs/processors/photoProcessor.ts reads from here (path.join(
 *     UPLOAD_TMP_DIR, photoId)) to find the bytes for a given photo id
 *
 * Neither of those files should own this constant on the other's behalf,
 * so it lives here instead — same shape as database.ts/redis.ts each owning
 * one shared piece of infrastructure both the API and the background worker
 * depend on.
 */

import os from 'node:os';
import path from 'node:path';

export const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'sys-photo-uploads');
