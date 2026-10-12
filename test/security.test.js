'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, hostAllowed } = require('../src/server');
const { createUpdates } = require('../src/updates');

async function withServer(fn) {
  const app = createApp({ db: openDatabase(':memory:') });
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
    await fn(call, { withHost, logout: () => { cookie = ''; } });
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
