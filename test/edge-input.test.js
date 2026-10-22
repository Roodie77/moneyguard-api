// Edge cases in how the API handles unusual input. Each test states the behaviour we want.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp, registerUser } from './helpers.js';

const UPLOAD_DIR = path.join(import.meta.dirname, '../src/uploads');
const created = [];

let app;
let user;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 1000 } }); // expenses need a balance to draw on
});
after(async () => {
  for (const name of created) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  await app.stop();
});

const post = (p, body) => app.api('POST', p, { token: user.token, body });

test('NUL characters in text fields are a 400 (Postgres cannot store them, so they used to be a 500)', async () => {
  assert.equal((await post('/api/bills', { name: 'a\u0000b', amount: 5 })).status, 400);
  assert.equal((await post('/api/expenses', { amount: 5, category: 'a\u0000b' })).status, 400);
  assert.equal((await post('/api/expenses', { amount: 5, description: 'a\u0000b' })).status, 400);
});

test('impossible or unstorable dates are a 400, never a 500', async () => {
  const bad = [
    '0000-01-01', '10000-01-01T00:00:00Z', '1899-12-31', '2201-01-01', // outside 1900-2200
    '2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-01-01T25:00:00Z', // not real dates (JS would shift them)
    '2026-01-01T09:00:00', '2026-01-01 09:00:00Z', 'yesterday', // no time zone / not ISO
  ];
  for (const date of bad) {
    const res = await post('/api/expenses', { amount: 1, date });
    assert.equal(res.status, 400, `date ${date} gave ${res.status}`);
  }
});

test('valid dates are stored exactly as given (leap day, offsets, range limits)', async () => {
  const cases = [
    ['2028-02-29', '2028-02-29T00:00:00.000Z'],
    ['2026-12-01T09:00:00Z', '2026-12-01T09:00:00.000Z'],
    ['2026-12-01T09:00:00+05:30', '2026-12-01T03:30:00.000Z'],
    ['1900-01-01', '1900-01-01T00:00:00.000Z'],
    ['2200-12-31T23:59:59Z', '2200-12-31T23:59:59.000Z'],
  ];
  for (const [input, stored] of cases) {
    const res = await post('/api/expenses', { amount: 1, date: input });
    assert.equal(res.status, 201, input);
    assert.equal(res.body.date, stored, input);
  }
});

test('a malformed id made only of hyphens is a 404, not a database error', async () => {
  const res = await app.api('DELETE', `/api/bills/${'-'.repeat(36)}`, { token: user.token });
  assert.equal(res.status, 404);
});

test('passwords longer than 72 BYTES are rejected (bcrypt would silently ignore the rest)', async () => {
  const res = await app.api('POST', '/api/auth/register', { body: { email: `${randomUUID()}@test.dev`, password: 'é'.repeat(50) } });
  assert.equal(res.status, 400); // 50 characters but 100 bytes
});

test('unusual unicode emails never cause a server error, and registered ones can log in', async () => {
  for (const local of ['İstanbul', 'ÀÉÎ', 'straße', 'ΑΣ', 'ǅ']) {
    const email = `${local}.${randomUUID().slice(0, 8)}@test.dev`;
    const reg = await app.api('POST', '/api/auth/register', { body: { email, password: 'password123' } });
    assert.ok([201, 400].includes(reg.status), `${email} -> ${reg.status}`);
    if (reg.status === 201) {
      const login = await app.api('POST', '/api/auth/login', { body: { email, password: 'password123' } });
      assert.equal(login.status, 200, `registered ${email} but could not log in`);
    }
  }
});

test('JSON sent with the wrong content type is a clear 400, not a server error', async () => {
  const res = await fetch(`${app.base}/api/bills`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ name: 'x', amount: 1 }),
  });
  assert.equal(res.status, 400);
});

test('dotfiles in the uploads folder are not served', async () => {
  assert.equal((await fetch(`${app.base}/uploads/.gitkeep`)).status, 404);
  assert.equal((await fetch(`${app.base}/uploads/`)).status, 404);
});

test('non-ASCII file names survive upload intact', async () => {
  for (const name of ['résumé.pdf', 'こんにちは.pdf', 'बिल.pdf']) {
    const form = new FormData();
    form.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), name);
    const res = await fetch(`${app.base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${user.token}` }, body: form });
    const body = await res.json();
    if (body.filename) created.push(body.filename);
    assert.equal(res.status, 201);
    assert.equal(body.originalName, name);
  }
});

test('if saving the upload record fails, the stored file is removed (no orphans)', async () => {
  const { query } = await import('../src/utils/db.js');
  // Fails only for this exact file name, so concurrently running test files are unaffected.
  await query(`CREATE OR REPLACE FUNCTION fail_marked_upload() RETURNS trigger AS $$
    BEGIN IF NEW.original_name = 'trigger-failure.pdf' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END
    $$ LANGUAGE plpgsql`);
  await query('DROP TRIGGER IF EXISTS fail_marked_upload_trg ON files');
  await query('CREATE TRIGGER fail_marked_upload_trg BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION fail_marked_upload()');

  const marker = `ORPHAN-MARKER-${randomUUID()}`;
  try {
    const form = new FormData();
    form.append('file', new Blob([marker], { type: 'application/pdf' }), 'trigger-failure.pdf');
    const res = await fetch(`${app.base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${user.token}` }, body: form });
    assert.equal(res.status, 500);

    const leftovers = fs.readdirSync(UPLOAD_DIR).filter((f) => !f.startsWith('.') && fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8') === marker);
    leftovers.forEach((f) => created.push(f));
    assert.deepEqual(leftovers, [], 'the uploaded file was left on disk');
  } finally {
    await query('DROP TRIGGER IF EXISTS fail_marked_upload_trg ON files');
    await query('DROP FUNCTION IF EXISTS fail_marked_upload()');
  }
});
