const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { DemoProvider } = require('../lib/demo');

// Smallest valid PNG (1x1 pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-trainer-'));
  const app = createApp({ dataDir, provider: new DemoProvider({ trainingMs: 50 }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const opts = { method };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  return { status: res.status, body: await res.json() };
}

test('upload, train, generate and rate out of 10', async () => {
  const created = await call('POST', '/api/projects', { name: 'My Dog' });
  assert.strictEqual(created.status, 201);
  const id = created.body.id;

  // Not enough pictures yet.
  assert.strictEqual((await call('POST', `/api/projects/${id}/train`)).status, 400);

  const form = new FormData();
  for (let i = 0; i < 5; i++) form.append('images', new Blob([PNG], { type: 'image/png' }), `dog${i}.png`);
  form.append('images', new Blob(['not an image'], { type: 'text/plain' }), 'notes.txt');
  const uploaded = await call('POST', `/api/projects/${id}/images`, form);
  assert.strictEqual(uploaded.body.trainingImages.length, 5, 'non-images are ignored');

  // Training images are served, the database is not.
  assert.strictEqual((await fetch(base + uploaded.body.trainingImages[0].url)).status, 200);
  assert.strictEqual((await fetch(base + '/files/db.json')).status, 404);

  // Can't generate before training.
  assert.strictEqual((await call('POST', `/api/projects/${id}/generate`, { prompt: 'x' })).status, 400);

  const training = await call('POST', `/api/projects/${id}/train`);
  assert.strictEqual(training.body.status, 'training');
  await new Promise((r) => setTimeout(r, 100));
  const ready = await call('GET', `/api/projects/${id}`);
  assert.strictEqual(ready.body.status, 'ready');
  assert.ok(ready.body.version);

  const gen = await call('POST', `/api/projects/${id}/generate`, { prompt: 'on the moon', count: 3 });
  assert.strictEqual(gen.status, 201);
  assert.strictEqual(gen.body.images.length, 3);
  assert.ok(gen.body.fullPrompt.startsWith(ready.body.triggerWord), 'trigger word is added to the prompt');
  assert.strictEqual((await fetch(base + gen.body.images[0].url)).status, 200);

  const [a, b] = gen.body.images;
  assert.strictEqual((await call('POST', `/api/images/${a.id}/rating`, { rating: 11 })).status, 400);
  assert.strictEqual((await call('POST', `/api/images/${a.id}/rating`, { rating: 0 })).status, 400);
  assert.strictEqual((await call('POST', `/api/images/${a.id}/rating`, { rating: 7.5 })).status, 400);
  assert.strictEqual((await call('POST', `/api/images/${a.id}/rating`, { rating: 9 })).body.rating, 9);
  assert.strictEqual((await call('POST', `/api/images/${b.id}/rating`, { rating: 6 })).body.rating, 6);

  const stats = (await call('GET', `/api/projects/${id}`)).body.stats;
  assert.deepStrictEqual(stats, { images: 3, rated: 2, avgRating: 7.5 });

  // Clearing a rating.
  assert.strictEqual((await call('POST', `/api/images/${b.id}/rating`, { rating: null })).body.rating, null);
  assert.strictEqual((await call('GET', `/api/projects/${id}`)).body.stats.avgRating, 9);

  const gens = await call('GET', `/api/projects/${id}/generations`);
  assert.strictEqual(gens.body.length, 1);

  assert.strictEqual((await call('DELETE', `/api/projects/${id}`)).status, 200);
  assert.strictEqual((await call('GET', `/api/projects/${id}`)).status, 404);
  assert.strictEqual((await call('POST', `/api/images/${a.id}/rating`, { rating: 5 })).status, 404);
});
