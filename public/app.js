const state = {
  mode: null,
  engine: null,
  minImages: 5,
  projects: [],
  currentId: null,
  tab: 'train',
  generations: [],
  latestGenId: null,
  sort: 'newest',
  prompt: '',
  count: '2',
  aspectRatio: '1:1',
  uploading: false,
  training: false,
  generating: false,
};
let pollTimer = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const current = () => state.projects.find((p) => p.id === state.currentId);
const ratingColor = (r) => `hsl(${((r - 1) / 9) * 120}, 70%, 55%)`;

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Can’t reach your computer. Check that the app is running and you’re on the same Wi-Fi.');
  }
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Please log in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

function upsertProject(p) {
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i === -1) state.projects.unshift(p);
  else state.projects[i] = p;
}

/* ---------- rendering ---------- */

function renderSidebar() {
  $('#project-list').innerHTML = state.projects
    .map(
      (p) => `<li data-id="${p.id}" class="${p.id === state.currentId ? 'active' : ''}">
        <span class="name">${esc(p.name)}</span>
        <span class="status ${p.status}">${p.status}</span>
      </li>`
    )
    .join('');
}

function ratingWidget(img) {
  const buttons = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    const on = img.rating != null && n <= img.rating;
    return `<button data-rate="${n}" data-img="${img.id}" class="${on ? 'on' : ''}"
      style="${on ? `background:${ratingColor(img.rating)}` : ''}" title="${n} out of 10">${n}</button>`;
  }).join('');
  return `<div class="rating-label"><span>Your rating</span>
      <span class="value" style="color:${img.rating ? ratingColor(img.rating) : 'var(--muted)'}">
        ${img.rating ? `${img.rating}/10` : 'not rated'}</span></div>
    <div class="rating">${buttons}</div>`;
}

function resultCard(img, gen) {
  const canAdd = state.mode !== 'demo' && img.rating >= 8 && !img.addedToTraining;
  return `<div class="result">
    <a class="img-link" href="${img.url}" target="_blank" rel="noopener"><img src="${img.url}" alt="${esc(gen.prompt)}" loading="lazy" /></a>
    <div class="body">
      <div class="prompt" title="${esc(gen.prompt)}">${esc(gen.prompt)}</div>
      ${ratingWidget(img)}
      <div class="actions">
        <a class="btn small" href="${img.url}" download>Save</a>
        ${canAdd ? `<button class="btn small" data-add="${img.id}">+ Add to training</button>` : ''}
      </div>
      ${img.addedToTraining ? `<div class="hint" style="margin:0">✓ Added to training pictures</div>` : ''}
    </div>
  </div>`;
}

function progressBar(percent) {
  return percent == null
    ? '<div class="progress"><div></div></div>'
    : `<div class="progress"><div class="fixed" style="width:${percent}%"></div></div>`;
}

function engineNotice() {
  const e = state.engine;
  if (state.mode !== 'local' || !e || e.checking) return '';
  if (!e.ok) return `<div class="notice err" style="margin:0 0 18px">Local AI isn’t ready: ${esc(e.error)}</div>`;
  if (e.device === 'cpu') {
    return `<div class="notice warn" style="margin:0 0 18px">No supported graphics card found, so the AI will run on your processor. That works, but training can take many hours and each picture several minutes.</div>`;
  }
  return '';
}

