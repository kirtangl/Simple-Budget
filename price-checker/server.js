'use strict';

// Simple Budget's price-checker: looks up prices on the supermarkets' websites in a real browser,
// for the app's Shopping tab. It answers only the app (on Docker's private network, with the
// shared PRICE_CHECKER_TOKEN), and it's the only part of Simple Budget that needs the internet.
//
//   GET  /health                   { ok, busy, blocked }
//   POST /jobs                     start a search or refresh (see lib/jobs.js), returns the job
//   GET  /jobs/:id                 how it's going, with results so far
//   POST /jobs/:id/cancel
//   POST /jobs/:id/skip            { store }: the person gave up on a bot check there
//   GET  /screen/:store            a picture of a store's tab, while it waits for a person
//   POST /input/:store             { type: click | down | move | up | key | text, x, y, key, text }
//   POST /warmup                   visit the stores' home pages now
//   GET  /image?url=…              a product picture from a store's image server

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createJobs } = require('./lib/jobs');
const { tick } = require('./lib/schedule');
const { imageOf } = require('./stores/common');

const DATA = process.env.DATA_DIR || '/data';
const STATE = path.join(DATA, 'state.json');

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return { blocked: s.blocked && typeof s.blocked === 'object' ? s.blocked : {}, warmups: s.warmups };
  } catch { return { blocked: {} }; }
}
function save(state) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
    fs.renameSync(`${STATE}.tmp`, STATE);
  } catch (err) { console.error('Could not save state:', err.message); }
}

// A product picture from a store's own image server (only those), up to 500 KB. A plain request:
// the stores' pictures need no cookies.
async function fetchImage(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { headers: { accept: 'image/*' }, signal: AbortSignal.timeout(10e3) });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !/^image\/(jpeg|png|webp|gif)/i.test(type)) return null;
  const body = Buffer.from(await res.arrayBuffer());
  return body.length && body.length <= 500e3 ? { type, body } : null;
}

function createServer({ jobs, browser, token, fetchImpl = globalThis.fetch }) {
  const want = crypto.createHash('sha256').update(String(token)).digest();
  const allowed = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return Boolean(m) && crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), want);
  };
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new RangeError('Too much.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new RangeError('Send JSON.')); }
    });
    req.on('error', reject);
  });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://checker');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, busy: jobs.busy() });
      }
      if (!allowed(req)) return send(res, 401, { error: 'Wrong or missing token.' });
      const post = req.method === 'POST';
      if (post && url.pathname === '/jobs') return send(res, 201, jobs.start(await readBody(req)));
      if (parts[0] === 'jobs' && parts[1]) {
        const id = parts[1];
        let job = null;
        if (req.method === 'GET' && parts.length === 2) job = jobs.get(id);
        else if (post && parts[2] === 'cancel') job = jobs.cancel(id);
        else if (post && parts[2] === 'skip') job = jobs.skip(id, String((await readBody(req)).store || ''));
        else return send(res, 404, { error: 'Not found.' });
        return job ? send(res, 200, job) : send(res, 404, { error: 'That check has finished or does not exist.' });
      }
      // Only a store waiting for a person can be seen or clicked on.
      if ((parts[0] === 'screen' || parts[0] === 'input') && parts[1]) {
        if (!jobs.needsPerson(parts[1])) return send(res, 409, { error: 'That store is not waiting for you.' });
        if (req.method === 'GET' && parts[0] === 'screen') {
          const img = await browser.screen(parts[1]);
          if (!img) return send(res, 404, { error: 'Not open.' });
          res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-width': browser.size.width, 'x-height': browser.size.height });
          return res.end(img);
        }
        if (post && parts[0] === 'input') return send(res, 200, { ok: await browser.input(parts[1], await readBody(req)) });
      }
      if (post && url.pathname === '/warmup') return send(res, 201, jobs.start({ type: 'warmup' }));
      if (req.method === 'GET' && url.pathname === '/image') {
        const src = imageOf(url.searchParams.get('url'));
        if (!src) return send(res, 400, { error: "That's not a store's picture." });
        let img = null;
        try { img = await fetchImage(src, fetchImpl); } catch { /* unreachable */ }
        if (!img) return send(res, 404, { error: "Couldn't get that picture." });
        res.writeHead(200, { 'content-type': img.type, 'cache-control': 'no-store' });
        return res.end(img.body);
      }
      send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof RangeError) return send(res, 400, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong in the price-checker.' });
    }
  });
}

function main() {
  const token = process.env.PRICE_CHECKER_TOKEN;
  if (!token) {
    console.error('Set PRICE_CHECKER_TOKEN (the same one as the app\'s), then start again.');
    process.exit(1);
  }
  const { createBrowser } = require('./lib/browser');
  const stores = require('./stores');
  const state = load();
  const browser = createBrowser({ stores, dataDir: DATA, headless: process.env.HEADLESS === 'true' });
  const jobs = createJobs({ browser, stores, state, save });
  const server = createServer({ jobs, browser, token });
  const port = Number(process.env.PORT) || 8090;
  server.listen(port, () => console.log(`Price-checker listening on ${port}`));

  // The twice-weekly visits to the stores' home pages.
  const check = () => {
    if (tick(state, Date.now(), () => { try { jobs.start({ type: 'warmup' }); } catch { /* none */ } })) save(state);
  };
  check();
  setInterval(check, 60e3);

  const stop = async () => { server.close(); await browser.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();

module.exports = { createServer };
