'use strict';

// The price-checker's work: searches (one product at every store, for Automatic price search)
// and refreshes (each matched product's own listing, for Update prices). One job runs at a time;
// within a job each store goes along in its own tab at the same time, one search after another.
//
// When a store shows a bot check, the store waits for a person: the app shows them the page
// (screen and input below) and they solve it themselves. Nothing here solves one. If it's still
// there after a while, or they give up, that store is "try later", and stays so for a while
// (an hour, then 6 hours, then a day), so a store that's blocking us isn't pushed.
//
// The browser and the stores are passed in, so this can be tested without either.

const BACKOFF = [60, 6 * 60, 24 * 60]; // minutes
const KEEP_FINISHED = 30 * 60e3; // a finished job can be read for 30 minutes
const MAX_SEARCHES = 400;

class Challenge extends Error {}

// The same address, whatever the case, a ?query or #part, or a trailing /.
const sameUrl = (a, b) => {
  const clean = (u) => String(u || '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  return Boolean(a) && clean(a) === clean(b);
};
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function createJobs({
  browser, stores, state = { blocked: {} }, save = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, now = () => Date.now(),
  personWait = 5 * 60e3, checkEvery = 1500,
}) {
  const jobs = new Map();
  const queue = [];
  const last = {}; // when each store was last searched
  let running = null;
  let next = 1;

  const between = (lo, hi) => lo + random() * (hi - lo);
  const blockedUntil = (key) => {
    const b = state.blocked[key];
    return b && b.until > now() ? b.until : null;
  };
  const blocked = (key) => {
    const b = state.blocked[key] || { strikes: 0 };
    b.strikes = Math.min(b.strikes + 1, BACKOFF.length);
    b.until = now() + BACKOFF[b.strikes - 1] * 60e3;
    state.blocked[key] = b;
    save(state);
  };
  const cleared = (key) => {
    if (!state.blocked[key]) return;
    delete state.blocked[key];
    save(state);
  };

  // Stores are paced so the searches come at the speed a person might go: a few seconds apart at
  // stores that are quick to block (Coles), a second or two elsewhere.
  async function pace(key) {
    const [lo, hi] = stores[key].gap || [1000, 2000];
    const wait = (last[key] || 0) + between(lo, hi) - now();
    if (wait > 0) await sleep(wait);
    last[key] = now();
  }

  // The store is showing a bot check: wait for a person to solve it. True once it's gone.
  async function person(job, key, page, q) {
    const st = job.stores[key];
    const store = stores[key];
    st.state = 'needs_person';
    st.message = null;
    if (store.show) {
      try { await store.show(page, q); } catch { /* the check page may be what failed to load */ }
    }
    const started = now();
    while (now() - started < personWait) {
      if (job.cancelled || job.skip.has(key)) return false;
      if (!(await store.challenged(page))) {
        st.state = 'working';
        cleared(key);
        return true;
      }
      await sleep(checkEvery);
    }
    return false;
  }

  // One search (or lookup) at a store, with a person's help if there's a bot check.
  async function search(job, key, page, q, ask = () => stores[key].search(page, q)) {
    const store = stores[key];
    for (let tries = 0; tries < 2; tries++) {
      await pace(key);
      try {
        if (await store.challenged(page)) throw new Challenge();
        return await ask();
      } catch (err) {
        if (!(err instanceof Challenge) || tries > 0) throw err;
        if (!(await person(job, key, page, q))) throw new Challenge();
      }
    }
    return null;
  }

  // A matched product's listing now: the store's own lookup when it has one, otherwise a search for
  // its name, picking the same listing (by address, or else by name and size). With search, it's
  // always a search, and the rest of the results come back too (as others), for its other sizes
  // and close matches. { match, others }.
  async function refreshOne(job, key, page, item) {
    const store = stores[key];
    if (store.lookup && !item.search) return { match: await search(job, key, page, item.name, () => store.lookup(page, item)), others: null };
    const found = (await search(job, key, page, item.q || item.name)) || [];
    const match = found.find((r) => sameUrl(r.url, item.url))
      || found.find((r) => sameText(r.name, item.name) && sameText(r.size, item.size)) || null;
    return { match, others: item.search ? found : null };
  }

  async function runStore(job, key, tasks) {
    const st = job.stores[key];
    const until = blockedUntil(key);
    if (until) {
      Object.assign(st, { state: 'try_later', until: new Date(until).toISOString() });
      return;
    }
    let page;
    try {
      st.state = 'working';
      page = stores[key].noBrowser ? null : await browser.page(key);
      let errors = 0;
      for (const task of tasks) {
        if (job.cancelled) { st.state = 'cancelled'; return; }
        try {
          if (job.type === 'search') {
            job.results[key] = (await search(job, key, page, task.q)) || [];
          } else {
            const { match, others } = await refreshOne(job, key, page, task);
            job.results.push({ key: task.key, store: key, found: Boolean(match), ...match, ...(others ? { others } : {}) });
          }
          errors = 0;
        } catch (err) {
          if (err instanceof Challenge || job.skip.has(key)) throw new Challenge();
          errors += 1;
          st.message = String(err.message || err).slice(0, 200);
          if (job.type !== 'search') job.results.push({ key: task.key, store: key, found: false, error: true });
          if (job.type === 'search' || errors >= 3) { st.state = 'error'; return; }
        }
        st.done += 1;
      }
      st.state = 'done';
    } catch (err) {
      if (!(err instanceof Challenge)) {
        Object.assign(st, { state: 'error', message: String(err.message || err).slice(0, 200) });
        return;
      }
      if (!job.cancelled) blocked(key);
      Object.assign(st, { state: job.cancelled ? 'cancelled' : 'try_later', until: blockedUntil(key) ? new Date(blockedUntil(key)).toISOString() : null });
    }
  }

  // A visit like a person's: the home page, a bit of a look around, then away. A bot check is left
  // alone (nobody's waiting to solve it), and the store isn't searched.
  async function warmStore(key) {
    if (blockedUntil(key) || stores[key].noBrowser) return;
    try {
      const page = await browser.page(key, { fresh: true });
      if (await stores[key].challenged(page)) return;
      const end = now() + between(20e3, 60e3);
      while (now() < end) {
        await sleep(between(3e3, 9e3));
        if (browser.scroll) await browser.scroll(key, Math.round(between(-200, 600)));
      }
    } catch { /* a warm-up that fails just doesn't happen */ } finally {
      await browser.closePage(key);
    }
  }

  async function run(job) {
    job.state = 'running';
    job.started_at = new Date(now()).toISOString();
    if (job.type === 'warmup') {
      for (const key of job.order) await warmStore(key);
    } else {
      await Promise.all(job.order.map((key) => runStore(job, key, job.tasks[key])));
    }
    job.state = job.cancelled ? 'cancelled' : 'done';
    job.finished_at = new Date(now()).toISOString();
  }

  async function drain() {
    if (running) return;
    while (queue.length) {
      running = queue.shift();
      try { await run(running); } catch (err) { running.state = 'done'; running.error = String(err.message || err); }
      const done = running;
      setTimeout(() => jobs.delete(done.id), KEEP_FINISHED).unref?.();
      running = null;
    }
    if (browser.idle) browser.idle();
  }

  // { type: 'search', q, stores: [keys] }, { type: 'refresh', items: [{ key, store, url, name, size, q, search }] }
  // or { type: 'warmup' }.
  function start(input) {
    const b = input && typeof input === 'object' ? input : {};
    const job = { id: `j${next++}`, type: b.type, state: 'queued', stores: {}, tasks: {}, order: [], skip: new Set(), cancelled: false };
    const known = (k) => typeof k === 'string' && Object.hasOwn(stores, k);
    if (b.type === 'search') {
      const q = typeof b.q === 'string' ? b.q.trim().slice(0, 120) : '';
      if (!q) throw new RangeError('Say what to search for.');
      job.order = (Array.isArray(b.stores) ? b.stores : Object.keys(stores)).filter(known);
      for (const k of job.order) job.tasks[k] = [{ q }];
      job.q = q;
      job.results = {};
    } else if (b.type === 'refresh') {
      const items = (Array.isArray(b.items) ? b.items : []).filter((i) => i && known(i.store) && typeof i.name === 'string').slice(0, MAX_SEARCHES);
      for (const i of items) {
        if (!job.tasks[i.store]) { job.tasks[i.store] = []; job.order.push(i.store); }
        job.tasks[i.store].push({ key: String(i.key ?? ''), url: String(i.url || ''), name: i.name, size: i.size || null, q: i.q || null, search: i.search === true });
      }
      job.results = [];
    } else if (b.type === 'warmup') {
      job.order = Object.keys(stores);
    } else {
      throw new RangeError('That kind of job does not exist.');
    }
    if (!job.order.length) throw new RangeError('Nothing to check.');
    for (const k of job.order) job.stores[k] = { state: 'waiting', done: 0, total: job.type === 'warmup' ? 0 : job.tasks[k].length, message: null };
    jobs.set(job.id, job);
    queue.push(job);
    drain();
    return view(job);
  }

  function view(job) {
    const ahead = queue.indexOf(job);
    return {
      id: job.id, type: job.type, state: job.state, waiting_for: ahead >= 0 ? ahead + (running ? 1 : 0) : 0,
      stores: JSON.parse(JSON.stringify(job.stores)), results: job.results, q: job.q,
    };
  }

  const get = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    job.cancelled = true;
    const i = queue.indexOf(job);
    if (i >= 0) { queue.splice(i, 1); job.state = 'cancelled'; }
    return view(job);
  }
  // The person gave up on a bot check at this store.
  function skip(id, key) {
    const job = jobs.get(id);
    if (!job) return null;
    job.skip.add(key);
    return view(job);
  }
  // Which stores are waiting for a person right now, so only those can be seen and clicked on.
  const needsPerson = (key) => Boolean(running && running.stores[key] && running.stores[key].state === 'needs_person');
  const busy = () => Boolean(running) || queue.length > 0;

  return { start, get, cancel, skip, needsPerson, busy, blockedUntil };
}

module.exports = { createJobs, Challenge, sameUrl };
