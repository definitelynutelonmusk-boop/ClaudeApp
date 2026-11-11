#!/usr/bin/env node
// Stands in for "python ml/engine.py ..." in tests, speaking the same JSON protocol.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const [, , , cmd, ...rest] = process.argv; // argv[2] is the engine path
const arg = (name) => rest[rest.indexOf(name) + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

if (cmd === 'check') out({ ok: true, device: 'cuda', gpu: 'Fake GPU', vramGb: 24, baseModel: 'fake/model' });

if (cmd === 'train') {
  if (process.env.FAKE_TRAIN_FAIL) {
    console.error('Traceback (most recent call last):');
    console.error('torch.OutOfMemoryError: CUDA out of memory.');
    process.exit(1);
  }
  const images = JSON.parse(fs.readFileSync(arg('--images-list'), 'utf8'));
  out({ event: 'status', message: `Preparing ${images.length} pictures…` });
  const total = Number(arg('--steps'));
  out({ event: 'progress', step: total, total, loss: 0.1, secondsLeft: 0 });
  fs.writeFileSync(path.join(arg('--out'), 'pytorch_lora_weights.safetensors'), 'fake');
  fs.writeFileSync(path.join(arg('--out'), 'meta.json'), JSON.stringify({ trigger: arg('--trigger') }));
  setTimeout(() => out({ event: 'done' }), 50);
}

if (cmd === 'serve') {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    if (req.prompt.includes('explode')) return out({ id: req.id, ok: false, error: 'boom' });
    if (!fs.existsSync(path.join(req.lora, 'pytorch_lora_weights.safetensors'))) {
      return out({ id: req.id, ok: false, error: 'LoRA missing' });
    }
    for (const p of req.outPaths) fs.writeFileSync(p, PNG);
    out({ id: req.id, ok: true, files: req.outPaths });
  });
}
