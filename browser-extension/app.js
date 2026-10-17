'use strict';

// The Coles button's page. Gets the products on the household's Simple Budget lists, searches Coles
// for them in one tab of this browser, a few seconds apart, and reads each search page's own data
// (__NEXT_DATA__). Matched products are found again by their Coles id; the rest are picked once
// here. Save sends the prices to Simple Budget.

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ITEMS = 60;
const local = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};

let conn = null; // { addr, key }
let items = []; // from Simple Budget
const found = new Map(); // product id -> { products, pick: index | 'none' | null, lost }
let stopping = false;
let busy = false;

const money = (cents) => (cents == null ? '–' : `$${(cents / 100).toFixed(2)}`);
const colesId = (url) => (/-(\d+)\/?$/.exec(String(url || '').split(/[?#]/)[0]) || [])[1] || null;
const say = (s, cls = '') => { $('status').textContent = s; $('status').className = `msg ${cls}`; };
const debug = (o) => { $('debug').textContent = JSON.stringify(o, null, 2).slice(0, 20000); };

async function call(method, path, body) {
  const res = await fetch(`${conn.addr}/api/shop-helper/${path}`, {
    method, headers: { authorization: `Bearer ${conn.key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* none */ }
  if (!res.ok) throw new Error((data && data.error) || `Simple Budget answered ${res.status}.`);
  return data;
}

// ---------- Connecting ----------

async function start() {
  conn = await local.get('conn');
  if (!conn) { showSetup(); return; }
  $('main').hidden = false;
  await loadList();
}

function showSetup() {
  $('setup').hidden = false;
  $('main').hidden = true;
  if (conn) { $('addr').value = conn.addr; $('key').value = conn.key; }
}

$('connect').onclick = async () => {
  const msg = $('setup-msg');
  let addr;
  try { addr = new URL($('addr').value.trim()).origin; } catch { msg.textContent = 'The address should look like http://192.168.1.20:3000'; return; }
  const key = $('key').value.trim();
  if (!key) { msg.textContent = 'Paste the key from Simple Budget.'; return; }
  // The browser asks once whether this extension may talk to that address.
  const ok = await chrome.permissions.request({ origins: [`${addr}/*`] });
  if (!ok) { msg.textContent = "The extension needs your OK to reach Simple Budget's address."; return; }
  conn = { addr, key };
  try {
    await call('GET', 'coles');
  } catch (err) { msg.textContent = err.message; return; }
  await local.set('conn', conn);
  $('setup').hidden = true;
  $('main').hidden = false;
  await loadList();
};
$('change').onclick = showSetup;

async function loadList() {
  try {
    const data = await call('GET', 'coles');
    items = data.items;
    say(items.length ? `${items.length} ${items.length === 1 ? 'product' : 'products'} on your lists.` : 'Nothing on your lists yet.');
  } catch (err) {
    say(`Couldn't reach Simple Budget: ${err.message}`, 'warn');
    items = [];
  }
  render();
}

// ---------- The table ----------

const wanted = (it) => !it.none && (!it.match || it.match.missing || it.out_of_date || $('all').checked);
$('all').onchange = render;

function cell(tr, content, cls = '') {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  if (typeof content === 'string') td.textContent = content; else td.append(...content);
  tr.append(td);
}
const span = (text, cls) => { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; return s; };

function render() {
  const tb = $('rows');
  tb.innerHTML = '';
  for (const it of items) {
    const tr = document.createElement('tr');
    const f = found.get(it.product_id);
    cell(tr, [span(it.name), span(it.size ? it.size : '', 'sub')]);
    if (f && f.products.length) {
      const sel = document.createElement('select');
      const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
      if (f.pick === null) sel.append(opt('', 'Pick the one you buy…'));
      f.products.slice(0, 12).forEach((p, i) => sel.append(opt(String(i), `${p.name}${p.size ? ` ${p.size}` : ''} – ${money(p.price_cents)}${p.was_cents ? ` (was ${money(p.was_cents)})` : ''}`)));
      sel.append(opt('none', 'Not sold at Coles / none of these'));
      sel.value = f.pick === null ? '' : String(f.pick);
      sel.onchange = () => { f.pick = sel.value === '' ? null : sel.value === 'none' ? 'none' : Number(sel.value); render(); };
      const parts = [sel];
      if (f.lost) parts.push(span("Couldn't find the matched product. Pick it again, or leave it.", 'sub warn'));
      cell(tr, parts);
      const p = typeof f.pick === 'number' ? f.products[f.pick] : null;
      cell(tr, p ? [span(money(p.price_cents), p.special ? 'special' : ''), span(p.special ? 'Special' : '', 'sub')] : '–', 'num');
    } else {
      const what = it.none ? span('Not sold at Coles', 'sub')
        : it.match ? [span(it.match.name), span(it.match.missing ? "Couldn't find it last time" : it.out_of_date ? 'Price out of date' : 'Up to date', `sub ${it.match.missing || it.out_of_date ? 'warn' : 'ok'}`)]
          : span(f ? 'No results at Coles' : 'Not matched yet', 'sub');
      cell(tr, Array.isArray(what) ? what : [what]);
      cell(tr, it.price_cents != null ? money(it.price_cents) : '–', 'num');
    }
    if (!wanted(it) && !f) tr.style.opacity = '.6';
    tb.append(tr);
  }
  const toSave = [...found.values()].some((f) => f.pick !== null || f.lost);
  $('save-row').hidden = !toSave;
}

// ---------- Checking Coles ----------

function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve(ok); };
    const t = setTimeout(() => done(false), timeout);
    function fn(id, info) { if (id === tabId && info.status === 'complete') done(true); }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// Runs inside the Coles search page: its results, from the data the page was built from.
function readPage() {
  const out = { title: document.title, url: location.href };
  const el = document.getElementById('__NEXT_DATA__');
  if (!el) {
    out.text = ((document.body && document.body.innerText) || '').slice(0, 400);
    out.blocked = /incapsula|request unsuccessful|something went wrong|verify|captcha|pardon our interruption/i.test(document.documentElement.outerHTML.slice(0, 5000) + out.text);
    out.error = 'no-page-data';
    return out;
  }
  let d;
  try { d = JSON.parse(el.textContent); } catch { out.error = 'bad-json'; return out; }
  const pp = (d.props && d.props.pageProps) || {};
  const results = (pp.searchResults && pp.searchResults.results) || [];
  out.first = results.find((r) => r && r._type === 'PRODUCT') || null;
  const cents = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Math.round(Number(v) * 100));
  out.products = results.filter((r) => r && (r._type === 'PRODUCT' || r.pricing) && r.pricing).map((r) => {
    const p = r.pricing;
    const slug = [r.brand, r.name, r.size].filter(Boolean).join(' ').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const now = cents(p.now);
    const was = cents(p.was);
    return {
      id: String(r.id),
      name: [r.brand, r.name].filter(Boolean).join(' ').trim(),
      size: r.size || null,
      price_cents: now,
      was_cents: was && now && was > now ? was : null,
      special: Boolean(p.promotionType || p.onlineSpecial || (was && now && was > now)),
      url: `https://www.coles.com.au/product/${slug}-${r.id}`,
    };
  }).filter((p) => p.price_cents);
  return out;
}

$('stop').onclick = () => { stopping = true; say('Stopping after this one…'); };

$('run').onclick = async () => {
  if (busy) return;
  await loadList();
  const todo = items.filter(wanted).slice(0, MAX_ITEMS);
  if (!todo.length) { say('Every Coles price on your lists is up to date.', 'ok'); return; }
  busy = true;
  stopping = false;
  $('run').disabled = true;
  $('stop').hidden = false;
  const log = [];
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: 'https://www.coles.com.au/', active: false });
    await waitForLoad(tab.id);
    await sleep(2500 + Math.random() * 2000);
    for (let i = 0; i < todo.length && !stopping; i++) {
      const it = todo[i];
      const q = it.match ? it.match.name : it.q;
      say(`Searching Coles, ${i + 1} of ${todo.length}: ${it.name}`);
      await chrome.tabs.update(tab.id, { url: `https://www.coles.com.au/search/products?q=${encodeURIComponent(q)}` });
      await waitForLoad(tab.id);
      await sleep(1200 + Math.random() * 800);
      let page;
      try { [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage }); } catch (err) { page = { error: String(err) }; }
      log.push({ q, title: page.title, error: page.error, blocked: page.blocked, count: (page.products || []).length, first: page.first });
      debug(log);
      if (page.blocked) {
        await chrome.tabs.update(tab.id, { active: true });
        say('Coles showed a check or an error. Have a look at the Coles tab. Once it shows products normally, press Check again.', 'warn');
        tab = null; // left open for you
        break;
      }
      const products = page.products || [];
      let pick = null;
      let lost = false;
      if (it.match) {
        const want = colesId(it.match.url);
        const i2 = products.findIndex((p) => p.id === want);
        if (i2 >= 0) pick = i2; else lost = true;
      }
      found.set(it.product_id, { products, pick, lost });
      render();
      if (i < todo.length - 1) await sleep(4000 + Math.random() * 3000);
    }
    const matched = [...found.values()].filter((f) => typeof f.pick === 'number').length;
    if (!/check or an error/.test($('status').textContent)) {
      const left = [...found.values()].filter((f) => f.pick === null && f.products.length).length;
      say(`Done. ${matched} found${left ? `, ${left} to pick below` : ''}. Press Save to Simple Budget.`, 'ok');
    }
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    busy = false;
    $('run').disabled = false;
    $('stop').hidden = true;
  }
};

$('save').onclick = async () => {
  const body = { found: [], none: [], missing: [] };
  for (const [id, f] of found) {
    if (typeof f.pick === 'number') {
      const p = f.products[f.pick];
      body.found.push({ product_id: id, url: p.url, name: p.name, size: p.size, price_cents: p.price_cents, was_cents: p.was_cents });
    } else if (f.pick === 'none') body.none.push(id);
    else if (f.lost) body.missing.push(id);
  }
  $('save').disabled = true;
  try {
    const r = await call('POST', 'coles/results', body);
    found.clear();
    await loadList();
    say(`Saved ${body.found.length} ${body.found.length === 1 ? 'price' : 'prices'} to Simple Budget${r.changes.length ? `, ${r.changes.length} changed` : ''}.`, 'ok');
  } catch (err) {
    $('save-msg').textContent = err.message;
  } finally {
    $('save').disabled = false;
  }
};

start();
