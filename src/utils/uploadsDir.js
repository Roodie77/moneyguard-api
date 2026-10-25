import path from 'path';
import { fileURLToPath } from 'url';

// The folder uploaded files are kept in when they are not on Cloudinary: src/uploads, unless UPLOADS_DIR says otherwise
// (for example a mounted disk that survives deploys, or a private folder for one test so parallel tests do not share files).
export const uploadsDir = () =>
  (process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(path.dirname(fileURLToPath(import.meta.url)), '../uploads'));
