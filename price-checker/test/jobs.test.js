'use strict';

// The price-checker's jobs and warm-up times, with made-up stores and no browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobs, Challenge, sameUrl } = require('../lib/jobs');
const { nextTime, tick } = require('../lib/schedule');

// A clock that moves on when something waits, so tests don't.
function clock(start = Date.parse('2026-10-14T10:00:00+10:00')) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); }, advance: (ms) => { t += ms; } };
}

const item = (store, name, price, extra = {}) => ({ name, size: '750g', price_cents: price, was_cents: null, special: false, unit_price: null, url: `https://shop.example/${store}/${name.replace(/ /g, '-')}`, available: true, ...extra });

function fakeStores({ check = {} } = {}) {
  const searched = [];
  const shelves = {
    north: [item('north', 'Test Oats', 280), item('north', 'Test Oats Fancy', 550)],
    south: [item('south', 'Test Oats', 300)],
  };
  const store = (id) => ({
    id, home: `https://shop.example/${id}`, gap: [10, 20],
    challenged: async (page) => Boolean(page.check),
    show: async () => {},
    search: async (page, q) => {
      searched.push([id, q]);
      if (check[id] && check[id]-- > 0) { page.check = true; throw new Challenge(); }
      return shelves[id].filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));
    },
  });
  return { stores: { north: store('north'), south: store('south') }, searched, shelves };
}

function fakeBrowser() {
  const pages = {};
  return {
    pages, closed: [],
    page: async (key) => (pages[key] ||= { key }),
    closePage: async function (key) { this.closed.push(key); delete pages[key]; },
    idle: () => {},
  };
}

const finished = async (jobs, id, c) => {
  for (let i = 0; i < 2000; i++) {
    const j = jobs.get(id);
    if (j.state === 'done' || j.state === 'cancelled') return j;
    await c.sleep(100);
  }
  throw new Error('never finished');
};

test('checker: a search goes to every store and comes back with each one\'s results', async () => {
  const c = clock();
  const { stores } = fakeStores();
  const jobs = createJobs({ browser: fakeBrowser(), stores, now: c.now, sleep: c.sleep });
  const started = jobs.start({ type: 'search', q: 'test oats', stores: ['north', 'south', 'nowhere'] });
  assert.deepEqual(Object.keys(started.stores), ['north', 'south']);
  const j = await finished(jobs, started.id, c);
  assert.equal(j.stores.north.state, 'done');
  assert.equal(j.results.north.length, 2);
  assert.equal(j.results.south[0].price_cents, 300);
  assert.throws(() => jobs.start({ type: 'search', q: '  ' }), /search for/);
  assert.throws(() => jobs.start({ type: 'nothing' }), /does not exist/);
});

test('checker: a refresh finds each matched product again, by its address or its name', async () => {
  const c = clock();
  const { stores, shelves } = fakeStores();
  const jobs = createJobs({ browser: fakeBrowser(), stores, now: c.now, sleep: c.sleep });
  shelves.north[0].price_cents = 260;
  const j = await finished(jobs, jobs.start({ type: 'refresh', items: [
    { key: '1', store: 'north', url: 'HTTPS://shop.example/north/Test-Oats/?from=list', name: 'Test Oats' },
    { key: '2', store: 'south', url: 'https://shop.example/south/old-address', name: 'test oats', size: '750G' },
    { key: '3', store: 'south', url: 'https://shop.example/south/gone', name: 'Test Oats Gone' },
  ] }).id, c);
  const by = Object.fromEntries(j.results.map((r) => [r.key, r]));
  assert.equal(by[1].found, true);
  assert.equal(by[1].price_cents, 260);
  assert.equal(by[2].found, true);
  assert.equal(by[3].found, false);
  assert.deepEqual([j.stores.south.done, j.stores.south.total], [2, 2]);
  assert.ok(sameUrl('https://a.example/x/', 'https://A.example/x?y=1'));
});

test('checker: one job at a time, and the next one waits its turn', async () => {
  const c = clock();
  const { stores } = fakeStores();
  const jobs = createJobs({ browser: fakeBrowser(), stores, now: c.now, sleep: c.sleep });
  const a = jobs.start({ type: 'search', q: 'test oats' });
  const b = jobs.start({ type: 'search', q: 'test oats' });
  assert.equal(b.state, 'queued');
  assert.equal(b.waiting_for, 1);
  assert.ok(jobs.busy());
  await finished(jobs, a.id, c);
  assert.equal((await finished(jobs, b.id, c)).state, 'done');
});