function renderTrainTab(p) {
  const n = p.trainingImages.length;
  const enough = n >= state.minImages;
  const isTraining = p.status === 'training';
  const newSinceTrain = p.version && p.trainedImageCount != null && n !== p.trainedImageCount;
  return `
    <div class="card">
      <h2>1. Your pictures (${n})</h2>
      <p class="hint">Upload 10–20 good pictures of what you want the AI to learn: a person, a pet, an object, or an art style.
        Use clear, varied pictures (different angles, backgrounds and lighting). JPG, PNG or WebP.</p>
      <label class="dropzone" id="dropzone">
        <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp" multiple hidden />
        ${state.uploading ? 'Uploading…' : '<b>Tap to choose pictures</b> or drag and drop them here'}
      </label>
      <div class="thumbs">
        ${p.trainingImages
          .map(
            (img) => `<div class="thumb"><img src="${img.url}" loading="lazy" alt="" />
            ${isTraining ? '' : `<button class="remove" data-remove="${img.file}" title="Remove">×</button>`}</div>`
          )
          .join('')}
      </div>
    </div>

    <div class="card">
      <h2>2. Train the AI</h2>
      <p class="hint">${
        state.mode === 'demo'
          ? 'Demo mode: training is simulated and takes a few seconds.'
          : 'Training runs on your own computer. With a good graphics card it takes about 15–40 minutes, and the first time also downloads the base model (several GB). Keep the app running; you can close this page and come back.'
      }</p>
      <div class="row">
        <button class="btn primary" id="train-btn" ${!enough || isTraining || state.training ? 'disabled' : ''}>
          ${isTraining ? 'Training…' : p.version ? 'Retrain with these pictures' : 'Start training'}
        </button>
        ${!enough ? `<span class="hint" style="margin:0">Add at least ${state.minImages - n} more picture${state.minImages - n === 1 ? '' : 's'}.</span>` : ''}
      </div>
      ${isTraining ? `${progressBar(p.percent)}<p class="hint" style="margin-top:8px">${esc(p.progress || 'Working…')}</p>` : ''}
      ${p.status === 'ready' && !isTraining ? `<div class="notice ok">Your model is trained${newSinceTrain ? `, but you've changed the pictures since then. Retrain to use them.` : '. Go to <b>Create</b> to make pictures.'}</div>` : ''}
      ${p.error ? `<div class="notice err">${esc(p.error)}</div>` : ''}
    </div>`;
}

