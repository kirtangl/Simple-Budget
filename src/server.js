'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { openDatabase, getSetting, setSetting } = require('./db');
const { createAuth } = require('./auth');
const { createApi } = require('./api');
const { createUpdates, UpdateError, compareVersions } = require('./updates');
const { createBackups, BackupError } = require('./backups');
const { createConfig, ConfigError, splitHosts } = require('./config');
const { version: PACKAGE_VERSION } = require('../package.json');
const { parseVersion } = require('./updates');

// A release image is stamped with its release's version (APP_VERSION, set when
// it's built), so a pre-release like 0.8.0-beta.1 knows it's that, not 0.8.0.
const VERSION = parseVersion(process.env.APP_VERSION) ? String(process.env.APP_VERSION).trim().replace(/^v/, '') : PACKAGE_VERSION;

// Which build this is, shown in the app: "test" (e.g. a test copy), "beta"
// (a pre-release version like 0.6.0-beta.1), or "" for a release.
function appChannel(set = process.env.APP_CHANNEL) {
  const v = String(set || '').trim().toLowerCase();
  if (v === 'test' || v === 'beta') return v;
  return /-beta/i.test(VERSION) ? 'beta' : '';
}

// Which Host names the app answers to. Without this, a web page on another site
// could point its own name at this server ("DNS rebinding") and read the budget.
// Home-network names are always fine; anything else (like a domain in front of
// a reverse proxy) is added in Settings → Advanced or ALLOWED_HOSTS, or * to turn this off.
const HOME_NAMES = /(^localhost$|\.localhost$|\.local$|\.lan$|\.home$|\.home\.arpa$|\.internal$|\.localdomain$|\.ts\.net$)/i;
const bareHost = (hostHeader) => String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
function homeHost(hostHeader) {
  const host = bareHost(hostHeader);
  if (!host) return false;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // an IP address
  return !host.includes('.') || HOME_NAMES.test(host); // e.g. "nas" or "budget.local"
}
function hostAllowed(hostHeader, extra = splitHosts(process.env.ALLOWED_HOSTS)) {
  if (extra.includes('*')) return true;
  if (homeHost(hostHeader)) return true;
  const host = bareHost(hostHeader);
  const full = String(hostHeader || '').toLowerCase();
  return extra.some((h) => host === h || full === h || (h.startsWith('.') && host.endsWith(h)));
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

// Notes which version is running, and when it was installed. The first start on a
// newer version shows "Welcome to v…" in Settings → Updates until it's dismissed.
function recordVersion(db, backups) {
  const was = getSetting(db, 'installed_version');
  if (was === VERSION) return;
  const now = new Date().toISOString();
  let updated = Boolean(was) && compareVersions(VERSION, was) > 0;
  // Before v0.8.0 the version wasn't kept: a backup made for this version in the last hour means it was just installed.
  if (!was) updated = backups.list().some((b) => b.kind === 'update' && b.version === VERSION && Date.now() - Date.parse(b.created_at) < 60 * 60 * 1000);
  setSetting(db, 'installed_version', VERSION);
  setSetting(db, 'installed_at', now);
  if (updated) setSetting(db, 'just_updated', JSON.stringify({ from: was || null, to: VERSION, at: now }));
}

function createApp({ db, secureCookies = false, fetchImpl, dataDir = null }) {
  // Keep the cookie signing secret in the database so logins survive restarts.
  let secret = process.env.SESSION_SECRET || getSetting(db, 'session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', secret);
  }

  const config = createConfig(db);
  const backups = createBackups({ db, dataDir });
  recordVersion(db, backups);
  const auth = createAuth({ db, secret, secureCookies: () => secureCookies || config.secureCookies() });
  const updates = createUpdates({
    version: VERSION, fetchImpl,
    settings: () => ({ channel: appChannel(config.channel()), repo: config.updateRepo(), token: config.githubToken() }),
    updater: () => ({ url: process.env.UPDATER_URL || '', token: process.env.UPDATER_TOKEN || '', imageTag: process.env.IMAGE_TAG || 'latest' }),
    prefs: () => {
      const beta = getSetting(db, 'updates_beta');
      return { autoCheck: getSetting(db, 'updates_auto_check') !== '0', beta: beta === '1' ? true : beta === '0' ? false : null };
    },
    info: () => {
      let just = null;
      try { just = JSON.parse(getSetting(db, 'just_updated') || 'null'); } catch { /* ignore a bad value */ }
      // Shown for a week at most, and only on the version it welcomes.
      if (!just || just.to !== VERSION || !(Date.now() - Date.parse(just.at) < 7 * 24 * 60 * 60 * 1000)) just = null;
      const backup = just && backups.list().find((b) => b.kind === 'update' && b.version === VERSION);
      return { installed_at: getSetting(db, 'installed_at') || null, just_updated: just && { ...just, backup: backup ? backup.name : null } };
    },
  });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy());
  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host, config.allowedHosts())) {
      return res.status(421).type('text/plain').send(`Simple Budget doesn't answer to "${String(req.headers.host || '').slice(0, 100)}". `
        + 'If this is your own address, open the app by its IP address and add it in Settings → Advanced, or add it to ALLOWED_HOSTS in .env (see the README).');
    }
    res.set(SECURITY_HEADERS);
    next();
  });
  // Small bodies everywhere, except a backup being restored.
  const smallJson = express.json({ limit: '100kb' });
  app.use((req, res, next) => (req.path === '/api/import' ? next() : smallJson(req, res, next)));
  app.use('/api/import', auth.require, express.json({ limit: '10mb' }));

  app.get('/api/version', (req, res) => res.json({ version: VERSION, channel: appChannel(config.channel()) }));
  app.get('/api/session', auth.status);
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);
  app.post('/api/password', auth.changePassword);
  app.get('/api/updates', auth.require, updates.get);
  app.post('/api/updates/check', auth.require, updates.checkNow);
  app.post('/api/updates/install', auth.require, async (req, res, next) => {
    if (req.login.id !== 0) return res.status(403).json({ error: 'Only the main login can install updates.' });
    try {
      res.json(await updates.install({ backup: dataDir ? (v) => backups.create('update', v) : null }));
    } catch (err) {
      if (err instanceof UpdateError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });
  app.post('/api/updates/dismiss', auth.require, (req, res) => {
    db.prepare("DELETE FROM settings WHERE key = 'just_updated'").run();
    res.json(updates.view());
  });
  // Settings → Updates → Preferences. Main login only, like installing.
  app.put('/api/updates/prefs', auth.require, async (req, res) => {
    if (req.login.id !== 0) return res.status(403).json({ error: 'Only the main login can change these.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if ('beta' in body) {
      if (typeof body.beta !== 'boolean') return res.status(400).json({ error: 'beta should be true or false.' });
      if (process.env.UPDATER_URL) return res.status(400).json({ error: 'This copy follows IMAGE_TAG in .env. Set it to beta (or latest) there.' });
      setSetting(db, 'updates_beta', body.beta ? '1' : '0');
      updates.reset();
    }
    if ('auto_check' in body) {
      if (typeof body.auto_check !== 'boolean') return res.status(400).json({ error: 'auto_check should be true or false.' });
      setSetting(db, 'updates_auto_check', body.auto_check ? '1' : '0');
    }
    if (!updates.view().checkedAt && updates.view().auto_check) await updates.check();
    res.json(updates.view());
  });

  // Backups of the whole database, kept on the server. Anyone can make one; only the main login can restore.
  const backupError = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof BackupError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
  // data/backups inside the app's folder (as in Docker), or the full path elsewhere.
  const shortPath = (p) => {
    const rel = path.relative(path.join(__dirname, '..'), p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
  };
  const backupsView = () => ({
    available: Boolean(dataDir),
    folder: dataDir ? `${shortPath(backups.dir)}/` : null,
    backups: backups.list(),
  });
  app.get('/api/backups', auth.require, (req, res) => res.json(backupsView()));
  app.post('/api/backups', auth.require, backupError((req, res) => {
    const name = backups.create('manual');
    res.json({ ...backupsView(), created: name });
  }));
  app.post('/api/backups/restore', auth.require, backupError((req, res) => {
    if (req.login.id !== 0) return res.status(403).json({ error: 'Only the main login can restore a backup.' });
    const r = backups.restore(req.body && req.body.name);
    res.json({ ...backupsView(), ...r });
  }));
  app.get('/api/me', auth.require, auth.me);
  app.put('/api/me/theme', auth.require, auth.saveTheme);
  app.get('/api/logins', auth.require, auth.listLogins);
  app.post('/api/logins', auth.require, auth.addLogin);
  app.patch('/api/logins/:id', auth.require, auth.updateLogin);
  app.delete('/api/logins/:id', auth.require, auth.removeLogin);

  // Settings → Advanced: server settings. Anyone can look; only the main login can change them.
  const isHttps = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const advanced = (req) => ({
    values: {
      allowed_hosts: config.get('allowed_hosts'), trust_proxy: config.get('trust_proxy'),
      secure_cookies: config.secureCookies(), app_channel: config.channel(),
      update_repo: config.get('update_repo'),
    },
    github_token_set: Boolean(config.githubToken()),
    locked: config.locked(),
    can_edit: req.login.id === 0,
    image_tag: process.env.UPDATER_URL ? (process.env.IMAGE_TAG || 'latest') : null,
    host: String(req.headers.host || ''), host_is_home: homeHost(req.headers.host), https: isHttps(req),
    version: VERSION, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, database: process.env.DB_FILE ? 'custom' : 'data/budget.db',
  });
  app.get('/api/advanced', auth.require, (req, res) => res.json(advanced(req)));
  app.put('/api/advanced', auth.require, (req, res) => {
    if (req.login.id !== 0) return res.status(403).json({ error: 'Only the main login can change these.' });
    const body = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    // The token is only ever sent in, never back. Leaving it out keeps the saved one.
    if (body.github_token === undefined) delete body.github_token;
    if (body.remove_github_token) body.github_token = '';
    delete body.remove_github_token;
    try {
      if ('allowed_hosts' in body) {
        const hosts = splitHosts(body.allowed_hosts);
        if (!hostAllowed(req.headers.host, hosts)) {
          throw new ConfigError(`That would stop the app answering at ${req.headers.host}, the address you're using now. Keep it in the list.`);
        }
      }
      if (body.secure_cookies === true && !secureCookies && !config.secureCookies() && !isHttps(req)) {
        throw new ConfigError("Secure cookies only work over HTTPS. Open the app with https:// first, or you'd be logged out and unable to log back in.");
      }
      const changed = config.update(body);
      if (changed.includes('trust_proxy')) app.set('trust proxy', config.trustProxy());
      if (changed.some((k) => ['app_channel', 'update_repo', 'github_token'].includes(k))) updates.reset();
      // A new cookie setting applies from the next login cookie, so send a fresh one now.
      if (changed.includes('secure_cookies')) auth.refreshCookie(req, res);
    } catch (err) {
      if (err instanceof ConfigError) return res.status(400).json({ error: err.message });
      throw err;
    }
    res.json(advanced(req));
  });
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
  const app = createApp({ db, secureCookies: process.env.SECURE_COOKIES === 'true', dataDir: path.dirname(dbFile) });
  app.locals.updates.start();
  const server = app.listen(port, () => {
    console.log(`Simple Budget running on http://localhost:${port}`);
    if (getSetting(db, 'password_must_change') === '1') {
      console.log('The password is still the default "simplebudget". You will be asked to change it when you log in.');
    }
    if (process.env.APP_PASSWORD) {
      console.warn('APP_PASSWORD is no longer used. The password is now set inside the app (Settings → General).');
    }
  });
  // Docker asks the app to stop (an update, a restart, or `docker compose down`).
  // Stop at once instead of waiting to be killed, closing the database cleanly.
  const stop = () => { server.close(); try { db.close(); } catch { /* already closed */ } process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp, hostAllowed };
