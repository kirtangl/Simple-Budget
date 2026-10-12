'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { openDatabase, getSetting, setSetting } = require('./db');
const { createAuth } = require('./auth');
const { createApi } = require('./api');
const { createUpdates } = require('./updates');
const { version: VERSION } = require('../package.json');

// Which build this is, shown in the app: "test" (APP_CHANNEL=test, e.g. a test
// copy), "beta" (a pre-release version like 0.6.0-beta.1), or "" for a release.
function appChannel() {
  const set = String(process.env.APP_CHANNEL || '').trim().toLowerCase();
  if (set === 'test' || set === 'beta') return set;
  return /-beta/i.test(VERSION) ? 'beta' : '';
}

// Only trust X-Forwarded-For from a reverse proxy you name (TRUST_PROXY), so
// nobody can dodge the login limit by pretending to be another address.
function trustProxy() {
  const v = String(process.env.TRUST_PROXY || '').trim();
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

// Which Host names the app answers to. Without this, a web page on another site
// could point its own name at this server ("DNS rebinding") and read the budget.
// Home-network names are always fine; anything else (like a domain in front of
// a reverse proxy) goes in ALLOWED_HOSTS, or ALLOWED_HOSTS=* to turn this off.
const HOME_NAMES = /(^localhost$|\.localhost$|\.local$|\.lan$|\.home$|\.home\.arpa$|\.internal$|\.localdomain$|\.ts\.net$)/i;
function hostAllowed(hostHeader) {
  const extra = String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (extra.includes('*')) return true;
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  if (!host) return false;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // an IP address
  if (!host.includes('.') || HOME_NAMES.test(host)) return true; // e.g. "nas" or "budget.local"
  return extra.some((h) => host === h || (h.startsWith('.') && host.endsWith(h)));
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

function createApp({ db, secureCookies = false, fetchImpl }) {
  // Keep the cookie signing secret in the database so logins survive restarts.
  let secret = process.env.SESSION_SECRET || getSetting(db, 'session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', secret);
  }

  const auth = createAuth({ db, secret, secureCookies });
  const updates = createUpdates({
    version: VERSION, channel: appChannel(), fetchImpl,
    repo: process.env.UPDATE_REPO || 'kirtangl/Simple-Budget', token: process.env.GITHUB_TOKEN || '',
  });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy());
  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host)) {
      return res.status(421).type('text/plain').send(`Simple Budget doesn't answer to "${String(req.headers.host || '').slice(0, 100)}". `
        + 'If this is your own address, add it to ALLOWED_HOSTS in .env (see the README).');
    }
    res.set(SECURITY_HEADERS);
    next();
  });
  // Small bodies everywhere, except a backup being restored.
  const smallJson = express.json({ limit: '100kb' });
  app.use((req, res, next) => (req.path === '/api/import' ? next() : smallJson(req, res, next)));
  app.use('/api/import', auth.require, express.json({ limit: '10mb' }));

  app.get('/api/version', (req, res) => res.json({ version: VERSION, channel: appChannel() }));
  app.get('/api/session', auth.status);
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);
  app.post('/api/password', auth.changePassword);
  app.get('/api/updates', auth.require, updates.get);
  app.post('/api/updates/check', auth.require, updates.checkNow);
  app.get('/api/me', auth.require, auth.me);
  app.put('/api/me/theme', auth.require, auth.saveTheme);
  app.get('/api/logins', auth.require, auth.listLogins);
  app.post('/api/logins', auth.require, auth.addLogin);
  app.patch('/api/logins/:id', auth.require, auth.updateLogin);
  app.delete('/api/logins/:id', auth.require, auth.removeLogin);
  app.use('/api', auth.require, createApi(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too big to send.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  app.locals.updates = updates;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'budget.db');
  const db = openDatabase(dbFile);
  const app = createApp({ db, secureCookies: process.env.SECURE_COOKIES === 'true' });
  app.locals.updates.start();
  app.listen(port, () => {
    console.log(`Simple Budget running on http://localhost:${port}`);
    if (getSetting(db, 'password_must_change') === '1') {
      console.log('The password is still the default "simplebudget". You will be asked to change it when you log in.');
    }
    if (process.env.APP_PASSWORD) {
      console.warn('APP_PASSWORD is no longer used. The password is now set inside the app (Settings → General).');
    }
  });
}

module.exports = { createApp, hostAllowed };