function renderCreateTab(p) {
  const latest = state.generations.find((g) => g.id === state.latestGenId);
  return `
    <div class="card">
      <h2>Describe what you want</h2>
      <p class="hint">The AI uses what it learned from your pictures. Your model's trigger word <code>${esc(p.triggerWord)}</code> is added for you automatically.</p>
      <textarea id="prompt" placeholder="e.g. sitting on a beach at sunset, oil painting">${esc(state.prompt)}</textarea>
      <div class="row" style="margin-top:10px">
        <label>Pictures
          <select id="count">${[1, 2, 3, 4].map((n) => `<option ${String(n) === state.count ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label>Shape
          <select id="aspect">${[
            ['1:1', 'Square'],
            ['16:9', 'Wide'],
            ['9:16', 'Tall'],
            ['4:3', 'Landscape'],
            ['3:4', 'Portrait'],
          ]
            .map(([v, l]) => `<option value="${v}" ${v === state.aspectRatio ? 'selected' : ''}>${l}</option>`)
            .join('')}</select>
        </label>
        <button class="btn primary" id="generate-btn" ${state.generating ? 'disabled' : ''}>
          ${state.generating ? 'Making pictures…' : 'Generate'}</button>
      </div>
      ${state.generating ? `${progressBar(null)}<p class="hint" style="margin-top:8px">${state.mode === 'local' ? 'Working on your computer. The first picture after starting the app takes longer while the model loads.' : 'Working…'}</p>` : ''}
    </div>
    ${
      latest
        ? `<h2 style="font-size:18px">Rate these out of 10</h2>
           <div class="gallery">${latest.images.map((img) => resultCard(img, latest)).join('')}</div>`
        : ''
    }`;
}

function renderGalleryTab() {
  const all = state.generations.flatMap((g) => g.images.map((img) => ({ img, gen: g })));
  if (!all.length) return `<div class="card"><p class="hint" style="margin:0">No pictures yet. Make some in the <b>Create</b> tab.</p></div>`;

  const sorted = [...all];
  if (state.sort === 'best') sorted.sort((a, b) => (b.img.rating ?? -1) - (a.img.rating ?? -1));
  if (state.sort === 'worst') sorted.sort((a, b) => (a.img.rating ?? 11) - (b.img.rating ?? 11));
  const shown = state.sort === 'unrated' ? sorted.filter((x) => x.img.rating == null) : sorted;

  const counts = Array.from({ length: 10 }, (_, i) => all.filter((x) => x.img.rating === i + 1).length);
  const max = Math.max(1, ...counts);
  const histogram = counts
    .map((c, i) => `<div class="bar" title="${c} picture${c === 1 ? '' : 's'} rated ${i + 1}" style="height:${(c / max) * 100}%;background:${ratingColor(i + 1)}"><span>${i + 1}</span></div>`)
    .join('');

  return `
    <div class="card">
      <div class="toolbar" style="margin:0">
        <div><h2>Your ratings</h2><p class="hint" style="margin:0">How many pictures got each score out of 10.</p></div>
        <div class="histogram" style="margin-bottom:18px">${histogram}</div>
      </div>
    </div>
    <div class="toolbar">
      <span class="hint" style="margin:0">${shown.length} picture${shown.length === 1 ? '' : 's'}</span>
      <select id="sort">
        ${[
          ['newest', 'Newest first'],
          ['best', 'Highest rated'],
          ['worst', 'Lowest rated'],
          ['unrated', 'Not rated yet'],
        ]
          .map(([v, l]) => `<option value="${v}" ${v === state.sort ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
    </div>
    <div class="gallery">${shown.map(({ img, gen }) => resultCard(img, gen)).join('')}</div>
    ${state.mode !== 'demo' ? `<p class="hint" style="margin-top:16px">Tip: pictures you rate 8 or higher can be added back to your training pictures. Then retrain to make the model even better.</p>` : ''}`;
}

function renderMain() {
  const p = current();
  if (!p) return;
  const ready = Boolean(p.version);
  if (!ready && state.tab !== 'train') state.tab = 'train';
  const avg = p.stats.avgRating;

  $('#main').innerHTML = `
    <div class="project-header">
      <div>
        <h1>${esc(p.name)} <span class="status ${p.status}">${p.status}</span></h1>
        <div class="meta">${p.trainingImages.length} training pictures · ${p.stats.images} generated · ${p.stats.rated} rated</div>
      </div>
      <div class="row">
        <div class="score-card">
          <div class="big" style="color:${avg ? ratingColor(Math.round(avg)) : 'var(--muted)'}">${avg ?? '–'}<span style="font-size:15px;color:var(--muted)">/10</span></div>
          <div class="label">average rating</div>
        </div>
        <button class="btn danger small" id="delete-project">Delete</button>
      </div>
    </div>
    <nav class="tabs">
      <button class="tab ${state.tab === 'train' ? 'active' : ''}" data-tab="train">Train</button>
      <button class="tab ${state.tab === 'create' ? 'active' : ''}" data-tab="create" ${ready ? '' : 'disabled title="Train the model first"'}>Create</button>
      <button class="tab ${state.tab === 'gallery' ? 'active' : ''}" data-tab="gallery" ${ready ? '' : 'disabled title="Train the model first"'}>Gallery & ratings</button>
    </nav>
    ${engineNotice()}
    <div id="tab-content">${
      state.tab === 'train' ? renderTrainTab(p) : state.tab === 'create' ? renderCreateTab(p) : renderGalleryTab()
    }</div>`;
}

function render() {
  renderSidebar();
  renderMain();
}

/* ---------- actions ---------- */

async function selectProject(id) {
  state.currentId = id;
  state.latestGenId = null;
  state.generations = [];
  const p = current();
  state.tab = p && p.version ? 'create' : 'train';
  render();
  state.generations = await api('GET', `/api/projects/${id}/generations`);
  render();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const p = current();
  if (!p || p.status !== 'training') return;
  pollTimer = setTimeout(async () => {
    try {
      const updated = await api('GET', `/api/projects/${p.id}`);
      upsertProject(updated);
      if (updated.status === 'ready' && p.status === 'training') toast('Training finished! Your model is ready.');
      if (updated.status === 'failed') toast(updated.error || 'Training failed', true);
      if (state.currentId === updated.id) render();
    } catch (e) {
      console.error(e);
    }
    schedulePoll();
  }, state.mode === 'demo' ? 2000 : 4000);
}

async function uploadFiles(files) {
  const p = current();
  const images = [...files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
  if (!images.length) return toast('Please choose JPG, PNG or WebP pictures', true);
  state.uploading = true;
  render();
  try {
    // Upload in small batches so big sets of photos don't time out.
    for (let i = 0; i < images.length; i += 10) {
      const form = new FormData();
      images.slice(i, i + 10).forEach((f) => form.append('images', f));
      upsertProject(await api('POST', `/api/projects/${p.id}/images`, form));
    }
    toast(`Added ${images.length} picture${images.length === 1 ? '' : 's'}`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.uploading = false;
    render();
  }
}

async function rate(imageId, rating) {
  const gen = state.generations.find((g) => g.images.some((i) => i.id === imageId));
  const img = gen.images.find((i) => i.id === imageId);
  const newRating = img.rating === rating ? null : rating; // click the same score again to clear it
  try {
    Object.assign(img, await api('POST', `/api/images/${imageId}/rating`, { rating: newRating }));
    upsertProject(await api('GET', `/api/projects/${state.currentId}`));
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- events ---------- */

$('#new-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#new-project-name');
  try {
    const p = await api('POST', '/api/projects', { name: input.value });
    input.value = '';
    upsertProject(p);
    selectProject(p.id);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#project-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) selectProject(li.dataset.id);
});

const main = $('#main');

main.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-tab]');
  if (!t) return;
  const p = current();

  if (t.dataset.tab) {
    state.tab = t.dataset.tab;
    return render();
  }
  if (t.dataset.rate) return rate(t.dataset.img, Number(t.dataset.rate));

  if (t.dataset.remove) {
    try {
      upsertProject(await api('DELETE', `/api/projects/${p.id}/images/${encodeURIComponent(t.dataset.remove)}`));
      render();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (t.dataset.add) {
    try {
      upsertProject(await api('POST', `/api/images/${t.dataset.add}/add-to-training`));
      state.generations.forEach((g) => g.images.forEach((i) => i.id === t.dataset.add && (i.addedToTraining = true)));
      toast('Added to training pictures. Retrain to use it.');
      render();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (t.id === 'train-btn') {
    state.training = true;
    render();
    try {
      upsertProject(await api('POST', `/api/projects/${p.id}/train`));
      toast('Training started!');
      schedulePoll();
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.training = false;
      render();
    }
    return;
  }

  if (t.id === 'generate-btn') {
    if (!state.prompt.trim()) return toast('Type what you want a picture of', true);
    state.generating = true;
    render();
    try {
      const gen = await api('POST', `/api/projects/${p.id}/generate`, {
        prompt: state.prompt,
        count: Number(state.count),
        aspectRatio: state.aspectRatio,
      });
      state.generations.unshift(gen);
      state.latestGenId = gen.id;
      upsertProject(await api('GET', `/api/projects/${p.id}`));
    } catch (err) {
      toast(
        err.message.startsWith('Can’t reach')
          ? 'Lost connection while making pictures. If your computer is still on, they’ll show up in the Gallery.'
          : err.message,
        true
      );
    } finally {
      state.generating = false;
      render();
    }
    return;
  }

  if (t.id === 'delete-project') {
    if (!confirm(`Delete "${p.name}" and all its pictures? This can't be undone.`)) return;
    try {
      await api('DELETE', `/api/projects/${p.id}`);
      state.projects = state.projects.filter((x) => x.id !== p.id);
      state.currentId = null;
      location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

main.addEventListener('input', (e) => {
  if (e.target.id === 'prompt') state.prompt = e.target.value;
});
main.addEventListener('keydown', (e) => {
  if (e.target.id === 'prompt' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#generate-btn')?.click();
});
main.addEventListener('change', (e) => {
  if (e.target.id === 'count') state.count = e.target.value;
  if (e.target.id === 'aspect') state.aspectRatio = e.target.value;
  if (e.target.id === 'sort') {
    state.sort = e.target.value;
    render();
  }
  if (e.target.id === 'file-input') uploadFiles(e.target.files);
});

for (const type of ['dragenter', 'dragover']) {
  main.addEventListener(type, (e) => {
    const dz = e.target.closest('#dropzone');
    if (!dz) return;
    e.preventDefault();
    dz.classList.add('drag');
  });
}
main.addEventListener('dragleave', (e) => e.target.closest('#dropzone')?.classList.remove('drag'));
main.addEventListener('drop', (e) => {
  const dz = e.target.closest('#dropzone');
  if (!dz) return;
  e.preventDefault();
  dz.classList.remove('drag');
  uploadFiles(e.dataTransfer.files);
});

/* ---------- phone ---------- */

async function openPhoneModal() {
  $('#phone-modal').hidden = false;
  const box = $('#phone-content');
  try {
    const info = await api('GET', '/api/connect');
    if (!info.urls.length) {
      box.innerHTML = `<p class="hint">This computer doesn’t seem to be on a home network. Connect it to Wi-Fi or Ethernet and try again.</p>`;
      return;
    }
    box.innerHTML = `
      <p class="hint">Connect your phone to the same Wi-Fi, then scan this with the camera:</p>
      <div class="qr">${info.qr}</div>
      <p class="hint">Or type one of these into your phone’s browser:</p>
      <ul class="url-list">${info.urls.map((u) => `<li><code>${esc(u.url)}</code> <span class="hint">${esc(u.label)}</span></li>`).join('')}</ul>
      <p class="hint">Not loading? Allow Node.js through Windows Firewall (on private networks).
        To add it to your home screen, open your browser’s menu and choose <b>Add to Home screen</b>.</p>
      ${info.passwordProtected ? '' : `<p class="notice warn">No password set, so anyone on your Wi-Fi can use the app. Set <code>APP_PASSWORD</code> in <code>.env</code> to lock it.</p>`}`;
  } catch (e) {
    box.innerHTML = `<p class="notice err">${esc(e.message)}</p>`;
  }
}

$('#phone-btn').addEventListener('click', openPhoneModal);
$('#phone-close').addEventListener('click', () => ($('#phone-modal').hidden = true));
$('#phone-modal').addEventListener('click', (e) => {
  if (e.target.id === 'phone-modal') $('#phone-modal').hidden = true;
});

// Coming back to the app (e.g. after locking your phone): catch up on anything that finished meanwhile.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.currentId) return;
  try {
    upsertProject(await api('GET', `/api/projects/${state.currentId}`));
    state.generations = await api('GET', `/api/projects/${state.currentId}/generations`);
    render();
    schedulePoll();
  } catch (e) {
    console.error(e);
  }
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ---------- start ---------- */

async function loadStatus() {
  const status = await api('GET', '/api/status');
  state.mode = status.mode;
  state.engine = status.engine;
  state.minImages = status.minTrainingImages;
  const badge = $('#mode-badge');
  const e = status.engine;
  if (status.mode === 'demo') {
    badge.textContent = 'Demo mode (fake images)';
    badge.className = 'badge demo';
  } else if (!e || e.checking) {
    badge.textContent = 'Local AI: checking…';
    badge.className = 'badge';
    setTimeout(() => loadStatus().then(render).catch(console.error), 3000);
  } else if (!e.ok) {
    badge.textContent = 'Local AI: not set up';
    badge.className = 'badge err';
  } else {
    badge.textContent = `Local AI · ${e.gpu || 'CPU only (slow)'}`;
    badge.className = 'badge ' + (e.device === 'cpu' ? 'demo' : 'live');
    badge.title = `Base model: ${e.baseModel}`;
  }
}

(async function init() {
  try {
    await loadStatus();
    state.projects = await api('GET', '/api/projects');
    renderSidebar();
    if (state.projects.length) selectProject(state.projects[0].id);
  } catch (e) {
    toast(e.message, true);
  }
})();
