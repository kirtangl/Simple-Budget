'use strict';

// Household logins. The main household password is stored hashed in the
// settings; on a fresh install it is DEFAULT_PASSWORD and the app asks for a
// new one on first login. Extra logins (e.g. one each) live in the `logins`
// table, each with its own password and theme. Everyone sees the same budget.
//
// A successful login sets a long-lived, HMAC-signed cookie naming the login,
// so nobody has to log in again on the same device. Changing a password logs
// that login out on every other device, because the signature includes its
// password hash. Removing a login does the same.

const crypto = require('node:crypto');
const { getSetting, setSetting, transaction } = require('./db');

const DEFAULT_PASSWORD = 'simplebudget';
const MIN_LENGTH = 6;
const LEGACY_COOKIE = 'sb_session'; // before each copy had its own cookie name
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MAIN = 0; // the main household login

// Themes a login can pick, and the colours a custom theme can set.
const THEMES = ['system', 'light', 'dark', 'warm', 'ocean', 'slate', 'midnight', 'custom'];
const THEME_COLOURS = ['bg', 'card', 'inset', 'text', 'muted', 'line', 'brand', 'brand-soft', 'on-brand', 'info', 'paid', 'paid-soft',
  'due', 'due-soft', 'firm', 'danger', 'danger-soft', 'upcoming', 'upcoming-soft'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(stored, given) {
  if (typeof given !== 'string' || typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(given, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Put the default password back on the main login and ask for a new one at next login.
function resetPassword(db) {
  transaction(db, () => {
    setSetting(db, 'password_hash', hashPassword(DEFAULT_PASSWORD));
    setSetting(db, 'password_must_change', '1');
  });
}

function ensurePassword(db) {
  if (!getSetting(db, 'password_hash')) resetPassword(db);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

// A custom theme: only known colour names, each a #rrggbb colour.
function cleanCustomTheme(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The custom theme should be a set of colours.');
  const out = {};
  for (const key of THEME_COLOURS) {
    const c = value[key];
    if (c == null) continue;
    if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`"${key}" should be a colour like #1f2937.`);
    out[key] = c.toLowerCase();
  }
  return out;
}

function createAuth({ db, secret, secureCookies }) {
  ensurePassword(db);
  const failures = new Map(); // ip -> { count, until }

  const mustChange = () => getSetting(db, 'password_must_change') === '1';
  const extras = () => db.prepare('SELECT * FROM logins ORDER BY name COLLATE NOCASE, id').all();
  const main = () => {
    let custom = null;
    try { custom = JSON.parse(getSetting(db, 'main_custom_theme') || 'null'); } catch { /* ignore a bad value */ }
    return { id: MAIN, name: getSetting(db, 'main_login_name') || 'Main', password_hash: getSetting(db, 'password_hash'),
      theme: getSetting(db, 'main_theme') || null, custom_theme: custom, colour: getSetting(db, 'main_colour') || null, main: true };
  };
  const loginById = (id) => {
    if (id === MAIN) return main();
    const row = db.prepare('SELECT * FROM logins WHERE id = ?').get(id);
    if (!row) return null;
    let custom = null;
    try { custom = JSON.parse(row.custom_theme || 'null'); } catch { /* ignore a bad value */ }
    return { ...row, custom_theme: custom, main: false };
  };
  const allLogins = () => [main(), ...extras().map((r) => loginById(r.id))];
  const publicLogin = (l, me) => ({ id: l.id, name: l.name, colour: l.colour || null, main: l.main, you: l.id === me });

  // Cookies are shared by every port on a host, so a test copy next to the live
  // one would overwrite its login. Each copy's name comes from its own secret.
  const COOKIE = `sb_session_${crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8)}`;

  const sign = (value, hash) => crypto.createHmac('sha256', `${secret}:${hash}`).update(value).digest('base64url');

  function makeToken(id) {
    const value = `${id}.${Date.now() + MAX_AGE_MS}`;
    return `${value}.${sign(value, loginById(id).password_hash)}`;
  }

  // The login this request is from, or null. Cookies from before extra logins
  // existed ("expires.signature") belong to the main login.
  function currentLogin(req) {
    return loginFromToken(readCookie(req, COOKIE)) || loginFromToken(readCookie(req, LEGACY_COOKIE));
  }
  // Was this request logged in only by the old shared cookie name?
  const usedLegacy = (req) => !loginFromToken(readCookie(req, COOKIE)) && Boolean(loginFromToken(readCookie(req, LEGACY_COOKIE)));

  function loginFromToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    let id; let expires; let value;
    if (parts.length === 2) { id = MAIN; [expires] = parts; value = expires; } else if (parts.length === 3) {
      id = Number(parts[0]); expires = parts[1]; value = `${parts[0]}.${parts[1]}`;
    } else return null;
    const sig = parts.at(-1);
    if (!Number.isInteger(id) || !expires || !sig) return null;
    const login = loginById(id);
    if (!login) return null;
    const expected = Buffer.from(sign(value, login.password_hash));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    return Number(expires) > Date.now() ? login : null;
  }

  const setCookie = (res, id) => res.cookie(COOKIE, makeToken(id), {
    httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: MAX_AGE_MS, path: '/',
  });

  // A new password must be long enough, not the default, and not one another login already uses.
  function checkNewPassword(password, exceptId) {
    if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Please use at least ${MIN_LENGTH} characters.`;
    if (password === DEFAULT_PASSWORD) return 'Please choose something other than the default password.';
    if (allLogins().some((l) => l.id !== exceptId && checkPassword(l.password_hash, password))) {
      return 'Another login already uses that password. Each login needs its own.';
    }
    return null;
  }
  // A login's icon colour: #rrggbb, or empty for the theme's own.
  const cleanColour = (c) => {
    if (c == null || c === '') return null;
    if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) throw new Error('The colour should look like #1f2937.');
    return c.toLowerCase();
  };
  const cleanName = (name) => (typeof name === 'string' ? name.trim().slice(0, 40) : '');

  return {
    status(req, res) {
      const must = mustChange();
      // Before login, only reveal that the default is still in use (so the
      // login screen can say what it is) on a brand new install.
      res.json({ loggedIn: Boolean(currentLogin(req)), mustChangePassword: must, defaultPassword: must ? DEFAULT_PASSWORD : undefined });
    },

    // The password alone says which login it is.
    login(req, res) {
      const ip = req.ip;
      const entry = failures.get(ip);
      if (entry && entry.until > Date.now()) {
        return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
      }
      const given = req.body && req.body.password;
      const match = allLogins().find((l) => checkPassword(l.password_hash, given));
      if (!match) {
        const count = (entry ? entry.count : 0) + 1;
        failures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
        return res.status(401).json({ error: 'That password is not right.' });
      }
      failures.delete(ip);
      setCookie(res, match.id);
      res.json({ ok: true, mustChangePassword: mustChange() });
    },

    logout(req, res) {
      res.clearCookie(COOKIE, { path: '/' });
      res.clearCookie(LEGACY_COOKIE, { path: '/' });
      res.json({ ok: true });
    },

    // Change your own password. The current one is only asked for when it isn't the first-run default.
    changePassword(req, res) {
      const me = currentLogin(req);
      if (!me) return res.status(401).json({ error: 'Please log in.' });
      const { current, password } = req.body || {};
      const first = me.id === MAIN && mustChange();
      if (!first && !checkPassword(me.password_hash, current)) {
        return res.status(400).json({ error: 'Your current password is not right.' });
      }
      const problem = checkNewPassword(password, me.id);
      if (problem) return res.status(400).json({ error: problem });
      if (me.id === MAIN) {
        transaction(db, () => {
          setSetting(db, 'password_hash', hashPassword(password));
          setSetting(db, 'password_must_change', '0');
        });
      } else {
        db.prepare('UPDATE logins SET password_hash = ? WHERE id = ?').run(hashPassword(password), me.id);
      }
      setCookie(res, me.id); // the old cookie stopped working when the hash changed
      res.json({ ok: true });
    },

    require(req, res, next) {
      const me = currentLogin(req);
      if (!me) return res.status(401).json({ error: 'Please log in.' });
      if (mustChange()) return res.status(403).json({ error: 'Please choose a new password first.', mustChangePassword: true });
      req.login = me;
      // Move a login from the old shared cookie onto this copy's own.
      if (usedLegacy(req)) { setCookie(res, me.id); res.clearCookie(LEGACY_COOKIE, { path: '/' }); }
      next();
    },

    // Who's logged in, and their theme.
    me(req, res) {
      const l = req.login;
      res.json({ id: l.id, name: l.name, main: l.main, colour: l.colour || null, theme: l.theme || 'system', custom_theme: l.custom_theme || null });
    },

    saveTheme(req, res) {
      const { theme, custom_theme: customTheme } = req.body || {};
      if (!THEMES.includes(theme)) return res.status(400).json({ error: 'Pick one of the themes.' });
      let custom;
      try { custom = customTheme === undefined ? req.login.custom_theme : cleanCustomTheme(customTheme); } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const json = custom ? JSON.stringify(custom) : null;
      if (req.login.id === MAIN) {
        transaction(db, () => { setSetting(db, 'main_theme', theme); setSetting(db, 'main_custom_theme', json || ''); });
      } else {
        db.prepare('UPDATE logins SET theme = ?, custom_theme = ? WHERE id = ?').run(theme, json, req.login.id);
      }
      res.json({ theme, custom_theme: custom });
    },

    listLogins(req, res) {
      res.json(allLogins().map((l) => publicLogin(l, req.login.id)));
    },

    addLogin(req, res) {
      const { name, password, colour } = req.body || {};
      const n = cleanName(name);
      if (!n) return res.status(400).json({ error: 'Give the login a name, like "Sam".' });
      let c;
      try { c = cleanColour(colour); } catch (err) { return res.status(400).json({ error: err.message }); }
      const problem = checkNewPassword(password, null);
      if (problem) return res.status(400).json({ error: problem });
      const { lastInsertRowid } = db.prepare('INSERT INTO logins (name, password_hash, colour) VALUES (?, ?, ?)').run(n, hashPassword(password), c);
      res.status(201).json(publicLogin(loginById(Number(lastInsertRowid)), req.login.id));
    },

    // Rename or recolour any login, or set a new password for another login (e.g. if it's been forgotten).
    updateLogin(req, res) {
      const id = Number(req.params.id);
      const login = Number.isInteger(id) ? loginById(id) : null;
      if (!login) return res.status(404).json({ error: 'Not found.' });
      const { name, password, colour } = req.body || {};
      if (colour !== undefined) {
        let c;
        try { c = cleanColour(colour); } catch (err) { return res.status(400).json({ error: err.message }); }
        if (id === MAIN) setSetting(db, 'main_colour', c || '');
        else db.prepare('UPDATE logins SET colour = ? WHERE id = ?').run(c, id);
      }
      if (name !== undefined) {
        const n = cleanName(name);
        if (!n) return res.status(400).json({ error: 'Give the login a name.' });
        if (id === MAIN) setSetting(db, 'main_login_name', n);
        else db.prepare('UPDATE logins SET name = ? WHERE id = ?').run(n, id);
      }
      if (password !== undefined) {
        if (id === req.login.id) return res.status(400).json({ error: 'Use "Change password" to change your own.' });
        const problem = checkNewPassword(password, id);
        if (problem) return res.status(400).json({ error: problem });
        if (id === MAIN) setSetting(db, 'password_hash', hashPassword(password));
        else db.prepare('UPDATE logins SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
      }
      res.json(publicLogin(loginById(id), req.login.id));
    },

    removeLogin(req, res) {
      const id = Number(req.params.id);
      if (id === MAIN) return res.status(400).json({ error: "The main login can't be removed." });
      if (id === req.login.id) return res.status(400).json({ error: "You can't remove the login you're using." });
      const { changes } = db.prepare('DELETE FROM logins WHERE id = ?').run(id);
      if (!changes) return res.status(404).json({ error: 'Not found.' });
      res.json({ ok: true });
    },
  };
}

module.exports = { createAuth, resetPassword, DEFAULT_PASSWORD, THEME_COLOURS };
