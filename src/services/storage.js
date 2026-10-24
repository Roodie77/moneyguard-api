import fs from 'fs/promises';
import logger from '../utils/logger.js';

// Where uploaded files are kept. With CLOUDINARY_URL set (cloudinary://API_KEY:API_SECRET@CLOUD_NAME) they go to
// Cloudinary and are opened by their https link. Without it they stay on this server's disk (src/uploads) and are
// served at /uploads/<name>. Nothing else in the app needs to know which one is in use.
export const cloudEnabled = () => Boolean(process.env.CLOUDINARY_URL);

// The SDK reads CLOUDINARY_URL itself when it loads. It is imported on first use, so a server that does not use
// Cloudinary never loads it.
let sdk;
const cloudinary = () => {
  sdk ??= import('cloudinary').then(({ v2 }) => { v2.config({ secure: true }); return v2; });
  return sdk;
};

// The only two Cloudinary calls we make, behind a small object so tests can swap in a fake (setCloudDriver).
const cloudinaryDriver = {
  async upload(buffer, { folder }) {
    const cld = await cloudinary();
    const result = await new Promise((resolve, reject) => {
      // resource_type 'auto' lets Cloudinary decide: images and PDFs are "image", videos are "video".
      cld.uploader
        .upload_stream({ folder, resource_type: 'auto', unique_filename: true, overwrite: false }, (err, res) => (err ? reject(err) : resolve(res)))
        .end(buffer);
    });
    return { publicId: result.public_id, url: result.secure_url, resourceType: result.resource_type };
  },
  async remove({ publicId, resourceType }) {
    const cld = await cloudinary();
    await cld.uploader.destroy(publicId, { resource_type: resourceType });
  },
};

let driver = cloudinaryDriver;
export const setCloudDriver = (replacement) => { driver = replacement; };

// Keeps a file that multer has just received. On disk it is already saved; in the cloud it is uploaded now, into a
// folder per user (moneyguard/<userId>) so the Cloudinary media library stays tidy.
export async function storeUpload(file, userId) {
  if (!cloudEnabled()) return { filename: file.filename, url: null, publicId: null, resourceType: null };
  const folder = `${process.env.CLOUDINARY_FOLDER || 'moneyguard'}/${userId}`;
  const stored = await driver.upload(file.buffer, { folder, mimetype: file.mimetype });
  return { filename: stored.publicId.split('/').pop(), ...stored };
}

// Undoes storeUpload when the database record could not be saved, so no file is left without a record.
// Never throws: it runs while another error is already being handled.
export async function discardUpload(file, stored) {
  try {
    if (!cloudEnabled()) await fs.rm(file.path, { force: true });
    else if (stored?.publicId) await driver.remove(stored);
  } catch (err) {
    logger.warn(`Could not clean up an upload: ${err.message}`);
  }
}

// The address a client opens: the Cloudinary link, or the path on this server for a file kept on disk.
export const withUrl = (record) => ({ ...record, url: record.url ?? `/uploads/${record.filename}` });
