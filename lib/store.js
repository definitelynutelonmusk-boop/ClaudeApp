// Tiny JSON-file database. Good enough for a single-user local app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createStore(dataDir) {
  const DATA_DIR = path.resolve(dataDir);
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  fs.mkdirSync(path.join(DATA_DIR, 'projects'), { recursive: true });

  let db = { projects: [], generations: [] };
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }

  function save() {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }

  const newId = () => crypto.randomBytes(6).toString('hex');

  const projectDir = (projectId, sub = '') => {
    const dir = path.join(DATA_DIR, 'projects', projectId, sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const getProject = (id) => db.projects.find((p) => p.id === id);

  function findImage(imageId) {
    for (const gen of db.generations) {
      const image = gen.images.find((img) => img.id === imageId);
      if (image) return { gen, image };
    }
    return null;
  }

  return { DATA_DIR, db, save, newId, projectDir, getProject, findImage };
}

module.exports = { createStore };
