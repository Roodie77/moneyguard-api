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

// Profile pictures: images only, at most 5 MB, in the form field "avatar".
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const avatarUpload = multer({
  storage,
  fileFilter: (req, file, cb) => (IMAGE_TYPES.has(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Invalid file type. Allowed: JPEG, PNG, WebP, GIF'), false)),
  defParamCharset: 'utf8',
  limits: { fileSize: 5 * 1024 * 1024 },
});

export const uploadAvatar = (req, res, next) => avatarUpload.single('avatar')(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large. Max 5MB.' });
  return next(err);
});

export const upload = multer({
  storage,
  fileFilter,
  defParamCharset: 'utf8', // multer defaults to latin1, which garbles non-ASCII file names
  limits: { fileSize: 20 * 1024 * 1024 },
});
