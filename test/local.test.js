const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { LocalProvider } = require('../lib/local');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, base, dataDir, provider;

before(async () => {
  process.env.ENGINE_LOGS = '0';
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-trainer-local-'));
  provider = new LocalProvider({ dataDir, python: path.join(__dirname, 'fake-python.js') });
  await provider.check();
  server = createApp({ dataDir, provider, trainingSteps: 10 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  provider.shutdown();
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

async function waitForStatus(id, status) {
  for (let i = 0; i < 100; i++) {
    const p = (await call('GET', `/api/projects/${id}`)).body;
    if (p.status === status) return p;
    await sleep(20);
  }
  throw new Error(`project never became ${status}`);
}

async function makeProject() {
  const id = (await call('POST', '/api/projects', { name: 'Local' })).body.id;
  const form = new FormData();
  for (let i = 0; i < 5; i++) form.append('images', new Blob([PNG], { type: 'image/png' }), `p${i}.png`);
  await call('POST', `/api/projects/${id}/images`, form);
  return id;
}

test('reports the local engine', async () => {
  const { body } = await call('GET', '/api/status');
  assert.strictEqual(body.mode, 'local');
  assert.strictEqual(body.engine.gpu, 'Fake GPU');
});

test('trains locally, then generates with the trained LoRA', async () => {
  const id = await makeProject();
  assert.strictEqual((await call('POST', `/api/projects/${id}/train`)).body.status, 'training');
  const p = await waitForStatus(id, 'ready');
  assert.ok(fs.existsSync(path.join(dataDir, p.version, 'pytorch_lora_weights.safetensors')));
  const list = JSON.parse(fs.readFileSync(path.join(dataDir, p.version, 'images.json'), 'utf8'));
  assert.strictEqual(list.length, 5);

  const gen = await call('POST', `/api/projects/${id}/generate`, { prompt: 'a castle', count: 2 });
  assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
  assert.strictEqual(gen.body.images.length, 2);
  assert.strictEqual((await fetch(base + gen.body.images[0].url)).status, 200);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'tmp')), [], 'temp files are cleaned up');

  // Errors from the engine reach the user, and the worker keeps going afterwards.
  const bad = await call('POST', `/api/projects/${id}/generate`, { prompt: 'explode' });
  assert.strictEqual(bad.status, 500);
  assert.match(bad.body.error, /boom/);
  assert.strictEqual((await call('POST', `/api/projects/${id}/generate`, { prompt: 'ok' })).status, 201);

  // Good pictures can go back into the training set.
  const added = await call('POST', `/api/images/${gen.body.images[0].id}/add-to-training`);
  assert.strictEqual(added.body.trainingImages.length, 6);
});

test('a failed training run explains what went wrong', async () => {
  const id = await makeProject();
  process.env.FAKE_TRAIN_FAIL = '1';
  try {
    await call('POST', `/api/projects/${id}/train`);
    const p = await waitForStatus(id, 'failed');
    assert.match(p.error, /ran out of memory/);
  } finally {
    delete process.env.FAKE_TRAIN_FAIL;
  }
});

test('training that never finished is reported after a restart', async () => {
  const r = await provider.getTraining({ trainingId: 'local-gone', version: 'projects/x/models/local-gone' });
  assert.strictEqual(r.status, 'failed');
});
