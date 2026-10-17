'use strict';

// What the store adapters share: telling a bot check from a page, and asking the store's own
// website for its data from inside its open tab, the way its own pages do.

const { Challenge } = require('../lib/jobs');

// Words a bot-check page shows. Cloud-based checks (Imperva at Coles, Akamai at Woolworths) put
// up one of these, or a puzzle in a frame.
const CHECK_WORDS = /pardon our interruption|verify (that )?you are (a )?human|are you a robot|checking your browser|access denied|request unsuccessful|incapsula incident|press (and|&) hold|complete the security check|unusual traffic/i;
const CHECK_FRAMES = /captcha|challenge|geo\.captcha-delivery|_incapsula_resource|perimeterx|px-cdn|arkoselabs/i;

async function challenged(page) {
  try {
    const seen = await page.evaluate(() => ({
      title: document.title,
      text: (document.body && document.body.innerText || '').slice(0, 3000),
      frames: [...document.querySelectorAll('iframe')].map((f) => f.src || '').slice(0, 20),
    }));
    return CHECK_WORDS.test(seen.title) || CHECK_WORDS.test(seen.text) || seen.frames.some((s) => CHECK_FRAMES.test(s));
  } catch {
    return false; // still loading
  }
}

// GET or POST from inside the store's page, so it carries the page's own cookies. A refusal, or a
// web page where data should be, is a bot check.
async function pageFetch(page, url, { method = 'GET', body, headers = {} } = {}) {
  const r = await page.evaluate(async ({ url, method, body, headers }) => {
    const res = await fetch(url, {
      method, credentials: 'include', headers: { accept: 'application/json, text/plain, */*', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
  }, { url, method, body, headers });
  if (r.status === 403 || r.status === 429 || (r.status < 400 && !/json/i.test(r.type))) throw new Challenge();
  if (r.status >= 400) throw new Error(`The store's website answered ${r.status}.`);
  try { return JSON.parse(r.text); } catch { throw new Challenge(); }
}

const cents = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const tidy = (s) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, 200) : null);

// A result the app can use, or null if it has no price.
function result({ name, size, price, was, special, unit, url, available = true }) {
  const price_cents = cents(price);
  if (!tidy(name) || !price_cents || !url) return null;
  const was_cents = cents(was);
  return {
    name: tidy(name), size: tidy(size), price_cents,
    was_cents: was_cents && was_cents > price_cents ? was_cents : null,
    special: Boolean(special) || Boolean(was_cents && was_cents > price_cents),
    unit_price: tidy(unit), url, available: available !== false,
  };
}

module.exports = { challenged, pageFetch, result, cents, Challenge };
