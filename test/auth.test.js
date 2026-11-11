const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { DemoProvider } = require('../lib/demo');

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-trainer-auth-'));
  server = createApp({ dataDir, provider: new DemoProvider(), password: 'hunter2' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const login = (password) =>
  fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

test('the app is locked until you log in', async () => {
  const page = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(page.status, 302);
  assert.strictEqual(page.headers.get('location'), '/login.html');
  assert.strictEqual((await fetch(base + '/api/projects')).status, 401);
  assert.strictEqual((await fetch(base + '/files/projects/x/outputs/y.png')).status, 401);

  // The login page and home-screen files stay reachable.
  for (const p of ['/login.html', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png']) {
    assert.strictEqual((await fetch(base + p)).status, 200, p);
  }
});

test('wrong password is rejected, right one unlocks everything', async () => {
  assert.strictEqual((await login('nope')).status, 401);
  assert.strictEqual((await login()).status, 401);

  const res = await login('hunter2');
  assert.strictEqual(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);

  const headers = { cookie };
  assert.strictEqual((await fetch(base + '/api/projects', { headers })).status, 200);
  assert.strictEqual((await fetch(base + '/', { headers })).status, 200);
  assert.strictEqual((await fetch(base + '/api/projects', { headers: { cookie: 'st_auth=forged' } })).status, 401);

  const connect = await (await fetch(base + '/api/connect', { headers })).json();
  assert.ok(Array.isArray(connect.urls));
  assert.strictEqual(connect.passwordProtected, true);
});
