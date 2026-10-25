'use strict';

// Household logins. The main household password is stored hashed in the
// settings. On a fresh install it is START_PASSWORD from .env, or else
// DEFAULT_PASSWORD, and then the app asks for a new one on first login. Extra logins (e.g. one each) live in the `logins`
// table, each with its own password and theme. Everyone sees the same budget.
//
// A successful login sets an HMAC-signed cookie naming the login. It lasts 30
// days and is renewed as the app is used, so a device in use stays logged in.
// Changing a password logs that login out on every other device, because the
// signature includes its password hash. So does "Log out everywhere", which
// bumps the login's session_gen, also in the signature. Removing a login does the same.

const crypto = require('node:crypto');
const { getSetting, setSetting, transaction } = require('./db');

const DEFAULT_PASSWORD = 'simplebudget';
const MIN_LENGTH = 8;
const LEGACY_COOKIE = 'sb_session'; // before each copy had its own cookie name
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 30 * DAY_MS;
const MAIN = 0; // the main household login

// Themes a login can pick, and the colours a custom theme can set.
const THEMES = ['system', 'light', 'dark', 'warm', 'ocean', 'slate', 'midnight', 'custom'];
const THEME_COLOURS = ['bg', 'card', 'inset', 'text', 'muted', 'line', 'brand', 'brand-soft', 'on-brand', 'info', 'paid', 'paid-soft',
  'due', 'due-soft', 'firm', 'danger', 'danger-soft', 'upcoming', 'upcoming-soft'];

// Passwords are hashed with scrypt at a strength OWASP recommends (N=2^14, r=8, p=5,
// the same work as N=2^17 with an eighth of the memory, which suits a NAS or Raspberry Pi).
// Stored as "scrypt$14.8.5$salt$hash". Older hashes ("scrypt$salt$hash") used Node's
// lighter defaults; they still work and are upgraded the next time that password is used.
const SCRYPT = { logN: 14, r: 8, p: 5 };
const LEGACY_SCRYPT = { logN: 14, r: 8, p: 1 };

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3 && parts[1] && parts[2]) return { ...LEGACY_SCRYPT, salt: parts[1], hash: parts[2], legacy: true };
  if (parts.length !== 4) return null;
  const [logN, r, p] = parts[1].split('.').map(Number);
  if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 16 || !parts[2] || !parts[3]) return null;
  return { logN, r, p, salt: parts[2], hash: parts[3], legacy: false };
}
const scryptOptions = (h) => ({ N: 2 ** h.logN, r: h.r, p: h.p, maxmem: 256 * 1024 * 1024 });

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64, scryptOptions(SCRYPT)).toString('base64url');
  return `scrypt$${SCRYPT.logN}.${SCRYPT.r}.${SCRYPT.p}$${salt}$${hash}`;
}
// The same, without blocking the server while it hashes.
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, scryptOptions(SCRYPT), (err, k) => (err ? reject(err) : resolve(k)));
  });
  return `scrypt$${SCRYPT.logN}.${SCRYPT.r}.${SCRYPT.p}$${salt}$${key.toString('base64url')}`;
}

// Checks a password without blocking the server while it hashes.
async function checkPassword(stored, given) {
  const h = parseHash(stored);
  if (typeof given !== 'string' || !h) return false;
  const expected = Buffer.from(h.hash, 'base64url');
  const actual = await new Promise((resolve, reject) => {
    crypto.scrypt(given, h.salt, expected.length, scryptOptions(h), (err, key) => (err ? reject(err) : resolve(key)));
  });
  return crypto.timingSafeEqual(expected, actual);
}
const needsRehash = (stored) => { const h = parseHash(stored); return Boolean(h && (h.legacy || h.logN !== SCRYPT.logN || h.r !== SCRYPT.r || h.p !== SCRYPT.p)); };