test('checker: a bot check waits for a person, then carries on', async () => {
  const c = clock();
  const { stores } = fakeStores({ check: { south: 1 } });
  const browser = fakeBrowser();
  const jobs = createJobs({ browser, stores, now: c.now, sleep: c.sleep });
  const { id } = jobs.start({ type: 'search', q: 'test oats' });
  let j;
  for (let i = 0; i < 100; i++) { await c.sleep(100); j = jobs.get(id); if (j.stores.south.state === 'needs_person') break; }
  assert.equal(j.stores.south.state, 'needs_person');
  assert.ok(jobs.needsPerson('south'));
  assert.ok(!jobs.needsPerson('north'));
  browser.pages.south.check = false; // they solved it
  j = await finished(jobs, id, c);
  assert.equal(j.stores.south.state, 'done');
  assert.equal(j.results.south.length, 1);
  assert.equal(jobs.blockedUntil('south'), null);
});

test('checker: giving up on a bot check is "try later", and the store rests for an hour', async () => {
  const c = clock();
  const { stores, searched } = fakeStores({ check: { south: 1 } });
  const saved = [];
  const jobs = createJobs({ browser: fakeBrowser(), stores, now: c.now, sleep: c.sleep, save: (s) => saved.push(JSON.stringify(s)) });
  const { id } = jobs.start({ type: 'search', q: 'test oats' });
  for (let i = 0; i < 100 && jobs.get(id).stores.south.state !== 'needs_person'; i++) await c.sleep(100);
  jobs.skip(id, 'south');
  const j = await finished(jobs, id, c);
  assert.equal(j.stores.south.state, 'try_later');
  assert.equal(j.stores.north.state, 'done');
  assert.ok(Date.parse(j.stores.south.until) - c.now() > 59 * 60e3);
  assert.equal(saved.length, 1);
  // Straight away, Coles (here "south") isn't asked again.
  const before = searched.length;
  const again = await finished(jobs, jobs.start({ type: 'search', q: 'test oats', stores: ['south'] }).id, c);
  assert.equal(again.stores.south.state, 'try_later');
  assert.equal(searched.length, before);
});

test('checker: a bot check nobody solves times out as "try later"', async () => {
  const c = clock();
  const { stores } = fakeStores({ check: { north: 1 } });
  const jobs = createJobs({ browser: fakeBrowser(), stores, now: c.now, sleep: c.sleep, personWait: 60e3 });
  const j = await finished(jobs, jobs.start({ type: 'search', q: 'test oats' }).id, c);
  assert.equal(j.stores.north.state, 'try_later');
});

test('checker: searches at a store are spaced out', async () => {
  const c = clock();
  const { stores } = fakeStores();
  stores.north.gap = [4000, 8000];
  const times = [];
  const search = stores.north.search;
  stores.north.search = async (...a) => { times.push(c.now()); return search(...a); };
  const jobs = createJobs({ browser: fakeBrowser(), stores, now: c.now, sleep: c.sleep });
  await finished(jobs, jobs.start({ type: 'refresh', items: [1, 2, 3].map((k) => ({ key: k, store: 'north', name: 'Test Oats', url: 'x' })) }).id, c);
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 4000);
});

test('checker: a warm-up visits each home page and leaves, skipping a bot check quietly', async () => {
  const c = clock();
  const { stores, searched } = fakeStores();
  const browser = fakeBrowser();
  browser.page = async (key) => (browser.pages[key] = { key, check: key === 'south' });
  const jobs = createJobs({ browser, stores, now: c.now, sleep: c.sleep });
  const j = await finished(jobs, jobs.start({ type: 'warmup' }).id, c);
  assert.equal(j.state, 'done');
  assert.deepEqual(browser.closed, ['north', 'south']);
  assert.equal(searched.length, 0);
  assert.equal(jobs.blockedUntil('south'), null);
});

test('checker: warm-ups are once Monday to Wednesday and once Thursday to Sunday, 8am to 9pm', () => {
  const hours = new Set();
  for (let i = 0; i < 200; i++) {
    const r = Math.random;
    const now = Date.parse('2026-10-15T12:00:00') + i * 3 * 60 * 60e3; // from a Thursday, every 3 hours
    const a = new Date(nextTime(0, now, r));
    const b = new Date(nextTime(1, now, r));
    assert.ok([1, 2, 3].includes(a.getDay()), `Mon-Wed, got ${a}`);
    assert.ok([4, 5, 6, 0].includes(b.getDay()), `Thu-Sun, got ${b}`);
    for (const d of [a, b]) {
      assert.ok(d.getTime() > now);
      assert.ok(d.getHours() >= 8 && d.getHours() < 21);
      hours.add(d.getHours());
    }
  }
  assert.ok(hours.size > 5, 'the time of day varies');

  // Once one's done, the next in that half is the following week.
  const state = {};
  let warmed = 0;
  const monday = Date.parse('2026-10-12T07:00:00');
  tick(state, monday, () => warmed++);
  assert.equal(warmed, 0);
  const first = state.warmups[0];
  tick(state, first, () => warmed++);
  assert.equal(warmed, 1);
  assert.ok(state.warmups[0] - first > 4 * 24 * 60 * 60e3);
  assert.ok(new Date(state.warmups[0]) >= new Date('2026-10-19T08:00:00'));
});
