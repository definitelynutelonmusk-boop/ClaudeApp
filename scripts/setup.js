// Sets up the local AI: creates a Python virtual environment in .venv and installs
// PyTorch + diffusers into it. Run with: npm run setup
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const venv = path.join(root, '.venv');
const isWin = process.platform === 'win32';
const venvPython = isWin ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.error || r.status !== 0) {
    console.error(`\nSetup failed while running: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

function findSystemPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : isWin ? ['py', 'python'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status === 0) {
      const [maj, min] = r.stdout.trim().split('.').map(Number);
      if (maj === 3 && min >= 10) return c;
      console.warn(`${c} is Python ${r.stdout.trim()}, but 3.10 or newer is needed.`);
    }
  }
  console.error('Python 3.10 or newer was not found. Install it from https://www.python.org/downloads/ and try again.');
  process.exit(1);
}

if (!fs.existsSync(venvPython)) {
  run(findSystemPython(), ['-m', 'venv', venv]);
}
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);

// On Windows, plain "pip install torch" gives a CPU-only build. Use the NVIDIA (CUDA) build instead.
// Override with TORCH_INDEX_URL, e.g. https://download.pytorch.org/whl/cu128 for newer cards.
const torchIndex = process.env.TORCH_INDEX_URL || (isWin ? 'https://download.pytorch.org/whl/cu124' : '');
if (torchIndex) run(venvPython, ['-m', 'pip', 'install', 'torch', '--index-url', torchIndex]);
run(venvPython, ['-m', 'pip', 'install', '-r', path.join('ml', 'requirements.txt')]);

console.log('\nChecking your hardware…');
run(venvPython, [path.join('ml', 'engine.py'), 'check']);
console.log('\nDone! Start the app with: npm start');
