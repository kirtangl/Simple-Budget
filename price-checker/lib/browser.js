'use strict';

// The one browser the price-checker uses: a real Chromium with a window (on a virtual screen, see
// the Dockerfile), not a headless one, and its own profile kept on disk, so cookies and the like
// carry over from one visit to the next, the way a person's browser does. Australian English and
// the server's time zone, and an ordinary window size.
//
// Each store gets its own tab, opened on its home page (with a few seconds' pause, as a person
// would) the first time it's needed. The browser closes 15 minutes after the last job, and opens
// again for the next.

const path = require('node:path');

const IDLE = 15 * 60e3;
const SIZE = { width: 1366, height: 768 };

function createBrowser({ stores, dataDir, headless = false, timezone = process.env.TZ || 'Australia/Brisbane' }) {
  let context = null;
  let opening = null;
  let timer = null;
  const pages = {};
  const pause = (lo, hi) => new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)));

  async function open() {
    if (context) return context;
    if (!opening) {
      const { chromium } = require('playwright');
      opening = chromium.launchPersistentContext(path.join(dataDir, 'profile'), {
        headless,
        locale: 'en-AU',
        timezoneId: timezone,
        viewport: SIZE,
        screen: SIZE,
        colorScheme: 'light',
        args: ['--disable-blink-features=AutomationControlled', `--window-size=${SIZE.width},${SIZE.height + 90}`, '--lang=en-AU'],
        extraHTTPHeaders: { 'Accept-Language': 'en-AU,en;q=0.9' },
      }).then((c) => {
        context = c;
        c.on('close', () => { context = null; for (const k of Object.keys(pages)) delete pages[k]; });
        return c;
      }).finally(() => { opening = null; });
    }
    return opening;
  }

  // The store's tab, opening it on the home page if it isn't open. `fresh` starts it again.
  async function page(key, { fresh = false } = {}) {
    clearTimeout(timer);
    const c = await open();
    if (fresh) await closePage(key);
    if (pages[key] && !pages[key].isClosed()) return pages[key];
    const empty = c.pages().find((p) => p.url() === 'about:blank' && !Object.values(pages).includes(p));
    const p = empty || await c.newPage();
    pages[key] = p;
    await p.goto(stores[key].home, { waitUntil: 'domcontentloaded', timeout: 45e3 });
    await pause(2000, 5000);
    return p;
  }

  async function closePage(key) {
    const p = pages[key];
    delete pages[key];
    if (p && !p.isClosed()) await p.close().catch(() => {});
  }

  // What a store's tab shows, for a person to solve a bot check.
  async function screen(key) {
    const p = pages[key];
    if (!p || p.isClosed()) return null;
    return p.screenshot({ type: 'jpeg', quality: 70, timeout: 10e3 });
  }

  // A person's click, drag or key press on a store's tab, at page coordinates.
  async function input(key, ev) {
    const p = pages[key];
    if (!p || p.isClosed()) return false;
    const x = Math.max(0, Math.min(SIZE.width, Number(ev.x) || 0));
    const y = Math.max(0, Math.min(SIZE.height, Number(ev.y) || 0));
    if (ev.type === 'click') await p.mouse.click(x, y, { delay: 60 + Math.random() * 80 });
    else if (ev.type === 'down') { await p.mouse.move(x, y); await p.mouse.down(); }
    else if (ev.type === 'move') await p.mouse.move(x, y, { steps: 4 });
    else if (ev.type === 'up') { await p.mouse.move(x, y); await p.mouse.up(); }
    else if (ev.type === 'key' && typeof ev.key === 'string' && /^[\w ]{1,20}$/.test(ev.key)) await p.keyboard.press(ev.key);
    else if (ev.type === 'text' && typeof ev.text === 'string') await p.keyboard.type(ev.text.slice(0, 100), { delay: 50 });
    else return false;
    return true;
  }

  async function scroll(key, dy) {
    const p = pages[key];
    if (p && !p.isClosed()) await p.mouse.wheel(0, dy).catch(() => {});
  }

  // Nothing to do for now: close the browser in a while.
  function idle() {
    clearTimeout(timer);
    timer = setTimeout(close, IDLE);
    timer.unref?.();
  }

  async function close() {
    clearTimeout(timer);
    const c = context;
    context = null;
    for (const k of Object.keys(pages)) delete pages[k];
    if (c) await c.close().catch(() => {});
  }

  return { page, closePage, screen, input, scroll, idle, close, size: SIZE };
}

module.exports = { createBrowser };
