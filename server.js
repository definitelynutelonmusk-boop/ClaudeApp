const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { createStore } = require('./lib/store');
const { LocalProvider } = require('./lib/local');
const { DemoProvider } = require('./lib/demo');

const MIN_TRAINING_IMAGES = 5;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];

function createProvider(env, dataDir) {
  if (env.DEMO_MODE === '1') return new DemoProvider({ trainingMs: Number(env.DEMO_TRAINING_MS) || 8000 });
  return new LocalProvider({ dataDir, generationSteps: Number(env.GENERATION_STEPS) || 30 });
}

function createApp({ dataDir, provider, trainingSteps = 1000 }) {
  const store = createStore(dataDir);
  const { db, save, newId, projectDir, getProject, findImage } = store;
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  // Only the image folders are public, never db.json.
  app.use('/files/projects', express.static(path.join(store.DATA_DIR, 'projects'), { dotfiles: 'deny' }));

  const fileUrl = (projectId, sub, file) => `/files/projects/${projectId}/${sub}/${file}`;

  function serializeProject(p) {
    const gens = db.generations.filter((g) => g.projectId === p.id);
    const ratings = gens.flatMap((g) => g.images).map((i) => i.rating).filter((r) => r != null);
    return {
      ...p,
      trainingImages: p.trainingImages.map((file) => ({ file, url: fileUrl(p.id, 'training', file) })),
      stats: {
        images: gens.reduce((n, g) => n + g.images.length, 0),
        rated: ratings.length,
        avgRating: ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null,
      },
    };
  }

  function serializeGeneration(g) {
    return { ...g, images: g.images.map((img) => ({ ...img, url: fileUrl(g.projectId, 'outputs', img.file) })) };
  }

  // Ask the provider how training is going and record the result.
  async function refreshTraining(p) {
    if (p.status !== 'training' || !p.trainingId) return;
    try {
      const t = await provider.getTraining({ trainingId: p.trainingId, version: p.pendingVersion });
      p.progress = t.progress || null;
      p.percent = t.percent ?? null;
      if (t.status === 'ready') {
        p.status = 'ready';
        p.version = t.version;
        p.trainedAt = new Date().toISOString();
        p.trainedImageCount = p.pendingImageCount;
        p.progress = null;
        p.percent = null;
      } else if (t.status === 'failed') {
        // If an older version exists the model is still usable.
        p.status = p.version ? 'ready' : 'failed';
        p.error = t.error || 'Training failed';
        p.progress = null;
        p.percent = null;
      }
      save();
    } catch (e) {
      p.progress = `Could not check training status: ${e.message}`;
    }
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function requireProject(req, res) {
    const p = getProject(req.params.id);
    if (!p) res.status(404).json({ error: 'Model not found' });
    return p;
  }

  app.get('/api/status', (req, res) =>
    res.json({
      mode: provider.mode,
      engine: provider.status ? provider.status() : null,
      minTrainingImages: MIN_TRAINING_IMAGES,
    })
  );

  app.get('/api/projects', wrap(async (req, res) => {
    await Promise.all(db.projects.map(refreshTraining));
    res.json(db.projects.map(serializeProject));
  }));

  app.post('/api/projects', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Give your model a name' });
    const id = newId();
    const project = {
      id,
      name,
      // A made-up word the AI links to your pictures. It's added to every prompt.
      triggerWord: `STY${id.slice(0, 4).toUpperCase()}`,
      status: 'draft',
      trainingImages: [],
      createdAt: new Date().toISOString(),
    };
    db.projects.unshift(project);
    save();
    res.status(201).json(serializeProject(project));
  });

  app.get('/api/projects/:id', wrap(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    await refreshTraining(p);
    res.json(serializeProject(p));
  }));

  app.delete('/api/projects/:id', (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    db.projects.splice(db.projects.indexOf(p), 1);
    db.generations = db.generations.filter((g) => g.projectId !== p.id);
    save();
    fs.rmSync(path.join(store.DATA_DIR, 'projects', p.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, projectDir(req.params.id, 'training')),
      filename: (req, file, cb) => cb(null, `${newId()}.${IMAGE_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 50 },
    fileFilter: (req, file, cb) => cb(null, Boolean(IMAGE_TYPES[file.mimetype])),
  });

  app.post('/api/projects/:id/images', (req, res, next) => {
    if (!requireProject(req, res)) return;
    next();
  }, upload.array('images', 50), (req, res) => {
    const p = getProject(req.params.id);
    const files = (req.files || []).map((f) => f.filename);
    if (!files.length) return res.status(400).json({ error: 'Only JPG, PNG or WebP pictures can be used' });
    p.trainingImages.push(...files);
    save();
    res.json(serializeProject(p));
  });

  app.delete('/api/projects/:id/images/:file', (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const i = p.trainingImages.indexOf(req.params.file);
    if (i === -1) return res.status(404).json({ error: 'Picture not found' });
    p.trainingImages.splice(i, 1);
    save();
    fs.rmSync(path.join(projectDir(p.id, 'training'), req.params.file), { force: true });
    res.json(serializeProject(p));
  });

  app.post('/api/projects/:id/train', wrap(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    if (p.status === 'training') return res.status(409).json({ error: 'Already training' });
    if (p.trainingImages.length < MIN_TRAINING_IMAGES) {
      return res.status(400).json({ error: `Add at least ${MIN_TRAINING_IMAGES} pictures first (10–20 works best)` });
    }
    const dir = projectDir(p.id, 'training');
    const { trainingId, version } = await provider.startTraining({
      imagePaths: p.trainingImages.map((file) => path.join(dir, file)),
      triggerWord: p.triggerWord,
      steps: trainingSteps,
      outputDir: projectDir(p.id, 'models'),
    });
    Object.assign(p, {
      status: 'training',
      trainingId,
      pendingVersion: version,
      error: null,
      progress: 'Starting…',
      trainingStartedAt: new Date().toISOString(),
      pendingImageCount: p.trainingImages.length,
    });
    save();
    res.json(serializeProject(p));
  }));

  app.post('/api/projects/:id/generate', wrap(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    if (!p.version) return res.status(400).json({ error: 'Train the model before making pictures' });
    const userPrompt = String(req.body.prompt || '').trim().slice(0, 1000);
    if (!userPrompt) return res.status(400).json({ error: 'Type what you want a picture of' });
    const count = Math.min(4, Math.max(1, parseInt(req.body.count, 10) || 1));
    const aspectRatio = ASPECT_RATIOS.includes(req.body.aspectRatio) ? req.body.aspectRatio : '1:1';
    // The trigger word tells the model to use what it learned from your pictures.
    const prompt = userPrompt.includes(p.triggerWord) ? userPrompt : `${p.triggerWord}, ${userPrompt}`;

    const outputs = await provider.generate({ version: p.version, prompt, count, aspectRatio });
    const outDir = projectDir(p.id, 'outputs');
    const gen = {
      id: newId(),
      projectId: p.id,
      prompt: userPrompt,
      fullPrompt: prompt,
      aspectRatio,
      modelVersion: p.version,
      createdAt: new Date().toISOString(),
      images: outputs.map(({ buffer, ext }) => {
        const id = newId();
        const file = `${id}.${ext}`;
        fs.writeFileSync(path.join(outDir, file), buffer);
        return { id, file, rating: null };
      }),
    };
    db.generations.unshift(gen);
    save();
    res.status(201).json(serializeGeneration(gen));
  }));

  app.get('/api/projects/:id/generations', (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    res.json(db.generations.filter((g) => g.projectId === p.id).map(serializeGeneration));
  });

  // Rating out of 10 (send null to clear a rating).
  app.post('/api/images/:imageId/rating', (req, res) => {
    const found = findImage(req.params.imageId);
    if (!found) return res.status(404).json({ error: 'Image not found' });
    const { rating } = req.body;
    if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 10)) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 10' });
    }
    found.image.rating = rating;
    found.image.ratedAt = rating === null ? null : new Date().toISOString();
    save();
    res.json({ ...found.image, url: fileUrl(found.gen.projectId, 'outputs', found.image.file) });
  });

  // Feed a generated image you love back into the training pictures.
  app.post('/api/images/:imageId/add-to-training', (req, res) => {
    const found = findImage(req.params.imageId);
    if (!found) return res.status(404).json({ error: 'Image not found' });
    const p = getProject(found.gen.projectId);
    const ext = path.extname(found.image.file).slice(1);
    if (!Object.values(IMAGE_TYPES).includes(ext)) {
      return res.status(400).json({ error: 'Demo images can’t be used for training' });
    }
    if (found.image.addedToTraining) return res.status(409).json({ error: 'Already added' });
    const file = `${newId()}.${ext}`;
    fs.copyFileSync(path.join(projectDir(p.id, 'outputs'), found.image.file), path.join(projectDir(p.id, 'training'), file));
    p.trainingImages.push(file);
    found.image.addedToTraining = true;
    save();
    res.json(serializeProject(p));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
    res.status(status).json({ error: err.message || 'Something went wrong' });
  });

  return app;
}

if (require.main === module) {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file */
  }
  if (process.argv.includes('--demo')) process.env.DEMO_MODE = '1';
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const provider = createProvider(process.env, dataDir);
  const app = createApp({
    dataDir,
    provider,
    trainingSteps: Number(process.env.TRAINING_STEPS) || 1000,
  });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Style Trainer running at http://localhost:${port}`);
    if (provider.mode === 'demo') {
      console.log('DEMO MODE: training and images are simulated.');
      return;
    }
    console.log('Checking the local AI…');
    provider.check().then((info) => {
      if (!info.ok) return console.log(`Local AI not ready: ${info.error}`);
      const where = info.gpu ? `${info.gpu}${info.vramGb ? ` (${info.vramGb} GB)` : ''}` : 'CPU (very slow!)';
      console.log(`Local AI ready on ${where}. Base model: ${info.baseModel}`);
    });
  });
  const stop = () => {
    provider.shutdown?.();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createApp, createProvider };
