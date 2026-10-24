// Profile picture when CLOUDINARY_URL is set (a fake Cloudinary, so no account is needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, registerUser } from './helpers.js';

process.env.CLOUDINARY_URL = 'cloudinary://123456:secret@demo'; // must be set before the app is imported
const UPLOAD_DIR = path.join(import.meta.dirname, '../src/uploads');

let app;
let user;
let n = 0;
const calls = { upload: [], remove: [] };
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  const storage = await import('../src/services/storage.js');
  storage.setCloudDriver({
    async upload(buffer, options) {
      calls.upload.push(options);
      const publicId = `${options.folder}/pic${++n}`;
      return { publicId, url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.png`, resourceType: 'image' };
    },
    async remove(asset) { calls.remove.push(asset); },
  });
});
after(() => app.stop());

const filesOnDisk = () => fs.readdirSync(UPLOAD_DIR).filter((f) => f !== '.gitkeep');
async function putAvatar(content = 'PNG', type = 'image/png') {
  const form = new FormData();
  form.append('avatar', new Blob([content], { type }), 'me.png');
  const res = await fetch(`${app.base}/api/me/avatar`, { method: 'PUT', headers: { authorization: `Bearer ${user.token}` }, body: form });
  return { status: res.status, body: await res.json() };
}
const me = async () => (await app.api('GET', '/api/me', { token: user.token })).body;

test('the picture goes to Cloudinary in the user\'s avatar folder, and the profile shows the https link', async () => {
  const disk = filesOnDisk();
  const res = await putAvatar();
  assert.equal(res.status, 200);
  assert.equal(res.body.avatarUrl, `https://res.cloudinary.com/demo/image/upload/v1/moneyguard/${user.user.id}/avatar/pic1.png`);
  assert.equal(calls.upload.at(-1).folder, `moneyguard/${user.user.id}/avatar`);
  assert.equal((await me()).avatarUrl, res.body.avatarUrl);
  assert.deepEqual(filesOnDisk(), disk, 'nothing may be written to the local uploads folder');
  assert.equal('avatarPublicId' in (await me()), false);
});

test('replacing the picture deletes the old one from Cloudinary', async () => {
  const removed = calls.remove.length;
  const res = await putAvatar('NEW');
  assert.equal(res.status, 200);
  assert.match(res.body.avatarUrl, /pic2\.png$/);
  assert.equal(calls.remove.length, removed + 1);
  assert.deepEqual(calls.remove.at(-1), { publicId: `moneyguard/${user.user.id}/avatar/pic1`, resourceType: 'image' });
});

test('removing the picture deletes it from Cloudinary and clears the link', async () => {
  const removed = calls.remove.length;
  const res = await app.api('DELETE', '/api/me/avatar', { token: user.token });
  assert.deepEqual(res.body, { avatarUrl: null });
  assert.equal(calls.remove.length, removed + 1);
  assert.equal(calls.remove.at(-1).publicId, `moneyguard/${user.user.id}/avatar/pic2`);
  assert.equal((await me()).avatarUrl, null);
});

test('a refused file is never sent to Cloudinary', async () => {
  const count = calls.upload.length;
  const res = await putAvatar('%PDF', 'application/pdf');
  assert.equal(res.status, 400);
  assert.equal(calls.upload.length, count);
});
