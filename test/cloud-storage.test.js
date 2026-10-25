// Uploads when CLOUDINARY_URL is set: files go to Cloudinary (a fake here, so no account is needed) and come back as links.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, registerUser } from './helpers.js';

process.env.CLOUDINARY_URL = 'cloudinary://123456:secret@demo'; // must be set before the app is imported
// A private upload folder, so tests running at the same time do not see each other's files.
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyguard-uploads-'));
process.env.UPLOADS_DIR = UPLOAD_DIR; // must be set before the app is imported

let app;
let user;
let storage;
let query;
const calls = { upload: [], remove: [] };
let behaviour = null; // lets one test change what the fake does

before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  storage = await import('../src/services/storage.js');
  ({ query } = await import('../src/utils/db.js'));
  storage.setCloudDriver({
    async upload(buffer, options) {
      calls.upload.push({ bytes: Buffer.from(buffer), ...options });
      if (behaviour) return behaviour(buffer, options);
      const publicId = `${options.folder}/abc123`;
      return { publicId, url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.png`, resourceType: 'image' };
    },
    async remove(asset) { calls.remove.push(asset); },
  });
});
after(() => app.stop());

const filesOnDisk = () => fs.readdirSync(UPLOAD_DIR).filter((f) => f !== '.gitkeep');

async function upload(content, { type = 'image/png', name = 'receipt.png', token = user.token } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  const res = await fetch(`${app.base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

test('an upload goes to Cloudinary, not to this server, and comes back with a link to open it', async () => {
  const before = filesOnDisk();
  const res = await upload('PNGDATA', { name: 'receipt.png' });
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/v1\/moneyguard\/.+\/abc123\.png$/);
  assert.equal(res.body.publicId, `moneyguard/${user.user.id}/abc123`);
  assert.equal(res.body.resourceType, 'image');
  assert.equal(res.body.filename, 'abc123');
  assert.equal(res.body.originalName, 'receipt.png');
  assert.equal(res.body.size, 7);
  assert.deepEqual(filesOnDisk(), before, 'nothing may be written to the local uploads folder');

  const sent = calls.upload.at(-1);
  assert.equal(sent.bytes.toString(), 'PNGDATA'); // the real bytes reached the uploader
  assert.equal(sent.folder, `moneyguard/${user.user.id}`); // a folder per user
  assert.equal(sent.mimetype, 'image/png');
});

test('the saved link is listed again later', async () => {
  const list = await app.api('GET', '/api/files', { token: user.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 1);
  assert.ok(list.body.every((f) => f.url.startsWith('https://res.cloudinary.com/')));
});

test('CLOUDINARY_FOLDER chooses the top folder', async () => {
  process.env.CLOUDINARY_FOLDER = 'finance-app';
  try {
    await upload('x');
    assert.equal(calls.upload.at(-1).folder, `finance-app/${user.user.id}`);
  } finally {
    delete process.env.CLOUDINARY_FOLDER;
  }
});

test('file type and size rules still apply, and a refused file is never sent to Cloudinary', async () => {
  const count = calls.upload.length;
  const html = await upload('<b>x</b>', { type: 'text/html', name: 'a.html' });
  assert.equal(html.status, 400);
  assert.match(html.body.error, /Invalid file type/);
  const big = await upload(new Uint8Array(21 * 1024 * 1024), { name: 'big.png' });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /too large/i);
  assert.equal(calls.upload.length, count);
});

test('if Cloudinary fails, the user gets a generic 500 and nothing is recorded', async () => {
  const fresh = await registerUser(app.api);
  behaviour = async () => { throw Object.assign(new Error('Invalid api_key 123456'), { http_code: 401 }); };
  try {
    const res = await upload('x', { token: fresh.token });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Something went wrong'); // the provider's message is never shown
  } finally {
    behaviour = null;
  }
  assert.deepEqual((await app.api('GET', '/api/files', { token: fresh.token })).body, []);
});

test('if the database record cannot be saved after the upload, the uploaded copy is removed again', async () => {
  const fresh = await registerUser(app.api);
  const removed = calls.remove.length;
  // Simulates a failure after the upload: the account disappears while the file is on its way to Cloudinary.
  behaviour = async (buffer, { folder }) => {
    await query('DELETE FROM users WHERE id = $1', [folder.split('/').pop()]);
    return { publicId: `${folder}/orphan`, url: 'https://res.cloudinary.com/demo/image/upload/v1/orphan.png', resourceType: 'image' };
  };
  try {
    const res = await upload('x', { token: fresh.token });
    assert.equal(res.status, 500);
  } finally {
    behaviour = null;
  }
  assert.equal(calls.remove.length, removed + 1);
  assert.deepEqual(calls.remove.at(-1), { publicId: `moneyguard/${fresh.user.id}/orphan`, resourceType: 'image', url: 'https://res.cloudinary.com/demo/image/upload/v1/orphan.png', filename: 'orphan' });
});

test('a failure while cleaning up is logged, not thrown', async () => {
  storage.setCloudDriver({ upload: async () => ({}), remove: async () => { throw new Error('cloud is down'); } });
  await assert.doesNotReject(storage.discardUpload({ path: 'x' }, { publicId: 'moneyguard/u/x', resourceType: 'image' }));
});
