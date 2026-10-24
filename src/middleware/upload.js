import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { cloudEnabled } from '../services/storage.js';

const UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../uploads');

// The extension comes from the allowed type, never from the client's filename (blocks "evil.html").
const allowed = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
]);

// In the cloud the file is held in memory (at most 20 MB, see the limit below) and handed to Cloudinary by the route;
// otherwise it is written straight to disk under a random name.
const storage = cloudEnabled()
  ? multer.memoryStorage()
  : multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${randomUUID()}${allowed.get(file.mimetype)}`),
  });

function fileFilter(req, file, cb) {
  if (allowed.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: images, PDF, MP4, MOV, WebM'), false);
  }
}

export const upload = multer({
  storage,
  fileFilter,
  defParamCharset: 'utf8', // multer defaults to latin1, which garbles non-ASCII file names
  limits: { fileSize: 20 * 1024 * 1024 },
});
