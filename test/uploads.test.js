import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, registerUser } from './helpers.js';

const UPLOAD_DIR = path.join(import.meta.dirname, '../src/uploads');
const created = [];

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

async function upload(content, { type, name = 'file', token = user.token } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  const res = await fetch(`${app.base}/api/files`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body = await res.json();
  if (body.filename) created.push(body.filename);
  return { status: res.status, body };
}

test('an allowed file is stored and listed; the server path is not exposed', async () => {
  const res = await upload('%PDF-1.4 test', { type: 'application/pdf', name: 'statement.pdf' });
  assert.equal(res.status, 201);
  assert.equal(res.body.originalName, 'statement.pdf');
  assert.equal(res.body.mimetype, 'application/pdf');
  assert.equal(res.body.size, 13);
  assert.ok(res.body.filename.endsWith('.pdf'));
  assert.equal('path' in res.body, false);
  assert.equal(res.body.url, `/uploads/${res.body.filename}`); // kept on this server: the link is a path on it
  assert.equal(res.body.publicId, null);

  const list = await app.api('GET', '/api/files', { token: user.token });
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].url, res.body.url);
});

test('the stored extension comes from the file type, never the client filename ("evil.html" cannot stay .html)', async () => {
  const res = await upload('<script>alert(1)</script>', { type: 'image/png', name: 'evil.html' });
  assert.equal(res.status, 201);
  assert.ok(res.body.filename.endsWith('.png'));

  const served = await fetch(`${app.base}/uploads/${res.body.filename}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('disallowed file types are rejected', async () => {
  for (const [type, name] of [['text/html', 'a.html'], ['application/x-msdownload', 'a.exe'], ['text/plain', 'a.txt']]) {
    const res = await upload('data', { type, name });
    assert.equal(res.status, 400, type);
    assert.match(res.body.error, /Invalid file type/);
  }
});

test('files over 20MB are rejected', async () => {
  const res = await upload(new Uint8Array(21 * 1024 * 1024), { type: 'image/png', name: 'big.png' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too large/i);
});

test('a request without a file is a 400; without a token it is a 401', async () => {
  const empty = await app.api('POST', '/api/files', { token: user.token, body: {} });
  assert.equal(empty.status, 400);
  const anon = await upload('x', { type: 'image/png', name: 'a.png', token: null });
  assert.equal(anon.status, 401);
});

test("one user's files are not listed for another", async () => {
  const other = await registerUser(app.api);
  const list = await app.api('GET', '/api/files', { token: other.token });
  assert.deepEqual(list.body, []);
});