// The main login's starting password: START_PASSWORD from .env if it's long enough, else the default.
function startPassword(env = process.env) {
  const p = typeof env.START_PASSWORD === 'string' ? env.START_PASSWORD.trim() : '';
  return p.length >= MIN_LENGTH ? { password: p, fromEnv: true } : { password: DEFAULT_PASSWORD, fromEnv: false };
}

// Put the main login back on its starting password. Only the default has to be
// changed at the next login, and only a brand new install shows it on the login page:
// after a reset the data is already there, so whoever runs the reset is told it instead.
function resetPassword(db, { fresh = false, env = process.env } = {}) {
  const start = startPassword(env);
  transaction(db, () => {
    setSetting(db, 'password_hash', hashPassword(start.password));
    setSetting(db, 'password_must_change', start.fromEnv ? '0' : '1');
    setSetting(db, 'password_hint', fresh && !start.fromEnv ? '1' : '0');
  });
  return start;
}

function ensurePassword(db) {
  if (!getSetting(db, 'password_hash')) resetPassword(db, { fresh: true });
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return undefined; }
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
  // Wrong guesses, per address and in total. Five wrong in a row locks that
  // address out for a minute; lots of wrong guesses from anywhere slow everyone
  // down, in case something is pretending to be many different addresses.
  // A guess is counted before it's checked, so guesses sent all at once can't
  // slip past the limit, and each address can only have one being checked at a time.
  const failures = new Map(); // ip -> { count, until }
  let recentFailures = []; // { t } for each wrong guess in the last minute
  const checking = new Map(); // ip -> guesses being checked right now
  const PER_IP = 5;
  const OVERALL = 30;
  const AT_ONCE = 4; // guesses being checked at once, from every address together
  const WINDOW_MS = 60_000;
  const SLOW_MS = 1000; // over the overall limit, guesses wait their turn this long apart
  let slowLane = Promise.resolve();
  function blocked(ip) {
    const entry = failures.get(ip);
    return Boolean(entry && entry.until > Date.now());
  }
  function busy() {
    const now = Date.now();
    recentFailures = recentFailures.filter((m) => m.t > now - WINDOW_MS);
    return recentFailures.length >= OVERALL;
  }
  // Counts a wrong guess, and returns a function that takes it back if it turns out right.
  function recordFailure(ip) {
    const now = Date.now();
    for (const [key, e] of failures) if (e.until && e.until <= now) failures.delete(key);
    if (failures.size > 10_000) failures.clear();
    const entry = failures.get(ip);
    const before = entry && !(entry.until && entry.until <= now) ? { ...entry } : null;
    const count = (before ? before.count : 0) + 1;
    failures.set(ip, { count, until: count >= PER_IP ? now + WINDOW_MS : 0 });
    const mark = { t: now };
    recentFailures.push(mark);
    return () => {
      recentFailures = recentFailures.filter((m) => m !== mark);
      failures.delete(ip);
    };
  }
  // Runs a password check for one address: refused while it's locked out or already
  // has one being checked, and slowed down (not refused) when lots of guesses are wrong.
  async function guarded(ip, check) {
    if (blocked(ip)) return { tooMany: true };
    const inFlight = [...checking.values()].reduce((a, b) => a + b, 0);
    if ((checking.get(ip) || 0) >= 1 || inFlight >= AT_ONCE) return { tooMany: true };
    checking.set(ip, (checking.get(ip) || 0) + 1);
    const undo = recordFailure(ip);
    try {
      if (busy()) {
        const turn = slowLane.then(() => new Promise((r) => { setTimeout(r, SLOW_MS); }));
        slowLane = turn;
        await turn;
      }
      const ok = await check();
      if (ok) undo();
      return { ok };
    } finally {
      const n = (checking.get(ip) || 1) - 1;
      if (n) checking.set(ip, n); else checking.delete(ip);
    }
  }
  const TOO_MANY = 'Too many attempts. Please wait a minute and try again.';

  // Only the main login is ever held at "choose a new password"; the others carry on.
  const mustChange = () => getSetting(db, 'password_must_change') === '1';
  const mustChangeFor = (l) => Boolean(l) && l.id === MAIN && mustChange();
  const extras = () => db.prepare('SELECT * FROM logins ORDER BY name COLLATE NOCASE, id').all();
  const main = () => {
    let custom = null;
    try { custom = JSON.parse(getSetting(db, 'main_custom_theme') || 'null'); } catch { /* ignore a bad value */ }
    return { id: MAIN, name: getSetting(db, 'main_login_name') || 'Main', password_hash: getSetting(db, 'password_hash'),
      theme: getSetting(db, 'main_theme') || null, custom_theme: custom, colour: getSetting(db, 'main_colour') || null, main: true,
      session_gen: Number(getSetting(db, 'main_session_gen')) || 0 };
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

  // Signed with the login's password hash and session_gen, so changing either ends its other cookies.
  // (A login that has never logged out everywhere signs as it always has, so nobody is logged out by the update.)
  const sign = (value, login) => crypto.createHmac('sha256', `${secret}:${login.password_hash}${login.session_gen ? `:${login.session_gen}` : ''}`)
    .update(value).digest('base64url');

  function makeToken(id) {
    const value = `${id}.${Date.now() + MAX_AGE_MS}`;
    return `${value}.${sign(value, loginById(id))}`;
  }

  // The login this request is from, or null. Cookies from before extra logins
  // existed ("expires.signature") belong to the main login.
  function currentLogin(req) {
    return loginFromToken(readCookie(req, COOKIE)) || loginFromToken(readCookie(req, LEGACY_COOKIE));
  }
  // When this request's cookie runs out (ms since 1970), or null.
  function expiresAt(req) {
    const token = readCookie(req, COOKIE);
    const parts = typeof token === 'string' ? token.split('.') : [];
    return parts.length === 3 ? Number(parts[1]) : null;
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
    const expected = Buffer.from(sign(value, login));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    return Number(expires) > Date.now() ? login : null;
  }

  const setCookie = (res, id) => res.cookie(COOKIE, makeToken(id), {
    httpOnly: true, sameSite: 'lax', secure: typeof secureCookies === 'function' ? secureCookies() : Boolean(secureCookies), maxAge: MAX_AGE_MS, path: '/',
  });

  // A new password must be long enough, not the default, and not one another login already uses.
  // Being told it's taken reveals another login's password, so that counts as a wrong guess.
  async function checkNewPassword(password, exceptId, ip) {
    if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Please use at least ${MIN_LENGTH} characters.`;
    if (password.length > 1024) return 'Please use a shorter password.';
    if (password === DEFAULT_PASSWORD) return 'Please choose something other than the default password.';
    if (blocked(ip)) return TOO_MANY;
    for (const l of allLogins()) {
      if (l.id !== exceptId && await checkPassword(l.password_hash, password)) {
        recordFailure(ip);
        return 'Another login already uses that password. Each login needs its own.';
      }
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

  // Saves a login's password hash (the main login's is a setting).
  function storeHash(id, hash) {
    if (id === MAIN) setSetting(db, 'password_hash', hash);
    else db.prepare('UPDATE logins SET password_hash = ? WHERE id = ?').run(hash, id);
  }

  async function finishChange(req, res, me, password) {
    const problem = await checkNewPassword(password, me.id, req.ip);
    if (problem) return res.status(problem === TOO_MANY ? 429 : 400).json({ error: problem });
    const hash = await hashPasswordAsync(password);
    if (me.id === MAIN) {
      transaction(db, () => {
        setSetting(db, 'password_hash', hash);
        setSetting(db, 'password_must_change', '0');
        setSetting(db, 'password_hint', '0');
      });
    } else {
      db.prepare('UPDATE logins SET password_hash = ? WHERE id = ?').run(hash, me.id);
    }
    setCookie(res, me.id); // the old cookie stopped working when the hash changed
    return res.json({ ok: true });
  }

  // Rename or recolour any login, or set a new password for another login (e.g. if it's been forgotten).
  // Logins only tell the household apart, so anyone can do this, except set the main login's
  // password: only Main can, or anyone could take over what only Main can change.
  async function changeLogin(req, res) {
    const id = Number(req.params.id);
    const login = Number.isInteger(id) ? loginById(id) : null;
    if (!login) return res.status(404).json({ error: 'Not found.' });
    const { name, password, colour } = req.body || {};
    // Check everything first, so a bad field doesn't leave the others half saved.
    let c; let n;
    if (colour !== undefined) {
      try { c = cleanColour(colour); } catch (err) { return res.status(400).json({ error: err.message }); }
    }
    if (name !== undefined) {
      n = cleanName(name);
      if (!n) return res.status(400).json({ error: 'Give the login a name.' });
    }
    if (password !== undefined) {
      if (id === req.login.id) return res.status(400).json({ error: 'Use "Change password" to change your own.' });
      if (id === MAIN) return res.status(403).json({ error: "Only the main login can change the main login's password." });
      const problem = await checkNewPassword(password, id, req.ip);
      if (problem) return res.status(problem === TOO_MANY ? 429 : 400).json({ error: problem });
    }
    const hash = password !== undefined ? await hashPasswordAsync(password) : null;
    transaction(db, () => {
      if (colour !== undefined) {
        if (id === MAIN) setSetting(db, 'main_colour', c || '');
        else db.prepare('UPDATE logins SET colour = ? WHERE id = ?').run(c, id);
      }
      if (name !== undefined) {
        if (id === MAIN) setSetting(db, 'main_login_name', n);
        else db.prepare('UPDATE logins SET name = ? WHERE id = ?').run(n, id);
      }
      if (password !== undefined) {
        if (id === MAIN) setSetting(db, 'password_hash', hash);
        else db.prepare('UPDATE logins SET password_hash = ? WHERE id = ?').run(hash, id);
      }
    });
    res.json(publicLogin(loginById(id), req.login.id));
  }

  return {
    status(req, res) {
      const me = currentLogin(req);
      // The login page only shows the default password on a brand new install,
      // never after a reset, when the household's data is already there.
      const hint = mustChange() && getSetting(db, 'password_hint') !== '0';
      res.json({ loggedIn: Boolean(me), mustChangePassword: me ? mustChangeFor(me) : hint, defaultPassword: hint && !me ? DEFAULT_PASSWORD : undefined });
    },

    // The password alone says which login it is.
    async login(req, res, next) {
      try {
        const given = req.body && req.body.password;
        let match = null;
        const r = await guarded(req.ip, async () => {
          if (typeof given !== 'string' || given.length > 1024) return false;
          for (const l of allLogins()) {
            if (await checkPassword(l.password_hash, given)) { match = l; return true; }
          }
          return false;
        });
        if (r.tooMany) return res.status(429).json({ error: TOO_MANY });
        if (!match) return res.status(401).json({ error: 'That password is not right.' });
        // A password saved with the older, lighter hashing is upgraded now that it's known.
        // The cookie is signed with the hash, so other devices log in again once.
        if (needsRehash(match.password_hash)) storeHash(match.id, await hashPasswordAsync(given));
        setCookie(res, match.id);
        res.json({ ok: true, mustChangePassword: mustChangeFor(match) });
      } catch (err) { next(err); }
    },

    logout(req, res) {
      res.clearCookie(COOKIE, { path: '/' });
      res.clearCookie(LEGACY_COOKIE, { path: '/' });
      res.json({ ok: true });
    },

    // Change your own password. The current one is asked for unless the main login is still on
    // the default, and it's checked like a login, so it can't be guessed without limit.
    async changePassword(req, res, next) {
      try {
        const me = currentLogin(req);
        if (!me) return res.status(401).json({ error: 'Please log in.' });
        const { current, password } = req.body || {};
        if (!mustChangeFor(me)) {
          const r = await guarded(req.ip, () => checkPassword(me.password_hash, current));
          if (r.tooMany) return res.status(429).json({ error: TOO_MANY });
          if (!r.ok) return res.status(400).json({ error: 'Your current password is not right.' });
        }
        await finishChange(req, res, me, password);
      } catch (err) { next(err); }
    },

    require(req, res, next) {
      const me = currentLogin(req);
      if (!me) return res.status(401).json({ error: 'Please log in.' });
      if (mustChangeFor(me)) return res.status(403).json({ error: 'Please choose a new password first.', mustChangePassword: true });
      req.login = me;
      // Move a login from the old shared cookie onto this copy's own.
      if (usedLegacy(req)) { setCookie(res, me.id); res.clearCookie(LEGACY_COOKIE, { path: '/' }); }
      // Keep a device in use logged in: renew the cookie at most once a day. Cookies
      // from before logins lasted 30 days are swapped for a 30-day one too.
      else {
        const left = expiresAt(req) - Date.now();
        if (left < MAX_AGE_MS - DAY_MS || left > MAX_AGE_MS) setCookie(res, me.id);
      }
      next();
    },

    refreshCookie(req, res) {
      if (req.login) setCookie(res, req.login.id);
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

    async addLogin(req, res, next) {
      try {
        const { name, password, colour } = req.body || {};
        const n = cleanName(name);
        if (!n) return res.status(400).json({ error: 'Give the login a name, like "Sam".' });
        let c;
        try { c = cleanColour(colour); } catch (err) { return res.status(400).json({ error: err.message }); }
        const problem = await checkNewPassword(password, null, req.ip);
        if (problem) return res.status(problem === TOO_MANY ? 429 : 400).json({ error: problem });
        const { lastInsertRowid } = db.prepare('INSERT INTO logins (name, password_hash, colour) VALUES (?, ?, ?)').run(n, await hashPasswordAsync(password), c);
        res.status(201).json(publicLogin(loginById(Number(lastInsertRowid)), req.login.id));
      } catch (err) { next(err); }
    },

    async updateLogin(req, res, next) {
      try { await changeLogin(req, res); } catch (err) { next(err); }
    },

    // Ends every cookie this login has, on every device. For your own login, this
    // device stays logged in (with a fresh cookie); for another, all of theirs end.
    logoutEverywhere(req, res) {
      const id = Number(req.params.id);
      const login = Number.isInteger(id) ? loginById(id) : null;
      if (!login) return res.status(404).json({ error: 'Not found.' });
      const gen = (login.session_gen || 0) + 1;
      if (id === MAIN) setSetting(db, 'main_session_gen', String(gen));
      else db.prepare('UPDATE logins SET session_gen = ? WHERE id = ?').run(gen, id);
      if (id === req.login.id) setCookie(res, id);
      res.json({ ok: true });
    },

    removeLogin(req, res) {
      const id = Number(req.params.id);
      if (id === MAIN) return res.status(400).json({ error: "The main login can't be removed." });
      if (id === req.login.id) return res.status(400).json({ error: "You can't remove the login you're using." });
      const { changes } = db.prepare('DELETE FROM logins WHERE id = ?').run(id);
      // Their goals become shared, so a future login given the same id doesn't inherit them.
      if (changes) db.prepare('UPDATE goals SET owner_id = NULL WHERE owner_id = ?').run(id);
      // Their once-offs become shared too, and no longer private, so they don't vanish for everyone.
      if (changes) db.prepare('UPDATE purchases SET owner_id = NULL, private = 0 WHERE owner_id = ? OR (owner_id IS NULL AND created_by = ?)').run(id, id);
      // Their own shopping list goes with them, for the same reason.
      if (changes) db.prepare('DELETE FROM shop_items WHERE owner_id = ?').run(id);
      if (!changes) return res.status(404).json({ error: 'Not found.' });
      res.json({ ok: true });
    },
  };
}

module.exports = { createAuth, resetPassword };
