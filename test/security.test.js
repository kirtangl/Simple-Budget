'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, hostAllowed } = require('../src/server');
const { createUpdates } = require('../src/updates');

async function withServer(fn) {
  const db = openDatabase(':memory:');
  const app = createApp({ db });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, headers: res.headers };
  };
  // fetch won't send a made-up Host header, so use http directly for that.
  const withHost = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/version', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  try {
    await call('POST', '/login', { password: 'simplebudget' });
    await call('POST', '/password', { password: 'household-pw' });
    await fn(call, { withHost, db, logout: () => { cookie = ''; }, getCookie: () => cookie, useCookie: (c) => { cookie = c; } });
  } finally { server.close(); }
}

test('settings only take real options, not names every object has', () => withServer(async (call) => {
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal((await call('PUT', '/settings', { pay_frequency: bad })).status, 400, bad);
    assert.equal((await call('PUT', '/settings', { rounding: bad })).status, 400, bad);
  }
  assert.equal((await call('GET', '/data')).status, 200);
  assert.equal((await call('GET', '/loan-calculator?frequency=constructor&years=30&rate=6')).status, 200);
}));

test('a made-up X-Forwarded-For does not get around the login limit', () => withServer(async (call, { logout }) => {
  logout();
  for (let i = 0; i < 5; i += 1) await call('POST', '/login', { password: `wrong-${i}` }, { 'x-forwarded-for': `10.0.0.${i}` });
  const r = await call('POST', '/login', { password: 'household-pw' }, { 'x-forwarded-for': '10.9.9.9' });
  assert.equal(r.status, 429);
}));

test('only home-network names and ALLOWED_HOSTS are answered', () => withServer(async (call, { withHost }) => {
  assert.equal(await withHost('evil.example.com'), 421);
  assert.equal(await withHost('localhost:3000'), 200);
  assert.equal(await withHost('192.168.1.20:3000'), 200);
  assert.equal(await withHost('nas:3000'), 200);
  assert.equal(await withHost('budget.local'), 200);
  const before = process.env.ALLOWED_HOSTS;
  try {
    process.env.ALLOWED_HOSTS = 'budget.example.com, .home.example.net';
    assert.equal(hostAllowed('budget.example.com'), true);
    assert.equal(hostAllowed('a.home.example.net:443'), true);
    assert.equal(hostAllowed('evil.example.com'), false);
    process.env.ALLOWED_HOSTS = '*';
    assert.equal(hostAllowed('anything.example'), true);
  } finally {
    if (before === undefined) delete process.env.ALLOWED_HOSTS; else process.env.ALLOWED_HOSTS = before;
  }
}));

test('pages come with security headers, and big bodies are refused outside restore', () => withServer(async (call) => {
  const r = await call('GET', '/version');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const big = { password: 'x'.repeat(200_000) };
  assert.equal((await call('POST', '/login', big)).status, 413);
}));

test('stored values are checked: dates, colours, negative money, date order', () => withServer(async (call) => {
  const { body: acct } = await call('POST', '/accounts', { name: 'Bills', color: 'red;background-image:url(https://x.example/b)' });
  assert.equal(acct.color, null);
  const { body: acct2 } = await call('POST', '/accounts', { name: 'Everyday', color: '#2563EB' });
  assert.equal(acct2.color, '#2563eb');
  const loan = { name: 'Car', principal_cents: 1000000, interest_rate: 7, term_months: 60, repayment_frequency: 'monthly' };
  assert.equal((await call('POST', '/loans', { ...loan, start_date: '0100-01-01' })).status, 400);
  assert.equal((await call('POST', '/loans', { ...loan, offset_cents: -500000 })).status, 400);
  assert.equal((await call('POST', '/expenses', { name: 'Gym', amount_cents: -5000, frequency: 'monthly', day_of_month: 1 })).status, 400);
  assert.equal((await call('POST', '/expenses', { name: 'Gym', amount_cents: 5000, frequency: 'monthly', day_of_month: 1,
    start_date: '2027-01-01', end_date: '2026-01-01' })).status, 400);
  const inc = await call('POST', '/incomes', { name: 'Pay', after_tax_cents: 300000, frequency: null });
  assert.equal(inc.status, 201);
  const off = await call('POST', '/expenses', { name: 'Paused', amount_cents: 5000, frequency: 'monthly', day_of_month: 1, active: 'false' });
  assert.equal(off.body.active, 0);
}));

test('a damaged backup gives warnings, not an error', () => withServer(async (call) => {
  const r = await call('POST', '/import', { app: 'simple-budget', format_version: 1, loans: [null, 5], goals: [null], expenses: [[]],
    categories: [{ name: 'Home', subcategories: [null] }] });
  assert.equal(r.status, 200);
  assert.ok(r.body.warnings.length >= 4);
  assert.equal((await call('POST', '/import', { app: 'simple-budget', format_version: -1 })).status, 400);
  assert.equal((await call('POST', '/import', { app: 'simple-budget', settings: { pay_frequency: 'constructor', rounding: 'toString' } })).status, 200);
  assert.equal((await call('GET', '/data')).status, 200);
}));

