// Optional password so other people on your Wi-Fi can't use the app.
// Turned on by setting APP_PASSWORD.
const crypto = require('crypto');

const COOKIE = 'st_auth';
const OPEN_PATHS = new Set(['/login.html', '/api/login', '/style.css', '/manifest.webmanifest', '/sw.js']);

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setupAuth(app, password) {
  if (!password) return;
  const token = crypto.createHmac('sha256', password).update('style-trainer-session').digest('hex');

  app.post('/api/login', (req, res) => {
    if (!sameText(req.body && req.body.password, password)) {
      // Slow down guessing.
      return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 800);
    }
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`
    );
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path) || req.path.startsWith('/icons/')) return next();
    const got = readCookie(req, COOKIE);
    if (got && sameText(got, token)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) {
      return res.status(401).json({ error: 'Please log in again' });
    }
    res.redirect('/login.html');
  });
}

module.exports = { setupAuth };
