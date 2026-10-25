'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, setSetting } = require('../src/db');
const { createApp } = require('../src/server');
const { notify, unread } = require('../src/notifications');
const { version } = require('../package.json');

// A server on its own database, logged in as the main login. login(password) switches who's logged in.
async function withServer(options, fn) {
  const db = options.db || openDatabase(':memory:');
  const app = createApp({ ...options, db });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  const login = async (password) => { await call('POST', '/logout'); return call('POST', '/login', { password }); };
  try {
    await call('POST', '/login', { password: 'simplebudget' });
    await call('POST', '/password', { password: 'household-pw' });
    await fn(call, { db, login });
  } finally { server.close(); }
}

test('the notifications table is added by a migration and only takes the four kinds', () => {
  const db = openDatabase(':memory:');
  const cols = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'created_at', 'kind', 'title', 'body', 'link', 'read_at', 'cleared_at', 'login_id']);
  assert.throws(() => db.prepare("INSERT INTO notifications (created_at, kind, title) VALUES ('2026-10-25', 'party', 'x')").run());
  assert.throws(() => notify(db, { kind: 'party', title: 'x' }));
  assert.throws(() => notify(db, { title: '  ' }));
  // Only app routes are kept as links.
  const id = notify(db, { title: 'Hi', link: 'https://example.com' });
  assert.equal(db.prepare('SELECT link FROM notifications WHERE id = ?').get(id).link, null);
  assert.equal(db.prepare('SELECT link FROM notifications WHERE id = ?').get(notify(db, { title: 'Hi', link: '#/settings/backups' })).link, '#/settings/backups');
});

test('the bell: newest first, its dot, read, mark all read and clear all', () => withServer({}, async (call, { db }) => {
  let r = await call('GET', '/notifications');
  assert.deepEqual(r.body, { items: [], unread: 0, level: null });
  assert.deepEqual((await call('GET', '/data')).body.notices, { unread: 0, level: null });

  const info = notify(db, { title: 'Updated', link: '#/settings/updates' });
  notify(db, { kind: 'warning', title: 'Prices not checked', body: 'Tried twice.' });
  r = await call('GET', '/notifications');
  assert.deepEqual(r.body.items.map((n) => n.title), ['Prices not checked', 'Updated']);
  assert.equal(r.body.unread, 2);
  assert.equal(r.body.level, 'warning');
  // The data the page loads anyway carries the dot, so it needs no polling of its own.
  assert.deepEqual((await call('GET', '/data')).body.notices, { unread: 2, level: 'warning' });

  // An alert or deleted data makes the dot red.
  notify(db, { kind: 'deleted', title: 'Deleted' });
  assert.equal((await call('GET', '/notifications/unread')).body.level, 'alert');

  r = await call('POST', `/notifications/${info}/read`);
  assert.equal(r.body.unread, 2);
  assert.ok(r.body.items.find((n) => n.id === info).read_at);
  assert.equal((await call('POST', '/notifications/9999/read')).status, 404);

  r = await call('POST', '/notifications/read');
  assert.deepEqual([r.body.unread, r.body.level], [0, null]);
  assert.equal(r.body.items.length, 3);

  r = await call('POST', '/notifications/clear');
  assert.deepEqual(r.body.items, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications WHERE cleared_at IS NOT NULL').get().n, 3);
}));

test("a notice for one login isn't shown to anyone else", () => withServer({}, async (call, { db, login }) => {
  const sam = (await call('POST', '/logins', { name: 'Sam', password: 'sams-password' })).body;
  const samId = (sam.logins || [sam]).find((l) => l.name === 'Sam')?.id ?? db.prepare("SELECT id FROM logins WHERE name = 'Sam'").get().id;
  notify(db, { title: 'For everyone' });
  const mine = notify(db, { title: 'For Sam', login_id: samId });
  assert.deepEqual((await call('GET', '/notifications')).body.items.map((n) => n.title), ['For everyone']);
  assert.equal((await call('POST', `/notifications/${mine}/read`)).status, 404);
  await login('sams-password');
  assert.deepEqual((await call('GET', '/notifications')).body.items.map((n) => n.title), ['For Sam', 'For everyone']);
  assert.equal(unread(db, 0).unread, 1);
}));

test('notices older than 90 days are tidied away', () => withServer({}, async (call, { db }) => {
  const old = notify(db, { title: 'Long ago' });
  db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 91 * 24 * 3600e3).toISOString(), old);
  notify(db, { title: 'Recent' });
  assert.deepEqual((await call('GET', '/notifications')).body.items.map((n) => n.title), ['Recent']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n, 1);
}));

