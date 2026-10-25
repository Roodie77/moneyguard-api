// Account deletion when files are on Cloudinary (a fake here): the uploaded files are removed too, with retries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

process.env.CLOUDINARY_URL = 'cloudinary://123456:secret@demo'; // must be set before the app is imported

let app;
let query;
let sweep;
let n = 0;
const removed = [];
let failFor = new Set(); // public ids whose deletion should fail
before(async () => {
  app = await startApp();
  ({ query } = await import('../src/utils/db.js'));
  ({ sweepDeletedAccounts: sweep } = await import('../src/services/account.js'));
  const storage = await import('../src/services/storage.js');
  storage.setCloudDriver({
    async upload(buffer, { folder }) {
      const publicId = `${folder}/asset${++n}`;
      return { publicId, url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.png`, resourceType: 'image' };
    },
    async remove({ publicId, resourceType }) {
      if (failFor.has(publicId)) throw new Error('cloud is down');
      removed.push({ publicId, resourceType });
    },
  });
});
after(() => app.stop());

const makeDue = (id) => query("UPDATE users SET deletion_requested_at = now() - interval '25 hours', deletes_at = now() - interval '1 hour' WHERE id = $1", [id]);
const queued = async () => query('SELECT public_id, attempts FROM storage_cleanup ORDER BY public_id');
async function upload(token, kind) {
  const form = new FormData();
  form.append(kind === 'avatar' ? 'avatar' : 'file', new Blob(['PNG'], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${app.base}${kind === 'avatar' ? '/api/me/avatar' : '/api/files'}`, { method: kind === 'avatar' ? 'PUT' : 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return res.json();
}
async function deletedUserWithFiles() {
  const u = await registerUser(app.api);
  const file = await upload(u.token, 'file');
  await upload(u.token, 'file');
  const avatar = await upload(u.token, 'avatar');
  await app.api('DELETE', '/api/me', { token: u.token, body: { currentPassword: 'password123' } });
  await makeDue(u.user.id);
  return { u, ids: [file.publicId, `moneyguard/${u.user.id}/avatar/`], userId: u.user.id, avatarUrl: avatar.avatarUrl };
}

test('every uploaded file and the profile picture are deleted from Cloudinary, then the queue is empty', async () => {
  const { userId } = await deletedUserWithFiles();
  removed.length = 0;
  await sweep();
  const ids = removed.map((r) => r.publicId);
  assert.equal(ids.filter((id) => id.startsWith(`moneyguard/${userId}/`) && !id.includes('/avatar/')).length, 2); // two files
  assert.equal(ids.filter((id) => id.startsWith(`moneyguard/${userId}/avatar/`)).length, 1); // the picture
  assert.ok(removed.every((r) => r.resourceType === 'image'));
  assert.deepEqual(await queued(), []);
});

test('files are NOT touched during the grace period', async () => {
  const u = await registerUser(app.api);
  await upload(u.token, 'file');
  await app.api('DELETE', '/api/me', { token: u.token, body: { currentPassword: 'password123' } });
  removed.length = 0;
  await sweep();
  assert.deepEqual(removed, []);
});

test('if Cloudinary is unreachable the file stays queued and is retried on the next sweep', async () => {
  const { userId } = await deletedUserWithFiles();
  const mine = (await query("SELECT public_id FROM files WHERE user_id = $1 ORDER BY created_at", [userId])).map((r) => r.publicId);
  failFor = new Set(mine);
  removed.length = 0;
  await sweep();
  assert.equal((await query('SELECT 1 FROM users WHERE id = $1', [userId])).length, 0); // the account itself is gone regardless
  const left = (await queued()).filter((r) => mine.includes(r.publicId));
  assert.equal(left.length, 2);
  assert.ok(left.every((r) => r.attempts === 1));

  failFor = new Set(); // Cloudinary is back
  await sweep();
  assert.deepEqual((await queued()).filter((r) => mine.includes(r.publicId)), []);
  assert.ok(mine.every((id) => removed.some((r) => r.publicId === id)));
});

test('after 10 failed tries a file is left alone instead of being retried for ever', async () => {
  await query("INSERT INTO storage_cleanup (public_id, resource_type, attempts) VALUES ('moneyguard/stuck/forever', 'image', 10)");
  failFor = new Set(['moneyguard/stuck/forever']);
  removed.length = 0;
  await sweep();
  const [row] = await query("SELECT attempts FROM storage_cleanup WHERE public_id = 'moneyguard/stuck/forever'");
  assert.equal(row.attempts, 10); // not tried again
  failFor = new Set();
  await query("DELETE FROM storage_cleanup WHERE public_id = 'moneyguard/stuck/forever'");
});
