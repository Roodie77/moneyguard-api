// Profile picture, with files kept on this server's disk (no CLOUDINARY_URL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, registerUser } from './helpers.js';

const UPLOAD_DIR = path.join(import.meta.dirname, '../src/uploads');
const created = new Set();

let app;
let user;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
});
after(async () => {
  for (const name of created) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  await app.stop();
});

async function putAvatar(content, { type = 'image/png', name = 'me.png', token = user.token, field = 'avatar' } = {}) {
  const form = new FormData();
  form.append(field, new Blob([content], { type }), name);
  const res = await fetch(`${app.base}/api/me/avatar`, { method: 'PUT', headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
  const body = await res.json();
  if (body.avatarUrl) created.add(path.basename(body.avatarUrl));
  return { status: res.status, body };
}
const me = async () => (await app.api('GET', '/api/me', { token: user.token })).body;
const onDisk = (url) => fs.existsSync(path.join(UPLOAD_DIR, path.basename(url)));

test('a new user has no picture', async () => {
  assert.equal((await me()).avatarUrl, null);
  assert.equal('avatarPublicId' in (await me()), false); // an internal detail, never shown
});

test('uploading a picture saves it, returns its link, and shows it on the profile and on the file link', async () => {
  const res = await putAvatar('PNGDATA');
  assert.equal(res.status, 200);
  assert.match(res.body.avatarUrl, /^\/uploads\/.+\.png$/);
  assert.equal((await me()).avatarUrl, res.body.avatarUrl);
  assert.ok(onDisk(res.body.avatarUrl));
  const served = await fetch(`${app.base}${res.body.avatarUrl}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
});

test('login and register answers also carry the picture link', async () => {
  const login = await app.api('POST', '/api/auth/login', { body: { email: user.email, password: 'password123' } });
  assert.equal(login.body.user.avatarUrl, (await me()).avatarUrl);
  assert.equal('avatarPublicId' in login.body.user, false);
});

test('a new picture replaces the old one, and the old file is deleted', async () => {
  const first = (await me()).avatarUrl;
  const second = await putAvatar('JPEGDATA', { type: 'image/jpeg', name: 'new.jpg' });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.avatarUrl, first);
  assert.match(second.body.avatarUrl, /\.jpg$/);
  assert.equal(onDisk(first), false, 'the old picture must be deleted');
  assert.ok(onDisk(second.body.avatarUrl));
  assert.equal((await me()).avatarUrl, second.body.avatarUrl);
});

test('only images are accepted, at most 5 MB, in the field "avatar"; a refused upload changes nothing', async () => {
  const before = (await me()).avatarUrl;
  const pdf = await putAvatar('%PDF-1.4', { type: 'application/pdf', name: 'a.pdf' });
  assert.equal(pdf.status, 400);
  assert.match(pdf.body.error, /Invalid file type/);
  const big = await putAvatar(new Uint8Array(6 * 1024 * 1024), { name: 'big.png' });
  assert.equal(big.status, 400);
  assert.equal(big.body.error, 'Image too large. Max 5MB.');
  const wrongField = await putAvatar('x', { field: 'file' });
  assert.equal(wrongField.status, 400);
  assert.equal((await me()).avatarUrl, before);
  assert.ok(onDisk(before));
});

test('a request with no image is a 400, and without a token a 401', async () => {
  assert.equal((await app.api('PUT', '/api/me/avatar', { token: user.token, body: {} })).status, 400);
  assert.equal((await putAvatar('x', { token: null })).status, 401);
});

test('removing the picture clears the link and deletes the file; doing it again is fine', async () => {
  const url = (await me()).avatarUrl;
  const res = await app.api('DELETE', '/api/me/avatar', { token: user.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { avatarUrl: null });
  assert.equal((await me()).avatarUrl, null);
  assert.equal(onDisk(url), false);
  assert.equal((await app.api('DELETE', '/api/me/avatar', { token: user.token })).status, 200);
});

test('pictures are private to their owner: one user cannot change or see another\'s link', async () => {
  const other = await registerUser(app.api);
  assert.equal((await app.api('GET', '/api/me', { token: other.token })).body.avatarUrl, null);
  const mine = await putAvatar('MINE');
  assert.equal((await app.api('GET', '/api/me', { token: other.token })).body.avatarUrl, null);
  assert.ok(mine.body.avatarUrl);
});