test('a backup that fails posts an alert, and a restore leaves the bell alone', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notices-'));
  try {
    await withServer({ dataDir }, async (call, { db }) => {
      const made = (await call('POST', '/backups')).body.created;
      notify(db, { title: 'Kept through a restore' });
      assert.equal((await call('POST', '/backups/restore', { name: made })).status, 200);
      assert.deepEqual((await call('GET', '/notifications')).body.items.map((n) => n.title), ['Kept through a restore']);

      // The backups folder can't be written to: a file where it should be.
      fs.rmSync(path.join(dataDir, 'backups'), { recursive: true, force: true });
      fs.writeFileSync(path.join(dataDir, 'backups'), 'not a folder');
      const r = await call('POST', '/backups');
      assert.equal(r.status, 500);
      assert.match(r.body.error, /Couldn't save the backup/);
      const n = (await call('GET', '/notifications')).body;
      assert.equal(n.items[0].kind, 'alert');
      assert.match(n.items[0].title, /backup failed/);
      assert.equal(n.items[0].link, '#/settings/backups');
      assert.equal(n.level, 'alert');
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('starting on a newer version posts "Updated to …"', async () => {
  const db = openDatabase(':memory:');
  setSetting(db, 'installed_version', '0.0.1');
  await withServer({ db }, async (call) => {
    const n = (await call('GET', '/notifications')).body.items;
    assert.equal(n.length, 1);
    assert.equal(n[0].title, `Updated to v${version}`);
    assert.match(n[0].body, /from v0\.0\.1/);
  });
  // Starting again on the same version doesn't post it twice.
  await withServer({ db }, async (call, { login }) => {
    await login('household-pw');
    assert.equal((await call('GET', '/notifications')).body.items.length, 1);
  });
});

test('Storage and the Price Checker status in Settings', async () => {
  await withServer({}, async (call) => {
    const s = (await call('GET', '/storage')).body;
    assert.ok(s.database > 0);
    assert.equal(s.backups, 0);
    assert.equal(s.free, null); // no data folder here
    assert.deepEqual((await call('GET', '/apps/price-checker')).body, { set_up: false, stores: ['woolworths', 'coles', 'aldi'] });
  });
  const checker = { on: true, status: async () => ({ set_up: true, reachable: true, token_ok: true, busy: false }) };
  await withServer({ checker }, async (call) => {
    assert.equal((await call('GET', '/apps/price-checker')).body.token_ok, true);
  });
});

test("the price checker's status: not set up, not answering, wrong password, running", async () => {
  const { createChecker } = require('../src/checker');
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  assert.deepEqual(await createChecker({ url: '' }).status(), { set_up: false });
  const down = createChecker({ url: 'http://pc', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal((await down.status()).reachable, false);
  const fake = (tokenOk) => async (url) => (url.endsWith('/health') ? reply(200, { ok: true, busy: true })
    : tokenOk ? reply(404, { error: 'Not found.' }) : reply(401, { error: 'Wrong or missing token.' }));
  assert.deepEqual(await createChecker({ url: 'http://pc', fetchImpl: fake(true) }).status(), { set_up: true, reachable: true, token_ok: true, busy: true });
  assert.equal((await createChecker({ url: 'http://pc', fetchImpl: fake(false) }).status()).token_ok, false);
});
