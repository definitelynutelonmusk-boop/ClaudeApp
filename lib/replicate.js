// Real AI provider: fine-tunes a FLUX LoRA on Replicate and generates images with it.
// Docs: https://replicate.com/docs/get-started/fine-tune-with-flux
const API = 'https://api.replicate.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ReplicateProvider {
  constructor({ token, trainer = 'ostris/flux-dev-lora-trainer' }) {
    this.mode = 'replicate';
    this.token = token;
    this.trainer = trainer;
  }

  async api(method, pathname, body, extraHeaders = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(API + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const detail = (data && (data.detail || data.title)) || text || res.statusText;
      const err = new Error(`Replicate ${method} ${pathname} failed (${res.status}): ${detail}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async owner() {
    if (!this._owner) this._owner = (await this.api('GET', '/account')).username;
    return this._owner;
  }

  // The trained weights are saved as a new version of a private model on your account.
  async ensureModel(name) {
    const owner = await this.owner();
    try {
      await this.api('GET', `/models/${owner}/${name}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      await this.api('POST', '/models', {
        owner,
        name,
        visibility: 'private',
        hardware: 'gpu-t4',
        description: 'Custom image model trained with Style Trainer',
      });
    }
    return `${owner}/${name}`;
  }

  async startTraining({ zipBuffer, modelName, triggerWord, steps }) {
    const destination = await this.ensureModel(modelName);

    // 1. Upload the zip of training pictures.
    const form = new FormData();
    form.append('content', new Blob([zipBuffer], { type: 'application/zip' }), 'training-images.zip');
    const file = await this.api('POST', '/files', form);

    // 2. Start training using the latest version of the trainer.
    const [tOwner, tName] = this.trainer.split('/');
    const trainerModel = await this.api('GET', `/models/${tOwner}/${tName}`);
    const versionId = trainerModel.latest_version.id;
    const training = await this.api(
      'POST',
      `/models/${tOwner}/${tName}/versions/${versionId}/trainings`,
      {
        destination,
        input: {
          input_images: file.urls.get,
          trigger_word: triggerWord,
          steps,
        },
      }
    );
    return { trainingId: training.id };
  }

  async getTraining(trainingId) {
    const t = await this.api('GET', `/trainings/${trainingId}`);
    const status =
      t.status === 'succeeded' ? 'ready' : ['failed', 'canceled'].includes(t.status) ? 'failed' : 'training';
    const lastLog = (t.logs || '').trim().split('\n').pop() || '';
    return {
      status,
      version: t.output && t.output.version,
      error: t.error || (t.status === 'canceled' ? 'Training was canceled' : null),
      progress: lastLog.slice(0, 200),
    };
  }

  async generate({ version, prompt, count, aspectRatio }) {
    // version looks like "owner/model:hash"; the predictions API wants the hash.
    const versionId = version.includes(':') ? version.split(':').pop() : version;
    let p = await this.api(
      'POST',
      '/predictions',
      {
        version: versionId,
        input: {
          prompt,
          num_outputs: count,
          aspect_ratio: aspectRatio,
          output_format: 'png',
          lora_scale: 1,
          num_inference_steps: 28,
        },
      },
      { Prefer: 'wait' }
    );
    while (!['succeeded', 'failed', 'canceled'].includes(p.status)) {
      await sleep(2000);
      p = await this.api('GET', `/predictions/${p.id}`);
    }
    if (p.status !== 'succeeded') throw new Error(p.error || `Generation ${p.status}`);

    const urls = Array.isArray(p.output) ? p.output : [p.output];
    // Replicate's output links expire, so download the images right away.
    return Promise.all(
      urls.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Could not download generated image (${res.status})`);
        const ext = (new URL(url).pathname.match(/\.(png|jpe?g|webp)$/i) || [, 'png'])[1].toLowerCase();
        return { buffer: Buffer.from(await res.arrayBuffer()), ext };
      })
    );
  }
}

module.exports = { ReplicateProvider };
