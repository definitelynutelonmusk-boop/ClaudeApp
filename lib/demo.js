// Demo provider: no API key, no cost. "Training" finishes after a short wait and
// "generated" images are placeholder artwork, so you can try the whole app for free.
const crypto = require('crypto');

const escapeXml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

const SIZES = {
  '1:1': [768, 768],
  '16:9': [1024, 576],
  '9:16': [576, 1024],
  '4:3': [896, 672],
  '3:4': [672, 896],
};

function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

class DemoProvider {
  constructor({ trainingMs = 8000 } = {}) {
    this.mode = 'demo';
    this.trainingMs = trainingMs;
    this.trainings = new Map();
  }

  async startTraining({ modelName }) {
    const trainingId = `demo-${crypto.randomBytes(4).toString('hex')}`;
    this.trainings.set(trainingId, { startedAt: Date.now(), modelName });
    return { trainingId };
  }

  async getTraining(trainingId) {
    const t = this.trainings.get(trainingId);
    // After a server restart the in-memory record is gone; treat it as finished.
    if (!t) return { status: 'ready', version: `demo/model:${trainingId}` };
    const pct = Math.min(100, Math.round(((Date.now() - t.startedAt) / this.trainingMs) * 100));
    if (pct >= 100) return { status: 'ready', version: `demo/${t.modelName}:${trainingId}` };
    return { status: 'training', progress: `Demo training… ${pct}%` };
  }

  async generate({ prompt, count, aspectRatio }) {
    const [w, h] = SIZES[aspectRatio] || SIZES['1:1'];
    return Array.from({ length: count }, () => {
      const hue = Math.floor(Math.random() * 360);
      const hue2 = (hue + 60 + Math.floor(Math.random() * 120)) % 360;
      const circles = Array.from({ length: 7 }, () => {
        const r = 40 + Math.random() * (Math.min(w, h) / 3);
        return `<circle cx="${Math.random() * w}" cy="${Math.random() * h}" r="${r}" fill="hsla(${(hue + Math.random() * 90) % 360},80%,65%,0.35)"/>`;
      }).join('');
      const lines = wrap(prompt, 28)
        .map((l, i) => `<tspan x="50%" dy="${i === 0 ? 0 : 1.25}em">${escapeXml(l)}</tspan>`)
        .join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,35%)"/><stop offset="1" stop-color="hsl(${hue2},70%,20%)"/>
</linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>${circles}
<text x="50%" y="45%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(w / 22)}" fill="#fff">${lines}</text>
<text x="50%" y="${h - 24}" text-anchor="middle" font-family="sans-serif" font-size="16" fill="rgba(255,255,255,.7)">DEMO IMAGE: add a Replicate token for real AI pictures</text>
</svg>`;
      return { buffer: Buffer.from(svg), ext: 'svg' };
    });
  }
}

module.exports = { DemoProvider };
