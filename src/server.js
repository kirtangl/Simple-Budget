'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { openDatabase, getSetting, setSetting } = require('./db');
const { createAuth } = require('./auth');
const { createApi } = require('./api');
const { createShop } = require('./shop');
const { createPriceLookup } = require('./prices');
const { createUpdates, UpdateError, compareVersions, parseVersion } = require('./updates');
const { createBackups, BackupError } = require('./backups');
const { createConfig, ConfigError, splitHosts } = require('./config');
const { version: PACKAGE_VERSION } = require('../package.json');

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
  const INTERVALS = [1, 3, 6, 12, 24];
  const KEEPS = [5, 10, 20];
  const numSetting = (key, allowed, fallback) => {
    const n = Number(getSetting(db, key));
    return allowed.includes(n) ? n : fallback;
  };
  const backups = createBackups({ db, dataDir, keep: () => numSetting('backups_keep', KEEPS, 5) });
  recordVersion(db, backups);
  const auth = createAuth({ db, secret, secureCookies: () => secureCookies || config.secureCookies() });
  const updates = createUpdates({
    version: VERSION, fetchImpl,
    settings: () => ({ channel: appChannel(config.channel()), repo: config.updateRepo(), token: config.githubToken() }),
    updater: () => ({ url: process.env.UPDATER_URL || '', token: process.env.UPDATER_TOKEN || '', imageTag: process.env.IMAGE_TAG || 'latest' }),
    prefs: () => {
      const beta = getSetting(db, 'updates_beta');
      return {
        autoCheck: getSetting(db, 'updates_auto_check') !== '0',
        intervalHours: numSetting('updates_interval_hours', INTERVALS, 6),
        waitDay: getSetting(db, 'updates_wait_day') === '1',
        tokenIgnored: getSetting(db, 'updater_token_ignored') === '1',
        beta: beta === '1' ? true : beta === '0' ? false : null,
      };
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
  // Restoring a backup file replaces everything, so it's main login only, like a server restore,
  // and what was there is saved first when this copy keeps backups.
  app.use('/api/import', auth.require, (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (req.login.id !== 0) return res.status(403).json({ error: 'Only the main login can restore a backup.' });
    next();
  }, express.json({ limit: '10mb' }), (req, res, next) => {
    if (req.method !== 'POST' || !dataDir) return next();
    try { res.locals.safetyBackup = backups.create('restore'); } catch (err) { return next(err); }
    next();
  });

  // Bank details shouldn't be left in a shared computer's browser cache after logging out.
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Changes only come from the app's own pages. A page on another site, or on another
  // app on the same server, can't press buttons here on a logged-in browser's behalf.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: "That request didn't come from this app." });
    const origin = req.get('origin');
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* "null" or not an address */ }
      if (host !== req.get('host')) return res.status(403).json({ error: "That request didn't come from this app." });
    }
    next(); // neither header: a script or the command line, which a browser page can't pretend to be
  });

  // Express 4 doesn't catch a failed promise: pass the error on, so it's a 500, not a crash.
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/api/version', (req, res) => res.json({ version: VERSION, channel: appChannel(config.channel()) }));
  app.get('/api/session', auth.status);
  // Only the login form's JSON counts as a try, so a stray form post from another page can't lock anyone out.
  app.post('/api/login', (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'Send the password as JSON.' })), auth.login);
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
  app.put('/api/updates/prefs', auth.require, asyncRoute(async (req, res) => {
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
    if ('wait_day' in body) {
      if (typeof body.wait_day !== 'boolean') return res.status(400).json({ error: 'wait_day should be true or false.' });
      setSetting(db, 'updates_wait_day', body.wait_day ? '1' : '0');
    }
    // "Ignore" on the updater password warning: it stays, folded up, without the red dots.
    if ('token_ignored' in body) {
      if (typeof body.token_ignored !== 'boolean') return res.status(400).json({ error: 'token_ignored should be true or false.' });
      setSetting(db, 'updater_token_ignored', body.token_ignored ? '1' : '0');
    }
    if ('interval_hours' in body) {
      if (!INTERVALS.includes(body.interval_hours)) return res.status(400).json({ error: `interval_hours should be one of ${INTERVALS.join(', ')}.` });
      setSetting(db, 'updates_interval_hours', String(body.interval_hours));
    }
    if ('backups_keep' in body) {
      if (!KEEPS.includes(body.backups_keep)) return res.status(400).json({ error: `backups_keep should be one of ${KEEPS.join(', ')}.` });
      setSetting(db, 'backups_keep', String(body.backups_keep));
    }
    if (!updates.view().checkedAt && updates.view().auto_check) await updates.check();
    res.json(updates.view());
  }));

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
    keep: numSetting('backups_keep', KEEPS, 5),
  });
  app.get('/api/backups', auth.require, (req, res) => res.json(backupsView()));
  app.post('/api/backups', auth.require, backupError((req, res) => {
    const name = backups.create('manual');
    res.json({ ...backupsView(), created: name });
  }));
  app.delete('/api/backups/:name', auth.require, backupError((req, res) => {
    if (req.login.id !== 0) return res.status(403).json({ error: 'Only the main login can delete a backup.' });
    backups.remove(req.params.name);
    res.json(backupsView());
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
  app.post('/api/logins/:id/logout-everywhere', auth.require, auth.logoutEverywhere);

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
  const lookup = createPriceLookup({ db, fetchImpl: fetchImpl || globalThis.fetch });
  app.use('/api/shop', auth.require, createShop(db, { lookup }));
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
  app.locals.lookup = lookup;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'budget.db');
  const db = openDatabase(dbFile);
  const app = createApp({ db, secureCookies: process.env.SECURE_COOKIES === 'true', dataDir: path.dirname(dbFile) });
  app.locals.updates.start();
  app.locals.lookup.start();
  const server = app.listen(port, () => {
    console.log(`Simple Budget running on http://localhost:${port}`);
    if (getSetting(db, 'password_must_change') === '1') {
      console.log('The main password is still the default "simplebudget". You will be asked to change it when you log in.');
    }
    if (process.env.APP_PASSWORD) {
      console.warn('APP_PASSWORD is no longer used. The password is now set inside the app (Settings → Security).');
    }
  });
  // Docker asks the app to stop (an update, a restart, or `docker compose down`).
  // Stop taking new requests, let the ones under way finish (a backup download, say),
  // then close the database cleanly. Docker waits 10 seconds, so give up after 8.
  const stop = () => {
    const done = () => { try { db.close(); } catch { /* already closed */ } process.exit(0); };
    server.close(done);
    server.closeIdleConnections();
    setTimeout(done, 8000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp, hostAllowed };