test("editing a login saves nothing if any part of it isn't right", () => withServer(async (call) => {
  const { body: sam } = await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
  assert.equal((await call('PATCH', `/logins/${sam.id}`, { name: 'Samantha', password: 'x' })).status, 400);
  const { body: list } = await call('GET', '/logins');
  assert.equal(list.find((l) => l.id === sam.id).name, 'Sam');
}));

test('a bad cookie is just logged out, not an error', () => withServer(async (call) => {
  const r = await call('GET', '/data', null, { cookie: 'sb_session=%E0%A4%A' });
  assert.equal(r.status, 401);
}));

test('the update check recovers after GitHub fails straight away', async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
    return Promise.resolve({ ok: true, status: 200, json: async () => [{ tag_name: 'v9.0.0', name: 'v9.0.0', html_url: 'https://evil.example/' }] });
  };
  const u = createUpdates({ version: '0.6.0', channel: '', repo: 'o/r', fetchImpl });
  await u.check();
  assert.equal(u.view().error, 'offline');
  await u.check();
  assert.equal(u.view().available, true);
  assert.equal(u.view().latest.url, 'https://github.com/o/r/releases');
});

test('Settings → Advanced: server settings can be changed in the app, and .env still wins', async () => {
  // This machine may have its own GITHUB_TOKEN; the test needs it unset.
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try { await advancedTest(); } finally { if (token !== undefined) process.env.GITHUB_TOKEN = token; }
});

const advancedTest = () => withServer(async (call, { withHost, logout }) => {
  let r = await call('GET', '/advanced');
  assert.equal(r.status, 200);
  assert.equal(r.body.can_edit, true);
  assert.equal(r.body.github_token_set, false);

  // Your own domain, added in the app.
  assert.equal(await withHost('budget.example.com'), 421);
  assert.equal((await call('PUT', '/advanced', { allowed_hosts: 'not a host!' })).status, 400);
  r = await call('PUT', '/advanced', { allowed_hosts: 'budget.example.com' });
  assert.equal(r.status, 200);
  assert.equal(await withHost('budget.example.com'), 200);

  // Secure cookies would lock you out over plain http.
  assert.equal((await call('PUT', '/advanced', { secure_cookies: true })).status, 400);

  // The token is saved but never sent back.
  r = await call('PUT', '/advanced', { github_token: 'github_pat_abcdefghij1234567890' });
  assert.equal(r.body.github_token_set, true);
  assert.doesNotMatch(JSON.stringify(r.body), /github_pat_/);
  r = await call('PUT', '/advanced', { remove_github_token: true });
  assert.equal(r.body.github_token_set, false);

  // A build tag set here shows in the header.
  await call('PUT', '/advanced', { app_channel: 'beta' });
  assert.equal((await call('GET', '/version')).body.channel, 'beta');
  assert.equal((await call('PUT', '/advanced', { app_channel: 'nightly' })).status, 400);

  // Something set in .env can't be changed here.
  const before = process.env.UPDATE_REPO;
  try {
    process.env.UPDATE_REPO = 'someone/fork';
    r = await call('GET', '/advanced');
    assert.equal(r.body.locked.update_repo, true);
    assert.equal((await call('PUT', '/advanced', { update_repo: 'other/repo' })).status, 400);
  } finally {
    if (before === undefined) delete process.env.UPDATE_REPO; else process.env.UPDATE_REPO = before;
  }

  // Trusting a proxy takes effect straight away: each forwarded address gets its own limit.
  assert.equal((await call('PUT', '/advanced', { trust_proxy: 'loopback' })).status, 200);
  assert.equal((await call('PUT', '/advanced', { trust_proxy: '300.1.1.1' })).status, 400);
  await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
  logout();
  for (let i = 0; i < 5; i += 1) await call('POST', '/login', { password: `wrong-${i}` }, { 'x-forwarded-for': '203.0.113.5' });
  assert.equal((await call('POST', '/login', { password: 'sams-password' }, { 'x-forwarded-for': '203.0.113.5' })).status, 429);
  assert.equal((await call('POST', '/login', { password: 'sams-password' }, { 'x-forwarded-for': '203.0.113.6' })).status, 200);

  // Only the main login can change them.
  assert.equal((await call('GET', '/advanced')).body.can_edit, false);
  assert.equal((await call('PUT', '/advanced', { app_channel: '' })).status, 403);
});

// A cookie signed the way the server signs them, for a login whose hash is known.
function forgeCookie(db, name, id, expires, hash, gen = 0) {
  const crypto = require('node:crypto');
  const { getSetting } = require('../src/db');
  const value = `${id}.${expires}`;
  const sig = crypto.createHmac('sha256', `${getSetting(db, 'session_secret')}:${hash}${gen ? `:${gen}` : ''}`).update(value).digest('base64url');
  return `${name}=${value}.${sig}`;
}

