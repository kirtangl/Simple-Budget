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
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(express.json({ limit: '10mb' }));

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

module.exports = { createApp };
