// Local provider: trains and generates on your own computer by running ml/engine.py.
// No API, no account, no content filter.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ENGINE = path.join(__dirname, '..', 'ml', 'engine.py');
const LORA_FILE = 'pytorch_lora_weights.safetensors';
const DEFAULT_NEGATIVE = 'blurry, low quality, jpeg artifacts, deformed, watermark, text';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function findPython(root) {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv =
    process.platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Turn a Python traceback into something a person can act on.
function explain(stderrLines, fallback) {
  const text = stderrLines.join('\n');
  if (/ModuleNotFoundError|No module named/.test(text)) {
    return 'The local AI isn’t installed yet. Run "npm run setup" and restart the app.';
  }
  if (/out of memory|OutOfMemoryError/i.test(text)) {
    return 'Your graphics card ran out of memory. Try LOW_VRAM=1 or a smaller model (see README).';
  }
  const last = stderrLines.filter((l) => l.trim()).pop();
  return fallback || last || 'The local AI stopped unexpectedly';
}

function collectStderr(stream, tail, label) {
  readline.createInterface({ input: stream }).on('line', (line) => {
    tail.push(line);
    if (tail.length > 40) tail.shift();
    if (process.env.ENGINE_LOGS !== '0') console.error(`[${label}] ${line}`);
  });
}

class LocalProvider {
  constructor({ dataDir, python, generationSteps = 30 }) {
    this.mode = 'local';
    this.dataDir = path.resolve(dataDir);
    this.python = python || findPython(path.join(__dirname, '..'));
    this.generationSteps = generationSteps;
    this.trainings = new Map();
    this.activeTraining = null;
    this.worker = null;
    this.seq = 0;
    this.info = { checking: true };
  }

  // Ask Python which device it will use, so the page can show it.
  check() {
    return new Promise((resolve) => {
      const tail = [];
      let result = null;
      const proc = spawn(this.python, [ENGINE, 'check'], { stdio: ['ignore', 'pipe', 'pipe'] });
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        try {
          result = JSON.parse(line);
        } catch {
          /* ignore */
        }
      });
      collectStderr(proc.stderr, tail, 'engine check');
      proc.on('error', (e) => {
        this.info = { ok: false, error: `Python wasn’t found (${this.python}). Install Python 3.10+ and run "npm run setup". (${e.message})` };
        resolve(this.info);
      });
      proc.on('close', () => {
        if (this.info.ok === false) return;
        this.info = result && result.ok ? result : { ok: false, error: explain(tail, result && result.error) };
        resolve(this.info);
      });
    });
  }

  status() {
    return this.info;
  }

  async startTraining({ imagePaths, triggerWord, steps, outputDir }) {
    if (this.activeTraining) throw httpError(409, 'Another model is already training. Only one can train at a time.');
    if (this.worker && this.worker.pending.size) {
      throw httpError(409, 'Wait for the pictures being made to finish, then start training.');
    }
    this.stopWorker(); // free the graphics card's memory for training

    const trainingId = `local-${crypto.randomBytes(4).toString('hex')}`;
    const outDir = path.join(outputDir, trainingId);
    fs.mkdirSync(outDir, { recursive: true });
    const listFile = path.join(outDir, 'images.json');
    fs.writeFileSync(listFile, JSON.stringify(imagePaths));
    const version = path.relative(this.dataDir, outDir);

    const t = { status: 'training', progress: 'Starting…', version, error: null };
    this.trainings.set(trainingId, t);
    this.activeTraining = trainingId;

    const tail = [];
    const proc = spawn(
      this.python,
      [ENGINE, 'train', '--images-list', listFile, '--out', outDir, '--trigger', triggerWord, '--steps', String(steps)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    t.proc = proc;
    let reportedError = null;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event === 'status') t.progress = msg.message;
      if (msg.event === 'progress') {
        const pct = Math.round((msg.step / msg.total) * 100);
        const mins = Math.ceil(msg.secondsLeft / 60);
        t.progress = `Learning from your pictures: step ${msg.step} of ${msg.total} (${pct}%), about ${mins} min left`;
        t.percent = pct;
      }
      if (msg.event === 'error') reportedError = msg.error;
    });
    collectStderr(proc.stderr, tail, 'training');
    proc.on('error', (e) => {
      reportedError = `Python wasn’t found (${this.python}): ${e.message}`;
    });
    proc.on('close', (code) => {
      if (this.activeTraining === trainingId) this.activeTraining = null;
      t.proc = null;
      if (code === 0 && fs.existsSync(path.join(outDir, LORA_FILE))) {
        t.status = 'ready';
      } else {
        t.status = 'failed';
        t.error = reportedError || explain(tail);
      }
    });

    return { trainingId, version };
  }

  async getTraining({ trainingId, version }) {
    const t = this.trainings.get(trainingId);
    if (t) {
      return { status: t.status, version: t.version, error: t.error, progress: t.progress, percent: t.percent };
    }
    // The app was restarted. Check whether the training finished before that.
    if (version && fs.existsSync(path.join(this.dataDir, version, LORA_FILE))) return { status: 'ready', version };
    return { status: 'failed', error: 'Training stopped because the app was closed. Start it again.' };
  }

  async generate({ version, prompt, count, aspectRatio }) {
    if (this.activeTraining) {
      throw httpError(409, 'Your graphics card is busy training a model. Try again when training finishes.');
    }
    const tmpDir = path.join(this.dataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPaths = Array.from({ length: count }, () => path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}.png`));
    try {
      await this.request({
        cmd: 'generate',
        lora: path.join(this.dataDir, version),
        prompt,
        negativePrompt: DEFAULT_NEGATIVE,
        aspect: aspectRatio,
        steps: this.generationSteps,
        outPaths,
      });
      return outPaths.map((p) => ({ buffer: fs.readFileSync(p), ext: 'png' }));
    } finally {
      for (const p of outPaths) fs.rmSync(p, { force: true });
    }
  }

  // The generation worker stays running so the model is only loaded once.
  ensureWorker() {
    if (this.worker) return this.worker;
    const proc = spawn(this.python, [ENGINE, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const w = { proc, pending: new Map(), tail: [], stopping: false };
    proc.stdin.on('error', () => {});
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const p = w.pending.get(msg.id);
      if (!p) return;
      w.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'Image generation failed'));
    });
    collectStderr(proc.stderr, w.tail, 'generate');
    const fail = (err) => {
      for (const p of w.pending.values()) p.reject(err);
      w.pending.clear();
      if (this.worker === w) this.worker = null;
    };
    proc.on('error', (e) => fail(new Error(`Python wasn’t found (${this.python}): ${e.message}`)));
    proc.on('close', () => fail(new Error(w.stopping ? 'The image engine was stopped' : explain(w.tail))));
    this.worker = w;
    return w;
  }

  request(payload) {
    const w = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      w.pending.set(id, { resolve, reject });
      w.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  stopWorker() {
    if (!this.worker) return;
    this.worker.stopping = true;
    this.worker.proc.kill();
    this.worker = null;
  }

  shutdown() {
    this.stopWorker();
    for (const t of this.trainings.values()) if (t.proc) t.proc.kill();
  }
}

module.exports = { LocalProvider, findPython };