test('log out everywhere ends other devices, and keeps this one logged in', () => withServer(async (call, { getCookie, useCookie, logout }) => {
  const phone = getCookie();
  const laptop = getCookie();
  useCookie(laptop);
  const r = await call('POST', '/logins/0/logout-everywhere');
  assert.equal(r.status, 200);
  assert.notEqual(getCookie(), laptop, 'this device gets a fresh cookie');
  assert.equal((await call('GET', '/me')).status, 200, 'this device stays logged in');
  useCookie(phone);
  assert.equal((await call('GET', '/me')).status, 401, 'the old cookie no longer works');
  logout();
  assert.equal((await call('POST', '/login', { password: 'household-pw' })).status, 200, 'logging in again works');
  assert.equal((await call('GET', '/me')).status, 200);
}));

test("log out everywhere on someone else's login ends all of theirs", () => withServer(async (call, { getCookie, useCookie, logout }) => {
  const mainCookie = getCookie();
  const added = await call('POST', '/logins', { name: 'Sam', password: 'sam-password-1' });
  assert.equal(added.status, 201);
  logout();
  await call('POST', '/login', { password: 'sam-password-1' });
  const sam = getCookie();
  assert.equal((await call('GET', '/me')).body.name, 'Sam');
  useCookie(mainCookie);
  assert.equal((await call('POST', `/logins/${added.body.id}/logout-everywhere`)).status, 200);
  assert.equal(getCookie(), mainCookie, "Main's own cookie is left alone");
  assert.equal((await call('GET', '/me')).status, 200);
  useCookie(sam);
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('POST', '/logins/999/logout-everywhere')).status, 401, 'needs a login');
  useCookie(mainCookie);
  assert.equal((await call('POST', '/logins/999/logout-everywhere')).status, 404);
}));

test('logins last 30 days and are renewed while in use', () => withServer(async (call, { db, getCookie, useCookie }) => {
  const { getSetting } = require('../src/db');
  const r = await call('POST', '/password', { current: 'household-pw', password: 'household-pw-2' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /Max-Age=2592000/);
  const name = getCookie().split('=')[0];
  const hash = getSetting(db, 'password_hash');
  const day = 24 * 60 * 60 * 1000;
  // A cookie set today isn't sent again on every request.
  assert.equal((await call('GET', '/me')).headers.get('set-cookie'), null);
  // One a few days old is renewed for another 30 days.
  useCookie(forgeCookie(db, name, 0, Date.now() + 25 * day, hash));
  const renewed = await call('GET', '/me');
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers.get('set-cookie') || '', /Max-Age=2592000/);
  // A year-long cookie from before 0.9.5 still works, and is swapped for a 30-day one.
  useCookie(forgeCookie(db, name, 0, Date.now() + 300 * day, hash));
  const old = await call('GET', '/me');
  assert.equal(old.status, 200);
  const expires = Number(getCookie().split('=')[1].split('.')[1]);
  assert.ok(expires <= Date.now() + 30 * day + 1000);
  // An expired one doesn't work.
  useCookie(forgeCookie(db, name, 0, Date.now() - 1000, hash));
  assert.equal((await call('GET', '/me')).status, 401);
}));

test('passwords are stored with stronger hashing, and older ones are upgraded at login', () => withServer(async (call, { db, logout }) => {
  const crypto = require('node:crypto');
  const { getSetting, setSetting } = require('../src/db');
  assert.match(getSetting(db, 'password_hash'), /^scrypt\$14\.8\.5\$/);
  // A password saved by 0.9.4 or earlier.
  const salt = crypto.randomBytes(16).toString('base64url');
  setSetting(db, 'password_hash', `scrypt$${salt}$${crypto.scryptSync('household-pw', salt, 64).toString('base64url')}`);
  logout();
  assert.equal((await call('POST', '/login', { password: 'wrong-password' })).status, 401);
  assert.equal((await call('POST', '/login', { password: 'household-pw' })).status, 200);
  assert.match(getSetting(db, 'password_hash'), /^scrypt\$14\.8\.5\$/, 'upgraded');
  assert.equal((await call('GET', '/me')).status, 200, 'the new cookie matches the new hash');
  logout();
  assert.equal((await call('POST', '/login', { password: 'household-pw' })).status, 200, 'still logs in after the upgrade');
}));

test('the home-screen icon and manifest need no login and only take hex colours', async () => {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const png = await fetch(`${base}/app-icon.png?size=180&bg=0f766e&fg=ffffff`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await png.arrayBuffer());
    assert.equal(buf.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [180, 180]);
    assert.equal((await fetch(`${base}/app-icon.png?size=64`)).status, 404);
    const m = await (await fetch(`${base}/manifest.webmanifest?bg=123abc&fg=<script>`)).json();
    assert.equal(m.theme_color, '#123abc');
    assert.deepEqual(m.icons.map((i) => i.sizes), ['192x192', '512x512']);
    assert.match(m.icons[0].src, /^app-icon\.png\?size=192&bg=123abc&fg=effffc$/);
  } finally { server.close(); }
});
