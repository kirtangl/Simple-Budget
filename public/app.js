'use strict';

(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  const $userMenu = document.getElementById('user-menu');
  const $modal = document.getElementById('modal');
  const $modalForm = document.getElementById('modal-form');
  const $prompt = document.getElementById('prompt');
  const $promptForm = document.getElementById('prompt-form');

  const state = { data: null, offset: 0, showIncomes: false, showUnused: false, calc: { amount: '', rate: '6', years: '30', frequency: 'monthly', limit: '70', result: null }, expenseQuery: '', expenseAccount: '', expenseWhen: '', expenseSort: 'due', expenseGroup: '', billAccount: '', billWhen: '', shopOpen: new Set() };

  // ---------- HTML helpers (everything interpolated is escaped unless raw) ----------

  class Raw { constructor(s) { this.s = s; } }
  const raw = (s) => new Raw(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v === null || v === undefined || v === false ? '' : esc(v));
  const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

  // ---------- Formatting ----------

  const moneyFmt = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
  const moneyWhole = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
  const money = (cents) => (cents % 100 === 0 ? moneyWhole : moneyFmt).format((cents || 0) / 100);
  const moneyInput = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace(/\.00$/, ''));

  function parseMoney(str) {
    let s = String(str ?? '').replace(/[$\s]/g, '');
    // Commas only as thousands separators (1,250.50), so "1,5" isn't read as 15.
    if (s.includes(',')) {
      if (!/^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return NaN;
      s = s.replace(/,/g, '');
    }
    if (s === '') return null;
    if (!/^-?\d*(\.\d{0,2})?$/.test(s) || s === '.' || s === '-') return NaN;
    return Math.round(Number(s) * 100);
  }

  // A Date as YYYY-MM-DD on this device's calendar (toISOString would give the UTC day).
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDaysIso = (s, n) => new Date(toDate(s).getTime() + n * 86400000).toISOString().slice(0, 10);
  const fmtDate = (s, withYear) => {
    const d = toDate(s);
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
  };
  const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const anchorWeekday = () => toDate(state.data.settings.pay_anchor_date).getUTCDay();
  const weekdayFor = (offset, long) => (long ? DAYS_LONG : DAYS)[(anchorWeekday() + offset) % 7];

  const FREQ_LABELS = {
    weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', bimonthly: 'Every 2 months',
    quarterly: 'Every 3 months', semiannual: 'Every 6 months', yearly: 'Yearly',
  };
  const FREQ_MONTHS = { bimonthly: 2, quarterly: 3, semiannual: 6, yearly: 12 };

  function scheduleText(e) {
    const off = e.day_offset ?? 0;
    switch (e.frequency) {
      case 'weekly': return `Weekly on ${weekdayFor(off, true)}`;
      case 'fortnightly': return `Fortnightly, week ${off < 7 ? 1 : 2} ${weekdayFor(off, true)}`;
      case 'monthly': return `Monthly on the ${ordinal(e.day_of_month || 1)}`;
      case 'yearly': return `Yearly on ${e.day_of_month || 1} ${MONTHS[(e.start_month || 1) - 1]}`;
      default: {
        const step = FREQ_MONTHS[e.frequency];
        const months = [];
        for (let m = ((e.start_month || 1) - 1) % step; m < 12; m += step) months.push(MONTHS[m]);
        return `${FREQ_LABELS[e.frequency]} on the ${ordinal(e.day_of_month || 1)} (${months.join(', ')})`;
      }
    }
  }

  // src/db.js keeps a copy for accounts, to save each one's colour: change both together.
  const PALETTE = ['#0f766e', '#2563eb', '#9333ea', '#ea580c', '#db2777', '#16a34a', '#ca8a04', '#0891b2', '#64748b', '#dc2626'];
  const colorFor = (item, i) => (item && item.color) || PALETTE[i % PALETTE.length];
  // Incomes default to colours that sit well beside the green combined income.
  const INCOME_PALETTE = ['#0891b2', '#2563eb', '#9333ea', '#ca8a04', '#db2777', '#0f766e', '#ea580c'];
  const incomeColor = (inc) => (inc && inc.color)
    || INCOME_PALETTE[Math.max(0, state.data.incomes.findIndex((x) => x.id === inc?.id)) % INCOME_PALETTE.length];

  // ---------- Lookups ----------

  const byId = (list, id) => list.find((x) => x.id === id);
  const account = (id) => byId(state.data.accounts, id);
  const accountColor = (id) => {
    const i = state.data.accounts.findIndex((a) => a.id === id);
    return i === -1 ? 'var(--muted)' : colorFor(state.data.accounts[i], i);
  };
  const payee = (id) => byId(state.data.payees, id);
  const category = (id) => byId(state.data.categories, id);
  const subcategory = (id) => state.data.categories.flatMap((c) => c.subcategories).find((s) => s.id === id);
  const bankTip = (a) => [a.institution, a.bsb && `BSB ${a.bsb}`, a.account_number && `Acc ${a.account_number}`].filter(Boolean).join('\n');

  const ROUNDING_LABELS = { exact: 'Exact (no rounding)', up5: 'Round up to the next $5', up10: 'Round up to the next $10' };

  // The server works out the deposits, and which bills and loans they cover this cycle,
  // the same way the Overview does, so every page shows the same numbers.
  const inDeposit = (e) => Boolean(e.in_deposit);
  const depositFor = (accountId) => (state.data.deposits && state.data.deposits[accountId]) || 0;

  // ---------- API ----------

  async function api(method, path, body) {
    const res = await fetch(`api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (res.status === 401 && path !== '/login') {
      showLogin();
      throw new Error('Please log in.');
    }
    if (res.status === 403 && data && data.mustChangePassword) {
      showChangePassword();
      throw new Error('Please log in.');
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    return data;
  }

  async function reload() {
    state.data = await api('GET', '/data');
    state.trends = null; // the year ahead is worked out from this data, so fetch it again next time
    showBell(state.data.notices);
  }

  // ---------- Notifications ----------
  // The bell in the top bar: a dot while there's something unread, red for an alert or deleted
  // data, amber for a warning, the accent colour otherwise. Its count comes with the data, and
  // with the hourly look for updates, so there's no polling of its own.
  function showBell(n) {
    if (!n) return;
    const dot = document.getElementById('bell-dot');
    dot.hidden = !n.unread;
    dot.dataset.level = n.level || 'info';
    document.getElementById('bell').setAttribute('aria-label', n.unread ? `Notifications, ${n.unread} unread` : 'Notifications');
  }
  const NOTICE_LABEL = { info: 'Info', warning: 'Warning', alert: 'Alert', deleted: 'Deleted' };
  function bellBody(list) {
    if (!list.items.length) return html`<p class="muted bell-empty">Nothing here. Notices about backups, updates and anything that needs a look show up here.</p>`;
    return html`<ul class="bell-list">${list.items.map((n) => html`<li>
      <button type="button" class="bell-item ${n.read_at ? '' : 'unread'}" data-notice="${n.id}" data-link="${n.link || ''}">
        <span class="bell-kind" data-kind="${n.kind}" title="${NOTICE_LABEL[n.kind]}"></span>
        <span class="bell-text"><span class="bell-title">${n.title}</span>${n.body ? html`<span class="bell-body">${n.body}</span>` : ''}
          <span class="bell-when">${updWhen(n.created_at)}</span></span>
        ${n.link ? html`<span class="bell-go" aria-hidden="true">›</span>` : ''}
      </button></li>`)}</ul>`;
  }
  function bellPanel(list) {
    showBell(list);
    const any = list.items.length > 0;
    openForm({
      title: 'Notifications',
      cls: 'bell-pop',
      focus: false,
      body: bellBody(list),
      lead: any ? html`<button type="button" data-bell="read" ${list.unread ? '' : raw('disabled')}>Mark all read</button><button type="button" data-bell="clear">Clear all</button>` : null,
      afterRender: (form) => {
        form.onclick = async (ev) => {
          const item = ev.target.closest('[data-notice]');
          const act = ev.target.closest('[data-bell]');
          try {
            if (item) {
              const fresh = await api('POST', `/notifications/${item.dataset.notice}/read`);
              showBell(fresh);
              if (item.dataset.link) { closeForm(); location.hash = item.dataset.link; } else bellPanel(fresh);
            } else if (act) {
              bellPanel(await api('POST', `/notifications/${act.dataset.bell}`));
            }
          } catch (err) { form.querySelector('#form-error').textContent = err.message; }
        };
      },
    });
  }

  // ---------- Small UI pieces ----------

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // The app is usually opened over plain http on the home network, where the
  // Clipboard API isn't available, so fall back to a hidden textarea. It has to
  // live inside an open dialog, because a modal dialog makes the rest of the page inert.
  async function copyText(text, label) {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
    }
    if (!ok) {
      const host = document.querySelector('dialog[open]') || document.body;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      host.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) toast(`${label} copied`);
    else window.prompt(`Couldn't copy automatically. Select and copy the ${label.toLowerCase()}:`, text);
  }

  const progress = (value, total, cls = '', color = '') => html`
    <div class="bar ${cls}"><span style="width:${total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)).toFixed(1) : 0}%${color ? `;background:${color}` : ''}"></span></div>`;

  // A text box that drops down a list of existing values, filtered as you type.
  // Typing something not in the list is fine too.
  // meta, if given, is a line shown beside each option: { option: text }.
  const combo = ({ id, name, value, options, meta = null, placeholder = '' }) => html`
    <div class="combo"><input id="${id}" name="${name}" value="${value}" placeholder="${placeholder}" autocomplete="off"
      role="combobox" aria-autocomplete="list" aria-expanded="false" data-combo="${JSON.stringify(options)}" ${raw(meta ? html`data-combo-meta="${JSON.stringify(meta)}"`.s : '')}><ul class="combo-list" role="listbox" hidden></ul></div>`;

  function options(list, selected, { empty = '— None —', label = (x) => x.name } = {}) {
    return html`<option value="">${empty}</option>${list.map((x) => html`<option value="${x.id}" ${x.id === selected ? raw('selected') : ''}>${label(x)}</option>`)}`;
  }

  // ---------- Dialogs ----------

  let modalHandler = null;

  // Opens the shared form dialog. onSave receives the form element and
  // should throw an Error with a friendly message to keep the dialog open.
  // Every popup gets the red ✕ at the top (ones with their own heading add it there). lead is a
  // button for the left of the bottom row, like Back.
  function openForm({ title, body, onSave, onDelete, saveLabel = 'Save', afterRender, noActions = false, cls = '', lead = null, focus = true }) {
    $modal.className = cls;
    $modalForm.onclick = null; // a popup's own click and input handlers (afterRender) go with it
    $modalForm.oninput = null;
    $modalForm.innerHTML = html`
      ${title == null ? '' : popHead(title, {})}
      ${body}
      <p class="error" id="form-error"></p>
      <div class="dialog-actions" ${raw(noActions ? 'hidden' : '')}>
        ${lead ? html`${lead}<span class="spacer"></span>` : ''}
        ${onDelete ? html`<button type="button" class="danger" data-modal="delete">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" data-modal="cancel">${onSave ? 'Cancel' : 'Close'}</button>
        ${onSave ? html`<button type="submit" class="primary">${saveLabel}</button>` : ''}
      </div>`.s;
    modalHandler = { onSave, onDelete };
    if (afterRender) afterRender($modalForm);
    if (!$modal.open) $modal.showModal();
    watchScroll();
    const first = $modalForm.querySelector('input:not([type=checkbox]), select, textarea');
    if (focus && first && window.matchMedia('(min-width: 721px)').matches) first.focus();
  }

  // Popups that need a scrollbar get a thin line above their buttons, which stay at the bottom while the rest scrolls.
  const scrollWatch = new ResizeObserver(() => {
    for (const form of [$modalForm, $promptForm]) form.classList.toggle('scrolls', form.scrollHeight > form.clientHeight + 1);
  });
  const watchScroll = () => {
    scrollWatch.disconnect();
    for (const form of [$modalForm, $promptForm]) [form, ...form.children].forEach((el) => scrollWatch.observe(el));
  };

  const closeForm = () => { if ($modal.open) $modal.close(); modalHandler = null; };

  $modalForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!modalHandler || !modalHandler.onSave) return closeForm();
    const btn = $modalForm.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await modalHandler.onSave($modalForm);
      closeForm();
      render();
    } catch (err) {
      $modalForm.querySelector('#form-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $modalForm.addEventListener('click', async (ev) => {
    const which = ev.target.closest('[data-modal]')?.dataset.modal;
    if (which === 'cancel') closeForm();
    if (which === 'delete' && modalHandler?.onDelete) {
      if (!confirm('Delete this? This cannot be undone.')) return;
      try {
        await modalHandler.onDelete();
        closeForm();
        render();
      } catch (err) {
        $modalForm.querySelector('#form-error').textContent = err.message;
      }
    }
  });

  // Tick boxes with data-toggle show or hide the fields that go with them.
  $modalForm.addEventListener('change', (ev) => {
    const sel = ev.target.dataset && ev.target.dataset.toggle;
    if (sel) $modalForm.querySelector(sel).hidden = !ev.target.checked;
  });

  // The heading of a small question dialog, with the red ✕ (which answers nothing).
  const promptHead = (title) => html`<div class="pop-head"><div class="pop-title"><h2>${title}</h2></div>
    <div class="pop-btns"><button type="button" class="pop-btn x" data-p="" aria-label="Close">✕</button></div></div>`;

  // A small "type a name" dialog used for adding categories, payees, etc.
  function askText(title, label, value = '', { inputmode = '' } = {}) {
    return new Promise((resolve) => {
      $promptForm.innerHTML = html`
        ${promptHead(title)}
        <div class="field"><label for="prompt-input">${label}</label><input id="prompt-input" name="value" value="${value}" autocomplete="off" ${inputmode ? raw(`inputmode="${inputmode}"`) : ''}></div>
        <div class="dialog-actions"><button type="button" data-p="cancel">Cancel</button><button type="submit" class="primary">OK</button></div>`.s;
      const input = $promptForm.querySelector('input');
      const done = (v) => { $promptForm.onsubmit = null; $promptForm.onclick = null; if ($prompt.open) $prompt.close(); resolve(v); };
      $promptForm.onsubmit = (e) => { e.preventDefault(); done(input.value.trim() || null); };
      $promptForm.onclick = (e) => { const p = e.target.closest('[data-p]')?.dataset.p; if (p === 'cancel' || p === '') done(null); };
      $prompt.oncancel = () => done(null);
      $prompt.showModal();
      watchScroll();
      input.focus();
      input.select();
    });
  }

  // A question with a few buttons, over whatever form is open. Resolves to the picked value, or null on Escape.
  function askChoice({ title, text, choices }) {
    return new Promise((resolve) => {
      $promptForm.innerHTML = html`
        ${promptHead(title)}
        <div class="choice-text">${text}</div>
        <div class="dialog-actions">${choices.map((c) => html`<button type="button" data-p="${c.value}" class="${c.danger ? 'danger' : c.primary ? 'primary' : ''}">${c.label}</button>`)}</div>`.s;
      const done = (v) => { $promptForm.onclick = null; if ($prompt.open) $prompt.close(); resolve(v); };
      $promptForm.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) done(b.dataset.p || null); };
      $prompt.oncancel = () => done(null);
      $prompt.showModal();
      watchScroll();
    });
  }

  // The same buttons on every details popup: Update (blue), Edit (green) and Close (red) at the top,
  // and again at the bottom with Close on the right. upd and edit are { label, action, id }, or left out.
  const popBtn = (cls, b) => html`<button type="button" class="pop-btn ${cls}" data-action="${b.action}" data-id="${b.id}">${b.label}</button>`;
  const popTop = ({ upd, edit }) => html`<div class="pop-btns">${upd ? popBtn('upd', upd) : ''}${edit ? popBtn('edit', { ...edit, label: 'Edit' }) : ''}
    <button type="button" class="pop-btn x" data-modal="cancel" aria-label="Close">✕</button></div>`;
  const popFoot = ({ upd, edit }) => html`<div class="pop-foot">${upd ? popBtn('upd', upd) : ''}${edit ? popBtn('edit', edit) : ''}
    <button type="button" class="pop-btn close" data-modal="cancel">Close</button></div>`;
  // A popup's heading with those buttons beside it.
  const popHead = (title, btns, sub = '') => html`<div class="pop-head"><div class="pop-title"><h2>${title}</h2>${sub}</div>${popTop(btns)}</div>`;

  const val = (form, name) => form.elements[name]?.value.trim() ?? '';
  const idVal = (form, name) => (val(form, name) ? Number(val(form, name)) : null);
  function moneyVal(form, name, label, { required } = {}) {
    const c = parseMoney(val(form, name));
    if (Number.isNaN(c)) throw new Error(`${label} must be a dollar amount, like 79.10`);
    if (required && c === null) throw new Error(`${label} is required.`);
    if (c !== null && c < 0) throw new Error(`${label} can't be negative.`);
    return c;
  }
  // A plain number like an interest rate or a term. "6.5%" is fine; "abc" is an error, not a blank.
  function numVal(form, name, label) {
    const s = val(form, name).replace(/[%\s]/g, '');
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number, like 6.24`);
    return n;
  }

  // ---------- Login ----------

  function showLogin(defaultPassword) {
    // Forget the budget, so Back after logging out can't show it again.
    state.data = null; state.trends = null; state.updates = null; state.advanced = null; state.backups = null;
    // A form left open (e.g. the login ran out mid-save) would sit over the login page.
    if ($modal.open) closeForm();
    $nav.hidden = true;
    $userMenu.hidden = true;
    $app.innerHTML = html`
      <form class="card login" id="login-form">
        <h1>Simple Budget</h1>
        <p class="muted">Enter your password.</p>
        ${defaultPassword ? html`<p class="small">First time here? The password is <b>${defaultPassword}</b>. You'll choose your own next.</p>` : ''}
        <div class="field"><label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>
        <p class="error" id="login-error"></p>
        <button class="primary" type="submit" style="width:100%">Log in</button>
      </form>`.s;
    const form = document.getElementById('login-form');
    form.querySelector('input').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/login', { password: form.password.value });
        await start();
      } catch (err) {
        document.getElementById('login-error').textContent = err.message;
      }
    });
  }

  const PASSWORD_ATTRS = raw('type="password" autocapitalize="off" autocorrect="off" spellcheck="false"');

  function showChangePassword() {
    $nav.hidden = true;
    $app.innerHTML = html`
      <form class="card login" id="first-pw-form">
        <h1>Choose a password</h1>
        <p class="muted">You're using the default password. Pick a new one for your household to use from now on.</p>
        <div class="field"><label for="np1">New password</label><input id="np1" name="password" ${PASSWORD_ATTRS} autocomplete="new-password" minlength="8" required>
          <div class="hint">At least 8 characters.</div></div>
        <div class="field"><label for="np2">Type it again</label><input id="np2" name="confirm" ${PASSWORD_ATTRS} autocomplete="new-password" required></div>
        <p class="error" id="pw-error"></p>
        <button class="primary" type="submit" style="width:100%">Save password</button>
        <button type="button" class="linkish" id="first-pw-logout" style="width:100%;margin-top:10px">Log out</button>
      </form>`.s;
    const form = document.getElementById('first-pw-form');
    document.getElementById('first-pw-logout').addEventListener('click', async () => { await api('POST', '/logout'); showLogin(); });
    form.querySelector('input').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        if (form.password.value !== form.confirm.value) throw new Error("The two passwords don't match.");
        await api('POST', '/password', { password: form.password.value });
        toast('Password saved');
        await start();
      } catch (err) {
        document.getElementById('pw-error').textContent = err.message;
      }
    });
  }

  function changePasswordForm() {
    openForm({
      title: 'Change password',
      body: html`
        <div class="field"><label for="cp0">Current password</label><input id="cp0" name="current" ${PASSWORD_ATTRS} autocomplete="current-password" required></div>
        <div class="field"><label for="cp1">New password</label><input id="cp1" name="password" ${PASSWORD_ATTRS} autocomplete="new-password" required>
          <div class="hint">At least 8 characters. Other devices will need to log in again.</div></div>
        <div class="field"><label for="cp2">Type it again</label><input id="cp2" name="confirm" ${PASSWORD_ATTRS} autocomplete="new-password" required></div>`,
      saveLabel: 'Change password',
      onSave: async (form) => {
        if (form.elements.password.value !== form.elements.confirm.value) throw new Error("The two new passwords don't match.");
        await api('POST', '/password', { current: form.elements.current.value, password: form.elements.password.value });
        toast('Password changed');
      },
    });
  }

  // ---------- Overview ----------

  const PAY_WORD = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month', custom: 'pay' };
  // The budget cycle in words: "month", "this month", "a month".
  const cycleWord = () => PAY_WORD[state.data.settings.pay_frequency] || 'pay';
  const thisCycle = () => `this ${cycleWord()}`;
  const aCycle = () => `a ${cycleWord()}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const INCOME_FREQ = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' };
  // An income's after-tax pay, averaged per budget cycle ($3,000 fortnightly is $6,500 a month), from the server.
  const incomePerCycle = (i) => i.per_cycle_cents ?? 0;
  // "($3,000 fortnightly)" beside a per-cycle amount, only when it is paid on a different rhythm to the budget.
  const rhythm = (cents, freq) => (freq && freq !== state.data.settings.pay_frequency && FREQ_LABELS[freq]
    ? html` <span class="rhythm">(${money(cents)} ${FREQ_LABELS[freq].toLowerCase()})</span>` : '');
  const untilTag = (row) => (row.end_date ? html` <span class="chip temp">${row.end_date < state.data.settings.today ? 'Ended' : 'Until'} ${fmtDate(row.end_date, true)}</span>` : '');
  // A "Temporary" tick box that shows the dates that go with it.
  const temporaryField = (row, { start = true } = {}) => html`
    <div class="field full"><label class="check"><input type="checkbox" name="temporary" data-toggle="#temp-dates" ${row.end_date ? raw('checked') : ''}> Temporary (stops on an end date)</label></div>
    <div class="fields full" id="temp-dates" style="gap:0 12px" ${row.end_date ? '' : raw('hidden')}>
      ${start ? html`<div class="field"><label for="t-start">Starts (optional)</label><input id="t-start" type="date" name="start_date" value="${row.start_date || ''}"></div>` : ''}
      <div class="field"><label for="t-end">Ends</label><input id="t-end" type="date" name="end_date" value="${row.end_date || ''}"></div>
    </div>`;
  function temporaryVal(form) {
    if (!form.elements.temporary.checked) return { end_date: null, ...(form.elements.start_date && form.elements.start_date.closest('#temp-dates') ? { start_date: null } : {}) };
    const end = val(form, 'end_date');
    if (!end) throw new Error('Add the end date, or untick Temporary.');
    const out = { end_date: end };
    if (form.elements.start_date && form.elements.start_date.closest('#temp-dates')) out.start_date = val(form, 'start_date') || null;
    if (out.start_date && out.start_date > end) throw new Error('The end date is before the start date.');
    return out;
  }

  const overviewTabs = (active) => html`
    <div class="sec-tabs ov-tabs" role="tablist" aria-label="Overview"><a role="tab" href="#/overview" aria-selected="${active === 'pay' ? 'true' : 'false'}" tabindex="${active === 'pay' ? '0' : '-1'}">This ${cycleWord()}</a>
      <a role="tab" href="#/overview/analytics" aria-selected="${active === 'analytics' ? 'true' : 'false'}" tabindex="${active === 'analytics' ? '0' : '-1'}">Analytics</a></div>`;

  const DEPOSIT_KEY = [['out', 'Bills that have come out'], ['left', 'Bills still to come out'], ['sav', 'Savings (they stay in the account)'],
    ['extra', 'Extra: more than the bills and savings'], ['over', "Over: the transfer doesn't cover them"]];
  // Keep in account shows rounded up to the whole dollar; its popup shows the exact amount.
  const keepUp = (cents) => Math.ceil((cents || 0) / 100) * 100;
  const dayText = (d) => fmtDate(d, d.slice(0, 4) !== state.data.settings.today.slice(0, 4));
  // What "Keep in account" is made of, as plain lines (the hover, and the popup on a tap).
  function keepParts(c, r) {
    const when = c.cycle.is_current ? 'today' : `on ${fmtDate(c.held_on)}, once that deposit is in`;
    const ahead = Math.max(0, r.held_cents - r.remaining_cents);
    return {
      when,
      lines: [
        [`Still to come out ${thisCycle()}`, r.remaining_cents],
        ...(ahead ? [['Held for bills further ahead', ahead]] : []),
      ],
      tight: r.held_cents > r.deposit_cents,
      low: r.held_cents && r.low_on ? `Tightest on ${dayText(r.low_on)}, after ${r.low_after}: the account gets down to $0 if it holds exactly this.` : '',
    };
  }
  // A styled card shown on hover (on a computer); tapping still opens the full popup.
  const keepCard = (c, r) => {
    const k = keepParts(c, r);
    return html`<span class="hover-card keep-card" role="tooltip">
      <span class="hc-title">Keep in account · ${k.when}</span>
      <span class="hc-row"><span>Exact amount</span><b class="num">${moneyFmt.format(r.held_cents / 100)}</b></span>
      ${k.lines.map(([label, cents]) => html`<span class="hc-row"><span>${label}</span><b class="num">${money(cents)}</b></span>`)}
      ${k.tight ? html`<span class="hc-warn">More than this ${cycleWord()}'s ${money(r.deposit_cents)} transfer, so none of it is spare.</span>` : ''}
      ${k.low ? html`<span class="hc-note">${k.low}</span>` : ''}
      ${r.ahead.length ? html`<span class="hc-sub">Big bills ahead</span>
        ${r.ahead.slice(0, 5).map((b) => html`<span class="hc-row"><span>${b.name} <span class="muted">· ${dayText(b.date)}</span></span><b class="num">${money(b.amount_cents)}</b></span>`)}
        ${r.ahead.length > 5 ? html`<span class="hc-note">and ${r.ahead.length - 5} more</span>` : ''}` : ''}
      <span class="hc-foot">Savings aren't included, so you can take this pay's out. Anything above this is spare. Click for more.</span>
    </span>`;
  };
  // An account's buffer beside its transfer, as a small "+10%" with the details on hover.
  function bufferTag(r) {
    const { rounding, buffer_percent: pct } = r.rules || {};
    if (!pct) return '';
    const up = { up5: '$5', up10: '$10' }[rounding];
    return html` <span class="buf-tag" tabindex="0">+${pct}%<span class="hover-card" role="tooltip">
      <span class="hc-title">Buffer</span><span class="hc-note">This transfer has a ${pct}% buffer on top of the account's bills and savings${up ? `, then it's rounded up to the next ${up}` : ''}. Change it by editing the account.</span></span></span>`;
  }
  function keepDetails(id) {
    const c = state.cycleData;
    const r = c && c.accounts.find((x) => x.account_id === id);
    const a = account(id);
    if (!r || !a) return;
    const k = keepParts(c, r);
    openForm({
      title: null,
      noActions: true,
      cls: 'keep-pop',
      body: html`
        ${popHead('Keep in account', {}, html`<div class="muted small">${a.name} · ${k.when}</div>`)}
        <div class="keep-big ${k.tight ? 'tight' : ''}"><b class="num">${moneyFmt.format(r.held_cents / 100)}</b></div>
        <p class="muted small">So every bill in the next 12 months can be paid with the deposits still to come.</p>
        <p class="keep-sav small">Savings aren't included. Take this ${cycleWord()}'s savings out and keep at least this much, and every bill is still covered.</p>
        <ul class="list keep-list">${k.lines.map(([label, cents]) => html`<li><span class="grow">${label}</span><b class="num">${money(cents)}</b></li>`)}</ul>
        ${k.tight ? html`<p class="keep-warn">That's more than this ${cycleWord()}'s ${money(r.deposit_cents)} transfer, so none of this deposit is spare. The rest needs to be in the account already.</p>` : ''}
        ${k.low ? html`<p class="small">${k.low}</p>` : ''}
        ${r.ahead.length ? html`<h3 class="keep-h">Big bills ahead</h3>
          <ul class="list keep-list">${r.ahead.map((b) => html`<li><span class="grow">${b.name}<span class="muted"> · ${dayText(b.date)}</span></span><b class="num">${money(b.amount_cents)}</b></li>`)}</ul>` : ''}
        <p class="muted small">Anything in the account above this is spare, so you can borrow it. Later deposits don't top it back up, so check again next ${cycleWord()}.</p>`,
    });
  }

  async function renderOverview() {
    const c = await api('GET', `/cycle?offset=${state.offset}`);
    const t = c.totals;
    const accountsById = new Map(c.accounts.map((a) => [a.account_id, a]));
    const rows = state.data.accounts.map((a, i) => ({ a, r: accountsById.get(a.id), i })).filter((x) => x.r);
    // Accounts with nothing going in or out this cycle fold away.
    const saved = goalSavings();
    const isUsed = ({ a, r }) => r.deposit_cents || r.bills_cents || r.savings_cents || r.held_cents || saved.has(a.id);
    const used = rows.filter(isUsed);
    const unused = rows.filter((x) => !isUsed(x));
    state.cycleData = c;
    // Per account: the transfer, what to keep in the account, and a bar of where this cycle's transfer goes
    // (bills out, bills still to come, savings, and what's extra).
    const depositRow = (a, r, i) => {
      const need = r.bills_cents + r.savings_cents;
      const scale = Math.max(r.deposit_cents, need) || 1;
      const seg = (cents, cls, tip) => (cents > 0 ? html`<span class="${cls}" style="width:${((cents / scale) * 100).toFixed(2)}%" title="${tip}"></span>` : '');
      const over = r.spare_cents < 0;
      const tight = r.held_cents > r.deposit_cents;
      return html`
            <li class="acct-line deposit dep2 clickable" data-action="account-details" data-id="${a.id}" style="--acct:${colorFor(a, i)}"><div class="grow">
              <div class="dep-head">
                <div class="grow"><div class="dep-name"><span class="sq" aria-hidden="true"></span><button class="acct-btn" data-action="account-details" data-id="${a.id}" data-tip="${bankTip(a) || 'No bank details yet'}">${a.name}</button></div>
                  <div class="dep-per"><b class="num">${money(r.deposit_cents)}</b> per pay${bufferTag(r)}</div></div>
                <button type="button" class="dep-keep ${tight ? 'tight' : ''}" data-action="keep-details" data-id="${a.id}" aria-label="Keep ${money(keepUp(r.held_cents))} in account: show the breakdown">
                  <b class="num">${money(keepUp(r.held_cents))}</b><span class="kl">Keep in account</span>${keepCard(c, r)}</button>
              </div>
              <div class="dep-seg" role="img" aria-label="${money(r.paid_cents)} of bills out, ${money(r.remaining_cents)} to come, ${money(r.savings_cents)} savings, ${over ? `${money(-r.spare_cents)} over` : `${money(r.spare_cents)} extra`}">
                ${seg(r.paid_cents, 'out', `${money(r.paid_cents)} in bills has come out`)}${seg(r.remaining_cents, 'left', `${money(r.remaining_cents)} in bills still to come out`)}${seg(r.savings_cents, 'sav', `${money(r.savings_cents)} to savings`)}${seg(r.spare_cents, 'extra', `${money(r.spare_cents)} extra`)}
                ${over ? html`<i class="dep-end" style="left:${((r.deposit_cents / scale) * 100).toFixed(2)}%" title="The ${money(r.deposit_cents)} transfer ends here"></i>` : ''}
              </div>
              <div class="dep-line">
                <span title="This ${cycleWord()}'s bills from this account that haven't come out yet (savings not included)">${r.bills_cents ? html`<b class="num left-amt">${money(r.remaining_cents)}</b> of ${money(r.bills_cents)} left` : html`<span class="muted">No bills ${thisCycle()}</span>`}</span>
                <span class="${r.savings_cents ? 'good-text' : 'muted'}" title="Savings from this account ${thisCycle()}. They stay in the account."><b class="num">${r.savings_cents ? '+' : ''}${money(r.savings_cents)}</b> Savings</span>
                <span class="${over ? 'neg' : r.spare_cents ? 'info-text' : 'muted'}" title="${over ? `${r.savings_cents ? 'Bills + savings are' : 'Bills are'} ${money(need)}, ${money(-r.spare_cents)} more than this transfer` : r.spare_cents ? `${money(r.spare_cents)} more than this ${cycleWord()}'s bills and savings` : `Exactly this ${cycleWord()}'s bills and savings`}"><b class="num">${over ? '−' : r.spare_cents ? '+' : ''}${money(Math.abs(r.spare_cents))}</b> ${over ? 'Over' : r.spare_cents ? 'Extra' : 'Even'}</span>
              </div>
              ${saved.has(a.id) ? html`<div class="figures">
                ${saved.has(a.id) ? html`<span class="figure goal-saved" title="Saved so far in ${saved.get(a.id).goals.map((g) => g.name).join(', ')}"><span class="label">Goals</span> <b class="num">${money(saved.get(a.id).cents)} saved</b></span>` : ''}
              </div>` : ''}
            </div></li>`;
    };
    const empty = !state.data.expenses.length && !state.data.loans.length;
    // Savings only show as expenses when they're set to.
    const bills = c.bills.filter((b) => b.is_expense);
    const paidCount = bills.filter((b) => b.status === 'paid').length;
    const status = { '': () => true, topay: (b) => b.status !== 'paid', paid: (b) => b.status === 'paid' }[state.billWhen] || (() => true);
    const inAccount = (b) => !state.billAccount || String(b.account_id ?? 'none') === state.billAccount;
    const shown = bills.filter((b) => inAccount(b) && status(b));
    const billAccounts = state.data.accounts.filter((a) => bills.some((b) => b.account_id === a.id));
    const sumOf = (list) => list.reduce((x, b) => x + b.amount_cents, 0);
    const word = cycleWord();
    const away = Math.abs(c.offset);
    // Budget income paid on another rhythm (e.g. fortnightly pay, monthly budget).
    const budgetIncomes = c.incomes.filter((r) => r.in_budget);
    const freqs = [...new Set(budgetIncomes.map((r) => r.frequency))];

    return html`
      ${overviewTabs('pay')}
      <div class="cycle-bar">
        <button class="icon" data-action="cycle" data-step="-1" aria-label="Previous ${word}">‹</button>
        <div class="cycle-title">
          <strong>${fmtDate(c.cycle.start)} – ${fmtDate(c.cycle.end, true)}</strong>
          ${c.cycle.is_current ? html`<span class="chip current">This ${word}</span>`
            : html`<span class="chip">${c.offset < 0 ? `${away} ${word}${away > 1 ? 's' : ''} ago` : `In ${away} ${word}${away > 1 ? 's' : ''}`}</span>
              <button class="chip back-now" data-action="cycle" data-step="0">↩ Back to ${thisCycle()}</button>`}
        </div>
        <button class="icon" data-action="cycle" data-step="1" aria-label="Next ${word}">›</button>
      </div>

      ${empty ? html`<div class="card welcome"><h2>Welcome!</h2><p>Start by adding your <a href="#/settings/accounts">accounts</a> and
        <a href="#/settings/income">income</a>, then add your bills on the <a href="#/budget/expenses">Expenses</a> tab.
        Set your budget cycle under <a href="#/settings/cycle">Settings → General</a>.</p></div>` : ''}

      <div class="stats">
        <div class="card stat"><div class="label">Income</div><div class="value num pos">${money(t.income_cents)}</div>
          ${freqs.length === 1 ? html`<div class="sub">${rhythm(budgetIncomes.reduce((x, r) => x + r.pay_cents, 0), freqs[0])}</div>` : ''}
          <div class="sub">${c.incomes.length ? html`${c.incomes.length} income${c.incomes.length === 1 ? '' : 's'}${t.other_income_cents ? ` incl. ${money(t.other_income_cents)} other` : ''} · <button class="linkish" data-action="toggle-incomes" aria-expanded="${state.showIncomes ? 'true' : 'false'}">${state.showIncomes ? 'Hide' : 'Show'}</button>`
            : html`<a href="#/settings/income">Add income</a>`}</div></div>
        <div class="card stat"><div class="label">Expenses · ${thisCycle()}</div><div class="value num neg">${money(t.bills_cents)}</div>
          <div class="sub">${money(t.paid_cents)} paid · ${money(t.outstanding_cents)} to go</div>
          ${progress(t.paid_cents, t.bills_cents)}</div>
        <div class="card stat"><div class="label">Remaining income</div><div class="value num ${t.remaining_cents < 0 ? 'neg' : 'info-text'}">${money(t.remaining_cents)}</div>
          <div class="sub">after ${money(t.deposits_cents)} in deposits${t.savings_cents ? `, incl. ${money(t.savings_cents)} savings` : ''}</div></div>
      </div>

      ${state.showIncomes && c.incomes.length ? incomeTable(c) : ''}

      ${c.cycle.is_current ? reviewNotes() : ''}
      ${t.unassigned_cents > 0 ? unassignedNote(t.unassigned_cents) : ''}
      ${fixedRateNote()}

      <div class="grid grid-2 overview-main">
        <div class="bills-cell"><section class="card bills-card">
          <div class="bills-head"><div class="card-head"><div><h2>Expenses</h2><div class="muted head-sub">${bills.length} bill${bills.length === 1 ? '' : 's'}<span class="cyc"> ${thisCycle()}</span>${paidCount ? ` · ${paidCount} paid` : ''}</div></div>
            ${bills.length ? segButtons('billWhen', [['', 'All'], ['topay', 'To pay'], ['paid', 'Paid']], 'Show bills') : ''}</div>
          ${bills.length ? html`<div class="filters">${accountChips('billAccount', billAccounts, bills.some((b) => b.account_id == null))}</div>` : ''}</div>
          <div class="bills-scroll">
          ${bills.length && !shown.length ? html`<p class="empty">${state.billWhen === 'topay' ? `Nothing left to pay ${thisCycle()}` : 'Nothing matches'}${state.billAccount ? ' in this account' : ''}.</p>` : ''}
          ${shown.length ? html`<ul class="list">${shown.map((b, n) => {
            const d = toDate(b.date);
            const a = account(b.account_id);
            const p = payee(b.payee_id);
            const action = b.kind === 'loan' ? html`data-action="loan-details" data-id="${b.loan_id}"` : html`data-action="bill-details" data-id="${b.expense_id}" data-date="${b.date}" data-amount="${b.amount_cents}" data-status="${b.status}"`;
            // A "Today" line just before the first bill still to come out.
            const today = state.data.settings.today;
            const divider = c.cycle.is_current && b.status !== 'paid' && (n === 0 || shown[n - 1].status === 'paid');
            return html`${divider ? html`<li class="today-line"><span>Today · ${fmtDate(today)}</span></li>` : ''}
            <li class="bill ${b.status} clickable" ${action}>
              <div class="date-box"><b>${d.getUTCDate()}</b><span>${DAYS[d.getUTCDay()]}</span></div>
              <div class="grow"><div class="title">${b.name}${b.kind === 'saving' ? html` <span class="chip">Savings</span>` : b.kind === 'loan' ? html` <span class="chip">Loan</span>` : ''}</div>
                ${b.moved_from_day ? html`<div class="meta moved">(set for the ${ordinal(b.moved_from_day)}, last day of ${MONTHS[d.getUTCMonth()]})</div>` : ''}
                <div class="meta">${a ? html`<span class="acct-tag bubble" style="--acct:${accountColor(a.id)}"><span class="dot"></span>${a.name}</span>` : ''}${p && a ? ' · ' : ''}${p ? p.name : ''}</div></div>
              <div class="right">${b.status === 'paid' ? html`<div class="num"><span class="tick" aria-label="Paid">✓</span> ${money(b.amount_cents)}</div>`
                : html`<div class="num">${money(b.amount_cents)}</div>${b.status === 'due' ? html`<span class="status due">Due today</span>` : ''}`}</div>
            </li>`;
          })}</ul>` : bills.length ? '' : html`<p class="empty">No bills come out ${thisCycle()}.</p>`}
          </div>
          ${bills.length ? html`<div class="bills-foot"><b class="num">${money(sumOf(bills.filter((b) => inAccount(b) && b.status !== 'paid')))}</b> to pay · <b class="num">${money(sumOf(bills.filter((b) => inAccount(b) && b.status === 'paid')))}</b> paid</div>` : ''}
        </section></div>

        <div class="stack">
        <section class="card">
          <div class="card-head dep-card-head"><div><h2>Deposits ${thisCycle()} <button type="button" class="help-q" aria-label="What the colours mean">?<span class="hover-card key-card" role="tooltip"><span class="hc-title">What the colours mean</span>
            ${DEPOSIT_KEY.map(([cls, text]) => html`<span class="hc-key"><i class="${cls}"></i>${text}</span>`)}
            <span class="hc-note">Keep in account turns <b class="due-text">amber</b> when it's more than the transfer.</span></span></button></h2>
            <div class="muted head-sub">${used.length} account${used.length === 1 ? '' : 's'}</div></div>
            <div class="dep-sum"><div class="dep-total-line"><svg class="dep-in" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><b class="num dep-total">${money(t.deposits_cents)}</b></div><div class="muted">goes in each pay</div></div></div>
          ${rows.length ? html`<ul class="list">${used.map(({ a, r, i }) => depositRow(a, r, i))}
            ${state.showUnused ? unused.map(({ a, r, i }) => depositRow(a, r, i)) : ''}</ul>
            ${unused.length ? html`<button class="linkish small" data-action="toggle-unused" aria-expanded="${state.showUnused ? 'true' : 'false'}">${state.showUnused ? 'Hide' : 'Show'} ${unused.length} unused account${unused.length === 1 ? '' : 's'}</button>` : ''}`
            : html`<p class="empty">No accounts yet. <a href="#/settings/accounts">Add one</a>.</p>`}
        </section>
        ${loansSummary()}
        </div>
      </div>

      ${goalsSummary()}`;
  }

  // ---------- Price reviews and price history ----------

  // Bills set to be checked once their review date passes (insurance renewals and the like).
  const reviewDue = (e) => e.active && kindOf(e) === 'expense' && e.review_date && e.review_date <= state.data.settings.today
    && !(e.review_snooze && e.review_snooze > state.data.settings.today);
  const addYearsIso = (s, n) => {
    const [y, m, d] = s.split('-').map(Number);
    const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate(); // 29 Feb becomes 28 Feb
    return `${y + n}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  };
  // The same day in the first year after today.
  const nextReview = (date) => {
    let next = date || state.data.settings.today;
    for (let n = 1; next <= state.data.settings.today; n++) next = addYearsIso(date || state.data.settings.today, n);
    return next;
  };
  const amountText = (cents, freq) => `${money(cents)}${freq ? ` ${(FREQ_LABELS[freq] || '').toLowerCase()}` : ''}`;
  const billCents = (e) => (isSplit(e) ? e.yearly_cents : e.amount_cents);

  function reviewNotes() {
    return state.data.expenses.filter(reviewDue).sort((a, b) => a.review_date.localeCompare(b.review_date)).map((e) => html`
      <div class="card small note-banner review-banner"><span class="note-tag">Review</span>
        <div class="grow"><span><button type="button" class="linkish" data-action="edit-expense" data-id="${e.id}">${e.name}</button>
          was due for a price check on ${fmtDate(e.review_date, true)}. It's ${isSplit(e) ? `${money(e.yearly_cents)} a year` : amountText(e.amount_cents, e.frequency)} now. Has it changed?</span>
          <div class="review-actions">
            <button type="button" class="primary" data-action="review-update" data-id="${e.id}">Update price</button>
            <button type="button" data-action="review-snooze" data-id="${e.id}">Remind me in 7 days</button>
            <button type="button" data-action="review-skip" data-id="${e.id}">Skip until next year</button>
          </div></div></div>`);
  }

  // The small popup for a new price: the amount, when it takes effect (backdated or ahead), and the next review.
  // From the review reminder, the next review is needed so the reminder goes away.
  function amountForm(e, { review = false } = {}) {
    const today = state.data.settings.today;
    const now = isSplit(e) ? `${money(e.yearly_cents)} a year` : amountText(e.amount_cents, e.frequency);
    const showReview = kindOf(e) === 'expense';
    openForm({
      title: `Update ${e.name}`,
      body: html`
        <p class="muted small" style="margin-top:0">It's ${now} now.${review ? " Leave it as is if it hasn't changed." : ''}
          ${e.pending_from ? html` <b>${money(e.pending_cents)}</b> is already set from ${fmtDate(e.pending_from, true)}. Another future date replaces it; today or earlier keeps it.` : ''}</p>
        <div class="fields">
          <div class="field"><label for="r-amount">New amount, ${isSplit(e) ? 'yearly' : (FREQ_LABELS[e.frequency] || '').toLowerCase()} ($)</label>
            <input id="r-amount" name="amount" inputmode="decimal" value="${moneyInput(e.pending_cents ?? billCents(e))}" required></div>
          <div class="field"><label for="r-from">Takes effect from</label><input id="r-from" type="date" name="from" value="${e.pending_from || today}" required>
            <div class="hint">Backdate it, or pick a future date to change it then.</div></div>
          ${showReview ? html`<div class="field full"><label for="r-date">Next review${review ? '' : ' (optional)'}</label><input id="r-date" type="date" name="review_date" value="${review || e.review_date ? nextReview(e.review_date) : ''}" ${review ? raw('required') : ''}>
            <div class="hint">When it's likely to change again.</div></div>` : ''}
        </div>`,
      onSave: async (form) => {
        const cents = moneyVal(form, 'amount', 'Amount', { required: true });
        const from = val(form, 'from') || today;
        const body = { amount_cents: cents, from };
        if (showReview) {
          const date = val(form, 'review_date') || null;
          if (review && !date) throw new Error('Pick the next review date.');
          if (date && date <= today) throw new Error('Pick a review date after today.');
          body.review_date = date;
        }
        await api('POST', `/expenses/${e.id}/amount`, body);
        await reload();
        toast(from > today ? `${e.name} changes to ${money(cents)} on ${fmtDate(from, true)}`
          : cents === billCents(e) ? `${e.name} checked${body.review_date ? `. Next review ${fmtDate(body.review_date, true)}` : ''}` : `${e.name} is now ${money(cents)}`);
      },
    });
  }

  // Loan statement update: the balance on a date, plus the rate and repayment if they've changed.
  function balanceForm(l) {
    const today = state.data.settings.today;
    const est = l.estimated_balance_cents;
    openForm({
      title: `Update ${l.name}`,
      body: html`
        <p class="muted small" style="margin-top:0">${est != null ? html`The estimate today is <b>${money(est)}</b>. ` : ''}Enter the balance from a statement or the bank's app.</p>
        <div class="fields">
          <div class="field"><label for="b-balance">Balance ($)</label><input id="b-balance" name="balance" inputmode="decimal" value="" placeholder="${est != null ? moneyInput(est) : ''}" required></div>
          <div class="field"><label for="b-date">Balance as at</label><input id="b-date" type="date" name="balance_date" value="${today}" max="${today}" required>
            <div class="hint">The statement date, or today.</div></div>
          <div class="field"><label for="b-rate">Interest rate (% p.a.)</label><input id="b-rate" name="interest_rate" inputmode="decimal" value="${l.interest_rate ?? ''}"></div>
          <div class="field"><label for="b-rep">Bank repayment ($ ${FREQ_UNIT[l.repayment_frequency] ? `/ ${FREQ_UNIT[l.repayment_frequency]}` : ''})</label><input id="b-rep" name="repayment" inputmode="decimal" value="${moneyInput(l.repayment_cents)}" placeholder="${l.repayment_cents == null && l.scheduled ? `${moneyInput(l.scheduled.amount_cents)} (calculated)` : ''}"></div>
          ${l.offset_cents != null ? html`<div class="field"><label for="b-offset">Offset balance ($)</label><input id="b-offset" name="offset" inputmode="decimal" value="${moneyInput(l.offset_cents)}"></div>` : ''}
        </div>
        <p class="hint">Rate and repayment changes are noted from the same date. Use Edit for everything else.</p>`,
      onSave: async (form) => {
        const body = { balance_cents: moneyVal(form, 'balance', 'Balance', { required: true }), balance_date: val(form, 'balance_date') || today,
          interest_rate: numVal(form, 'interest_rate', 'Interest rate'), repayment_cents: moneyVal(form, 'repayment', 'Repayment') };
        if (form.elements.offset) body.offset_cents = moneyVal(form, 'offset', 'Offset balance');
        if (body.balance_date > today) throw new Error("The balance date can't be in the future.");
        await api('POST', `/loans/${l.id}/balance`, body);
        await reload();
        toast(`${l.name} balance updated`);
        const id = l.id;
        setTimeout(() => loanDetails(id).catch(() => {}), 0);
      },
    });
  }

  async function reviewLater(e, how) {
    const body = how === 'snooze' ? { review_snooze: addDaysIso(state.data.settings.today, 7) } : { review_date: nextReview(e.review_date), review_snooze: null };
    await api('PATCH', `/expenses/${e.id}`, body);
    await reload();
    render();
    toast(how === 'snooze' ? `We'll remind you about ${e.name} on ${fmtDate(body.review_snooze, true)}` : `${e.name} is next up for review on ${fmtDate(body.review_date, true)}`);
  }

  // A smooth line through points (monotone, so it never overshoots between two prices).
  function smoothPath(pts) {
    if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
    const n = pts.length;
    const d = []; const m = [];
    for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / ((pts[i + 1][0] - pts[i][0]) || 1));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i]; const b = m[i + 1] / d[i]; const h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    let out = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = pts[i]; const [x1, y1] = pts[i + 1]; const dx = (x1 - x0) / 3;
      out += `C${(x0 + dx).toFixed(1)},${(y0 + m[i] * dx).toFixed(1)} ${(x1 - dx).toFixed(1)},${(y1 - m[i + 1] * dx).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return out;
  }

  // A curved line of one amount over time, a point at each change (hover or tap for it), and the
  // changes listed underneath, newest first. A change set for a future date shows in orange.
  // rows: [{ on_date, value, frequency }] oldest first. future: { on_date, value, frequency } or null.
  // remove: { kind, item } adds a bin to each entry, for one added by mistake.
  function historyChart(rows, { fmt = (r) => amountText(r.value, r.frequency), costUp = true, label = 'Amount over time', future = null, remove = null } = {}) {
    if (!rows.length) return '';
    const today = state.data.settings.today;
    const day = (s) => toDate(s).getTime() / 86400000;
    const first = day(rows[0].on_date);
    const now = Math.max(day(today), day(rows.at(-1).on_date));
    const fut = future && day(future.on_date) > now ? future : null;
    const end = fut ? day(fut.on_date) + Math.max(14, (day(fut.on_date) - first) * 0.08) : now;
    const vals = [...rows.map((r) => Number(r.value)), ...(fut ? [Number(fut.value)] : [])];
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.25 || Math.abs(hi) * 0.2 || 1;
    const W = 560; const H = 120;
    const x = (d) => (end === first ? W / 2 : ((d - first) / (end - first)) * (W - 16) + 8);
    const y = (v) => 12 + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 24);
    // Hold each price until just before the next one, so the curve rises or falls at the change, not across the gap.
    const ease = (fromX, toX) => Math.min(14, (toX - fromX) / 2);
    const line = [];
    rows.forEach((r, k) => {
      const px = x(day(r.on_date));
      if (k) line.push([px - ease(line.at(-1)[0], px), line.at(-1)[1]]);
      line.push([px, y(Number(r.value))]);
    });
    if (x(now) > line.at(-1)[0] + 0.5) line.push([x(now), line.at(-1)[1]]);
    const fx = fut ? x(day(fut.on_date)) : 0;
    const futLine = fut ? [[x(now), line.at(-1)[1]], [fx - ease(x(now), fx), line.at(-1)[1]], [fx, y(Number(fut.value))], [x(end), y(Number(fut.value))]] : null;
    const diff = (r, prev) => {
      if (!prev || prev.frequency !== r.frequency) return '';
      const dv = Number(r.value) - Number(prev.value);
      if (!dv) return '';
      const up = dv > 0;
      const pct = prev.value ? ` (${up ? '+' : '−'}${Math.abs(Math.round((dv / prev.value) * 100))}%)` : '';
      return html`<span class="ph-diff ${up === costUp ? 'worse' : 'better'}">${up ? '+' : '−'}${fmt({ ...r, value: Math.abs(dv), frequency: null })}${pct}</span>`;
    };
    const dot = (r, cls = '') => {
      const [px, py] = [x(day(r.on_date)), y(Number(r.value))];
      const tip = `${fmtDate(r.on_date, true)}${cls ? ' (coming up)' : ''}\n${fmt(r)}`;
      return html`<button type="button" class="ph-pt ${cls} ${px / W > 0.6 ? 'tip-left' : ''}" style="left:${(px / W) * 100}%;top:${(py / H) * 100}%" data-tip="${tip}" aria-label="${tip.replace('\n', ': ')}"></button>`;
    };
    const changes = rows.map((r, k) => ({ r, prev: rows[k - 1] })).reverse();
    return html`<div class="ph">
      <div class="ph-box">
        <svg class="ph-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}">
          ${fut ? html`<rect x="${x(now).toFixed(1)}" y="0" width="${(W - x(now)).toFixed(1)}" height="${H}" fill="var(--firm)" opacity=".1"></rect>` : ''}
          <path d="${smoothPath(line)}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>
          ${futLine ? html`<path d="${smoothPath(futLine)}" fill="none" stroke="var(--firm)" stroke-width="2.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"></path>` : ''}
        </svg>
        <div class="ph-pts">${rows.map((r) => dot(r))}${fut ? dot(fut, 'future') : ''}</div>
        ${fut ? html`<span class="ph-today" style="left:${(x(now) / W) * 100}%">Today</span>` : ''}
      </div>
      <div class="ph-axis"><span>${fmtDate(rows[0].on_date, true)}</span><span>${fut ? fmtDate(fut.on_date, true) : 'Today'}</span></div>
      <ul class="ph-list">
        ${fut ? html`<li class="future"><span class="ph-date">${fmtDate(fut.on_date, true)}</span><span class="num">${fmt(fut)}</span>${diff(fut, rows.at(-1))}<span class="ph-diff soon">Coming up</span>
          ${remove && remove.kind === 'expense' ? binBtn(remove, { id: 'pending' }, `${fmtDate(fut.on_date, true)}: ${fmt(fut)} (coming up)`) : ''}</li>` : ''}
        ${changes.map(({ r, prev }, k) => html`<li ${k + (fut ? 1 : 0) >= SHOW_FIRST ? raw('class="more" hidden') : ''}><span class="ph-date">${fmtDate(r.on_date, true)}</span>
        <span class="num">${fmt(r)}</span>${prev ? diff(r, prev) : html`<span class="ph-diff muted">${rows.length === 1 && !fut ? 'Changes will show here' : 'First recorded'}</span>`}
        ${remove && rows.length > 1 && r.id ? binBtn(remove, r, `${fmtDate(r.on_date, true)}: ${fmt(r)}`) : ''}</li>`)}</ul>
      ${moreBtn(changes.length + (fut ? 1 : 0))}
    </div>`;
  }
  const binBtn = (remove, r, what) => html`<button type="button" class="ph-bin" data-action="history-remove" data-kind="${remove.kind}" data-item="${remove.item}"
    data-id="${r.id}" data-what="${what}" aria-label="Remove ${what}" title="Remove">${BIN_ICON}</button>`;
  // A bill's price history, with any change waiting for a future date.
  const priceHistory = (rows, e = null) => {
    const own = rows.filter((r) => r.field === 'amount_cents');
    const last = own.at(-1);
    const future = e && e.pending_from ? { on_date: e.pending_from, value: e.pending_cents, frequency: last ? last.frequency : e.frequency } : null;
    return historyChart(own, { label: 'Price over time', future, remove: e && e.id ? { kind: 'expense', item: e.id } : null });
  };

  // Fixed rates ending within 60 days (or just ended), so there's time to look at rates.
  function fixedRateNote() {
    const ending = state.data.loans.filter((l) => !l.paid_off && l.rate_type === 'fixed' && l.fixed_until)
      .map((l) => ({ l, days: daysUntil(l.fixed_until) })).filter(({ days }) => days <= 60 && days >= -14);
    return ending.map(({ l, days }) => html`<div class="card small note-banner"><span class="note-tag">Note</span>
      <span><button type="button" class="linkish" data-action="loan-details" data-id="${l.id}">${l.name}</button>'s fixed rate
      ${days < 0 ? `ended ${fmtDate(l.fixed_until, true)}` : days === 0 ? 'ends today' : `ends ${fmtDate(l.fixed_until, true)} (${days} day${days === 1 ? '' : 's'})`}.
      It'll move to the lender's variable rate, so it's worth comparing rates or asking about a new fixed term.</span></div>`);
  }

  // Bills and loan repayments with no account aren't in any deposit. Name them, and
  // send each to where it's fixed: the Loans page for loans, Expenses for the rest.
  function unassignedNote(cents) {
    const items = [
      ...state.data.expenses.filter((e) => inDeposit(e) && !e.account_id).map((e) => ({ name: e.name, action: 'edit-expense', id: e.id })),
      ...state.data.loans.filter((l) => !l.account_id && l.per_pay_cents).map((l) => ({ name: l.name, action: 'edit-loan', id: l.id })),
    ];
    const loans = items.filter((i) => i.action === 'edit-loan').length;
    const where = [items.length > loans || !items.length ? html`<a href="#/budget/expenses">Expenses</a>` : '', loans ? html`<a href="#/budget/loans">Loans</a>` : ''].filter(Boolean);
    const names = items.slice(0, 4).map((i) => html`<button type="button" class="linkish" data-action="${i.action}" data-id="${i.id}">${i.name}</button>`);
    const more = items.length > 4 ? ` and ${items.length - 4} more` : '';
    const parts = names.map((n) => n.s);
    const joined = more ? parts.join(', ') + more : parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
    const list = names.length ? raw(joined) : 'Some expenses';
    return html`<div class="card small note-banner"><span class="note-tag">Note</span>
      <span>${list} ${items.length === 1 ? "doesn't" : "don't"} have an account yet (about ${money(cents)} ${aCycle()}), so ${items.length === 1 ? "it isn't" : "they aren't"} in the deposits.
      Tap ${items.length === 1 ? 'the name' : 'a name'} to set the account, or go to ${raw(where.map((w) => w.s).join(' or '))}.</span></div>`;
  }

  // Days, weeks or cycles until a date, for the goal and debt summaries.
  const daysUntil = (date) => Math.round((toDate(date) - toDate(state.data.settings.today)) / 86400000);
  const timeLeft = (days) => (days >= 14 ? `${Math.round(days / 7)} weeks left` : `${days} day${days === 1 ? '' : 's'} left`);
  // What to put aside each cycle to reach `cents` by `date`, rounded up to the dollar.
  const perCycleTo = (cents, date) => {
    const cycles = Math.max(1, Math.ceil((daysUntil(date) * state.data.settings.pays_per_year) / 365.25));
    return Math.ceil(cents / cycles / 100) * 100;
  };

  // Open goals or debts, most pressing first: overdue, then due soonest, then the rest by progress.
  function openGoals(kind) {
    const today = state.data.settings.today;
    const rank = (g) => (g.target_date ? (g.target_date < today ? 0 : 1) : 2);
    return state.data.goals.filter((g) => !g.done && g.kind === kind && shownGoal(g))
      .sort((a, b) => rank(a) - rank(b) || (a.target_date || '').localeCompare(b.target_date || '')
        || (b.target_cents ? b.current_cents / b.target_cents : 0) - (a.target_cents ? a.current_cents / a.target_cents : 0));
  }

  // Every open goal or debt in a popup, each with its own Edit button.
  function goalListPopup(kind) {
    const list = openGoals(kind);
    const debt = kind === 'debt';
    const done = state.data.goals.filter((g) => g.done && g.kind === kind).length;
    openForm({
      title: debt ? 'Paying back' : 'Saving for',
      body: html`
        ${list.length ? html`<ul class="list goal-popup">${list.map((g) => goalRow(g, { button: true }))}</ul>` : html`<p class="empty">Nothing open.</p>`}
        <div class="row" style="justify-content:space-between;align-items:center;margin-top:12px">
          <a class="small" href="#/goals/${debt ? 'paying-back' : 'saving-for'}">${`Open ${debt ? 'Paying back' : 'Saving for'}`}${done ? ` (${done} done)` : ''}</a>
          <button type="button" class="primary" data-action="new-goal" data-kind="${kind}">Add ${debt ? 'repayment' : 'goal'}</button>
        </div>`,
    });
  }

  function goalRow(g, { button = false } = {}) {
    const left = Math.max(0, (g.target_cents || 0) - g.current_cents);
    const days = g.target_date ? daysUntil(g.target_date) : null;
    const late = days != null && days < 0;
    const debt = g.kind === 'debt';
    const firm = debt && g.target_firm;
    const started = g.current_cents > 0;
    let when;
    if (debt && g.target_date) {
      when = late
        ? html`<span class="pill bad">Overdue ${-days} day${days === -1 ? '' : 's'}${firm ? ' · firm' : ` · was due ${fmtDate(g.target_date)}`}</span>`
        : html`<span class="pill">Due ${fmtDate(g.target_date)} · ${days} day${days === 1 ? '' : 's'}${firm ? ' · firm' : ''}</span>`;
    } else if (g.target_date) {
      when = late ? html`<div class="meta neg">Overdue ${-days} day${days === -1 ? '' : 's'} · was due ${fmtDate(g.target_date, true)}</div>`
        : html`<div class="meta">By ${fmtDate(g.target_date, true)} · ${timeLeft(days)}${started && g.target_cents ? ` · ${money(g.current_cents)} of ${money(g.target_cents)} saved` : ''}</div>`;
    } else {
      // No date: still fill line 2 so every row lines up.
      const sofar = g.target_cents && started ? `${money(g.current_cents)} of ${money(g.target_cents)} ${debt ? 'paid' : 'saved'} · ` : '';
      when = debt ? html`<span class="pill">${sofar}No due date</span>` : html`<div class="meta">${sofar}No target date</div>`;
    }
    // Line 3 is always a bar or a banner of the same height, so every row is the same size.
    const nudge = (text, amount, tone = debt ? 'bad' : '') => html`<div class="nudge ${tone}"><span>${text}</span>${amount ? html`<b class="num">${amount}</b>` : ''}</div>`;
    let body;
    if (!g.target_cents) {
      body = nudge(debt ? 'No amount owing set · tap to add it' : 'No target amount set · tap to add one', '', 'plain');
    } else if (!left) {
      body = nudge(debt ? 'Paid off · tap to mark it done' : 'Target reached · tap to mark it done', '✓', 'good');
    } else if (!started) {
      if (late || (debt && !g.target_date)) body = nudge(`Nothing ${debt ? 'paid' : 'saved'} yet.${late || debt ? ` ${debt ? 'Pay' : 'Put aside'} now to clear` : ''}`, money(left));
      else if (g.target_date) body = nudge(`${debt ? 'Pay' : 'Put aside'} per ${cycleWord()} to ${debt ? 'clear by the due date' : 'hit target'}`, money(perCycleTo(left, g.target_date)));
      else body = nudge('Nothing saved yet · add a date to plan it', money(left));
    } else {
      const pct = Math.min(100, Math.round((g.current_cents / g.target_cents) * 100));
      body = html`<div class="bar-row">${progress(g.current_cents, g.target_cents, 'goal', debt ? 'var(--danger)' : 'var(--paid)')}
        <span class="meta num">${debt ? `${money(g.current_cents)} of ${money(g.target_cents)} paid` : `${pct}%`}</span></div>`;
    }
    return html`<li class="clickable goal-sum${button ? ' with-btn' : ''}" data-action="edit-goal" data-id="${g.id}">
      <div class="grow">
        <div class="dep-top"><span class="title">${g.name}${household() ? html` ${ownerTag(g)}` : ''}</span>
          <span class="dep-amt">${g.target_cents ? html`<b class="num">${money(left)}</b> <span class="muted">to go</span>` : html`<b class="num">${money(g.current_cents)}</b> <span class="muted">${debt ? 'paid' : 'saved'}</span>`}</span></div>
        <div class="goal-when">${when}</div>${body}
      </div>${button ? html`<button type="button" data-action="edit-goal" data-id="${g.id}">Edit</button>` : ''}</li>`;
  }

  // Money already put aside in open savings goals, by the account it sits in (null: no account).
  function goalSavings(goals = state.data.goals) {
    const by = new Map();
    for (const g of goals) {
      if (g.kind !== 'goal' || g.done || !(g.current_cents > 0)) continue;
      const key = g.account_id ?? null;
      const x = by.get(key) || { cents: 0, goals: [] };
      x.cents += g.current_cents;
      x.goals.push(g);
      by.set(key, x);
    }
    return by;
  }

  // Who a goal belongs to. Only shown once the household has more than one login.
  const household = () => (state.logins || []).length > 1;
  const ownerOf = (g) => (g.owner_id == null ? null : (state.logins || []).find((l) => l.id === g.owner_id) || null);
  const whoKey = () => `goal-who-${state.me ? state.me.id : ''}`;
  // 'mine' shows your own goals and shared ones; anything else shows everyone's.
  const goalWho = () => {
    if (!household()) return 'all';
    if (state.goalWho == null) { try { state.goalWho = localStorage.getItem(whoKey()) || 'all'; } catch { state.goalWho = 'all'; } }
    return state.goalWho;
  };
  const shownGoal = (g) => goalWho() !== 'mine' || g.owner_id == null || g.owner_id === state.me.id;
  function setGoalWho(who) {
    state.goalWho = who;
    try { localStorage.setItem(whoKey(), who); } catch { /* this device only, then */ }
    render();
  }
  function ownerTag(g) {
    if (!household()) return '';
    const l = ownerOf(g);
    return l ? html`<span class="g-owner" style="--who:${l.colour || 'var(--brand)'}">${l.name}</span>` : html`<span class="g-owner shared">Shared</span>`;
  }
  // A price tag with an arrow: "update the amount".
  const PRICE_ICON = raw('<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.5h5v5l-7 7-5-5z"/><circle cx="11" cy="4" r=".9" fill="currentColor" stroke="none"/><path d="M5 9.5l2.5-2.5M7.5 7v2.4M7.5 7H5.1"/></svg>');
  const BIN_ICON = raw('<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>');
  // A list cut to its first five, with a button for the rest.
  const SHOW_FIRST = 5;
  const moreBtn = (n) => (n > SHOW_FIRST ? html`<button type="button" class="linkish show-more" data-action="show-more">Show ${n - SHOW_FIRST} more</button>` : '');
  const PERSON_ICON = raw('<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="currentColor"/><path d="M2 15c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5z" fill="currentColor"/></svg>');
  // The small Overview switch between your goals and everyone's.
  const whoIcon = () => (household() ? html`<button type="button" class="who-btn ${goalWho() === 'mine' ? 'on' : ''}" data-action="goal-who" data-who="${goalWho() === 'mine' ? 'all' : 'mine'}"
    aria-pressed="${goalWho() === 'mine' ? 'true' : 'false'}" title="${goalWho() === 'mine' ? "Showing yours and shared ones. Tap to show everyone's" : 'Showing everyone\'s. Tap to show just yours'}">${PERSON_ICON}<span>${goalWho() === 'mine' ? 'Mine' : 'All'}</span></button>` : '');

  // Goals and debts that need attention: overdue or due soonest first, then the rest by progress.
  function goalsSummary() {
    if (!state.data.goals.some((g) => !g.done)) return '';
    const open = state.data.goals.filter((g) => !g.done && shownGoal(g));
    const pick = (kind) => openGoals(kind).slice(0, 3);
    const section = (kind, title) => {
      const list = pick(kind);
      const total = open.filter((g) => g.kind === kind).length;
      return html`
        <section class="card soft-${kind}">
          <div class="card-head"><h2>${title}</h2><span class="head-tools">${whoIcon()}<button type="button" class="linkish small" data-action="goal-list" data-kind="${kind}">See all${total > list.length ? ` (${total})` : ''}</button></span></div>
          ${list.length ? html`<ul class="list">${list.map((g) => goalRow(g))}</ul>` : html`<p class="empty">Nothing open.</p>`}
        </section>`;
    };
    return html`<div class="grid grid-2 overview-pair" style="margin-top:16px">${section('goal', 'Saving for')}${section('debt', 'Paying back')}</div>`;
  }

  // ---------- Analytics ----------

  // One switch drives every amount on the page: per pay cycle, month or year.
  const ANA_PERIODS = {
    cycle: { label: () => cap(cycleWord()), factor: () => 1, per: () => aCycle() },
    month: { label: () => 'Month', factor: () => state.data.settings.pays_per_year / 12, per: () => 'a month' },
    year: { label: () => 'Year', factor: () => state.data.settings.pays_per_year, per: () => 'a year' },
  };
  const anaPeriods = () => Object.keys(ANA_PERIODS).filter((p) => !(p === 'month' && state.data.settings.pay_frequency === 'monthly'));
  const anaPeriod = () => (anaPeriods().includes(state.anaPeriod) ? state.anaPeriod : 'cycle');
  const perText = () => ANA_PERIODS[anaPeriod()].per();
  const pct = (v, of) => (!of ? '' : v / of < 0.01 ? '<1%' : `${Math.round((v / of) * 100)}%`);

  async function renderAnalytics() {
    if (!state.trends) state.trends = (await api('GET', '/trends?months=12')).months;
    const months = state.trends;
    const k = ANA_PERIODS[anaPeriod()].factor();
    const sc = (v) => Math.round(v * k);
    const perPayRows = [...state.data.expenses.filter(inDeposit), ...state.data.loans.filter((l) => l.per_pay_cents)];
    const spend = perPayRows.filter((e) => kindOf(e) === 'expense' || e.show_as_expense || e.repayment_frequency);

    // Spending by category (loans count under their category, or "Loans"). These colours are shared by the cash flow and the donut.
    const byCategory = new Map();
    for (const e of spend) {
      const key = e.category_id ?? (e.repayment_frequency ? 'loans' : null);
      byCategory.set(key, (byCategory.get(key) || 0) + e.per_pay_cents);
    }
    const categorySegments = [...byCategory.entries()].sort((x, y) => y[1] - x[1]).map(([id, value]) => {
      if (id === 'loans') return { label: 'Loans', value: sc(value), color: '#64748b' };
      const i = state.data.categories.findIndex((c) => c.id === id);
      const cat = state.data.categories[i];
      return { label: cat ? cat.name : 'No category', value: sc(value), color: cat ? colorFor(cat, i) : '#94a3b8' };
    });
    const byAccount = state.data.accounts.map((a) => ({ label: a.name, value: sc(depositFor(a.id)), color: accountColor(a.id) })).filter((x) => x.value > 0);
    const top = [...spend].sort((x, y) => y.per_pay_cents - x.per_pay_cents).slice(0, 10)
      .map((e) => ({ label: e.name, value: sc(e.per_pay_cents), account: e.account_id }));

    return html`
      <div class="ana-head">
        ${overviewTabs('analytics')}
        <div class="ana-period"><span class="lbl">Show amounts per</span>
          <span class="mini-seg">${anaPeriods().map((p) => html`<button type="button" class="${p === anaPeriod() ? 'on' : ''}" data-action="ana-period" data-period="${p}">${ANA_PERIODS[p].label()}</button>`)}</span></div>
      </div>
      <section class="card ana-card">
        <div class="ana-card-head"><div><h2>Cash flow</h2><div class="ana-sub">Where the income comes from and where it goes · average ${perText()}</div></div>
          <div class="sk-readout" aria-live="polite"></div></div>
        ${sankey(categorySegments, sc)}
      </section>
      <section class="card ana-card">${yearAhead(months)}</section>
      <div class="ana-donuts">
        <section class="card ana-card">
          <div class="ana-card-head"><h2>Expenses by category</h2><span class="ana-sub">average ${perText()}</span></div>
          ${donutCard(categorySegments)}
        </section>
        <section class="card ana-card">
          <div class="ana-card-head"><h2>Deposits by account</h2><span class="ana-sub">${perText()}</span></div>
          ${donutCard(byAccount)}
        </section>
      </div>
      <section class="card ana-card">${topExpenses(top)}</section>`;
  }

  // Cash flow as a three-column flow: incomes → combined income → where it goes.
  // Income left out of the budget flows straight across to "Not budgeted".
  function sankey(categorySegments, sc) {
    const today = state.data.settings.today;
    const incomes = state.data.incomes.filter((i) => (!i.end_date || i.end_date >= today) && (!i.start_date || i.start_date <= today));
    const inBudget = incomes.filter((i) => i.include_in_budget !== 0);
    const outside = incomes.filter((i) => i.include_in_budget === 0);
    const incomeOf = (i) => sc(incomePerCycle(i));
    const income = inBudget.reduce((s, i) => s + incomeOf(i), 0);
    const savings = sc(state.data.expenses.filter((e) => inDeposit(e) && kindOf(e) === 'saving' && !e.show_as_expense).reduce((s, e) => s + e.per_pay_cents, 0));
    const spending = categorySegments.reduce((s, x) => s + x.value, 0);
    if (!income && !spending) return html`<p class="empty">Add income and expenses to see the flow.</p>`;

    const outs = categorySegments.map((x) => ({ ...x }));
    if (savings) outs.push({ label: 'Savings', value: savings, color: '#0891b2' });
    const left = income - spending - savings;
    if (left > 0) outs.push({ label: 'Left over (avg)', value: left, color: 'var(--info)' });
    const CENTRE = 'var(--paid)';
    const ins = inBudget.map((i) => ({ label: i.name, value: incomeOf(i), color: incomeColor(i) }));
    if (left < 0) ins.push({ label: 'Shortfall', value: -left, color: 'var(--danger)' });
    const otherTotal = outside.reduce((s, i) => s + incomeOf(i), 0);
    const centre = Math.max(income, spending + savings);

    // Layout in SVG units: three columns of 10px bars, bands proportional to money.
    // Phones get narrower columns and bigger text units, so the whole flow scales down to fit and stays readable.
    const compact = window.matchMedia('(max-width: 720px)').matches;
    const fs = compact ? 26 : 13; const gapY = compact ? 36 : 19; const charW = fs * (compact ? 0.6 : 0.52);
    const barW = compact ? 14 : 10; const colX = compact ? [0, 110, 220] : [0, 330, 660]; const W = colX[2] + barW;
    const TOP = compact ? 44 : 26; // room for "Combined income" above the middle bar
    const name = (t) => (compact && t.length > 13 ? `${t.slice(0, 12)}…` : t);
    const leftItems = [...ins, ...outside.map((i) => ({ label: `${i.name} (other)`, value: incomeOf(i), color: incomeColor(i), outside: true }))];
    const rightItems = [...outs, ...(otherTotal ? [{ label: 'Not budgeted', value: otherTotal, color: '#94a3b8', outside: true }] : [])];
    const H = compact ? Math.max(520, 40 * rightItems.length) : Math.max(280, 24 * rightItems.length);
    const usable = H - Math.max(14 * (leftItems.length - 1), 7 * (rightItems.length - 1));
    const scale = usable / (centre + otherTotal);
    // Stack the bars top to bottom. Each label sits level with its own bar, and labels are never closer than gapY,
    // so when small categories crowd together their bars move down with their labels instead of drifting apart.
    const stack = (items, gap) => {
      let y = TOP; let ly = -Infinity;
      return items.map((it) => {
        const v = it.value * scale; const h = Math.max(3, v);
        const mid = Math.max(y + h / 2, ly + gapY);
        const n = { ...it, y: mid - h / 2, h, v, ly: mid };
        y = n.y + h + gap; ly = mid;
        return n;
      });
    };
    const leftNodes = stack(leftItems, 14);
    const rightNodes = stack(rightItems, 7);

    const defs = [];
    const share = (v) => (income ? ` · ${((v / income) * 100).toFixed(1)}% of income` : '');
    const band = (x0, y0, h0, x1, y1, h1, from, to, label, value) => {
      const mx = (x0 + x1) / 2;
      const id = `sk-g${defs.length}`;
      defs.push(html`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x1}" y2="0">
        <stop offset="0" style="stop-color:${from}"></stop><stop offset="1" style="stop-color:${to}"></stop></linearGradient>`);
      return html`<path class="sk-band" data-readout="${label} · ${money(value)} ${perText()}${share(value)}" d="M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1 + h1} C${mx},${y1 + h1} ${mx},${y0 + h0} ${x0},${y0 + h0} Z"
        fill="url(#${id})"><title>${label}: ${money(value)}</title></path>`;
    };
    const links = [];
    let cy = TOP;
    for (const n of leftNodes.filter((x) => !x.outside)) { links.push(band(colX[0] + barW, n.y, n.h, colX[1], cy, n.v, n.color, CENTRE, n.label, n.value)); cy += n.v; }
    cy = TOP;
    for (const n of rightNodes.filter((x) => !x.outside)) { links.push(band(colX[1] + barW, cy, n.v, colX[2], n.y, n.h, CENTRE, n.color, n.label, n.value)); cy += n.v; }
    const notBudgeted = rightNodes.find((x) => x.outside);
    let oy = notBudgeted ? notBudgeted.y : 0;
    for (const n of leftNodes.filter((x) => x.outside)) { links.push(band(colX[0] + barW, n.y, n.h, colX[2], oy, n.h, n.color, '#94a3b8', n.label, n.value)); oy += n.h; }

    const rect = (x, n) => html`<rect x="${x}" y="${n.y}" width="${barW}" height="${n.h}" rx="2" fill="${n.color}"><title>${n.label}: ${money(n.value)}</title></rect>`;
    const leftLabel = (n) => html`<text x="${colX[0] - 8}" y="${n.ly}" dy=".35em" text-anchor="end" class="sk-label">${name(n.label)} <tspan class="sk-num">${money(n.value)}</tspan></text>`;
    const rightLabel = (n) => html`<text x="${colX[2] + barW + 8}" y="${n.ly}" dy=".35em" class="sk-label">${name(n.label)} <tspan class="sk-num">${money(n.value)}</tspan>${compact ? '' : html`<tspan class="sk-pct"> ${pct(n.value, income)}</tspan>`}</text>`;
    const labelW = (nodes, extra) => Math.max(60, ...nodes.map((n) => (name(n.label).length + money(n.value).length + extra) * charW + 16));
    const padL = labelW(leftNodes, 0);
    const padR = labelW(rightNodes, 4);
    const bottom = Math.max(...rightNodes.map((n) => Math.max(n.y + n.h, n.ly + fs * 0.6)), ...leftNodes.map((n) => Math.max(n.y + n.h, n.ly + fs * 0.6))) + 8;
    return html`
      <div class="sankey-wrap"><svg class="sankey${compact ? ' compact' : ''}" viewBox="${-padL} 0 ${W + padL + padR} ${bottom}" role="img" aria-label="Cash flow from income to spending">
        <defs>${defs}</defs>
        <g class="sk-bands">${links}</g>
        ${leftNodes.map((n) => rect(colX[0], n))}${leftNodes.map(leftLabel)}
        <rect x="${colX[1]}" y="${TOP}" width="${barW}" height="${centre * scale}" rx="2" fill="${CENTRE}"><title>Combined income ${money(income)}</title></rect>
        <text x="${colX[1] + barW / 2}" y="${TOP - fs * 0.8}" text-anchor="middle" class="sk-label sk-centre">${compact ? 'Combined' : 'Combined income'} <tspan class="sk-num">${money(income)}</tspan></text>
        ${rightNodes.map((n) => rect(colX[2], n))}${rightNodes.map(rightLabel)}
      </svg></div>
      <p class="ana-foot">Yearly bills are spread across the year. Hover or tap a band for its amount.</p>`;
  }

  // The next 12 months, always monthly: left over, income vs expenses, or savings.
  function yearAhead(months) {
    if (!months.length) return '';
    const view = ['left', 'ive', 'sav'].includes(state.yaView) ? state.yaView : 'left';
    const n = months.length;
    let run = 0;
    const rows = months.map((m) => { run += m.surplus_cents; return { ...m, running: run, mon: MONTHS[Number(m.month.slice(5)) - 1], monLong: MONTHS_LONG[Number(m.month.slice(5)) - 1] }; });
    // Savings start from what's already put aside in goals.
    const saved = state.data.goals.filter((g) => g.kind === 'goal' && !g.done).reduce((s, g) => s + (g.current_cents || 0), 0);
    let added = 0;
    for (const r of rows) { added += r.savings_cents; r.added = added; r.balance = saved + added; }
    const colPct = (i) => ((i + 0.5) / n) * 100;
    let bars = ''; let overlay = ''; let insight; let legend;
    const sq = (color, label) => html`<span><span class="sq" style="background:${color}"></span>${label}</span>`;
    if (view === 'sav') {
      const max = Math.max(1, ...rows.map((r) => r.balance));
      bars = rows.map((r) => html`<div class="ya-stack">
        <span class="ya-seg add" style="height:${(r.added / max) * 100}%"></span><span class="ya-seg base" style="height:${(saved / max) * 100}%"></span></div>`);
      const last = rows[n - 1];
      insight = html`<div class="ya-insight sav">Savings grow by about ${money(Math.round(last.added / n))} a month, reaching ≈ ${moneyShort(last.balance)} by ${last.monLong}, about ${moneyShort(last.added)} more than today.</div>`;
      legend = html`${sq('#155e70', 'Saved today')}${sq('#1e9bb8', 'Added from now')}`;
    } else {
      const short = rows.filter((r) => r.surplus_cents < 0).length;
      const below = rows.find((r) => r.running < 0);
      insight = below
        ? html`<div class="ya-insight bad">⚠ At this rate your running total drops below $0 in ${below.monLong}. ${short} of the next ${n} months spend more than they bring in.</div>`
        : html`<div class="ya-insight good">You stay ahead all year.${short ? ` ${short} of the next ${n} months spend more than they bring in, but earlier months cover it.` : ''}</div>`;
      if (view === 'left') {
        const lo = Math.min(0, ...rows.map((r) => Math.min(r.surplus_cents, r.running)));
        const hi = Math.max(0, ...rows.map((r) => Math.max(r.surplus_cents, r.running)));
        const y = (v) => ((hi - v) / (hi - lo || 1)) * 100;
        const zero = y(0);
        bars = rows.map((r) => {
          const top = Math.min(y(r.surplus_cents), zero); const h = Math.abs(y(r.surplus_cents) - zero);
          return html`<span class="ya-bar ${r.surplus_cents < 0 ? 'neg' : 'pos'}" style="top:${top}%;height:${Math.max(h, 0.6)}%"></span>`;
        });
        overlay = html`<div class="ya-zero" style="top:${zero}%"></div>
          <svg class="ya-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points="${rows.map((r, i) => `${colPct(i).toFixed(2)},${y(r.running).toFixed(2)}`).join(' ')}" fill="none" stroke="#79c0ff" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"></polyline></svg>`;
        legend = html`${sq('var(--paid)', 'Left over each month')}${sq('#ff7b72', 'Short')}<span><span class="ya-linekey"></span>Running total</span>`;
      } else {
        const max = Math.max(1, ...rows.map((r) => Math.max(r.income_cents, r.expenses_cents + r.savings_cents)));
        bars = rows.map((r) => html`<span class="ya-pair"><span class="ya-in" style="height:${(r.income_cents / max) * 100}%"></span><span class="ya-out" style="height:${((r.expenses_cents + r.savings_cents) / max) * 100}%"></span></span>`);
        legend = html`${sq('var(--paid)', 'Income')}${sq('#ff7b72', 'Expenses + savings')}`;
      }
    }
    const readout = (r) => (view === 'sav'
      ? `${r.mon}: savings balance ≈ ${moneyShort(r.balance)} · +${moneyShort(r.savings_cents)} this month`
      : `${r.mon}: income ${moneyShort(r.income_cents)} · expenses ${moneyShort(r.expenses_cents)} · savings ${moneyShort(r.savings_cents)} · left over ${moneyShort(r.surplus_cents)} · running total ${moneyShort(r.running)}`);
    const views = [['left', 'Left over'], ['ive', 'Income vs expenses'], ['sav', 'Savings']];
    return html`
      <div class="ana-card-head ya-head"><div><h2>The year ahead</h2><div class="ana-sub">Next 12 months, worked out from your income and bills · always monthly</div></div>
        <span class="mini-seg">${views.map(([v, t]) => html`<button type="button" class="${view === v ? 'on' : ''}" data-action="ya-view" data-view="${v}">${t}</button>`)}</span></div>
      ${insight}
      <div class="ya-legend">${legend}</div>
      <div class="ya-chart ${view}" style="--n:${n}">
        ${overlay}
        ${rows.map((r, i) => html`<div class="ya-col" data-readout="${readout(r)}">${view === 'left' ? bars[i] : view === 'ive' ? bars[i] : bars[i]}</div>`)}
      </div>
      <div class="ya-months" style="--n:${n}">${rows.map((r) => html`<div class="ya-month" data-readout="${readout(r)}"><span class="m-long">${r.mon}</span><span class="m-short">${r.mon[0]}</span>
        <b class="num ${view === 'sav' ? 'sav' : r.surplus_cents < 0 ? 'neg' : 'pos'}">${moneyShort(view === 'sav' ? r.balance : r.surplus_cents)}</b></div>`)}</div>
      <p class="ya-readout" aria-live="polite">Hover or tap a month for its figures.</p>`;
  }

  // A ring with the total in the middle and a legend beside it.
  function donutCard(segments) {
    const total = segments.reduce((s, x) => s + x.value, 0);
    if (!total) return html`<p class="empty">Nothing to show yet.</p>`;
    let at = 0;
    const stops = segments.filter((s) => s.value > 0).map((s) => { const from = at; at += (s.value / total) * 360; return `${s.color} ${from.toFixed(2)}deg ${at.toFixed(2)}deg`; });
    return html`<div class="dn-wrap">
      <div class="dn-ring" style="background:conic-gradient(${stops.join(', ')})"><div class="dn-hole"><b class="num">${money(total)}</b><span>${perText()}</span></div></div>
      <ul class="dn-legend">${segments.map((s) => html`<li><span class="sq" style="background:${s.color}"></span><span class="dn-name" title="${s.label}">${s.label}</span>
        <b class="num">${money(s.value)}</b><span class="dn-pct num">${pct(s.value, total)}</span></li>`)}</ul></div>`;
  }

  function topExpenses(rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    const ids = [...new Set(rows.map((r) => r.account ?? null))];
    const legend = ids.map((id) => { const a = account(id); return html`<span><span class="dot" style="background:${a ? accountColor(a.id) : 'var(--muted)'}"></span>${a ? a.name : 'No account'}</span>`; });
    return html`
      <div class="ana-card-head"><div><h2>Top expenses</h2><div class="ana-sub">Biggest ${rows.length} bills, ${perText()} equivalent</div></div><div class="te-legend">${legend}</div></div>
      ${rows.length ? html`<ul class="te-list">${rows.map((r) => html`<li><span class="te-name" title="${r.label}">${r.label}</span>
        <span class="te-track"><span style="width:${((r.value / max) * 100).toFixed(1)}%;background:${r.account ? accountColor(r.account) : 'var(--muted)'}"></span></span>
        <b class="num">${money(r.value)}</b></li>`)}</ul>` : html`<p class="empty">Nothing to show yet.</p>`}
      <a class="te-more" href="#/budget/expenses">See all in Expenses →</a>`;
  }

  // Hover or tap: a band in the cash flow, or a month in the year ahead, shows its figures.
  function readoutFor(el) {
    const band = el.closest && el.closest('.sk-band');
    if (band) {
      const svg = band.closest('svg');
      svg.querySelectorAll('.sk-band.on').forEach((b) => b.classList.remove('on'));
      band.classList.add('on');
      svg.classList.add('hovering');
      const out = svg.closest('.ana-card').querySelector('.sk-readout');
      if (out) out.textContent = band.dataset.readout;
      return true;
    }
    const col = el.closest && el.closest('.ya-col, .ya-month');
    if (col) {
      const card = col.closest('.ana-card');
      const i = [...col.parentElement.children].filter((c) => c.matches('.ya-col, .ya-month')).indexOf(col);
      card.querySelectorAll('.ya-col').forEach((c, j) => c.classList.toggle('on', j === i));
      card.querySelector('.ya-readout').textContent = col.dataset.readout;
      return true;
    }
    return false;
  }
  // The cash flow lays itself out differently on phones, so redraw it when the width crosses over.
  window.matchMedia('(max-width: 720px)').addEventListener('change', () => { if (document.querySelector('svg.sankey')) render(); });
  document.addEventListener('mouseover', (ev) => readoutFor(ev.target));
  document.addEventListener('click', (ev) => readoutFor(ev.target));
  document.addEventListener('mouseout', (ev) => {
    const svg = ev.target.closest && ev.target.closest('svg.sankey');
    if (svg && !svg.contains(ev.relatedTarget)) {
      svg.classList.remove('hovering');
      svg.querySelectorAll('.sk-band.on').forEach((b) => b.classList.remove('on'));
      const out = svg.closest('.ana-card').querySelector('.sk-readout');
      if (out) out.textContent = '';
    }
    const chart = ev.target.closest && ev.target.closest('.ya-chart, .ya-months');
    if (chart && !chart.contains(ev.relatedTarget)) {
      const card = chart.closest('.ana-card');
      card.querySelectorAll('.ya-col.on').forEach((c) => c.classList.remove('on'));
      card.querySelector('.ya-readout').textContent = 'Hover or tap a month for its figures.';
    }
  });

  const moneyShort = (cents) => {
    const v = cents / 100;
    const sign = v < 0 ? '−' : '';
    const a = Math.abs(v);
    return `${sign}$${a >= 10000 ? `${Math.round(a / 1000)}k` : a >= 1000 ? `${(a / 1000).toFixed(1)}k` : Math.round(a)}`;
  };

  function showAccountDetails(id) {
    const a = account(id);
    if (!a) return;
    const line = (label, value) => (value ? html`<li><div class="grow"><div class="meta">${label}</div><div class="title num">${value}</div></div>
      <button type="button" data-copy="${value}" data-label="${label}">Copy</button></li>` : '');
    const btns = { edit: { label: 'Edit account', action: 'edit-account', id: a.id } };
    openForm({
      title: null,
      noActions: true,
      body: html`
        ${popHead(a.name, btns)}
        <ul class="list">
          ${line('BSB', a.bsb)}
          ${line('Account number', a.account_number)}
          ${a.bsb && a.account_number ? line('BSB and account', `${a.bsb} ${a.account_number}`) : ''}
        </ul>
        <p class="muted small">${[a.institution, a.type, a.owner && `Owner: ${a.owner}`].filter(Boolean).join(' · ')}</p>
        ${!a.bsb && !a.account_number ? html`<p>No bank details saved yet.</p>` : ''}
        ${popFoot(btns)}`,
    });
  }

  // ---------- Expenses ----------

  const KIND_TEXT = {
    expense: { title: 'Expenses', one: 'expense', items: 'bills', search: 'Search name, payee, category', none: 'No bills yet. Add your first one.' },
    saving: { title: 'Savings', one: 'saving', items: 'savings', search: 'Search savings…', none: 'No savings yet. Add a regular amount to put aside, and it\'s added to that account\'s deposit.' },
  };
  const kindOf = (e) => e.kind || 'expense';

  // Rough number of budget cycles until a saving reaches its goal.
  function savingGoalText(e) {
    if (!e.goal_cents) return '';
    const perPay = e.per_pay_exact_cents;
    if (!perPay) return `Goal ${money(e.goal_cents)}`;
    const n = Math.ceil(e.goal_cents / perPay);
    return `Goal ${money(e.goal_cents)} · about ${n} ${cycleWord()}${n === 1 ? '' : 's'} at this rate`;
  }
  const isSplit = (e) => e.yearly_cents !== null && e.yearly_cents !== undefined;

  // A small switch, e.g. All / To pay / Paid. Tapping sets state[key].
  const segButtons = (key, options, label) => html`<div class="seg" role="group" aria-label="${label}">${options.map(([v, text]) => html`
    <button type="button" data-action="set-filter" data-key="${key}" data-value="${v}" class="${(state[key] || '') === v ? 'on' : ''}" aria-pressed="${(state[key] || '') === v ? 'true' : 'false'}">${text}</button>`)}</div>`;
  // Account chips with their colour dots. Tap one to show only that account; tap it again (or All) for every account.
  const accountChips = (key, accounts, withNone = false) => html`<div class="acct-chips" role="group" aria-label="Filter by account">
    <button type="button" class="acct-chip ${state[key] ? '' : 'on'}" data-action="set-filter" data-key="${key}" data-value="" aria-pressed="${state[key] ? 'false' : 'true'}">All accounts</button>
    ${accounts.map((a) => { const on = state[key] === String(a.id); return html`<button type="button" class="acct-chip ${on ? 'on' : ''}" style="--chip:${accountColor(a.id)}"
      data-action="set-filter" data-key="${key}" data-value="${on ? '' : a.id}" aria-pressed="${on ? 'true' : 'false'}"><span class="dot" style="background:${accountColor(a.id)}"></span>${a.name}</button>`; })}
    ${withNone ? html`<button type="button" class="acct-chip ${state[key] === 'none' ? 'on' : ''}" data-action="set-filter" data-key="${key}" data-value="${state[key] === 'none' ? '' : 'none'}">No account</button>` : ''}</div>`;

  // Whether an active expense next comes out today, by the end of this cycle, or within 30 days.
  function dueWithin(e, when) {
    const { today, cycle_end: cycleEnd } = state.data.settings;
    if (!e.active || !e.next_date) return false;
    const last = when === 'today' ? today : when === 'cycle' ? cycleEnd : addDaysIso(today, Number(when));
    return e.next_date <= last;
  }

  // What one bill costs and how often: "$79 / month". Spread yearly amounts show the year.
  const FREQ_UNIT = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month', bimonthly: '2 months', quarterly: 'quarter', semiannual: '6 months', yearly: 'year' };
  const billAmount = (e) => (isSplit(e) ? [e.yearly_cents, 'year'] : [e.amount_cents, FREQ_UNIT[e.frequency] || e.frequency]);
  // Shown only when it differs from the bill itself (a fortnightly bill on a fortnightly pay).
  const showsPerCycle = (e) => isSplit(e) || e.frequency !== state.data.settings.pay_frequency;

  // "Due today", "Tomorrow", "In 3 days" for the next week; the date gets its year when it's far off.
  function relDue(date) {
    const days = daysUntil(date);
    const label = days === 0 ? ['Due today', 'today'] : days === 1 ? ['Tomorrow', 'soon'] : days >= 2 && days <= 3 ? [`In ${days} days`, 'soon']
      : days >= 4 && days <= 6 ? [`In ${days} days`, 'week'] : null;
    return { label, date: fmtDate(date, days > 180), days };
  }
  const relDueHtml = (date) => {
    const r = relDue(date);
    return html`${r.label ? html`<span class="rel ${r.label[1]}">${r.label[0]}</span> · ` : ''}<span class="rel-date">${r.date}</span>`;
  };
  // A dot by the schedule: green when the bill comes out this pay, blue next pay, faint grey after that.
  function dueDot(e) {
    if (isSplit(e) && e.active) return html`<i class="due-dot later" title="Put aside each ${cycleWord()}" role="img" aria-label="Put aside each ${cycleWord()}"></i>`;
    if (!e.active || !e.next_date) return html`<i class="due-dot none" aria-hidden="true"></i>`;
    const st = state.data.settings;
    const [cls, tip] = e.next_date <= st.cycle_end ? ['now', `Due ${thisCycle()}`] : e.next_date <= st.next_cycle_end ? ['next', `Due next ${cycleWord()}`] : ['later', 'Not due for a while'];
    return html`<i class="due-dot ${cls}" title="${tip}" role="img" aria-label="${tip}"></i>`;
  }
  // The short schedule for the table: "Monthly on the 14th", "Weekly on Tue", "Fortnightly, wk 1 Thu".
  function shortSchedule(e) {
    const off = e.day_offset ?? 0;
    if (e.frequency === 'weekly') return `Weekly on ${weekdayFor(off)}`;
    if (e.frequency === 'fortnightly') return `Fortnightly, wk ${off < 7 ? 1 : 2} ${weekdayFor(off)}`;
    return scheduleText(e);
  }

  // Collapsed expense groups, remembered on this device.
  const collapsedGroups = () => { try { return new Set(JSON.parse(localStorage.getItem('collapsed-groups') || '[]')); } catch { return new Set(); } };
  function toggleGroup(key) {
    const set = collapsedGroups();
    if (set.has(key)) set.delete(key); else set.add(key);
    try { localStorage.setItem('collapsed-groups', JSON.stringify([...set])); } catch { /* not remembered */ }
    render();
  }

  const EXPENSE_SORTS = {
    due: (a, b) => (a.active && a.next_date ? a.next_date : '9999').localeCompare(b.active && b.next_date ? b.next_date : '9999') || a.name.localeCompare(b.name),
    amount: (a, b) => b.per_pay_cents - a.per_pay_cents || a.name.localeCompare(b.name),
    az: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  };

  // A compact filter: "Account: All accounts ▾", a real <select> underneath so phones show their own picker.
  // Filter dropdowns draw their own menu, so the list matches the app on every browser (Windows ignores styling on a native list).
  const dropdown = (key, label, options) => {
    const cur = state[key] || '';
    const shown = (options.find(([v]) => v === cur) || options[0])[1];
    return html`<div class="dd" data-dd="${key}">
      <button type="button" class="dd-btn" data-action="dd-open" aria-haspopup="listbox" aria-expanded="false" aria-label="${label}: ${shown}">
        <span class="dd-lbl">${label}:</span> <b>${shown}</b></button>
      <ul class="dd-menu" role="listbox" aria-label="${label}" hidden>${options.map(([v, t]) => html`<li><button type="button" role="option" aria-selected="${v === cur ? 'true' : 'false'}"
        data-action="dd-pick" data-key="${key}" data-value="${v}">${t}</button></li>`)}</ul></div>`;
  };
  function closeDropdowns() {
    document.querySelectorAll('.dd-menu:not([hidden])').forEach((m) => { m.hidden = true; m.parentElement.querySelector('.dd-btn').setAttribute('aria-expanded', 'false'); });
  }
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.dd')) closeDropdowns(); }, true);
  // Escape closes, and the arrow keys move through the open list.
  document.addEventListener('keydown', (ev) => {
    const dd = ev.target.closest && ev.target.closest('.dd');
    if (!dd) return;
    const menu = dd.querySelector('.dd-menu');
    if (ev.key === 'Escape' && !menu.hidden) { closeDropdowns(); dd.querySelector('.dd-btn').focus(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(ev.key)) return;
    ev.preventDefault();
    if (menu.hidden) { dd.querySelector('.dd-btn').click(); return; }
    const opts = [...menu.querySelectorAll('[role=option]')];
    const i = opts.indexOf(document.activeElement);
    opts[Math.max(0, Math.min(opts.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))].focus();
  });

  // Every row on the Expenses or Savings tab, and the ones the search and filters leave.
  function expenseRows(kind) {
    const q = state.expenseQuery.toLowerCase();
    // Savings ticked "Include in expenses" are listed on the Expenses tab too.
    const all = state.data.expenses.filter((e) => kindOf(e) === kind || (kind === 'expense' && e.show_as_expense));
    const list = all.filter((e) => {
      if (state.expenseAccount && String(e.account_id ?? 'none') !== state.expenseAccount) return false;
      if (state.expenseWhen && !dueWithin(e, state.expenseWhen)) return false;
      if (!q) return true;
      const hay = [e.name, payee(e.payee_id)?.name, category(e.category_id)?.name, subcategory(e.subcategory_id)?.name, e.notes, e.reference].join(' ').toLowerCase();
      return hay.includes(q);
    }).sort(EXPENSE_SORTS[state.expenseSort || 'due']);
    const accounts = state.data.accounts.filter((a) => all.some((e) => e.account_id === a.id));
    return { all, list, accounts, noAccount: all.some((e) => e.account_id == null) };
  }
  const EXPENSE_FILTERS = {
    expenseAccount: '', expenseWhen: '', expenseGroup: '', expenseSort: 'due',
  };
  const expenseWhenOptions = () => [['', 'Any time'], ['today', 'Today'], ['cycle', `This ${cycleWord()}`], ['30', 'Next 30 days']];
  // How many filters differ from the defaults (the search box aside).
  const filtersOn = () => Object.entries(EXPENSE_FILTERS).filter(([key, def]) => (state[key] || def) !== def).length;

  // Phones: the filters live in a bottom sheet of chips, applied as they're tapped.
  function expenseFilterSheet(kind) {
    const { list, accounts, noAccount } = expenseRows(kind);
    const chip = (key, value, text, color) => {
      const on = (state[key] || EXPENSE_FILTERS[key]) === value;
      return html`<button type="button" class="sheet-chip ${on ? 'on' : ''}" aria-pressed="${on ? 'true' : 'false'}" data-action="sheet-filter" data-kind="${kind}" data-key="${key}" data-value="${value}">${color ? html`<span class="dot" style="background:${color}"></span>` : ''}${text}</button>`;
    };
    const group = (label, chips) => html`<div class="sheet-group"><div class="sheet-label">${label}</div><div class="sheet-chips">${chips}</div></div>`;
    const n = list.length;
    openForm({
      title: 'Filters',
      noActions: true,
      body: html`
        <button type="button" class="linkish sheet-reset" data-action="sheet-reset" data-kind="${kind}">Reset</button>
        ${group('Account', [chip('expenseAccount', '', 'All accounts'), ...accounts.map((a) => chip('expenseAccount', String(a.id), a.name, accountColor(a.id))),
          ...(noAccount ? [chip('expenseAccount', 'none', 'No account', 'var(--muted)')] : [])])}
        ${group('Due', expenseWhenOptions().map(([v, t]) => chip('expenseWhen', v, t)))}
        ${group('Group by', [chip('expenseGroup', '', 'Account'), chip('expenseGroup', 'category', 'Category')])}
        ${group('Sort', [chip('expenseSort', 'due', 'Next due'), chip('expenseSort', 'amount', 'Amount'), chip('expenseSort', 'az', 'A–Z')])}
        <div class="sheet-foot"><button type="button" class="primary sheet-done" data-modal="cancel">Show ${n} ${n === 1 ? KIND_TEXT[kind].items.replace(/s$/, '') : KIND_TEXT[kind].items}</button></div>`,
    });
  }

  function renderExpenses(kind = 'expense') {
    const k = KIND_TEXT[kind];
    const sortBy = state.expenseSort || 'due';
    const byCategory = state.expenseGroup === 'category';
    const { all, list, accounts, noAccount } = expenseRows(kind);
    const perCycle = (items) => items.filter(inDeposit).reduce((s, e) => s + e.per_pay_cents, 0);

    const groups = (byCategory
      ? [...state.data.categories.map((c) => ({ id: c.id, name: c.name })), { id: null, name: 'No category' }]
        .map((g, i) => ({ ...g, color: g.id == null ? 'var(--muted)' : colorFor(state.data.categories[i], i), items: list.filter((e) => (e.category_id ?? null) === g.id) }))
      : [...state.data.accounts.map((a) => ({ id: a.id, name: a.name, color: accountColor(a.id), deposit: kind === 'expense' ? depositFor(a.id) : null })),
        { id: null, name: 'No account', color: 'var(--muted)' }]
        .map((g) => ({ ...g, items: list.filter((e) => (e.account_id ?? null) === g.id) })))
      .filter((g) => g.items.length)
      .map((g) => ({ ...g, key: `${kind}:${byCategory ? 'cat' : 'acct'}:${g.id ?? 'none'}`, total: perCycle(g.items) }));
    const collapsed = collapsedGroups();
    const total = perCycle(list);
    const word = cycleWord();
    const count = (n) => `${n} ${n === 1 ? k.items.replace(/s$/, '') : k.items}`;

    const nameLine = (e) => html`<span class="b-name">${e.name}</span>${payee(e.payee_id) ? html`<span class="b-payee"> · ${payee(e.payee_id).name}</span>` : ''}${e.active ? '' : html` <span class="chip">Paused</span>`}${kind === 'saving' && e.show_as_expense ? html` <span class="chip">In expenses</span>` : ''}${kind === 'expense' && kindOf(e) === 'saving' ? html` <span class="chip">Savings</span>` : ''}${untilTag(e)}${e.pending_from ? html` <span class="chip pending" title="New amount from ${fmtDate(e.pending_from, true)}">${money(e.pending_cents)} from ${dateNear(e.pending_from)}</span>` : ''}`;
    const updBtn = (e) => html`<button type="button" class="upd-amt" data-action="update-amount" data-id="${e.id}" data-tip="Update amount" aria-label="Update the amount of ${e.name}">${PRICE_ICON}</button>`;
    const amountHtml = (e) => { const [c, unit] = billAmount(e); return html`<b class="num">${money(c)}</b> <span class="unit">/ ${unit}</span>`; };
    const dueHtml = (e) => (e.active && e.next_date ? relDueHtml(e.next_date) : html`<span class="rel-date">${e.active ? '' : 'Paused'}</span>`);
    const isToday = (e) => e.active && e.next_date === state.data.settings.today;

    // Phones and tablets: a card per group, two lines per bill, one coloured bar down the group.
    const cards = html`<div class="exp-cards">${groups.map((g) => {
      const shut = collapsed.has(g.key);
      return html`<section class="card exp-group ${shut ? 'shut' : ''}">
        <button type="button" class="exp-ghead" data-action="toggle-group" data-key="${g.key}" aria-expanded="${shut ? 'false' : 'true'}">
          <span class="dot" style="background:${g.color}"></span><span class="g-name">${g.name}</span><span class="g-count">${count(g.items.length)}</span>
          <span class="g-right num ${g.deposit != null && g.total > g.deposit ? 'over' : ''}" title="${g.deposit != null ? `Deposit ${money(g.deposit)} ${aCycle()}` : ''}">${money(g.total)}</span><span class="chev">${shut ? '▸' : '▾'}</span></button>
        ${shut ? '' : html`<ul class="exp-rows" style="--acct:${g.color}">${g.items.map((e) => html`
          <li class="clickable ${e.active ? '' : 'paused'}" data-action="edit-expense" data-id="${e.id}">
            <div class="grow"><div class="b-line1">${nameLine(e)}</div>
              <div class="b-line2">${dueDot(e)}${e.active && e.next_date ? relDueHtml(e.next_date) : e.active ? FREQ_LABELS[e.frequency] : 'Paused'}${kindOf(e) === 'saving' && savingGoalText(e) ? ` · ${savingGoalText(e)}` : ''}</div></div>
            <div class="right"><div>${updBtn(e)}${amountHtml(e)}</div>${showsPerCycle(e) ? html`<div class="b-line2 num">≈ ${money(e.per_pay_cents)} ${aCycle()}</div>` : ''}</div>
          </li>`)}</ul>`}
      </section>`;
    })}</div>`;

    // Desktop: a table, sortable by its headings, with each group in its own tile under the pinned headings.
    const sortHead = (key, text, cls = '') => html`<button type="button" class="th ${cls} ${sortBy === key ? 'on' : ''}" data-action="set-filter" data-key="expenseSort" data-value="${key}">${text}${sortBy === key ? ' ↓' : ''}</button>`;
    const head = html`<div class="exp-tr exp-th" role="row">${sortHead('az', k.one === 'saving' ? 'Saving' : 'Bill')}<span class="th">Schedule</span>${sortHead('due', 'Next due')}${sortHead('amount', 'Amount', 'r')}<span class="th r">Per ${word}</span></div>`;
    const table = html`<div class="exp-table" role="table">
      ${groups.map((g) => {
        const shut = collapsed.has(g.key);
        return html`<section class="card exp-tile ${shut ? 'shut' : ''}" role="rowgroup">
          <div class="exp-tr exp-tg" role="row" data-action="toggle-group" data-key="${g.key}" aria-expanded="${shut ? 'false' : 'true'}">
          <span class="g-cell"><span class="chev">${shut ? '▸' : '▾'}</span><span class="dot" style="background:${g.color}"></span><span class="g-name">${g.name}</span><span class="g-count">${count(g.items.length)}</span></span>
          <span class="g-dep r">${g.deposit != null ? `${money(g.deposit)} deposit` : ''}</span>
          <span class="r g-total ${g.deposit != null && g.total > g.deposit ? 'over' : ''}">${money(g.total)}</span></div>
          ${shut ? '' : g.items.map((e) => html`<div class="exp-tr exp-td clickable ${isToday(e) ? 'today' : ''} ${e.active ? '' : 'paused'}" role="row" style="--acct:${g.color}" data-action="edit-expense" data-id="${e.id}">
            <span class="b-cell">${nameLine(e)}</span>
            <span class="sched">${dueDot(e)}${isSplit(e) ? `${money(e.yearly_cents)} a year, spread` : shortSchedule(e)}</span>
            <span>${dueHtml(e)}</span>
            <span class="r">${updBtn(e)}${amountHtml(e)}</span>
            <span class="r per num">${money(e.per_pay_cents)}</span></div>`)}
        </section>`;
      })}
      <div class="card exp-tile"><div class="exp-tr exp-tt" role="row"><span>Total</span><span class="r num">${money(total)}</span></div></div>
    </div>`;

    return html`
      <div class="exp-mpin"><div class="exp-mtools">
        <label class="exp-search-wrap"><span class="ico" aria-hidden="true">⌕</span><input type="search" class="exp-search" placeholder="Search" value="${state.expenseQuery}" data-input="expense-query" aria-label="Search"></label>
        <button type="button" class="filters-btn ${filtersOn() ? 'on' : ''}" data-action="expense-filters" data-kind="${kind}">Filters${filtersOn() ? html` <span class="tab-count">${filtersOn()}</span>` : ''}</button>
      </div>
      <p class="exp-mcount">${count(list.length)} · about ${money(Math.round(total))} ${aCycle()}</p></div>
      <div class="exp-pin"><div class="card exp-shell">
        <div class="exp-tools">
          <label class="exp-search-wrap"><span class="ico" aria-hidden="true">⌕</span><input type="search" class="exp-search" placeholder="${k.search}" value="${state.expenseQuery}" data-input="expense-query" aria-label="Search"></label>
          ${dropdown('expenseAccount', 'Account', [['', 'All accounts'], ...accounts.map((a) => [String(a.id), a.name]), ...(noAccount ? [['none', 'No account']] : [])])}
          ${dropdown('expenseWhen', 'Due', expenseWhenOptions())}
          ${dropdown('expenseGroup', 'Group by', [['', 'Account'], ['category', 'Category']])}
          ${dropdown('expenseSort', 'Sort by', [['due', 'Next due'], ['amount', 'Amount'], ['az', 'A–Z']])}
          <button type="button" class="exp-reset" data-action="expense-reset" ${filtersOn() || state.expenseQuery ? '' : raw('disabled')} title="Clear the search and filters">↺ Reset</button>
                  </div>
        <div class="exp-count">${count(list.length)} · about ${money(Math.round(total))} ${aCycle()}</div>
        ${groups.length ? head : html`<p class="empty">${all.length ? `No ${k.items} match.` : k.none}</p>`}
      </div></div>
      ${groups.length ? html`${table}${cards}` : ''}
      ${kind === 'saving' ? savingsGoalsCard() : ''}`;
  }

  // Savings tab: the goals that have money in them, under the account they're saved in.
  function savingsGoalsCard() {
    const by = goalSavings();
    if (!by.size) return '';
    const order = [...state.data.accounts.map((a) => a.id), null].filter((id) => by.has(id));
    return html`<section class="card sv-goals">
      <div class="card-head"><div><h2>Goals with money saved</h2><div class="muted head-sub">By the account they're saved in · <a href="#/goals/saving-for">Open Goals</a></div></div></div>
      ${order.map((id) => {
        const a = id != null && account(id);
        const x = by.get(id);
        return html`<div class="sv-acct" style="--acct:${a ? accountColor(a.id) : 'var(--muted)'}">
          <div class="sv-acct-head"><span class="dot"></span><b>${a ? a.name : 'No account'}</b><span class="sv-total num">${money(x.cents)} saved</span></div>
          <ul class="sv-list">${x.goals.map((g) => html`<li><span class="grow">${g.name}</span>
            ${g.target_cents ? html`<span class="sv-bar">${progress(g.current_cents, g.target_cents, 'goal', 'var(--paid)')}</span>` : ''}
            <span class="num sv-amt">${money(g.current_cents)}${g.target_cents ? html`<span class="muted"> of ${money(g.target_cents)}</span>` : ''}</span></li>`)}</ul>
        </div>`;
      })}
    </section>`;
  }

  function scheduleFields(e) {
    const f = e.frequency || 'monthly';
    if (f === 'weekly' || f === 'fortnightly') {
      const n = f === 'weekly' ? 7 : 14;
      const opts = Array.from({ length: n }, (_, i) => html`<option value="${i}" ${i === (e.day_offset ?? 0) % n ? raw('selected') : ''}>${f === 'fortnightly' ? `Week ${i < 7 ? 1 : 2}, ` : ''}${weekdayFor(i, true)}</option>`);
      return html`<div class="field full"><label for="f-offset">Comes out on</label><select id="f-offset" name="day_offset">${opts}</select>
        <div class="hint">Week 1 starts on pay day (${weekdayFor(0, true)}).</div></div>`;
    }
    const days = Array.from({ length: 31 }, (_, i) => html`<option value="${i + 1}" ${i + 1 === (e.day_of_month || 1) ? raw('selected') : ''}>${ordinal(i + 1)}</option>`);
    const dayField = html`<div class="field"><label for="f-dom">Day of the month</label><select id="f-dom" name="day_of_month">${days}</select>
      <div class="hint">Short months use their last day.</div></div>`;
    if (f === 'monthly') return dayField;
    const months = MONTHS_LONG.map((m, i) => html`<option value="${i + 1}" ${i + 1 === (e.start_month || 1) ? raw('selected') : ''}>${m}</option>`);
    return html`${dayField}<div class="field"><label for="f-month">${f === 'yearly' ? 'Month' : 'One of the months it comes out'}</label>
      <select id="f-month" name="start_month">${months}</select></div>`;
  }

  function expenseForm(e = { frequency: 'monthly', active: 1 }, newKind = 'expense') {
    const subs = (catId) => category(catId)?.subcategories || [];
    const kind = e.id ? kindOf(e) : newKind;
    openForm({
      title: e.id ? `Edit ${KIND_TEXT[kind].one}` : `Add ${KIND_TEXT[kind].one}`,
      body: html`
        <div class="fields">
          <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" value="${e.name || ''}" placeholder="${kind === 'saving' ? 'e.g. Emergency fund' : 'e.g. Internet'}" required></div>
          <div class="field"><label for="f-kind">Type</label><select id="f-kind" name="kind">
            <option value="expense" ${kind === 'expense' ? raw('selected') : ''}>Expense</option>
            <option value="saving" ${kind === 'saving' ? raw('selected') : ''}>Savings</option></select></div>
          <div class="field full only-saving" ${kind === 'saving' ? '' : raw('hidden')}><label for="f-mode">How much</label><select id="f-mode" name="mode">
            <option value="regular" ${isSplit(e) ? '' : raw('selected')}>A regular amount</option>
            <option value="yearly" ${isSplit(e) ? raw('selected') : ''}>A yearly target</option></select></div>
          <div class="field full only-yearly" ${kind === 'saving' && isSplit(e) ? '' : raw('hidden')}><label for="f-yearly">Save each year ($)</label>
            <input id="f-yearly" name="yearly" inputmode="decimal" value="${moneyInput(e.yearly_cents)}" placeholder="e.g. 1000"><div class="hint" id="f-yearly-hint"></div></div>
          <div class="field only-regular" ${kind === 'saving' && isSplit(e) ? raw('hidden') : ''}><label for="f-amount">Amount ($)</label><input id="f-amount" name="amount" inputmode="decimal" value="${isSplit(e) ? '' : moneyInput(e.amount_cents)}" placeholder="0.00"></div>
          <div class="field only-regular" ${kind === 'saving' && isSplit(e) ? raw('hidden') : ''}><label for="f-freq">How often</label><select id="f-freq" name="frequency">
            ${Object.entries(FREQ_LABELS).map(([k, v]) => html`<option value="${k}" ${k === e.frequency ? raw('selected') : ''}>${v}</option>`)}</select></div>
          <div class="fields full only-regular" id="schedule" style="gap:0 12px" ${kind === 'saving' && isSplit(e) ? raw('hidden') : ''}>${scheduleFields(e)}</div>
          <div class="field full only-saving" ${kind === 'saving' ? '' : raw('hidden')}><label for="f-goal">Savings goal ($, optional)</label>
            <input id="f-goal" name="goal" inputmode="decimal" value="${moneyInput(e.goal_cents)}">
            <div class="hint">Shows roughly how many ${cycleWord()}s it takes to get there.</div></div>
          <div class="field full only-saving" ${kind === 'saving' ? '' : raw('hidden')}><label class="check"><input type="checkbox" name="show_as_expense" ${e.show_as_expense ? raw('checked') : ''}> Include in expenses</label>
            <div class="hint">Savings always go in the account's deposit. Tick this to also list it with the expenses each ${cycleWord()}.</div></div>
          <div class="field full"><label for="f-account" data-label-expense="Paid from account" data-label-saving="Saved into account">${kind === 'saving' ? 'Saved into account' : 'Paid from account'}</label>
            <div class="with-add"><select id="f-account" name="account_id">${options(state.data.accounts, e.account_id)}</select>
            <button type="button" class="icon" data-add="account" aria-label="New account">+</button></div></div>
          <div class="field full only-expense" ${kind === 'expense' ? '' : raw('hidden')}><label for="f-payee">Payee</label>
            <div class="with-add"><select id="f-payee" name="payee_id">${options(state.data.payees, e.payee_id)}</select>
            <button type="button" class="icon" data-add="payee" aria-label="New payee">+</button></div></div>
          <div class="field only-expense" ${kind === 'expense' ? '' : raw('hidden')}><label for="f-cat">Category</label>
            <div class="with-add"><select id="f-cat" name="category_id">${options(state.data.categories, e.category_id)}</select>
            <button type="button" class="icon" data-add="category" aria-label="New category">+</button></div></div>
          <div class="field only-expense" ${kind === 'expense' ? '' : raw('hidden')}><label for="f-sub">Sub category</label>
            <div class="with-add"><select id="f-sub" name="subcategory_id">${options(subs(e.category_id), e.subcategory_id)}</select>
            <button type="button" class="icon" data-add="subcategory" aria-label="New sub category">+</button></div></div>
          <div class="field only-expense" ${kind === 'expense' ? '' : raw('hidden')}><label for="f-ref">Reference / customer no.</label><input id="f-ref" name="reference" value="${e.reference || ''}"></div>
          <div class="field"><label for="f-notes">Notes</label><input id="f-notes" name="notes" value="${e.notes || ''}"></div>
          <div class="field only-expense" ${kind === 'expense' ? '' : raw('hidden')}><label for="f-review">Price review (optional)</label><input id="f-review" type="date" name="review_date" value="${e.review_date || ''}">
            <div class="hint">When it usually changes, like an insurance renewal. The Overview reminds you once it passes.</div></div>
          ${temporaryField(e)}
          <div class="field full"><label class="check"><input type="checkbox" name="active" ${e.active ? raw('checked') : ''}> Active (untick to pause without deleting)</label></div>
          ${e.id ? html`<div class="full ph-slot"></div>` : ''}
        </div>`,
      onSave: async (form) => {
        const saving = val(form, 'kind') === 'saving';
        const review = saving ? null : val(form, 'review_date') || null;
        const yearly = saving && val(form, 'mode') === 'yearly' ? moneyVal(form, 'yearly', 'Yearly amount', { required: true }) : null;
        const body = {
          name: val(form, 'name'),
          amount_cents: yearly ?? moneyVal(form, 'amount', 'Amount', { required: true }),
          frequency: yearly != null ? 'yearly' : val(form, 'frequency'),
          yearly_cents: yearly,
          show_as_expense: saving && form.elements.show_as_expense.checked,
          ...temporaryVal(form),
          day_offset: idVal(form, 'day_offset'),
          day_of_month: idVal(form, 'day_of_month'),
          start_month: idVal(form, 'start_month'),
          account_id: idVal(form, 'account_id'),
          payee_id: idVal(form, 'payee_id'),
          category_id: idVal(form, 'category_id'),
          subcategory_id: idVal(form, 'subcategory_id'),
          reference: val(form, 'reference'),
          notes: val(form, 'notes'),
          active: form.elements.active.checked,
          kind: val(form, 'kind'),
          goal_cents: val(form, 'kind') === 'saving' ? moneyVal(form, 'goal', 'Savings goal') : null,
          review_date: review,
        };
        // A new review date starts afresh, without any "remind me later".
        if (review !== (e.review_date || null)) body.review_snooze = null;
        if (!body.name) throw new Error('Please give it a name.');
        await (e.id ? api('PATCH', `/expenses/${e.id}`, body) : api('POST', '/expenses', body));
        await reload();
        toast(body.kind === 'saving' ? 'Saving saved' : 'Expense saved');
      },
      onDelete: e.id ? async () => { await api('DELETE', `/expenses/${e.id}`); await reload(); toast('Deleted'); } : null,
      afterRender: (form) => {
        if (e.id) {
          api('GET', `/history/expense/${e.id}`).then((rows) => {
            const slot = form.querySelector('.ph-slot');
            if (slot && rows.length) slot.innerHTML = html`<h3 class="ph-title">Price history</h3>${priceHistory(rows, e)}`.s;
          }).catch(() => {});
        }
        // Switching between expense and savings (and regular or yearly savings) shows the fields that fit.
        const showMode = () => {
          const yearly = form.elements.kind.value === 'saving' && form.elements.mode.value === 'yearly';
          form.querySelectorAll('.only-regular').forEach((el) => { el.hidden = yearly; });
          form.querySelectorAll('.only-yearly').forEach((el) => { el.hidden = !yearly; });
          const cents = parseMoney(form.elements.yearly.value);
          form.querySelector('#f-yearly-hint').textContent = cents > 0
            ? `About ${money(Math.round(cents / state.data.settings.pays_per_year))} ${aCycle()}, added to the account's deposit.` : `Split evenly across each ${cycleWord()}.`;
        };
        form.elements.mode.addEventListener('change', showMode);
        form.elements.yearly.addEventListener('input', showMode);
        showMode();
        form.elements.kind.addEventListener('change', () => {
          const k = form.elements.kind.value;
          form.querySelectorAll('.only-expense').forEach((el) => { el.hidden = k !== 'expense'; });
          form.querySelectorAll('.only-saving').forEach((el) => { el.hidden = k !== 'saving'; });
          showMode();
          const label = form.querySelector('label[for="f-account"]');
          label.textContent = label.dataset[k === 'saving' ? 'labelSaving' : 'labelExpense'];
          form.querySelector('h2').textContent = `${e.id ? 'Edit' : 'Add'} ${KIND_TEXT[k].one}`;
        });
        const freq = form.elements.frequency;
        freq.addEventListener('change', () => {
          const current = { frequency: freq.value, day_offset: idVal(form, 'day_offset'), day_of_month: idVal(form, 'day_of_month'), start_month: idVal(form, 'start_month') };
          form.querySelector('#schedule').innerHTML = scheduleFields(current).s;
        });
        const cat = form.elements.category_id;
        const sub = form.elements.subcategory_id;
        cat.addEventListener('change', () => { sub.innerHTML = options(subs(Number(cat.value))).s; });
        form.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', async () => {
          const kind = btn.dataset.add;
          const labels = { account: 'account', payee: 'payee', category: 'category', subcategory: 'sub category' };
          if (kind === 'subcategory' && !cat.value) return toast('Pick a category first');
          const name = await askText(`New ${labels[kind]}`, 'Name');
          if (!name) return;
          // Already have one with that name? Pick it rather than making a duplicate.
          const pool = { account: state.data.accounts, payee: state.data.payees, category: state.data.categories, subcategory: subs(Number(cat.value)) }[kind];
          const same = pool.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (same) {
            const select = { account: form.elements.account_id, payee: form.elements.payee_id, category: cat, subcategory: sub }[kind];
            select.value = String(same.id);
            select.dispatchEvent(new Event('change'));
            return toast(`${same.name} already exists, so it's been picked`);
          }
          try {
            const path = { account: '/accounts', payee: '/payees', category: '/categories', subcategory: '/subcategories' }[kind];
            const created = await api('POST', path, kind === 'subcategory' ? { name, category_id: Number(cat.value) } : { name });
            await reload();
            if (kind === 'account') form.elements.account_id.innerHTML = options(state.data.accounts, created.id).s;
            if (kind === 'payee') form.elements.payee_id.innerHTML = options(state.data.payees, created.id).s;
            if (kind === 'category') { cat.innerHTML = options(state.data.categories, created.id).s; sub.innerHTML = options([]).s; }
            if (kind === 'subcategory') sub.innerHTML = options(subs(Number(cat.value)), created.id).s;
            toast(`Added ${name}`);
          } catch (err) {
            form.querySelector('#form-error').textContent = err.message;
          }
        }));
      },
    });
  }

  // ---------- Goals and debts ----------

  const KIND = {
    goal: { title: 'Goals', one: 'goal', target: 'Target amount', current: 'Saved so far', of: 'saved of' },
    debt: { title: 'Paying back', one: 'repayment', target: 'Total owed', current: 'Paid off so far', of: 'paid of' },
  };

  // Goal and debt categories: the saved ones plus any name a goal uses.
  function goalGroups(kind) {
    const names = new Map();
    for (const gr of state.data.goal_groups.filter((x) => x.kind === kind)) names.set(gr.name.toLowerCase(), gr.name);
    for (const g of state.data.goals.filter((x) => x.kind === kind && x.group_name)) {
      if (!names.has(g.group_name.toLowerCase())) names.set(g.group_name.toLowerCase(), g.group_name);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  const findGroup = (kind, name) => name && state.data.goal_groups.find((x) => x.kind === kind && x.name.toLowerCase() === name.toLowerCase());
  function groupColor(kind, name) {
    if (!name) return '#94a3b8';
    const saved = findGroup(kind, name);
    if (saved && saved.color) return saved.color;
    const i = goalGroups(kind).findIndex((n) => n.toLowerCase() === name.toLowerCase());
    return PALETTE[Math.max(0, i) % PALETTE.length];
  }

  // Short cycle unit for "$305 / fn".
  const CYCLE_SHORT = { week: 'wk', fortnight: 'fn', month: 'mo' };
  const cycleShort = () => CYCLE_SHORT[cycleWord()] || 'pay';
  const goalLeft = (g) => (g.done ? 0 : Math.max(0, (g.target_cents || 0) - g.current_cents));
  // A date in this year leaves the year off.
  const dateNear = (s) => fmtDate(s, s.slice(0, 4) !== state.data.settings.today.slice(0, 4));
  // Due now: overdue, or due within 14 days, with money still to find.
  const goalDueNow = (g) => !g.done && g.target_date && goalLeft(g) > 0 && daysUntil(g.target_date) <= 14;
  // What to put aside each cycle to make the date: what's left spread over the pay cycles until then, rounded up to the dollar.
  function goalPerCycle(g) {
    const left = goalLeft(g);
    if (!left || !g.target_date || goalDueNow(g)) return 0;
    const cycles = Math.max(1, Math.ceil((daysUntil(g.target_date) * state.data.settings.pays_per_year) / 365.25));
    return Math.ceil(left / cycles / 100) * 100;
  }
  // Paying back gets a red count when something is overdue or due within 3 days.
  // 'bad' when a repayment is overdue, 'soon' when one is due within 3 days, otherwise nothing.
  const debtPressing = () => {
    const open = state.data.goals.filter((g) => g.kind === 'debt' && !g.done && g.target_date && goalLeft(g) > 0);
    if (open.some((g) => daysUntil(g.target_date) < 0)) return 'bad';
    if (open.some((g) => daysUntil(g.target_date) <= 3)) return 'soon';
    return '';
  };

  // One chip for the date, merging overdue and firm.
  function goalStatusChip(g) {
    if (!g.target_date) return '';
    const days = daysUntil(g.target_date);
    const firm = g.kind === 'debt' && g.target_firm ? ' · firm' : '';
    const d = dateNear(g.target_date);
    if (g.done || (g.target_cents && !goalLeft(g))) return html`<span class="g-chip">By ${d}${firm}</span>`;
    if (days < 0) return html`<span class="g-chip late">Overdue ${-days} day${days === -1 ? '' : 's'} · was ${d}${firm}</span>`;
    if (days <= 3) return html`<span class="g-chip soon">${days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`} · ${d}${firm}</span>`;
    return html`<span class="g-chip">By ${d} · ${days < 60 ? `${days} days` : `${Math.round(days / 7)} weeks`}${firm}</span>`;
  }

  function goalNextStep(g) {
    const debt = g.kind === 'debt';
    const left = goalLeft(g);
    if (!g.target_cents) return html`<div class="g-next muted">No ${debt ? 'amount owing' : 'target amount'} set. Edit it to add one</div>`;
    if (!left) return html`<div class="g-next good">${debt ? 'Fully paid' : 'Fully saved'}</div>`;
    if (!g.target_date) return html`<div class="g-next muted">No target date. Add one to get a suggested amount</div>`;
    const days = daysUntil(g.target_date);
    if (days < 0) return html`<div class="g-next bad">Needs ${money(left)} now</div>`;
    if (days <= 14) return html`<div class="g-next soon">Needs ${money(left)} by ${dateNear(g.target_date)}</div>`;
    return html`<div class="g-next ok">Put aside ${money(goalPerCycle(g))} ${aCycle()} to make it</div>`;
  }

  function goalItem(g) {
    const debt = g.kind === 'debt';
    const acct = g.account_id && account(g.account_id);
    const left = goalLeft(g);
    return html`
      <li class="g-item" data-goal="${g.id}">
        <div class="g-main clickable" data-action="edit-goal" data-id="${g.id}">
          <div class="g-name">${g.name}${g.notes ? html`<span class="g-note"> · ${g.notes}</span>` : ''}</div>
          <div class="g-chips">${ownerTag(g)}${goalStatusChip(g)}
            ${acct ? html`<span class="g-acct"><span class="dot" style="background:${accountColor(acct.id)}"></span>${acct.name}</span>` : ''}
            ${debt && g.start_date ? html`<span class="g-started">Started ${fmtDate(g.start_date, true)}</span>` : ''}</div>
          <div class="g-progress">
            ${g.target_cents ? progress(g.current_cents, g.target_cents, 'goal g-bar') : ''}
            <span class="num">${g.target_cents ? `${money(g.current_cents)} of ${money(g.target_cents)} ${debt ? 'paid' : 'saved'}` : `${money(g.current_cents)} ${debt ? 'paid' : 'saved'}`}</span>
          </div>
          ${goalNextStep(g)}
        </div>
        <div class="g-side">
          <div class="g-left">${g.target_cents ? html`<b class="num">${money(left)}</b> <span>to go</span>` : html`<b class="num">${money(g.current_cents)}</b> <span>${debt ? 'paid' : 'saved'}</span>`}</div>
          <div class="g-actions">
            <button type="button" class="g-add" data-action="goal-panel" data-id="${g.id}" data-mode="add">+ Add</button>
            <button type="button" class="g-more" data-action="goal-menu" data-id="${g.id}" aria-label="More options for ${g.name}" aria-haspopup="menu">⋯</button>
            <div class="g-menu" role="menu" hidden>
              <div class="g-menu-title">${g.name}</div>
              <button type="button" role="menuitem" data-action="goal-panel" data-id="${g.id}" data-mode="remove">Remove money</button>
              <button type="button" role="menuitem" data-action="toggle-goal" data-id="${g.id}">Mark done</button>
              <button type="button" role="menuitem" data-action="edit-goal" data-id="${g.id}">Edit</button>
              <button type="button" role="menuitem" class="danger-text" data-action="delete-goal" data-id="${g.id}">Delete</button>
            </div>
          </div>
        </div>
        <div class="g-panel-slot"></div>
      </li>`;
  }

  const doneOpen = () => { try { return localStorage.getItem('goals-done-open') === '1'; } catch { return false; } };

  function renderGoals(kind) {
    const k = KIND[kind];
    const debt = kind === 'debt';
    const everyone = state.data.goals.filter((g) => g.kind === kind);
    const all = everyone.filter(shownGoal);
    const items = all.filter((g) => !g.done);
    const done = all.filter((g) => g.done);
    const groups = new Map();
    for (const name of goalGroups(kind)) groups.set(name.toLowerCase(), { name, list: [] });
    groups.set('', { name: null, list: [] });
    for (const g of items) groups.get((g.group_name || '').toLowerCase()).list.push(g);
    const sections = [...groups.values()].filter((gr) => gr.list.length);

    const target = items.reduce((s, g) => s + (g.target_cents || 0), 0);
    const current = items.reduce((s, g) => s + Math.min(g.current_cents || 0, g.target_cents || g.current_cents || 0), 0);
    const left = items.reduce((s, g) => s + goalLeft(g), 0);
    const perCycle = items.reduce((s, g) => s + goalPerCycle(g), 0);
    const dueNow = items.filter(goalDueNow);
    const dueNowTotal = dueNow.reduce((s, g) => s + goalLeft(g), 0);

    const summary = html`<div class="g-stats">
      <div class="card g-stat"><div class="g-stat-lbl">${debt ? 'Paid back' : 'Saved'}</div><div class="g-stat-val num ${debt ? 'paid-back' : 'saved'}">${money(current)}</div>
        <div class="g-stat-sub">of ${money(target)} · ${target ? Math.round((current / target) * 100) : 0}%</div></div>
      <div class="card g-stat"><div class="g-stat-lbl">${debt ? 'Still owed' : 'Still to go'}</div><div class="g-stat-val num owed">${money(left)}</div>
        <div class="g-stat-sub">across ${items.length} item${items.length === 1 ? '' : 's'}</div></div>
      <div class="card g-stat"><div class="g-stat-lbl">To stay on track</div><div class="g-stat-val num track">${money(perCycle)} / ${cycleShort()}</div>
        <div class="g-stat-sub ${dueNow.length ? 'soon' : ''}">${dueNow.length ? `plus ${money(dueNowTotal)} due now (${dueNow.map((g) => g.name).join(', ')})` : 'covers every dated item'}</div></div>
    </div>`;

    // Saving for: what's saved in each account, so it can be checked against the bank.
    const byAccount = debt ? new Map() : goalSavings(items);
    const acctStrip = byAccount.size ? html`<div class="card g-accts"><span class="g-accts-lbl">Saved by account</span>
      ${[...byAccount.entries()].map(([id, x]) => {
        const a = id != null && account(id);
        return html`<span class="g-acct-total" title="${x.goals.map((g) => `${g.name}: ${money(g.current_cents)}`).join('\n')}"><span class="dot" style="background:${a ? accountColor(a.id) : 'var(--muted)'}"></span>${a ? a.name : 'No account'} <b class="num">${money(x.cents)}</b></span>`;
      })}</div>` : '';

    const groupCards = sections.map(({ name, list }) => {
      const color = groupColor(kind, name);
      const groupLeft = list.reduce((s, g) => s + goalLeft(g), 0);
      return html`
        <section class="card g-group g-${kind}">
          <div class="g-group-head">
            ${name ? html`<button class="group-btn" data-action="edit-goal-group" data-kind="${kind}" data-name="${name}" title="Rename or change colour">
                <span class="g-dot" style="background:${color}"></span><h2>${name}</h2></button>`
              : html`<span class="group-btn"><span class="g-dot" style="background:${color}"></span><h2>No category</h2></span>`}
            <span class="g-count">${list.length} item${list.length === 1 ? '' : 's'}</span>
            <span class="g-group-left num">${money(groupLeft)} ${debt ? 'owed' : 'to go'}</span>
          </div>
          <ul class="g-items" style="border-left-color:${color}">${list.map(goalItem)}</ul>
        </section>`;
    });

    const completed = done.length ? html`
      <section class="card g-done ${doneOpen() ? 'open' : ''}">
        <button type="button" class="g-done-head" data-action="toggle-goals-done" aria-expanded="${doneOpen() ? 'true' : 'false'}">
          <span class="g-tick">✓</span><h2>Completed</h2><span class="g-count">${done.length}</span><span class="g-chev" aria-hidden="true">▸</span></button>
        ${doneOpen() ? html`<ul class="g-done-list">${done.map((g) => html`<li>
          <span class="g-dot" style="background:${groupColor(kind, g.group_name)}"></span>
          <span class="g-done-name">${g.name}</span>
          <span class="g-done-meta">${g.group_name || 'No category'} · ${money(g.target_cents || g.current_cents)} ${debt ? 'paid' : 'saved'}</span>
          <button type="button" class="linkish" data-action="toggle-goal" data-id="${g.id}">Undo</button></li>`)}</ul>` : ''}
      </section>` : '';

    const hidden = everyone.filter((g) => !g.done).length - items.length;
    const whoBar = household() ? html`<div class="g-who"><span class="mini-seg" role="group" aria-label="Whose ${k.title.toLowerCase()}">
        <button type="button" class="${goalWho() === 'mine' ? 'on' : ''}" data-action="goal-who" data-who="mine" aria-pressed="${goalWho() === 'mine' ? 'true' : 'false'}">${PERSON_ICON} Mine</button>
        <button type="button" class="${goalWho() !== 'mine' ? 'on' : ''}" data-action="goal-who" data-who="all" aria-pressed="${goalWho() !== 'mine' ? 'true' : 'false'}">Everyone's</button></span>
      ${hidden ? html`<span class="muted small">Hiding ${hidden} of ${[...new Set(everyone.filter((g) => !shownGoal(g)).map((g) => (ownerOf(g) || {}).name))].join(' and ')}'s</span>` : ''}</div>` : '';

    return html`
      ${whoBar}
      ${items.length || done.length ? summary : ''}
      ${acctStrip}
      ${items.length ? groupCards : html`<div class="card"><p class="empty">${done.length ? 'Everything here is done.' : `No ${k.title.toLowerCase()} yet.`}</p></div>`}
      ${completed}`;
  }

  // The inline panel under an item: add money (or record a payment), or take money out.
  function openGoalPanel(g, mode) {
    closeGoalMenus();
    document.querySelectorAll('.g-panel').forEach((p) => p.remove());
    const li = document.querySelector(`.g-item[data-goal="${g.id}"]`);
    if (!li) return;
    const debt = g.kind === 'debt';
    const left = goalLeft(g);
    const chips = [];
    if (mode === 'add') {
      const per = goalPerCycle(g);
      if (per > 0) chips.push([per, `${money(per)} (suggested)`]);
      if (left > 0 && left !== per) chips.push([left, `${money(left)} (all)`]);
    }
    const title = mode === 'remove' ? 'Remove money' : debt ? 'Record a payment' : 'Add to savings';
    li.querySelector('.g-panel-slot').innerHTML = html`
      <div class="g-panel" data-id="${g.id}" data-mode="${mode}">
        <span class="g-panel-title">${title}</span>
        <label class="g-amount"><span>$</span><input type="text" inputmode="decimal" aria-label="${title} amount" autocomplete="off"></label>
        ${chips.map(([cents, label]) => html`<button type="button" class="g-quick" data-action="goal-quick" data-cents="${cents}">${label}</button>`)}
        <span class="g-panel-gap"></span>
        <button type="button" class="linkish g-cancel" data-action="goal-panel-cancel">Cancel</button>
        <button type="button" class="primary g-save" data-action="goal-panel-save">Save</button>
      </div>`.s;
    li.querySelector('.g-panel input').focus();
  }

  async function saveGoalPanel(panel) {
    const g = state.data.goals.find((x) => x.id === Number(panel.dataset.id));
    if (!g || panel.dataset.busy) return; // a double tap would add the money twice
    panel.dataset.busy = '1';
    try { await saveGoalChange(panel, g); } finally { delete panel.dataset.busy; }
  }

  async function saveGoalChange(panel, g) {
    const input = panel.querySelector('input');
    const cents = parseMoney(input.value);
    if (Number.isNaN(cents) || !cents || cents < 0) { input.focus(); throw new Error('Enter an amount, like 100.'); }
    const sign = panel.dataset.mode === 'remove' ? -1 : 1;
    // Never below nothing, and never past the target.
    const max = g.target_cents || Infinity;
    const next = Math.max(0, Math.min(max, g.current_cents + sign * cents));
    const change = next - g.current_cents;
    if (change) await api('POST', `/goals/${g.id}/adjust`, { amount_cents: change });
    await reload();
    await render();
    const debt = g.kind === 'debt';
    if (!change) toast(sign > 0 ? `${g.name} is already ${debt ? 'fully paid' : 'fully saved'}.` : `Nothing to take out of ${g.name}.`);
    else if (g.target_cents && next >= g.target_cents) toast(`${g.name} has reached its ${debt ? 'total' : 'target'}!`);
    else toast(`${change > 0 ? (debt ? 'Paid' : 'Added') : 'Took out'} ${money(Math.abs(change))}. Now ${money(next)} ${debt ? 'paid off' : 'saved'}.`);
  }

  function closeGoalMenus() {
    document.querySelectorAll('.g-menu:not([hidden])').forEach((m) => { m.hidden = true; });
    document.querySelectorAll('.g-more[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    document.body.classList.remove('g-sheet-open');
  }
  // Clicking outside an open ⋯ menu, or pressing Escape, closes it. Escape also closes the inline panel.
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.g-menu, .g-more')) closeGoalMenus();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (document.querySelector('.g-menu:not([hidden])')) closeGoalMenus();
      else if (ev.target.closest && ev.target.closest('.g-panel')) ev.target.closest('.g-panel').remove();
    }
    if (ev.key === 'Enter' && ev.target.closest && ev.target.closest('.g-panel input')) {
      ev.preventDefault();
      if (ev.repeat) return;
      saveGoalPanel(ev.target.closest('.g-panel')).catch((err) => toast(err.message));
    }
  });

  function goalForm(kind, g = { kind, current_cents: 0 }) {
    const k = KIND[kind];
    const accounts = state.data.accounts;
    openForm({
      title: g.id ? `Edit ${k.one}` : `Add ${k.one}`,
      body: html`
        <div class="fields">
          <div class="field full"><label for="g-name">Name</label><input id="g-name" name="name" value="${g.name || ''}" required></div>
          <div class="full pick-row"><div class="field"><label for="g-group">Category</label>
            ${combo({ id: 'g-group', name: 'group_name', value: g.group_name || '', options: goalGroups(kind), placeholder: 'Pick or type a new one' })}</div>
          <div class="field color-field"><label for="g-color">Colour</label><input id="g-color" type="color" name="group_color" value="${g.group_name ? groupColor(kind, g.group_name) : PALETTE[goalGroups(kind).length % PALETTE.length]}"></div></div>
          <div class="field"><label for="g-target">${k.target} ($)</label><input id="g-target" name="target" inputmode="decimal" value="${moneyInput(g.target_cents)}"></div>
          <div class="field"><label for="g-current">${k.current} ($)</label><input id="g-current" name="current" inputmode="decimal" value="${moneyInput(g.current_cents)}"></div>
          ${kind === 'goal' ? html`
          <div class="field full"><label for="g-account">Saved in account (optional)</label><select id="g-account" name="account_id">${options(accounts, g.account_id)}</select></div>` : ''}
          ${kind === 'debt' ? html`
          <div class="field"><label for="g-start">Started (optional)</label><input id="g-start" type="date" name="start_date" value="${g.start_date || ''}">
            <div class="hint">When the debt began.</div></div>
          <div class="field"><label for="g-date">Pay off by (optional)</label><input id="g-date" type="date" name="target_date" value="${g.target_date || ''}"></div>
          <div class="field full"><label class="check"><input type="checkbox" name="target_firm" ${g.target_firm ? raw('checked') : ''}> Firm date (it must be paid off by then)</label></div>`
          : html`
          <div class="field full"><label for="g-date">Aim for (optional)</label><input id="g-date" type="date" name="target_date" value="${g.target_date || ''}">
            <div class="hint">The date you'd like to reach this goal.</div></div>`}
          ${household() ? html`<div class="field full"><label for="g-owner">Whose is it?</label><select id="g-owner" name="owner_id">
            <option value="">Shared</option>${state.logins.map((l) => html`<option value="${l.id}" ${(g.id ? g.owner_id === l.id : l.you) ? raw('selected') : ''}>${l.name}${l.you ? ' (you)' : ''}</option>`)}</select></div>` : ''}
          <div class="field full"><label for="g-notes">Notes</label><textarea id="g-notes" name="notes" rows="2">${g.notes || ''}</textarea></div>
          <div class="field full"><label class="check"><input type="checkbox" name="done" ${g.done ? raw('checked') : ''}> Done</label></div>
        </div>`,
      afterRender: (form) => {
        // Show the picked category's colour.
        const sync = () => {
          const existing = findGroup(kind, form.elements.group_name.value.trim());
          if (existing) form.elements.group_color.value = groupColor(kind, existing.name);
        };
        form.elements.group_name.addEventListener('change', sync);
        form.elements.group_name.addEventListener('input', sync);
      },
      onSave: async (form) => {
        const body = {
          kind, name: val(form, 'name'), group_name: val(form, 'group_name') || null, notes: val(form, 'notes'),
          target_cents: moneyVal(form, 'target', k.target), current_cents: moneyVal(form, 'current', k.current) ?? 0,
          done: form.elements.done.checked,
          target_date: val(form, 'target_date') || null,
        };
        if (kind === 'goal') body.account_id = idVal(form, 'account_id');
        if (form.elements.owner_id) body.owner_id = form.elements.owner_id.value === '' ? null : Number(form.elements.owner_id.value);
        if (kind === 'debt') {
          body.start_date = val(form, 'start_date') || null;
          body.target_firm = form.elements.target_firm.checked;
          if (body.start_date && body.target_date && body.target_date < body.start_date) throw new Error('The pay off date is before the start date.');
        }
        if (!body.name) throw new Error('Please give it a name.');
        // A new category, or a new colour for one, is saved with the goal.
        if (body.group_name) body.group_color = val(form, 'group_color');
        await (g.id ? api('PATCH', `/goals/${g.id}`, body) : api('POST', '/goals', body));
        await reload();
      },
      onDelete: g.id ? async () => { await api('DELETE', `/goals/${g.id}`); await reload(); } : null,
    });
  }

  function goalGroupForm(kind, name) {
    const existing = findGroup(kind, name);
    const count = state.data.goals.filter((g) => g.kind === kind && (g.group_name || '').toLowerCase() === name.toLowerCase()).length;
    openForm({
      title: 'Edit category',
      body: html`
        <div class="fields">
          <div class="full pick-row"><div class="field"><label for="gg-name">Name</label><input id="gg-name" name="name" value="${name}" required></div>
          <div class="field color-field"><label for="gg-color">Colour</label><input id="gg-color" type="color" name="color" value="${groupColor(kind, name)}"></div></div>
        </div>
        <p class="hint">${count} ${KIND[kind].one}${count === 1 ? '' : 's'} in this category. Deleting it keeps them, without a category.</p>`,
      onSave: async (form) => {
        const newName = val(form, 'name');
        if (!newName) throw new Error('Please give the category a name.');
        const body = { name: newName, color: val(form, 'color') };
        if (existing) {
          await api('PATCH', `/goal_groups/${existing.id}`, body);
        } else {
          // A category that only existed as a name on its goals: save it, and its goals move with it.
          await api('POST', '/goal_groups', { kind, ...body, from_name: name });
        }
        await reload();
      },
      onDelete: async () => {
        if (existing) {
          await api('DELETE', `/goal_groups/${existing.id}`);
        } else {
          await api('POST', '/goal_groups/clear', { kind, name });
        }
        await reload();
      },
    });
  }

  // ---------- Loans ----------

  const LOAN_FREQ = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' };
  const LOAN_PER_YEAR = { weekly: 52, fortnightly: 26, monthly: 12 };
  const termText = (months) => (months ? `${Math.floor(months / 12) ? `${Math.floor(months / 12)} yr` : ''}${months % 12 ? ` ${months % 12} mo` : ''}`.trim() : '');

  function renderLoans() {
    const loans = state.data.loans;
    const active = loans.filter((l) => !l.paid_off);
    const owed = active.reduce((s, l) => s + (l.estimated_balance_cents ?? l.balance_cents ?? l.principal_cents ?? 0), 0);
    const perCycle = active.filter((l) => l.include_in_budget !== 0).reduce((s, l) => s + (l.per_pay_cents || 0), 0);
    const interestLeft = active.reduce((s, l) => s + (l.estimated_interest_left_cents || 0), 0);
    const stat = (label, value, color, sub) => html`<div class="card loan-stat"><div class="label">${label}</div><div class="value num" style="color:${color}">${value}</div><div class="sub">${sub}</div></div>`;
    return html`
      ${active.length ? html`<div class="loan-stats">
        ${stat('Still owed', money(owed), 'var(--danger)', `across ${active.length} loan${active.length === 1 ? '' : 's'} · estimate`)}
        ${stat('Budgeted repayments', money(perCycle), 'var(--link)', `${aCycle()}, feeds into deposits`)}
        ${stat('Interest still to come', `~${money(interestLeft)}`, 'var(--due)', 'if you keep budgeting as now')}
      </div>` : ''}
      ${loans.length ? html`${loans.map(loanCard)}
        <p class="tab-hint loan-note">Balances, pay-off dates and interest are estimates. Update the balance from your statement now and then to keep them close.
          <button type="button" class="linkish" data-action="update-balances">Update balances</button></p>`
        : html`<div class="card"><p class="empty">No loans yet. Add a mortgage, car loan or personal loan to track its repayments.</p></div>`}
      ${loanCalculator()}`;
  }

  // One loan: what it is, how it's paid, and paid vs still to pay.
  function loanCard(l) {
    const a = account(l.account_id);
    const bal = l.estimated_balance_cents;
    const sch = l.scheduled;
    const bud = l.budgeted;
    const unit = (r) => html` <span class="unit">/ ${FREQ_UNIT[r.frequency]}</span>`;
    const cell = (label, value, sub, cls = '') => html`<div class="lc-cell"><div class="lc-label">${label}</div><div class="lc-value num">${value}</div><div class="lc-sub ${cls}">${sub}</div></div>`;
    const when = (r) => (!r.date ? '' : r.frequency === 'monthly' ? `On the ${ordinal(Number(r.date.slice(8)))}` : `From ${fmtDate(r.date)}`);
    const diff = bud.per_month_cents - sch.per_month_cents;
    let budSub = html`Same as the bank`; let budCls = '';
    if (bud.custom) {
      budSub = html`${when(bud)}${diff ? ` · ${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}/month ${diff > 0 ? 'extra' : 'less'}` : ''}`;
      budCls = diff > 0 ? 'good' : diff < 0 ? 'bad' : '';
    }
    const end = l.end_date;
    const { text: offSub, cls: offCls } = payoffVsEnd(l);
    return html`<section class="card loan-card clickable ${l.paid_off ? 'is-done' : ''}" data-action="loan-details" data-id="${l.id}">
      <div class="lc-head">
        <div class="lc-title">
          <div class="lc-name"><b>${l.name}</b>${l.lender ? html`<span class="muted"> · ${l.lender}</span>` : ''}</div>
          <div class="lc-chips">
            ${a ? html`<span class="lc-chip"><span class="dot" style="background:${accountColor(a.id)}"></span>${a.name}</span>` : ''}
            ${l.interest_rate != null ? html`<span class="lc-chip">${l.interest_rate}% p.a.</span>` : ''}
            ${l.term_months ? html`<span class="lc-chip soft">${termText(l.term_months)}${end ? ` · ends ${fmtDate(end, true)}` : ''}</span>` : ''}
            ${l.include_in_budget === 0 ? html`<span class="lc-chip soft">Not in the budget</span>` : ''}
            ${l.paid_off ? html`<span class="lc-chip soft">Paid off</span>` : ''}
          </div>
        </div>
        <div class="lc-right">
          <span class="lc-btns">${l.paid_off ? '' : popBtn('upd', { label: 'Update balance', action: 'update-balance', id: l.id })}
            ${popBtn('edit', { label: 'Edit', action: 'edit-loan', id: l.id })}${popBtn('del', { label: 'Delete', action: 'delete-loan', id: l.id })}</span>
          ${bal != null ? html`<div class="lc-bal"><div class="num">${money(bal)}</div><div class="muted">left to pay</div></div>` : ''}
        </div>
      </div>
      <div class="lc-strip">
        ${cell('Bank takes', html`${money(sch.amount_cents)}${unit(sch)}`, `${when(sch)}${l.repayment_cents == null ? ' · calculated' : ''}`)}
        ${cell('You budget', html`${money(bud.amount_cents)}${unit(bud)}`, budSub, budCls)}
        ${cell('Paid off around', l.estimated_payoff_date ? fmtDate(l.estimated_payoff_date, true) : '—', offSub, offCls)}
      </div>
      ${loanBar(l)}
      ${l.notes ? html`<div class="meta note" style="margin-top:10px"><b>Note:</b> ${l.notes}</div>` : ''}
    </section>`;
  }



  // Pay-off date against the loan's own end date: "About 2 years early", "On schedule" or late.
  function payoffVsEnd(l) {
    const end = l.end_date;
    if (!l.estimated_payoff_date || !end) return { text: '', cls: '' };
    const months = Math.round((toDate(end) - toDate(l.estimated_payoff_date)) / (86400000 * 30.44));
    const span = (m) => (m >= 24 ? `About ${Math.round(m / 12)} years` : `${m} month${m === 1 ? '' : 's'}`);
    if (Math.abs(months) <= 1) return { text: 'On schedule', cls: '' };
    return months > 0 ? { text: `${span(months)} early`, cls: 'good' } : { text: `${span(-months)} late`, cls: 'bad' };
  }

  const monthIdx = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
  const monthName = (i) => `${MONTHS[i % 12]} ${Math.floor(i / 12)}`;
  const spanText = (m) => [Math.floor(m / 12) ? `${Math.floor(m / 12)} yr${Math.floor(m / 12) === 1 ? '' : 's'}` : '', m % 12 ? `${m % 12} mo` : ''].filter(Boolean).join(' ') || 'Under a month';

  // Balance over time: your plan (history plus projection), the bank's schedule from today, and with extra.
  function loanChart(l, extraPoints) {
    const t = l.timeline;
    if (!t || t.points.length < 2) return '';
    const today = state.data.settings.today;
    const todayI = monthIdx(today) + (Number(today.slice(8)) - 1) / 30;
    const at = (d) => monthIdx(d) + (Number(d.slice(8)) - 1) / 30;
    // With a statement balance, the plan runs from the start ignoring it, and the actual path goes
    // through each balance entered, then on at today's repayments.
    const planned = l.plan && l.plan.points.length > 1;
    const plan = (planned ? l.plan.points : t.points.map((p) => [p.month, p.balance_cents])).map(([m, v]) => [monthIdx(m), v]);
    const startI = l.start_date ? monthIdx(l.start_date) : plan[0][0] - 1;
    if (l.start_date && l.principal_cents) plan.unshift([startI, l.principal_cents]);
    const updates = (l.history || []).filter((r) => r.field === 'balance_cents').map((r) => [at(r.on_date), Number(r.value)]).sort((a, b) => a[0] - b[0]);
    const lastI = updates.length ? updates.at(-1)[0] : null;
    const actual = planned && updates.length ? [[startI, l.principal_cents], ...updates,
      ...t.points.map((p) => [monthIdx(p.month), p.balance_cents]).filter(([i]) => i > lastI)] : [];
    const bal = l.estimated_balance_cents || 0;
    const bank = l.bank ? [[todayI, bal], ...l.bank.points.map(([m, v]) => [monthIdx(m), v])] : [];
    const extra = extraPoints ? [[todayI, bal], ...extraPoints.map(([m, v]) => [monthIdx(m), v])] : [];
    const endI = Math.max(l.end_date ? monthIdx(l.end_date) : 0, plan.at(-1)[0], bank.length ? bank.at(-1)[0] : 0, actual.length ? actual.at(-1)[0] : 0);
    const top = Math.max(l.principal_cents || 0, ...plan.map((p) => p[1]), ...actual.map((p) => p[1]), 1);
    const W = 560; const H = 180;
    const x = (i) => ((i - startI) / (endI - startI || 1)) * W;
    const y = (v) => 6 + (1 - v / top) * (H - 6);
    const path = (pts) => pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const line = path(plan);
    const area = `${line}L${x(plan.at(-1)[0]).toFixed(1)},${H}L${x(plan[0][0]).toFixed(1)},${H}Z`;
    // Dotted lines where the repayment, balance or rate was changed (not where it was first recorded).
    const seen = new Set();
    const marks = (l.history || []).filter((r) => { const first = !seen.has(r.field); seen.add(r.field); return !first && r.field !== 'balance_cents'; })
      .map((r) => ({ r, i: monthIdx(r.on_date) + (Number(r.on_date.slice(8)) - 1) / 30 })).filter(({ i }) => i >= startI && i <= endI);
    const y0 = Math.floor(startI / 12); const y1 = Math.ceil(endI / 12);
    const step = Math.max(1, Math.round((y1 - y0) / 5));
    const years = [];
    for (let yr = y0; yr <= y1; yr += step) years.push(yr);
    return html`<div class="ld-chart" data-start="${startI}" data-end="${endI}"
        data-points="${JSON.stringify(t.points.map((p) => [monthIdx(p.month), p.paid_cents, p.interest_cents, p.balance_cents]))}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Balance over time">
        <path d="${area}" fill="#2ec4b6" opacity=".12"></path>
        ${bank.length > 1 ? html`<path d="${path(bank)}" fill="none" stroke="#8b98a8" stroke-width="1.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"></path>` : ''}
        <path d="${line}" fill="none" stroke="#2ec4b6" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>
        ${actual.length > 1 ? html`<path class="ld-actual" d="${path(actual)}" fill="none" stroke="var(--firm)" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>` : ''}
        ${extra.length > 1 ? html`<path d="${path(extra)}" fill="none" stroke="#3fb950" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>` : ''}
        <line x1="${x(todayI)}" x2="${x(todayI)}" y1="0" y2="${H}" stroke="#5b6778" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"></line>
        ${marks.map(({ r, i }) => html`<line class="ld-mark" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="0" y2="${H}" stroke="var(--firm)" stroke-width="1.5" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"><title>${fmtDate(r.on_date, true)}: ${LOAN_FIELDS[r.field]} ${loanHistoryValue(r)}</title></line>`)}
        <line class="ld-cursor" x1="0" x2="0" y1="0" y2="${H}" stroke="currentColor" stroke-width="1" opacity="0" vector-effect="non-scaling-stroke"></line>
      </svg>
      <span class="ld-today" style="left:${(x(todayI) / W) * 100}%">Today</span>
      <div class="ld-pts">${balancePoints(l, x, y, startI, endI, W, H, actual.length ? null : plan)}</div>
      <div class="ld-tip" hidden></div>
      <div class="ld-years">${years.map((yr) => html`<span style="left:${(x(yr * 12) / W) * 100}%">${yr}</span>`)}</div>
    </div>`;
  }

  // Each balance entered from a statement, as a point on the line. Hover or tap for the estimate it replaced.
  function balancePoints(l, x, y, startI, endI, W, H, plan) {
    // Where the drawn line is at a point in time, so each dot sits on it.
    const lineAt = (i) => {
      const k = plan.findIndex((p) => p[0] >= i);
      if (k <= 0) return plan[Math.max(0, k)][1];
      const [i0, v0] = plan[k - 1]; const [i1, v1] = plan[k];
      return v0 + ((v1 - v0) * (i - i0)) / (i1 - i0 || 1);
    };
    // On the actual line (plan null), a dot sits at the balance itself.
    return (l.history || []).filter((r) => r.field === 'balance_cents').map((r) => {
      const i = monthIdx(r.on_date) + (Number(r.on_date.slice(8)) - 1) / 30;
      if (i < startI || i > endI) return '';
      const before = r.before_value != null ? Number(r.before_value) : null;
      const diff = before != null ? Number(r.value) - before : null;
      const tip = [`Balance updated ${fmtDate(r.on_date, true)}`,
        `Calculated before: ${before != null ? money(Math.round(before)) : 'not recorded'}`,
        `Set to: ${money(r.value)}`,
        diff != null ? `Difference: ${diff > 0 ? '+' : diff < 0 ? '−' : ''}${money(Math.abs(Math.round(diff)))}` : null].filter(Boolean).join('\n');
      const right = x(i) / W > 0.6;
      return html`<button type="button" class="ld-pt ${right ? 'tip-left' : ''}" style="left:${(x(i) / W) * 100}%;top:${(y(plan ? lineAt(i) : Number(r.value)) / H) * 100}%" data-tip="${tip}" aria-label="${tip.replace(/\n/g, '. ')}"></button>`;
    });
  }

  const LOAN_FIELDS = { repayment_cents: 'Repayment', balance_cents: 'Balance', interest_rate: 'Interest rate' };
  const loanHistoryValue = (r) => (r.field === 'interest_rate' ? `${Number(r.value)}%` : r.field === 'repayment_cents' ? `${money(r.value)}${r.frequency ? ` / ${FREQ_UNIT[r.frequency]}` : ''}` : money(r.value));

  // Every change to a loan's repayment, statement balance and rate, newest first.
  function loanHistoryPopup(l) {
    const rows = [...(l.history || [])].reverse();
    const prevOf = (r) => { const k = l.history.indexOf(r); return l.history.slice(0, k).reverse().find((q) => q.field === r.field); };
    const change = (r) => {
      const p = prevOf(r);
      if (!p) return html`<span class="muted">First recorded</span>`;
      const d = Number(r.value) - Number(p.value);
      if (!d) return html`<span class="muted">${r.frequency !== p.frequency ? 'New schedule' : 'No change'}</span>`;
      const txt = r.field === 'interest_rate' ? `${Math.abs(Math.round(d * 100) / 100)}%` : money(Math.abs(d));
      // A higher repayment or a lower balance or rate is good news.
      const good = r.field === 'repayment_cents' ? d > 0 : d < 0;
      return html`<span class="ph-diff ${good ? 'better' : 'worse'}">${d > 0 ? '+' : '−'}${txt}</span>`;
    };
    openForm({
      title: `${l.name} history`,
      body: html`
        <p class="muted small" style="margin-top:0">Each time the repayment, statement balance or rate was changed. Balances use their statement date. The loan chart marks these with dotted lines.</p>
        ${rows.length ? html`<div class="lh-table" role="table">
          <div class="lh-tr lh-th" role="row"><span>Date</span><span>What</span><span class="r">Amount</span><span class="r">Change</span><span></span></div>
          ${rows.map((r, k) => html`<div class="lh-tr ${k >= SHOW_FIRST ? 'more' : ''}" role="row" ${k >= SHOW_FIRST ? raw('hidden') : ''}><span>${fmtDate(r.on_date, true)}</span><span>${LOAN_FIELDS[r.field]}</span>
            <span class="r num">${loanHistoryValue(r)}</span><span class="r">${change(r)}</span>
            <span class="r">${l.history.filter((q) => q.field === r.field).length > 1 ? binBtn({ kind: 'loan', item: l.id }, r, `${LOAN_FIELDS[r.field]} ${fmtDate(r.on_date, true)}: ${loanHistoryValue(r)}`) : ''}</span></div>`)}</div>
          ${moreBtn(rows.length)}`
          : html`<p class="empty">Nothing recorded yet. Changes show here from now on.</p>`}`,
      lead: html`<button type="button" data-action="loan-details" data-id="${l.id}">‹ Back to ${l.name}</button>`,
    });
  }

  // Hover, or tap, for a month's repayments, interest and balance. The tooltip flips left past 60% of the width.
  function loanChartTip(ev) {
    const chart = ev.target.closest && ev.target.closest('.ld-chart');
    if (!chart) return;
    // A balance point has its own tooltip.
    if (ev.target.closest('.ld-pt')) { chart.querySelector('.ld-tip').hidden = true; return; }
    const svg = chart.querySelector('svg');
    const box = svg.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
    const start = Number(chart.dataset.start); const end = Number(chart.dataset.end);
    const pts = JSON.parse(chart.dataset.points);
    const want = start + f * (end - start);
    const p = pts.reduce((best, q) => (Math.abs(q[0] - want) < Math.abs(best[0] - want) ? q : best), pts[0]);
    const tip = chart.querySelector('.ld-tip');
    const cursor = chart.querySelector('.ld-cursor');
    const cx = ((p[0] - start) / (end - start || 1)) * 560;
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('opacity', '.35');
    tip.innerHTML = html`<b>${MONTHS_LONG[p[0] % 12]} ${Math.floor(p[0] / 12)}</b><div>Repaid ${money(p[1])}</div>
      <div class="i">Interest ${money(p[2])}</div><div class="b">Balance ${money(p[3])}</div>`.s;
    tip.hidden = false;
    const px = (cx / 560) * box.width;
    const right = px / box.width > 0.6;
    tip.style.left = right ? '' : `${px + 10}px`;
    tip.style.right = right ? `${box.width - px + 10}px` : '';
  }
  document.addEventListener('pointermove', loanChartTip);
  document.addEventListener('pointerdown', loanChartTip);
  document.addEventListener('pointerout', (ev) => {
    const chart = ev.target.closest && ev.target.closest('.ld-chart');
    if (!chart || chart.contains(ev.relatedTarget) || ev.pointerType === 'touch') return;
    chart.querySelector('.ld-tip').hidden = true;
    chart.querySelector('.ld-cursor').setAttribute('opacity', '0');
  });

  // "What if I pay extra?": the slider's results, and the chart with the extra line. The server
  // works them out (`sim`) the same way as the loan's other estimates; with no extra there's nothing to ask.
  let openLoan = null;
  function payExtraResults(l, extra, sim = null) {
    const b = l.budgeted;
    const unit = FREQ_UNIT[b.frequency];
    let off = '…'; let sooner = '—'; let saved = '—'; let soonerCls = ''; let extraPts = null;
    if (!extra) {
      off = l.estimated_payoff_date ? monthName(monthIdx(l.estimated_payoff_date)) : '—';
    } else if (sim) {
      extraPts = sim.points;
      off = sim.paid_off ? monthName(monthIdx(sim.payoff_date)) : 'Not in 50 years';
      if (sim.paid_off && sim.base.payoff_date) {
        sooner = spanText(Math.max(0, monthIdx(sim.base.payoff_date) - monthIdx(sim.payoff_date)));
        saved = `~${money(Math.max(0, Math.round((sim.base.interest_cents - sim.interest_cents) / 100) * 100))}`;
        soonerCls = 'good';
      }
    }
    return {
      extraPts,
      head: html`<b class="num">+${money(extra)}</b> a ${unit}`,
      cells: html`<div><span>Paid off</span><b class="num">${off}</b></div>
        <div><span>Sooner by</span><b class="${soonerCls}">${sooner}</b></div>
        <div><span>Interest saved</span><b class="num ${soonerCls}">${saved}</b></div>`,
    };
  }
  // Answers are kept per loan and amount, and only the newest one asked for is shown.
  const extraCache = new Map();
  let extraAsked = 0;
  let extraTimer = null;
  function showExtra(root, l, extra, sim) {
    const r = payExtraResults(l, extra, sim);
    root.querySelector('.ld-x-amt').innerHTML = r.head.s;
    root.querySelector('.ld-x-cells').innerHTML = r.cells.s;
    if (!extra || sim) {
      root.querySelector('.ld-chart-wrap').innerHTML = loanChart(l, r.extraPts).s;
      root.querySelector('.ld-key-extra').hidden = !extra;
    }
  }
  document.addEventListener('input', (ev) => {
    if (!ev.target.matches || !ev.target.matches('#ld-extra') || !openLoan) return;
    const l = openLoan;
    const extra = Number(ev.target.value) * 100;
    const root = ev.target.closest('.ld');
    ev.target.style.setProperty('--fill', `${(Number(ev.target.value) / Number(ev.target.max)) * 100}%`);
    const key = `${l.id}:${l.estimated_balance_cents}:${extra}`;
    const asked = ++extraAsked;
    clearTimeout(extraTimer);
    showExtra(root, l, extra, extraCache.get(key));
    if (!extra || extraCache.has(key)) return;
    extraTimer = setTimeout(async () => {
      try {
        const sim = await api('GET', `/loans/${l.id}/extra?cents=${extra}`);
        extraCache.set(key, sim);
        if (asked === extraAsked && openLoan === l && root.isConnected) showExtra(root, l, extra, sim);
      } catch (err) { if (asked === extraAsked) toast(err.message); }
    }, 120);
  });

  // Detail popup: balance and pay-off, how it's paid, what it costs, the balance over time and what paying extra would do.
  const loanBtns = (l) => ({ upd: l.paid_off ? null : { label: 'Update balance', action: 'update-balance', id: l.id }, edit: { label: 'Edit loan', action: 'edit-loan', id: l.id } });

  async function loanDetails(id) {
    const l = await api('GET', `/loans/${id}/details`);
    openLoan = l;
    extraCache.clear();
    const t = l.timeline;
    const sch = l.scheduled;
    const bud = l.budgeted;
    const a = account(l.account_id);
    const off = payoffVsEnd(l);
    const unit = (r) => html` <span class="unit">/ ${FREQ_UNIT[r.frequency]}</span>`;
    const cell = (label, value, sub, cls = '') => html`<div class="lc-cell"><div class="lc-label">${label}</div><div class="lc-value num">${value}</div><div class="lc-sub ${cls}">${sub}</div></div>`;
    const when = (r) => (!r.date ? '' : r.frequency === 'monthly' ? `On the ${ordinal(Number(r.date.slice(8)))}` : `From ${fmtDate(r.date)}`);
    const diff = bud.per_month_cents - sch.per_month_cents;
    const budSub = !bud.custom ? 'Same as the bank' : diff ? `${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}/month ${diff > 0 ? 'extra' : 'less'}` : when(bud);
    const due = l.next_due;
    let dueCell = cell('Next due', '—', '');
    if (due && !l.paid_off) {
      const short = due.full_period ? due.due_cents - due.budgeted_cents : 0;
      dueCell = cell('Next due', fmtDate(due.date), short > 0 ? `${money(short)} short` : due.full_period ? `${money(due.budgeted_cents)} put aside ✓` : `${money(due.budgeted_cents)} put aside so far`, short > 0 ? 'bad' : due.full_period ? 'good' : '');
    }
    // The estimate against the last statement, when they're more than about 1% or $500 apart.
    const h = t && t.history;
    const gap = h ? h.estimated_balance_cents - h.statement_balance_cents : 0;
    const warn = h && gap !== 0 && (Math.abs(gap) >= 50000 || Math.abs(gap) >= h.statement_balance_cents * 0.01);
    const fixed = l.rate_type === 'fixed';
    const daysSinceStatement = l.balance_date ? daysUntil(l.balance_date) * -1 : null;
    const saved = l.bank && t ? l.bank.interest_cents - t.interest_left_cents : null;
    const x = payExtraResults(l, 0);
    const row = (k, v, cls = '') => html`<li><span>${k}</span><b class="${cls}">${v}</b></li>`;
    const fees = l.monthly_fee_cents && l.term_months ? l.monthly_fee_cents * l.term_months : 0;
    const rateRise = l.rate_rise_cents;

    openForm({
      title: null,
      cls: 'loan-modal',
      noActions: true,
      body: html`<div class="ld">
        <div class="ld-head">
          <div class="ld-title">
            <div class="ld-name"><b>${l.name}</b>${l.lender ? html`<span> · ${l.lender}</span>` : ''}</div>
            <div class="lc-chips">
              ${a ? html`<span class="lc-chip"><span class="dot" style="background:${accountColor(a.id)}"></span>${a.name}</span>` : ''}
              ${l.interest_rate != null ? html`<span class="lc-chip">${l.interest_rate}% p.a. · ${fixed ? 'Fixed' : 'Variable'}</span>` : ''}
              ${l.term_months ? html`<span class="lc-chip soft">${termText(l.term_months)}${l.end_date ? ` · ends ${fmtDate(l.end_date, true)}` : ''}</span>` : ''}
            </div>
          </div>
          ${popTop(loanBtns(l))}
        </div>

        <div class="ld-sum">
          <div><div class="ld-lbl">Left to pay</div><div class="ld-bal num">${l.estimated_balance_cents != null ? money(l.estimated_balance_cents) : '—'}</div></div>
          <div class="ld-off"><div class="ld-lbl">Paid off around</div><div class="ld-date">${l.estimated_payoff_date ? fmtDate(l.estimated_payoff_date, true) : '—'}</div>
            ${off.text ? html`<div class="ld-vs ${off.cls}">${off.text}</div>` : ''}</div>
        </div>

        ${warn ? html`<div class="ld-warn"><span>The estimate is <b>${money(Math.abs(gap))}</b> ${gap < 0 ? 'below' : 'above'} your last statement (${fmtDate(h.to)}).
            <button type="button" class="linkish" data-action="ld-working">How is this worked out?</button></span>
          <button type="button" class="ld-warn-btn" data-action="update-balance" data-id="${l.id}">Update balance</button></div>
          <div class="ld-working" hidden>Before ${fmtDate(h.to, true)} (estimated at today's rate): ${money(h.paid_cents)} repaid, ${money(h.interest_cents)} interest.
            Since then (calculated): ${money(t.paid_since_cents)} repaid, ${money(t.interest_since_cents)} interest.
            The estimate puts the balance at ${money(h.estimated_balance_cents)}; your statement says ${money(h.statement_balance_cents)}.</div>` : ''}

        <div class="lc-strip ld-strip">
          ${cell('Bank takes', html`${money(sch.amount_cents)}${unit(sch)}`, `${when(sch)}${l.repayment_cents == null ? ' · calculated' : ''}`)}
          ${cell('You budget', html`${money(bud.amount_cents)}${unit(bud)}`, budSub, bud.custom && diff > 0 ? 'good' : bud.custom && diff < 0 ? 'bad' : '')}
          ${dueCell}
        </div>

        <div class="ld-pad ld-bar">${loanBar(l)}</div>

        ${t && t.points.length > 1 ? html`<div class="ld-pad ld-sec">
          <div class="ld-sec-head"><h3>Balance over time</h3>${l.history && l.history.length ? html`<button type="button" class="linkish small" data-action="loan-history">History</button>` : ''}</div>
          <div class="ld-keys"><span><i class="k-plan"></i>Your plan</span>${l.bank ? html`<span><i class="k-bank"></i>Bank schedule</span>` : ''}${(l.history || []).some((r) => r.field === 'balance_cents') ? html`<span><i class="k-pt ${l.plan ? 'k-actual' : ''}"></i>${l.plan ? 'Actual (balance updates)' : 'Balance updated'}</span>` : ''}${(() => { const seenF = new Set(); return (l.history || []).some((r) => { const again = seenF.has(r.field); seenF.add(r.field); return again && r.field !== 'balance_cents'; }); })() ? html`<span><i class="k-mark"></i>Rate or repayment changed</span>` : ''}<span class="ld-key-extra" hidden><i class="k-extra"></i>With extra</span></div>
          <div class="ld-chart-wrap">${loanChart(l, null)}</div>
        </div>` : ''}

        ${l.estimated_balance_cents > 0 && !l.paid_off ? html`<div class="ld-extra">
          <div class="ld-x-head"><b>What if I pay extra?</b><span class="ld-x-amt">${x.head}</span></div>
          <input id="ld-extra" type="range" min="0" max="500" step="25" value="0" aria-label="Extra each ${FREQ_UNIT[bud.frequency]}">
          <div class="ld-x-cells">${x.cells}</div>
          <p class="ld-x-note">Compared with your current ${money(bud.amount_cents)} a ${FREQ_UNIT[bud.frequency]}.${rateRise != null ? html` Rate +0.25% would add about <b>${money(rateRise)}/month</b> to the bank's monthly repayment.` : ''}</p>
        </div>` : ''}

        <div class="ld-pad ld-sec"><h3>Details</h3>
          <ul class="ld-details">
            ${row('Borrowed', `${l.principal_cents ? money(l.principal_cents) : '—'}${l.start_date ? ` · ${fmtDate(l.start_date, true)}` : ''}`)}
            ${saved != null ? row('Interest saved by paying extra', saved > 0 ? `~${money(Math.round(saved / 100) * 100)} vs bank schedule` : bud.custom ? 'None vs bank schedule' : "None, you pay the bank's amount", saved > 0 ? 'good' : '') : ''}
            ${l.interest_fy_cents != null ? row('Interest this financial year', `~${money(l.interest_fy_cents)}`) : ''}
            <li><span>Offset account</span>${l.offset_cents ? html`<b class="num">${money(l.offset_cents)}</b>` : html`<button type="button" class="linkish" data-action="edit-loan" data-id="${l.id}">Add balance</button>`}</li>
            ${row('Fixed rate ends', fixed ? (l.fixed_until ? fmtDate(l.fixed_until, true) : 'Fixed, no end date set') : 'Variable, n/a', fixed ? '' : 'muted')}
            ${row('Fees', l.monthly_fee_cents ? `${money(l.monthly_fee_cents)} / month` : 'None', l.monthly_fee_cents ? '' : 'muted')}
            ${row('Early repayment / break fees', l.break_fees || 'None', l.break_fees ? '' : 'muted')}
            ${row('Balance last updated', l.balance_date ? `${fmtDate(l.balance_date, true)} (statement)` : 'Not yet, estimated from the start', daysSinceStatement == null || daysSinceStatement > 90 ? 'soon' : '')}
          </ul></div>

        <p class="ld-pad ld-foot">Estimates${t && t.from ? ` from ${fmtDate(t.from, true)}` : ''}, using the repayments you budget${fees ? `. The total cost includes about ${money(fees)} in fees over the term` : ''}. Update the balance from a statement to keep them close.</p>
        <div class="ld-btns">${popFoot(loanBtns(l))}</div>
      </div>`,
    });
  }

  // A bill on the Overview: this payment, what's come out so far this year, and how it's paid.
  async function billDetails(id, { date, amount, status }) {
    const e = await api('GET', `/expenses/${id}/details`);
    const p = payee(e.payee_id);
    const a = account(e.account_id);
    const cat = category(e.category_id);
    const sub = subcategory(e.subcategory_id);
    const fact = (label, value, sub2 = '') => html`<div class="fact"><div class="label">${label}</div><div class="value num">${value}</div>${sub2 ? html`<div class="meta">${sub2}</div>` : ''}</div>`;
    const times = (n) => `${n} payment${n === 1 ? '' : 's'}`;
    const ref = e.reference || p?.reference;
    // Copyable lines, like an account's bank details.
    const line = (label, value, copy = true) => (value ? html`<li><div class="grow"><div class="meta">${label}</div><div class="title num">${value}</div></div>
      ${copy ? html`<button type="button" data-copy="${value}" data-label="${label}">Copy</button>` : ''}</li>` : '');
    const btns = { upd: { label: 'Update amount', action: 'update-amount', id: e.id }, edit: { label: `Edit ${kindOf(e) === 'saving' ? 'saving' : 'expense'}`, action: 'edit-expense', id: e.id } };
    openForm({
      title: null,
      noActions: true,
      body: html`
        ${popHead(e.name, btns)}
        <div class="facts two">
          ${fact(status === 'paid' ? 'Came out' : status === 'due' ? 'Due today' : 'Due', money(Number(amount)), fmtDate(date, true))}
          ${fact('How often', isSplit(e) ? `${money(e.yearly_cents)} a year` : e.spread ? `${money(e.amount_cents)} ${FREQ_LABELS[e.frequency].toLowerCase()}` : FREQ_LABELS[e.frequency],
            e.spread ? `put aside each ${cycleWord()}` : scheduleText(e))}
          ${fact('Paid this financial year', money(e.paid_fytd.cents), `${times(e.paid_fytd.count)} since ${fmtDate(e.paid_fytd.from, true)}`)}
          ${fact('Paid this calendar year', money(e.paid_ytd.cents), `${times(e.paid_ytd.count)} since ${fmtDate(e.paid_ytd.from, true)}`)}
        </div>
        <ul class="list details-list">
          ${a ? html`<li><div class="grow"><div class="meta">Paid from</div><div class="title"><span class="acct-tag"><span class="dot" style="background:${accountColor(a.id)}"></span>${a.name}</span></div></div></li>` : ''}
          ${p ? html`<li><div class="grow"><div class="meta">Payee</div><div class="title">${p.name}${p.pay_type ? html` <span class="chip">${PAY_TYPES[p.pay_type]}</span>` : ''}</div></div></li>` : ''}
          ${line('Account / policy number', p?.policy_number)}
          ${p?.pay_type === 'bpay' ? line('Biller code', p.biller_code) : ''}
          ${p?.pay_type === 'transfer' ? html`${line('Account name', p.account_name, false)}${line('BSB', p.bsb)}${line('Account number', p.account_number)}` : ''}
          ${line(p?.pay_type === 'bpay' ? 'Reference (CRN)' : 'Reference', ref)}
          ${cat ? line('Category', [cat.name, sub?.name].filter(Boolean).join(' › '), false) : ''}
          ${!e.spread && e.next_date && e.next_date !== date ? line('Next after this', fmtDate(e.next_date, true), false) : ''}
          ${e.pending_from ? line('Price change', `${money(e.pending_cents)} from ${fmtDate(e.pending_from, true)}`, false) : ''}
          ${e.notes ? html`<li class="note-line"><div class="grow"><div class="meta">Notes</div><div class="title">${e.notes}</div></div></li>` : ''}
        </ul>
        <p class="hint">Paid so far counts every date it was due before today${e.start_date ? `, from ${fmtDate(e.start_date, true)}` : ''}.</p>
        ${e.history && e.history.length ? html`<h3 class="ph-title">Price history${e.review_date ? html` <span class="muted small">· ${e.review_date <= state.data.settings.today ? 'review was due' : 'next review'} ${fmtDate(e.review_date, true)}</span>` : ''}</h3>${priceHistory(e.history, e)}` : ''}
        ${popFoot(btns)}`,
    });
  }

  // True when part of the loan's past is estimated (it has a statement balance after the start).
  const estimatedHistory = (l) => Boolean(l.balance_cents != null && l.balance_date && l.start_date && l.principal_cents && l.start_date < l.balance_date);

  // What's been paid and what's left, each split into the amount borrowed and interest.
  // Paid is bright, left is dull. Interest is an estimate.
  // Paid (bright) and still to pay (muted), split by principal and interest, with a gap marking today.
  function loanBar(l) {
    const bal = l.estimated_balance_cents;
    if (!l.principal_cents || bal == null) return '';
    const principalPaid = Math.max(0, l.principal_cents - bal);
    const intPaid = l.estimated_interest_paid_cents || 0;
    const intLeft = l.estimated_interest_left_cents || 0;
    const paidTotal = principalPaid + intPaid;
    const leftTotal = bal + intLeft;
    const total = paidTotal + leftTotal;
    if (!total) return '';
    // A monthly fee adds to what the loan costs over its whole term.
    const fees = l.monthly_fee_cents && l.term_months ? l.monthly_fee_cents * l.term_months : 0;
    const est = estimatedHistory(l) ? '~' : '';
    const seg = (v, of, cls, label) => (v > 0 ? html`<span class="${cls}" style="width:${(v / of) * 100}%" title="${label}: ${money(v)}"></span>` : '');
    const key = (cls, label, v, tilde = '') => html`<span><span class="sq ${cls}"></span>${label} <b class="num">${tilde}${money(v)}</b></span>`;
    return html`
      <div class="lb-top"><span>Total cost of loan <b class="num">~${money(total + fees)}</b>${fees ? html` <span class="muted">incl. ${money(fees)} fees</span>` : ''}</span><span>${Math.round((principalPaid / l.principal_cents) * 100)}% of principal paid off</span></div>
      <div class="lb-bar">
        ${paidTotal ? html`<span class="lb-pill" style="width:calc(${(paidTotal / total) * 100}% - 1.5px)">${seg(principalPaid, paidTotal, 'p-paid', 'Principal paid')}${seg(intPaid, paidTotal, 'i-paid', 'Interest paid')}</span>` : ''}
        ${leftTotal ? html`<span class="lb-pill grow">${seg(bal, leftTotal, 'p-left', 'Principal still owed')}${seg(intLeft, leftTotal, 'i-left', 'Interest still to come (estimate)')}</span>` : ''}
      </div>
      <div class="lb-legend">
        <div><div class="lb-head">Paid · <b class="num">${est}${money(paidTotal)}</b></div>
          <div class="lb-keys">${key('p-paid', 'Principal', principalPaid)}${key('i-paid', 'Interest', intPaid, est)}</div></div>
        <div class="lb-right"><div class="lb-head">Still to pay · <b class="num">~${money(leftTotal)}</b></div>
          <div class="lb-keys">${key('p-left', 'Principal', bal)}${key('i-left', 'Interest', intLeft, '~')}</div></div>
      </div>`;
  }

  // Simple loans card for the Overview.
  function loansSummary() {
    const loans = state.data.loans.filter((l) => !l.paid_off);
    if (!loans.length) return '';
    return html`<section class="card">
      <div class="card-head"><h2>Loans</h2><a class="small" href="#/budget/loans">See all</a></div>
      <ul class="list">${loans.map((l) => {
        const bal = l.estimated_balance_cents;
        const paid = l.principal_cents && bal != null ? Math.max(0, l.principal_cents - bal) : null;
        return html`<li class="clickable" data-action="loan-details" data-id="${l.id}">
        <div class="grow"><div class="title">${l.name}</div>
          ${paid != null ? html`<div class="meta"><b class="num">${money(paid)}</b> of ${money(l.principal_cents)} paid off</div>
            ${progress(paid, l.principal_cents, '', 'var(--info)')}` : ''}
          ${l.next_due ? html`<div class="meta">Next due ${fmtDate(l.next_due.date)} · ${money(l.next_due.due_cents)}</div>` : ''}</div>
        <div class="right">${bal != null ? html`<div class="num">${money(bal)}</div><div class="meta">left</div>` : ''}</div>
      </li>`;
      })}</ul></section>`;
  }

  // "What if" calculator. Works out as you type; the server knows this pay's income and commitments.
  const calcOpen = () => { try { return localStorage.getItem('calc-open') !== '0'; } catch { return true; } };
  function loanCalculator() {
    const c = state.calc;
    const open = calcOpen();
    const field = (id, name, label, value, { pre = '', post = '', placeholder = '', mode = 'decimal' } = {}) => html`<div class="field calc-field"><label for="${id}">${label}</label>
      <div class="unit-input">${pre ? html`<span class="pre">${pre}</span>` : ''}<input id="${id}" name="${name}" inputmode="${mode}" value="${value}" placeholder="${placeholder}" autocomplete="off">${post ? html`<span class="post">${post}</span>` : ''}</div></div>`;
    return html`
      <section class="card calc-card ${open ? 'open' : ''}">
        <button type="button" class="calc-head" data-action="toggle-calc" aria-expanded="${open ? 'true' : 'false'}">
          <span><span class="calc-title">Loan calculator</span><span class="calc-sub">Could you afford a new loan? Estimates only, not financial advice.</span></span>
          <span class="chev">${open ? '▾' : '▸'}</span></button>
        ${open ? html`<form id="calc-form" class="calc-body" novalidate>
          <div class="calc-grid">
            ${field('c-amount', 'amount', 'Loan amount', c.amount, { pre: '$', placeholder: '450,000' })}
            ${field('c-rate', 'rate', 'Interest rate', c.rate, { post: '% p.a.' })}
            ${field('c-years', 'years', 'Term', c.years, { post: 'years', mode: 'numeric' })}
            ${field('c-limit', 'limit', 'Keep commitments under', c.limit, { post: '% of income', mode: 'numeric' })}
          </div>
          <div class="calc-freq"><span class="lbl">Repayments</span>
            <span class="mini-seg">${Object.entries(LOAN_FREQ).map(([k, v]) => html`<button type="button" class="${c.frequency === k ? 'on' : ''}" data-action="calc-freq" data-value="${k}">${v}</button>`)}</span>
            <span class="calc-rule">70% is a common rule of thumb.</span></div>
          <div id="calc-result">${calcResult(c.result, c.frequency)}</div>
        </form>` : ''}
      </section>`;
  }

  function calcResult(r, freq) {
    const cell = (label, value, sub, color = '') => html`<div class="lc-cell"><div class="lc-label">${label}</div><div class="lc-value big num" style="${color ? `color:${color}` : ''}">${value}</div><div class="lc-sub">${sub}</div></div>`;
    const ppy = state.data.settings.pays_per_year;
    const freqYear = { weekly: 52, fortnightly: 26, monthly: 12 }[freq];
    // Room under the limit each pay, after what's already committed.
    const room = r ? Math.round(((r.income_per_year_cents * r.limit_percent) / 100 - r.committed_per_year_cents) / ppy) : null;
    if (!r) {
      return html`<div class="lc-strip calc-strip">
        ${cell('Repayment', '—', 'Enter a loan amount')}
        ${cell('Total interest', '—', 'over the full term', 'var(--due)')}
        ${cell('Affordable?', '—', 'Enter a term to check')}
      </div>`;
    }
    // No amount yet: the most you could borrow and stay under the limit.
    if (r.repayment_cents == null) {
      const over = !(r.max_loan_cents > 0);
      return html`<div class="lc-strip calc-strip">
        ${cell('Most you could borrow', over ? '$0' : `~${money(Math.floor(r.max_loan_cents / 10000) * 10000)}`, over ? `Commitments are already over ${r.limit_percent}%` : `over ${state.calc.years} years at ${state.calc.rate || 0}%`, over ? 'var(--danger)' : 'var(--paid)')}
        ${cell('Repayment at that', over ? '—' : money(r.max_repayment_cents), over ? 'Nothing spare under the limit' : `a ${FREQ_UNIT[freq]}${PAY_WORD[state.data.settings.pay_frequency] === FREQ_UNIT[freq] ? '' : ` · ≈ ${money(room)} ${aCycle()}`}`)}
        ${cell('Committed now', r.committed_percent != null ? `${r.committed_percent}%` : '—', `of income · limit ${r.limit_percent}%`, r.committed_percent > r.limit_percent ? 'var(--danger)' : '')}
      </div>
      <p class="calc-info"><span aria-hidden="true">ⓘ</span> With the loan amount blank, this works out the biggest loan whose repayments still keep all your commitments (bills, savings and loan repayments) under ${r.limit_percent}% of your income, at the rate and term above. Type an amount to check a specific loan.</p>`;
    }
    const perCycle = Math.round((r.repayment_cents * freqYear) / ppy);
    const same = PAY_WORD[state.data.settings.pay_frequency] === FREQ_UNIT[freq];
    const ok = perCycle <= room;
    return html`<div class="lc-strip calc-strip">
      ${cell('Repayment', money(r.repayment_cents), `a ${FREQ_UNIT[freq]}${same ? '' : ` · ≈ ${money(perCycle)} ${aCycle()}`}`)}
      ${cell('Total interest', `~${money(r.total_interest_cents)}`, 'over the full term', 'var(--due)')}
      ${ok ? cell('Affordable?', 'Yes', `${money(room - perCycle)} ${aCycle()} to spare`, 'var(--paid)')
        : cell('Affordable?', 'Over limit', room > 0 ? `${money(perCycle - room)} ${aCycle()} over your ${r.limit_percent}%` : `You're already over your ${r.limit_percent}%`, 'var(--danger)')}
    </div>`;
  }

  let calcTimer;
  let calcSeq = 0;
  async function runCalc() {
    const f = document.querySelector('#calc-form');
    if (!f) return;
    const el = f.elements;
    Object.assign(state.calc, { amount: el.amount.value, rate: el.rate.value, years: el.years.value, limit: el.limit.value });
    const amount = parseMoney(el.amount.value.replace(/,/g, ''));
    const q = new URLSearchParams({ rate: el.rate.value || '0', years: el.years.value, frequency: state.calc.frequency, limit_percent: el.limit.value || '70' });
    if (amount > 0) q.set('amount_cents', String(amount));
    const seq = ++calcSeq; // only the newest answer is shown
    let result;
    try {
      result = await api('GET', `/loan-calculator?${q}`);
    } catch {
      result = null; // e.g. no term yet
    }
    if (seq !== calcSeq) return;
    state.calc.result = result;
    const out = document.querySelector('#calc-result');
    if (out) out.innerHTML = calcResult(state.calc.result, state.calc.frequency).s;
  }
  document.addEventListener('submit', (ev) => { if (ev.target.id === 'calc-form') { ev.preventDefault(); runCalc(); } });
  document.addEventListener('input', (ev) => {
    if (!ev.target.closest || !ev.target.closest('#calc-form')) return;
    clearTimeout(calcTimer);
    calcTimer = setTimeout(runCalc, 250);
  });

  // Loans to bring up to date from a statement.
  function updateBalances() {
    const loans = state.data.loans.filter((l) => !l.paid_off);
    if (loans.length === 1) return balanceForm(loans[0]);
    openForm({
      title: 'Update balances',
      body: html`<p class="hint">Pick a loan and enter the balance from its latest statement.</p>
        <ul class="list">${loans.map((l) => html`<li><div class="grow"><div class="title">${l.name}</div>
          <div class="meta">${l.balance_cents != null && l.balance_date ? `${money(l.balance_cents)} as at ${fmtDate(l.balance_date, true)}` : 'No statement balance yet'}</div></div>
          <button type="button" data-action="update-balance" data-id="${l.id}">Update</button></li>`)}</ul>`,
    });
  }

  function loanForm(l = { repayment_frequency: 'monthly', include_in_budget: 1 }) {
    const endDate = l.start_date && l.term_months ? l.end_date : '';
    openForm({
      title: l.id ? 'Edit loan' : 'Add loan',
      body: html`
        <div class="fields">
          <div class="field"><label for="l-name">Name</label><input id="l-name" name="name" value="${l.name || ''}" placeholder="e.g. Home loan" required></div>
          <div class="field"><label for="l-lender">Lender</label><input id="l-lender" name="lender" value="${l.lender || ''}"></div>
          <div class="field"><label for="l-principal">Amount borrowed ($)</label><input id="l-principal" name="principal" inputmode="decimal" value="${moneyInput(l.principal_cents)}"></div>
          <div class="field"><label for="l-rate">Interest rate (% a year)</label><input id="l-rate" name="interest_rate" inputmode="decimal" value="${l.interest_rate ?? ''}"></div>
          <div class="field"><label for="l-rtype">Rate type</label><select id="l-rtype" name="rate_type">
            <option value="variable" ${l.rate_type !== 'fixed' ? raw('selected') : ''}>Variable</option><option value="fixed" ${l.rate_type === 'fixed' ? raw('selected') : ''}>Fixed</option></select></div>
          <div class="field" id="l-fixed-wrap" ${l.rate_type === 'fixed' ? '' : raw('hidden')}><label for="l-fixed">Fixed rate ends</label><input id="l-fixed" type="date" name="fixed_until" value="${l.fixed_until || ''}">
            <div class="hint">You'll get a reminder on the Overview 60 days before.</div></div>
          <div class="field"><label for="l-start">Start date</label><input id="l-start" type="date" name="start_date" value="${l.start_date || ''}"></div>
          <div class="field"><label for="l-term">Term (years)</label><input id="l-term" name="term_years" inputmode="decimal" value="${l.term_months ? +(l.term_months / 12).toFixed(2) : ''}">
            <div class="hint">Or set the end date and the term is worked out.</div></div>
          <div class="field"><label for="l-end">End date</label><input id="l-end" type="date" name="end_date" value="${endDate || ''}"></div>
          <h3 class="field full form-section">Scheduled repayment <span class="muted small">what the lender requires</span></h3>
          <div class="field"><label for="l-freq">How often</label><select id="l-freq" name="repayment_frequency">
            ${Object.entries(LOAN_FREQ).map(([k, v]) => html`<option value="${k}" ${k === l.repayment_frequency ? raw('selected') : ''}>${v}</option>`)}</select></div>
          <div class="field"><label for="l-repay">Amount ($, optional)</label><input id="l-repay" name="repayment" inputmode="decimal" value="${moneyInput(l.repayment_cents)}">
            <div class="hint" id="l-calc">Leave blank to use the calculated repayment.</div></div>
          <div class="field"><label for="l-sdate">Next due date</label><input id="l-sdate" type="date" name="scheduled_date" value="${l.scheduled_date || ''}">
            <div class="hint">Any due date, past or future. Defaults to the start date.</div></div>
          <h3 class="field full form-section">Budgeted repayment <span class="muted small">what you actually pay, shown in expenses and deposits</span></h3>
          <div class="field full"><label class="check"><input type="checkbox" name="own_budget" data-toggle="#l-budget" ${l.budget_cents != null ? raw('checked') : ''}> Pay a different amount or schedule</label>
            <div class="hint">For example $700 every fortnight towards $1,400 due each month.</div></div>
          <div class="fields full" id="l-budget" style="gap:0 12px" ${l.budget_cents != null ? '' : raw('hidden')}>
            <div class="field"><label for="l-bfreq">How often</label><select id="l-bfreq" name="budget_frequency">
              ${Object.entries(LOAN_FREQ).map(([k, v]) => html`<option value="${k}" ${k === (l.budget_frequency || state.data.settings.pay_frequency) ? raw('selected') : ''}>${v}</option>`)}</select></div>
            <div class="field"><label for="l-bamount">Amount ($)</label><input id="l-bamount" name="budget" inputmode="decimal" value="${moneyInput(l.budget_cents)}"></div>
            <div class="field"><label for="l-bdate">First payment</label><input id="l-bdate" type="date" name="budget_date" value="${l.budget_date || ''}">
              <div class="hint">Payments repeat from this date.</div></div>
          </div>
          <h3 class="field full form-section">Other details</h3>
          <div class="field"><label for="l-account">Paid from account</label><select id="l-account" name="account_id">${options(state.data.accounts, l.account_id)}</select></div>
          <div class="field"><label for="l-bal">Current balance ($, optional)</label><input id="l-bal" name="balance" inputmode="decimal" value="${moneyInput(l.balance_cents)}"></div>
          <div class="field"><label for="l-baldate">Balance as at</label><input id="l-baldate" type="date" name="balance_date" value="${l.balance_date || ''}">
            <div class="hint">From a statement. Update it after an extra payment or redraw.</div></div>
          <div class="field"><label for="l-iday">Interest charged on day</label><input id="l-iday" name="interest_day" type="number" min="1" max="31" inputmode="numeric" value="${l.interest_day ?? ''}">
            <div class="hint">Day of the month. Defaults to the start day.</div></div>
          <div class="field"><label for="l-offset">Offset account balance ($)</label><input id="l-offset" name="offset" inputmode="decimal" value="${moneyInput(l.offset_cents)}">
            <div class="hint">Money in it isn't charged interest.</div></div>
          <div class="field"><label for="l-fee">Fees ($ a month)</label><input id="l-fee" name="monthly_fee" inputmode="decimal" value="${moneyInput(l.monthly_fee_cents)}"></div>
          <div class="field full"><label for="l-break">Early repayment / break fees</label><input id="l-break" name="break_fees" value="${l.break_fees || ''}" placeholder="e.g. None, or $300 if paid out early"></div>
          <div class="field"><label for="l-cat">Category (for analytics)</label><select id="l-cat" name="category_id">${options(state.data.categories, l.category_id)}</select></div>
          <div class="field full"><label for="l-notes">Notes</label><textarea id="l-notes" name="notes" rows="2">${l.notes || ''}</textarea></div>
          <div class="field full"><label class="check"><input type="checkbox" name="include_in_budget" ${l.include_in_budget !== 0 ? raw('checked') : ''}> Include repayments in the budget (adds them to the account's deposit)</label>
            <div class="hint">If you already have this repayment as an expense, untick this or delete that expense, so it isn't counted twice.</div></div>
          <div class="field full"><label class="check"><input type="checkbox" name="paid_off" ${l.paid_off ? raw('checked') : ''}> Paid off</label></div>
        </div>`,
      afterRender: (form) => {
        const f = form.elements;
        const monthsBetween = (a, b) => {
          const [ay, am, ad] = a.split('-').map(Number);
          const [by, bm, bd] = b.split('-').map(Number);
          return (by - ay) * 12 + (bm - am) - (bd < ad ? 1 : 0);
        };
        const addMonths = (d, n) => {
          const [y, m, day] = d.split('-').map(Number);
          const t = new Date(Date.UTC(y, m - 1 + n, 1));
          const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
          return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
        };
        // Show the calculated repayment as you type.
        const showCalc = () => {
          const p = parseMoney(f.principal.value);
          const rate = Number(f.interest_rate.value) || 0;
          const months = Math.round(Number(f.term_years.value) * 12);
          const perYear = LOAN_PER_YEAR[f.repayment_frequency.value];
          const n = Math.round((months / 12) * perYear);
          const r = rate / 100 / perYear;
          const pmt = p > 0 && n > 0 ? (r ? (p * r) / (1 - (1 + r) ** -n) : p / n) : 0;
          form.querySelector('#l-calc').textContent = pmt
            ? `Calculated: about ${money(Math.round(pmt))} ${LOAN_FREQ[f.repayment_frequency.value].toLowerCase()} (estimate). Leave blank to use it.`
            : 'Leave blank to use the calculated repayment.';
        };
        f.end_date.addEventListener('change', () => {
          if (f.start_date.value && f.end_date.value) f.term_years.value = +(monthsBetween(f.start_date.value, f.end_date.value) / 12).toFixed(2);
          showCalc();
        });
        const syncEnd = () => {
          const months = Math.round(Number(f.term_years.value) * 12);
          if (f.start_date.value && months > 0) f.end_date.value = addMonths(f.start_date.value, months);
          showCalc();
        };
        f.term_years.addEventListener('input', syncEnd);
        f.start_date.addEventListener('change', syncEnd);
        ['principal', 'interest_rate', 'repayment_frequency'].forEach((k) => f[k].addEventListener('input', showCalc));
        f.repayment_frequency.addEventListener('change', showCalc);
        showCalc();
        f.rate_type.addEventListener('change', () => { form.querySelector('#l-fixed-wrap').hidden = f.rate_type.value !== 'fixed'; });
      },
      onSave: async (form) => {
        const termYears = val(form, 'term_years');
        const body = {
          name: val(form, 'name'), lender: val(form, 'lender') || null,
          principal_cents: moneyVal(form, 'principal', 'Amount borrowed'),
          interest_rate: numVal(form, 'interest_rate', 'Interest rate'),
          start_date: val(form, 'start_date') || null,
          term_months: termYears ? Math.round(Number(termYears) * 12) : null,
          repayment_frequency: val(form, 'repayment_frequency'),
          repayment_cents: moneyVal(form, 'repayment', 'Repayment'),
          account_id: idVal(form, 'account_id'), category_id: idVal(form, 'category_id'),
          balance_cents: moneyVal(form, 'balance', 'Balance'), balance_date: val(form, 'balance_date') || null,
          interest_day: idVal(form, 'interest_day'), notes: val(form, 'notes') || null,
          include_in_budget: form.elements.include_in_budget.checked, paid_off: form.elements.paid_off.checked,
          scheduled_date: val(form, 'scheduled_date') || null,
          budget_cents: null, budget_frequency: null, budget_date: null,
          rate_type: val(form, 'rate_type'), fixed_until: val(form, 'rate_type') === 'fixed' ? val(form, 'fixed_until') || null : null,
          offset_cents: moneyVal(form, 'offset', 'Offset balance'), monthly_fee_cents: moneyVal(form, 'monthly_fee', 'Fees'),
          break_fees: val(form, 'break_fees') || null,
        };
        if (form.elements.own_budget.checked) {
          Object.assign(body, { budget_cents: moneyVal(form, 'budget', 'Budgeted amount', { required: true }),
            budget_frequency: val(form, 'budget_frequency'), budget_date: val(form, 'budget_date') || null });
          if (!body.budget_date) throw new Error('Add the date of the first budgeted payment.');
        }
        if (!body.name) throw new Error('Please give the loan a name.');
        if (termYears && !(Number(termYears) > 0)) throw new Error('The term must be a number of years, like 30.');
        if (body.balance_cents != null && !body.balance_date) throw new Error('Add the date the balance is from.');
        if (body.repayment_cents == null && !(body.principal_cents && body.term_months)) {
          throw new Error('Add the amount borrowed and term so the repayment can be worked out, or enter the repayment yourself.');
        }
        // A loan that started in the past with no balance: offer to work out where it should be by now.
        const today = state.data.settings.today;
        if (!l.id && body.start_date && body.start_date < today && body.balance_cents == null && body.principal_cents) {
          const guess = await api('POST', '/loans/estimate-balance', body);
          const est = guess.balance_cents;
          const pick = await askChoice({
            title: 'Work out the balance?',
            text: html`<p>This loan started ${fmtDate(body.start_date, true)} and has no balance yet.</p>
              <p><b>Yes</b> sets it to ${est != null ? html`about <b>${money(est)}</b>, ` : ''}what's left if only the minimum repayments were made${guess.repayments != null ? html`: ${guess.repayments} repayment${guess.repayments === 1 ? '' : 's'} of ${money(guess.repayment_cents)}, the amount borrowed plus interest spread evenly over the term` : ''}.</p>
              <p><b>No</b> keeps the full ${money(body.principal_cents)} borrowed as today's balance, until you update it.</p>`,
            choices: [{ label: 'Cancel', value: 'cancel' }, { label: 'No', value: 'no' }, { label: 'Yes', value: 'yes', primary: true }],
          });
          if (!pick || pick === 'cancel') throw new Error('');
          Object.assign(body, { balance_cents: pick === 'yes' && est != null ? est : body.principal_cents, balance_date: today });
        }
        await (l.id ? api('PATCH', `/loans/${l.id}`, body) : api('POST', '/loans', body));
        await reload();
        toast('Loan saved');
      },
      onDelete: l.id ? async () => { await api('DELETE', `/loans/${l.id}`); await reload(); } : null,
    });
  }

  // ---------- Settings ----------

  const SETTINGS_TABS = [['income', 'Income'], ['accounts', 'Accounts'], ['payees', 'Payees'], ['categories', 'Categories'], ['cycle', 'General'],
    ['appearance', 'Appearance'], ['security', 'Security'], ['updates', 'Updates'], ['backups', 'Backups'], ['advanced', 'Advanced'], ['price-checker', 'Price Checker']];

  // Setting up the budget, then the app itself. Each page keeps its old address, so links and bookmarks still work.
  const SETTINGS_GROUPS = [
    ['Your budget', ['income', 'accounts', 'payees', 'categories']],
    ['Site', ['cycle']],
    ['Appearance & Security', ['appearance', 'security']],
    ['Backups & Updates', ['updates', 'backups', 'advanced']],
    ['Apps', ['price-checker']],
  ];
  const settingsName = (k) => SETTINGS_TABS.find(([x]) => x === k)[1];

  // A side list of the groups on a computer. On a phone, Settings on its own is the list, and each
  // page has a back arrow to it.
  function renderSettings(sub) {
    if (sub === 'logins') sub = 'security'; // its old name
    const home = !SETTINGS_TABS.some(([k]) => k === sub);
    const tab = home ? 'income' : sub;
    const body = { income: settingsIncome, accounts: settingsAccounts, payees: settingsPayees, categories: settingsCategories, cycle: settingsCycle,
      appearance: themeCard, security: settingsSecurity, updates: settingsUpdates, backups: settingsBackups, advanced: settingsAdvanced, 'price-checker': settingsPriceChecker }[tab]();
    const group = SETTINGS_GROUPS.find(([, keys]) => keys.includes(tab))[0];
    return html`
      <div class="settings ${home ? 'settings-home' : ''}">
        <div class="page-head st-head"><h1>Settings</h1></div>
        <nav class="settings-nav" aria-label="Settings">${SETTINGS_GROUPS.map(([name, keys]) => html`<div class="sn-group">
          <h2 class="sn-head">${name}</h2>
          ${keys.map((k) => html`<a href="#/settings/${k}" ${!home && k === tab ? raw('aria-current="page"') : ''} class="${k === tab ? 'active' : ''} ${k === 'advanced' ? 'st-advanced' : ''}"><span class="sn-name">${settingsName(k)}</span>${k === 'updates' ? updTabDot() : ''}<span class="sn-go" aria-hidden="true">›</span></a>`)}</div>`)}</nav>
        <div class="settings-page">
          <div class="st-crumb"><a href="#/settings" class="st-back" aria-label="Back to Settings">‹ Settings</a><span class="st-where">${group}</span></div>
          <h2 class="st-title">${settingsName(tab)}</h2>
          ${body}
        </div>
      </div>`;
  }

  // Expandable table of this pay's incomes on the Overview. Rows open the edit popup.
  function incomeTable(c) {
    const t = c.totals;
    return html`
      <section class="card income-table" style="margin-bottom:16px">
        <div class="card-head"><div><h2>Income ${thisCycle()}</h2>
          <div class="muted small">Budget income ${money(t.income_cents)}${t.other_income_cents ? ` · Other income ${money(t.other_income_cents)}` : ''}</div></div>
          <button class="primary small" data-action="new-income">+ Add income</button></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th class="hide-sm">Paid by</th><th class="num">After tax</th><th class="num hide-sm">Before tax</th><th class="num hide-sm">Super</th><th>Pool</th></tr></thead>
          <tbody>${c.incomes.map((r) => {
            const i = byId(state.data.incomes, r.income_id) || {};
            return html`<tr class="clickable" data-action="edit-income" data-id="${r.income_id}">
              <td>${r.name}${untilTag(r)}</td><td class="hide-sm">${i.payer || ''}</td>
              <td class="num">${money(r.amount_cents)}${rhythm(r.pay_cents, r.frequency)}</td>
              <td class="num hide-sm">${i.before_tax_cents != null ? money(i.before_tax_cents) : ''}</td>
              <td class="num hide-sm">${i.super_cents != null ? money(i.super_cents) : ''}</td>
              <td>${r.in_budget ? html`<span class="chip current">Budget</span>` : html`<span class="chip other">Other</span>`}</td></tr>`;
          })}</tbody>
        </table></div>
      </section>`;
  }

  function settingsIncome() {
    const today = state.data.settings.today;
    const now = state.data.incomes.filter((i) => (!i.end_date || i.end_date >= today) && (!i.start_date || i.start_date <= today));
    const total = now.filter((i) => i.include_in_budget).reduce((s, i) => s + incomePerCycle(i), 0);
    const other = now.filter((i) => !i.include_in_budget).reduce((s, i) => s + incomePerCycle(i), 0);
    return html`
      <div class="card">
        <div class="card-head"><div><h2>Income</h2><p class="muted small" style="margin:2px 0 0">${money(total)} budget income ${aCycle()} after tax${other ? ` · ${money(other)} other income` : ''}</p></div>
          <button class="primary" data-action="new-income">+ Add income</button></div>
        ${state.data.incomes.length ? html`<ul class="list">${state.data.incomes.map((i) => html`
          <li class="clickable acct-line" data-action="edit-income" data-id="${i.id}" style="--acct:${incomeColor(i)}">
            <div class="grow"><div class="title">${i.name}${i.include_in_budget ? '' : html` <span class="chip other">Other income</span>`}${untilTag(i)}</div>
              <div class="meta">${[i.payer, i.before_tax_cents != null && `Before tax ${money(i.before_tax_cents)}`, i.super_cents != null && `Super ${money(i.super_cents)}`,
                i.start_date && `From ${fmtDate(i.start_date, true)}`].filter(Boolean).join(' · ')}</div></div>
            <div class="right"><div class="num" style="font-weight:700">${money(incomePerCycle(i))}</div><div class="meta">${aCycle()} after tax</div>
              ${(i.frequency || 'fortnightly') !== state.data.settings.pay_frequency ? html`<div class="meta num">(${money(i.after_tax_cents)} ${(INCOME_FREQ[i.frequency] || 'Fortnightly').toLowerCase()})</div>` : ''}</div>
          </li>`)}</ul>` : html`<p class="empty">No income added yet.</p>`}
      </div>`;
  }

  function incomeForm(i = {}) {
    openForm({
      title: i.id ? 'Edit income' : 'Add income',
      body: html`
        <div class="fields">
          <div class="field"><label for="i-name">Whose income</label><input id="i-name" name="name" value="${i.name || ''}" placeholder="e.g. Alex" required></div>
          <div class="field"><label for="i-payer">Paid by</label><input id="i-payer" name="payer" value="${i.payer || ''}" placeholder="Employer"></div>
          <div class="field"><label for="i-after">After tax per pay ($)</label><input id="i-after" name="after" inputmode="decimal" value="${moneyInput(i.after_tax_cents)}" required></div>
          <div class="field"><label for="i-freq">Paid</label><select id="i-freq" name="frequency">
            ${Object.entries(INCOME_FREQ).map(([k, v]) => html`<option value="${k}" ${k === (i.frequency || 'fortnightly') ? raw('selected') : ''}>${v}</option>`)}</select>
            <div class="hint">Can differ from the budget cycle. It's averaged per ${cycleWord()}.</div></div>
          <div class="field"><label for="i-before">Before tax ($, optional)</label><input id="i-before" name="before" inputmode="decimal" value="${moneyInput(i.before_tax_cents)}"></div>
          <div class="field"><label for="i-super">Super ($, optional)</label><input id="i-super" name="super" inputmode="decimal" value="${moneyInput(i.super_cents)}"></div>
          <div class="field"><label for="i-start">Starts (optional)</label><input id="i-start" type="date" name="start_date" value="${i.start_date || ''}"></div>
          <div class="field"><label for="i-color">Colour</label><input id="i-color" type="color" name="color" value="${incomeColor(i)}">
            <div class="hint">Used in the cash flow chart.</div></div>
          ${temporaryField(i, { start: false })}
          <div class="field full"><label class="check"><input type="checkbox" name="include_in_budget" ${i.include_in_budget === undefined || i.include_in_budget ? raw('checked') : ''}> Include in budget income (the expenses pool)</label>
            <div class="hint">Untick for income you don't want counted towards bills and deposits. It shows as Other income.</div></div>
        </div>`,
      onSave: async (form) => {
        const body = {
          name: val(form, 'name'), payer: val(form, 'payer'),
          after_tax_cents: moneyVal(form, 'after', 'After tax amount', { required: true }),
          before_tax_cents: moneyVal(form, 'before', 'Before tax'), super_cents: moneyVal(form, 'super', 'Super'),
          start_date: val(form, 'start_date') || null, ...temporaryVal(form), frequency: val(form, 'frequency'),
          include_in_budget: form.elements.include_in_budget.checked, color: val(form, 'color'),
        };
        if (body.start_date && body.end_date && body.end_date < body.start_date) throw new Error('The end date is before the start date.');
        if (!body.name) throw new Error('Please say whose income this is.');
        await (i.id ? api('PATCH', `/incomes/${i.id}`, body) : api('POST', '/incomes', body));
        await reload();
      },
      onDelete: i.id ? async () => { await api('DELETE', `/incomes/${i.id}`); await reload(); } : null,
    });
  }

  function settingsAccounts() {
    const accts = state.data.accounts;
    return html`
      <div class="card">
        <div class="card-head"><h2>Accounts</h2><button class="primary" data-action="new-account">+ Add account</button></div>
        ${accts.length ? html`<ul class="list">${accts.map((a, i) => html`
          <li>
            <span class="dot" style="background:${colorFor(a, i)}"></span>
            <div class="grow clickable" data-action="edit-account" data-id="${a.id}" style="cursor:pointer">
              <div class="title">${a.name}${a.nickname ? html` <span class="muted small">(${a.nickname})</span>` : ''}</div>
              <div class="meta">${[a.institution, a.type, a.owner].filter(Boolean).join(' · ')}</div>
              <div class="meta num">${[a.bsb && `BSB ${a.bsb}`, a.account_number && `Acc ${a.account_number}`].filter(Boolean).join(' · ')}</div>
              <div class="meta">Deposit ${aCycle()}: <b class="num">${money(depositFor(a.id))}</b></div>
            </div>
            <div class="row" style="flex-direction:column;gap:4px">
              ${a.bsb || a.account_number ? html`<button class="small" data-action="copy-account" data-id="${a.id}">Copy</button>` : ''}
              <div class="row" style="gap:4px">
                <button class="icon ghost" data-action="move-account" data-id="${a.id}" data-dir="-1" ${i === 0 ? raw('disabled') : ''} aria-label="Move up">↑</button>
                <button class="icon ghost" data-action="move-account" data-id="${a.id}" data-dir="1" ${i === accts.length - 1 ? raw('disabled') : ''} aria-label="Move down">↓</button>
              </div>
            </div>
          </li>`)}</ul>` : html`<p class="empty">No accounts yet.</p>`}
      </div>`;
  }

  function accountForm(a = {}) {
    const i = a.id ? state.data.accounts.indexOf(a) : state.data.accounts.length;
    const s = state.data.settings;
    openForm({
      title: a.id ? 'Edit account' : 'Add account',
      body: html`
        <div class="fields">
          <div class="field full"><label for="a-name">Name</label><input id="a-name" name="name" value="${a.name || ''}" placeholder="e.g. Bills" required></div>
          <div class="field"><label for="a-nick">Nickname</label><input id="a-nick" name="nickname" value="${a.nickname || ''}"></div>
          <div class="field"><label for="a-inst">Bank</label><input id="a-inst" name="institution" value="${a.institution || ''}"></div>
          <div class="field"><label for="a-type">Type</label><input id="a-type" name="type" value="${a.type || ''}" placeholder="e.g. Savings"></div>
          <div class="field"><label for="a-owner">Owner</label><input id="a-owner" name="owner" value="${a.owner || ''}"></div>
          <div class="field"><label for="a-bsb">BSB</label><input id="a-bsb" name="bsb" inputmode="numeric" data-input="bsb" maxlength="7" autocomplete="off" value="${a.bsb || ''}" placeholder="000-000">
            <div class="hint">6 digits. The dash is added for you.</div></div>
          <div class="field"><label for="a-acc">Account number</label><input id="a-acc" name="account_number" inputmode="numeric" data-input="account-number" maxlength="30" autocomplete="off" value="${a.account_number || ''}">
            <div class="hint">Numbers only.</div></div>
          <div class="field"><label for="a-color">Colour</label><input id="a-color" type="color" name="color" value="${colorFor(a, i)}"></div>
          <div class="field full form-sub"><b>Deposit</b><div class="hint">This account's deposit is the per-${cycleWord()} total of its bills and savings plus the buffer, then rounded up,
            so it's a round number. For example $301 with a 10% buffer is $331.10, and rounded up to $10 that's $340.</div></div>
          <div class="field"><label for="a-rounding">Rounding</label><select id="a-rounding" name="rounding">
            ${Object.entries(ROUNDING_LABELS).map(([k, v]) => html`<option value="${k}" ${k === (a.rounding ?? s.rounding) ? raw('selected') : ''}>${v}</option>`)}</select></div>
          <div class="field"><label for="a-buffer">Buffer (%)</label><input id="a-buffer" name="buffer_percent" type="number" inputmode="numeric" min="0" max="20" step="1" value="${a.buffer_percent ?? s.buffer_percent}">
            <div class="hint">0 to 20. Extra on top, for prices that go up.</div></div>
        </div>`,
      onSave: async (form) => {
        const body = Object.fromEntries(['name', 'nickname', 'institution', 'type', 'owner', 'bsb', 'account_number', 'color'].map((k) => [k, val(form, k)]));
        const pct = Number(form.elements.buffer_percent.value || 0);
        if (!Number.isInteger(pct) || pct < 0 || pct > 20) throw new Error('The buffer needs to be a whole number from 0 to 20.');
        Object.assign(body, { rounding: form.elements.rounding.value, buffer_percent: pct });
        if (!body.name) throw new Error('Please give the account a name.');
        if (body.bsb && !/^\d{3}-\d{3}$/.test(body.bsb)) throw new Error('The BSB needs 6 digits, like 062-000.');
        if (body.account_number && !/^\d{1,20}$/.test(body.account_number)) throw new Error('The account number can only have numbers, up to 20 digits.');
        if (!a.id) body.sort_order = state.data.accounts.length;
        await (a.id ? api('PATCH', `/accounts/${a.id}`, body) : api('POST', '/accounts', body));
        await reload();
      },
      onDelete: a.id ? async () => {
        const n = state.data.expenses.filter((e) => e.account_id === a.id).length;
        if (n && !confirm(`${n} expense${n === 1 ? '' : 's'} use this account and will be left without one. Continue?`)) throw new Error('Not deleted.');
        await api('DELETE', `/accounts/${a.id}`);
        await reload();
      } : null,
    });
  }

  const PAY_TYPES = { bpay: 'BPAY', transfer: 'Bank transfer', direct_debit: 'Direct Debit', other: 'Other' };

  // One line of payment details for a payee, e.g. "BPAY 12345 · Ref 678".
  function payeeDetails(p) {
    const policy = p.policy_number && `Acc/policy ${p.policy_number}`;
    if (p.pay_type === 'bpay') return [policy, p.biller_code && `BPAY ${p.biller_code}`, p.reference && `Ref ${p.reference}`];
    if (p.pay_type === 'transfer') {
      return [policy, p.account_name, p.bank, p.bsb && `BSB ${p.bsb}`, p.account_number && `Acc ${p.account_number}`, p.reference && `Ref ${p.reference}`];
    }
    if (p.pay_type === 'direct_debit') return [policy, p.reference && `Ref ${p.reference}`];
    return [policy, p.reference];
  }

  function settingsPayees() {
    return html`
      <div class="card">
        <div class="card-head"><h2>Payees</h2><button class="primary" data-action="new-payee">+ Add payee</button></div>
        ${state.data.payees.length ? html`<ul class="list">${state.data.payees.map((p) => {
          const n = state.data.expenses.filter((e) => e.payee_id === p.id).length;
          return html`<li class="clickable" data-action="edit-payee" data-id="${p.id}">
            <div class="grow"><div class="title">${p.name}${p.pay_type ? html` <span class="chip">${PAY_TYPES[p.pay_type]}</span>` : ''}</div>
              <div class="meta num">${[...payeeDetails(p), p.notes].filter(Boolean).join(' · ')}</div></div>
            <span class="muted small">${n} bill${n === 1 ? '' : 's'}</span></li>`;
        })}</ul>` : html`<p class="empty">No payees yet.</p>`}
      </div>`;
  }

  function payeeFields(type, p) {
    const f = (id, name, label, extra = '') => html`<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${name}" value="${p[name] || ''}" ${raw(extra)}></div>`;
    if (type === 'bpay') {
      return html`<div class="fields">${f('p-biller', 'biller_code', 'Biller code', 'inputmode="numeric"')}${f('p-ref', 'reference', 'Reference (CRN)')}</div>`;
    }
    if (type === 'transfer') {
      return html`<div class="fields">
        ${f('p-accname', 'account_name', 'Account name')}${f('p-bank', 'bank', 'Bank')}
        ${f('p-bsb', 'bsb', 'BSB', 'inputmode="numeric" data-input="bsb" maxlength="7" autocomplete="off" placeholder="000-000"')}
        ${f('p-acc', 'account_number', 'Account number', 'inputmode="numeric" data-input="account-number" maxlength="30" autocomplete="off"')}
        <div class="field full"><label for="p-ref">Reference</label><input id="p-ref" name="reference" value="${p.reference || ''}"></div></div>`;
    }
    const label = type === 'direct_debit' ? 'Reference' : 'Biller / reference';
    return html`<div class="field"><label for="p-ref">${label}</label><input id="p-ref" name="reference" value="${p.reference || ''}"></div>`;
  }

  function payeeForm(saved = {}) {
    const p = { ...saved }; // typing into the form mustn't change the saved payee until Save
    let type = p.pay_type || 'other';
    openForm({
      title: p.id ? 'Edit payee' : 'Add payee',
      body: html`
        <div class="fields">
          <div class="field"><label for="p-name">Name</label><input id="p-name" name="name" value="${p.name || ''}" required></div>
          <div class="field"><label for="p-type">How it's paid</label><select id="p-type" name="pay_type">
            ${Object.entries(PAY_TYPES).map(([k, v]) => html`<option value="${k}" ${k === type ? raw('selected') : ''}>${v}</option>`)}</select></div>
          <div class="field full"><label for="p-policy">Account / policy number</label><input id="p-policy" name="policy_number" value="${p.policy_number || ''}" autocomplete="off">
            <div class="hint">The number the biller knows you by (customer, account or policy number).</div></div>
        </div>
        <div id="pay-fields">${payeeFields(type, p)}</div>
        <div class="field"><label for="p-notes">Notes</label><textarea id="p-notes" name="notes" rows="2">${p.notes || ''}</textarea></div>`,
      afterRender: (form) => {
        form.elements.pay_type.addEventListener('change', () => {
          // Keep what's been typed so far when switching type.
          const typed = Object.fromEntries(['reference', 'biller_code', 'bank', 'bsb', 'account_number', 'account_name']
            .map((k) => [k, form.elements[k] ? form.elements[k].value : p[k]]));
          Object.assign(p, typed);
          type = form.elements.pay_type.value;
          form.querySelector('#pay-fields').innerHTML = payeeFields(type, p).s;
        });
      },
      onSave: async (form) => {
        const body = { name: val(form, 'name'), notes: val(form, 'notes'), pay_type: type, reference: val(form, 'reference') || null,
          policy_number: val(form, 'policy_number') || null };
        // Only keep the details that belong to the chosen type.
        for (const k of ['biller_code', 'bank', 'bsb', 'account_number', 'account_name']) body[k] = val(form, k) || null;
        if (!body.name) throw new Error('Please give the payee a name.');
        if (body.bsb && !/^\d{3}-\d{3}$/.test(body.bsb)) throw new Error('The BSB needs 6 digits, like 062-000.');
        await (p.id ? api('PATCH', `/payees/${p.id}`, body) : api('POST', '/payees', body));
        await reload();
      },
      onDelete: p.id ? async () => { await api('DELETE', `/payees/${p.id}`); await reload(); } : null,
    });
  }

  function settingsCategories() {
    return html`
      <div class="page-head" style="margin-bottom:12px"><p class="muted small" style="margin:0">Tap a category name to rename it or change its colour.</p>
        <button class="primary" data-action="new-category">+ Add category</button></div>
      ${state.data.categories.map((c, i) => html`
        <section class="card section">
          <div class="card-head">
            <button class="acct-btn" data-action="edit-category" data-id="${c.id}" style="text-decoration:none">
              <span class="dot" style="display:inline-block;vertical-align:-1px;margin-right:6px;background:${colorFor(c, i)}"></span>${c.name}</button>
            <button class="small" data-action="new-subcategory" data-id="${c.id}">+ Sub category</button>
          </div>
          <div class="tags">${c.subcategories.length ? c.subcategories.map((s) => html`
            <span class="tag"><span data-action="rename-subcategory" data-id="${s.id}" style="cursor:pointer">${s.name}</span>
              <button data-action="delete-subcategory" data-id="${s.id}" aria-label="Remove ${s.name}">×</button></span>`)
            : html`<span class="muted small">No sub categories.</span>`}</div>
        </section>`)}`;
  }

  function categoryForm(c = {}) {
    const i = c.id ? state.data.categories.indexOf(c) : state.data.categories.length;
    openForm({
      title: c.id ? 'Edit category' : 'Add category',
      body: html`
        <div class="field"><label for="c-name">Name</label><input id="c-name" name="name" value="${c.name || ''}" required></div>
        <div class="field"><label for="c-color">Colour</label><input id="c-color" type="color" name="color" value="${colorFor(c, i)}"></div>
        ${c.id ? html`<p class="hint">Deleting a category also removes its sub categories. Expenses using it will become uncategorised.</p>` : ''}`,
      onSave: async (form) => {
        const body = { name: val(form, 'name'), color: val(form, 'color') };
        if (!body.name) throw new Error('Please give the category a name.');
        if (!c.id) body.sort_order = state.data.categories.length;
        await (c.id ? api('PATCH', `/categories/${c.id}`, body) : api('POST', '/categories', body));
        await reload();
      },
      onDelete: c.id ? async () => { await api('DELETE', `/categories/${c.id}`); await reload(); } : null,
    });
  }

  function settingsCycle() {
    const s = state.data.settings;
    return html`
      <div class="card">
        <h2>Budget cycle</h2>
        <p class="muted small">How often you budget, and any one day a cycle starts (past or future). The Overview, expenses and each
          account's deposit are worked out per cycle. Each income has its own pay frequency, so you can be paid fortnightly but budget monthly.</p>
        <form id="cycle-form">
          <div class="fields">
            <div class="field"><label for="payfreq">Budget</label><select id="payfreq" name="pay_frequency">
              ${Object.entries({ weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', custom: 'Custom' }).map(([k, v]) => html`<option value="${k}" ${k === s.pay_frequency ? raw('selected') : ''}>${v}</option>`)}</select></div>
            <div class="field" id="custom-days" ${s.pay_frequency === 'custom' ? '' : raw('hidden')}><label for="paydays">Every (days)</label>
              <input id="paydays" name="pay_custom_days" type="number" min="1" max="366" inputmode="numeric" value="${s.pay_custom_days || 14}"></div>
            <div class="field"><label for="anchor">A cycle start day</label><input id="anchor" type="date" name="pay_anchor_date" value="${s.pay_anchor_date}" required></div>
          </div>
          <button class="primary" type="submit">Save</button>
        </form>
        <p class="hint">${s.pay_frequency === 'monthly' ? `Each cycle starts on the ${ordinal(Number(s.pay_anchor_date.slice(8)))} of the month.`
          : `Currently each cycle starts on a ${weekdayFor(0, true)}.`} Usually this is a pay day. Weekly and fortnightly bills are counted from it.</p>
      </div>`;
  }

  // Everyone shares the same budget. A login is just a password with a name, so each person can have their own theme.
  // ---------- Updates ----------

  // What the server last heard from GitHub. It checks every few hours itself;
  // the page asks it now and then, and "Check now" asks GitHub straight away.
  async function loadUpdates(force) {
    try { state.updates = await api(force ? 'POST' : 'GET', force ? '/updates/check' : '/updates'); } catch { return; }
    showUpdateBadge();
  }
  function showUpdateBadge() {
    const u = state.updates;
    const on = Boolean(u && u.available);
    document.getElementById('update-pill').hidden = !on;
    document.querySelector('.menu-btn').classList.toggle('has-update', on);
    const item = document.getElementById('menu-update');
    item.hidden = !on;
    if (on) item.textContent = `Update to v${u.latest.version}`;
    // Red until the updater has its own password (only the main login runs the server).
    const fix = needsToken(u);
    for (const dot of document.querySelectorAll('.st-dot')) { dot.hidden = !on && !fix; dot.classList.toggle('st-dot-warn', fix); }
    document.getElementById('settings-dot').hidden = !fix;
  }

  // Just enough Markdown for release notes: headings, bullets, bold and code.
  function releaseNotes(text) {
    const inline = (t) => html`${t}`.s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    let out = ''; let list = false;
    for (const line of String(text || '').split(/\r?\n/)) {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) { if (!list) { out += '<ul>'; list = true; } out += `<li>${inline(bullet[1])}</li>`; continue; }
      if (list) { out += '</ul>'; list = false; }
      const head = /^#{1,6}\s+(.*)$/.exec(line);
      if (head) out += `<h4>${inline(head[1])}</h4>`;
      else if (line.trim()) out += `<p>${inline(line)}</p>`;
    }
    if (list) out += '</ul>';
    return raw(out || '<p class="muted">No release notes.</p>');
  }

  // Release notes written for the household: "New: …", "Improved: …" and "Fixed: …"
  // lines, or bullets under "### New" (or Added), "### Improved" (or Changed) and "### Fixed".
  const NOTE_KINDS = { new: 'new', added: 'new', improved: 'improved', changed: 'improved', fixed: 'fixed', fixes: 'fixed', security: 'fixed' };
  function noteItems(text) {
    const items = []; let section = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const head = /^#{1,6}\s+(.*)$/.exec(line);
      if (head) { section = NOTE_KINDS[head[1].toLowerCase().replace(/[^a-z]/g, '')] || null; continue; }
      const tagged = /^\s*(?:[-*]\s+)?(new|improved|fixed)\s*:\s*(.+)$/i.exec(line);
      if (tagged) { items.push({ kind: tagged[1].toLowerCase(), text: tagged[2] }); continue; }
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet && section) items.push({ kind: section, text: bullet[1] });
    }
    return items;
  }
  const noteInline = (t) => raw(html`${t}`.s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>'));

  // A release's "### Extra steps": what to do on the server besides Update now, as its words and
  // the commands in its code block (run in the app's folder).
  function extraSteps(text) {
    const out = { words: [], commands: [] };
    let inside = false; let code = false;
    for (const line of String(text || '').split(/\r?\n/)) {
      const head = /^#{1,6}\s+(.*)$/.exec(line);
      if (head && !code) { inside = /^extra steps?$/i.test(head[1].trim()); continue; }
      if (!inside) continue;
      if (/^\s*```/.test(line)) { code = !code; continue; }
      if (code) { if (line.trim()) out.commands.push(line.trim()); continue; }
      if (line.trim()) out.words.push(line.replace(/^\s*[-*]\s+/, '').trim());
    }
    return out.words.length || out.commands.length ? out : null;
  }
  const versionAfter = (a, b) => {
    const x = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const y = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  // The extra steps of every release from (not including) one version up to another, oldest first.
  const stepsBetween = (u, from, to) => (u.releases || [])
    .filter((r) => versionAfter(r.version, from) && !versionAfter(r.version, to))
    .map((r) => ({ version: r.version, steps: extraSteps(r.notes) })).filter((r) => r.steps).reverse();
  // The commands to copy: into the app's folder first, when it's been saved.
  const stepCommands = (u, list) => {
    const lines = list.flatMap((r) => r.steps.commands);
    if (!lines.length) return '';
    return [u.server_folder ? `cd "${u.server_folder}"` : null, ...lines].filter(Boolean).join('\n');
  };
  function extraStepsCard(u, list, when) {
    if (!list.length) return '';
    const cmds = stepCommands(u, list);
    return html`<div class="upd-extra">
      <div class="upd-extra-head"><b>Extra steps ${when}</b>${cmds ? html`<button class="mini" data-action="copy-extra-steps" data-cmds="${cmds}">Copy commands</button>` : ''}</div>
      ${list.map((r) => html`${list.length > 1 ? html`<div class="upd-extra-ver mono">v${r.version}</div>` : ''}${r.steps.words.map((w) => html`<p class="small">${noteInline(w)}</p>`)}`)}
      ${cmds ? html`<pre class="upd-cmd">${cmds}</pre>
        ${u.server_folder ? '' : html`<p class="small muted">Run these in the app's folder on the server. Save the folder under Preferences and it's included for you.</p>`}` : ''}
    </div>`;
  }

  // "Today, 7:42 pm", "Yesterday, …" or "Thu 1 Oct, …".
  function updWhen(iso) {
    const d = new Date(iso);
    const day = localDate(d);
    const today = localDate(new Date());
    const label = day === today ? 'Today' : day === addDaysIso(today, -1) ? 'Yesterday' : fmtDate(day, day.slice(0, 4) !== today.slice(0, 4));
    return `${label}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const fileSize = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  // The logo's ring, drawn in the current colour.
  const ringSvg = (cls = '') => raw(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="3.6" pathLength="100" stroke-dasharray="44 6 25 6 13 6" transform="rotate(-90 12 12)"/></svg>`);

  function settingsUpdates() {
    const u = state.updates;
    if (!u) return html`<div class="card"><p class="muted">Couldn't load update details.</p></div>`;
    const main = Boolean(state.me && state.me.main);
    return html`
      ${u.default_token ? updTokenCard() : ''}
      ${updMainCard(u, main)}
      <div class="upd-grid">
        ${updNotesCard(u)}
        <div class="upd-side">${updPrefsCard(u, main)}</div>
      </div>`;
  }

  // The Updates tab's dot: brand-coloured for a new version, red while the updater needs its own password.
  function updTabDot() {
    const u = state.updates;
    const fix = needsToken(u);
    return html`<span class="st-dot ${fix ? 'st-dot-warn' : ''}" ${(u && u.available) || fix ? '' : raw('hidden')}></span>`;
  }

  // Red dots for the updater password: main login only (it runs the server), and not once ignored.
  const needsToken = (u) => Boolean(u && u.default_token && !u.token_ignored && state.me && state.me.main);

  // This copy still uses the updater password every copy starts with. Ignoring it folds
  // the card to its heading (+ opens it again) and hides the red dots.
  function updTokenCard() {
    const u = state.updates;
    const main = Boolean(state.me && state.me.main);
    const open = !u.token_ignored || state.tokenOpen;
    const head = u.token_ignored
      ? html`<button type="button" class="upd-token-head" data-action="toggle-token-card" aria-expanded="${open ? 'true' : 'false'}">
          <h2>Give the updater its own password</h2><span class="upd-token-plus" aria-hidden="true">${open ? '−' : '+'}</span></button>`
      : html`<h2>Give the updater its own password</h2>`;
    if (!open) return html`<div class="card adv-warning upd-token folded">${head}</div>`;
    return html`<div class="card adv-warning upd-token">
      ${head}
      <p class="small">This copy's updater still has the password every copy of Simple Budget starts with. The updater can restart the app
        and install new versions, and its password is how it knows a request really came from your copy. Its port is never opened, so
        only something already running on the server could use it.</p>
      <ul class="small upd-risk">
        <li><b>Only you on your home network:</b> low risk, but still recommended.</li>
        <li><b>Others use your network or the server</b> (housemates, guests, other apps or containers on it): higher risk. Change it now.</li>
        <li><b>Opened to the internet</b> (port forwarding): strongly advised against, whatever this password. Use a VPN such as WireGuard or Tailscale to reach it from outside instead.</li>
      </ul>
      <p class="small">In the app's folder on the server, run these two commands once. Updating works the same way afterwards.</p>
      <pre class="upd-cmd">${TOKEN_CMD}</pre>
      <div class="row"><button data-action="copy-token-cmd">Copy commands</button>
        ${main ? html`<button data-action="ignore-token" data-on="${u.token_ignored ? '0' : '1'}">${u.token_ignored ? 'Stop ignoring' : 'Ignore'}</button>` : ''}</div>
    </div>`;
  }
  // printf starts a new line first, in case .env doesn't end with one.
  const TOKEN_CMD = 'printf \'\\nUPDATER_TOKEN=%s\\n\' "$(openssl rand -hex 24)" | sudo tee -a .env\nsudo docker compose up -d';

  // The one card at the top, which changes with what's happening.
  function updMainCard(u, main) {
    const l = u.latest;
    const i = state.updateInstall;
    const failed = state.updateFailed;
    const tag = { test: 'Test', beta: 'Beta' }[u.channel];
    let s;
    if (i) {
      s = { mode: 'busy', eyebrow: "Updating · Don't close this tab", title: `Installing v${i.version}…`,
        sub: i.slow ? 'This is taking longer than usual. The new version may still be downloading. If nothing changes, check both containers are running (sudo docker compose ps).'
          : 'You can keep this tab open. It reloads by itself when the app is back.' };
    } else if (failed) {
      s = { mode: 'bad', eyebrow: 'Update failed', title: `Couldn't install v${failed.version}`, sub: html`Nothing was changed. Your data is safe.<br><span class="upd-err">${failed.error}</span>`,
        primary: main && u.available && u.can_install ? ['install-update', 'Try again'] : null,
        secondary: state.backups && state.backups.backups.length ? ['upd-to-backups', 'Restore backup'] : ['upd-dismiss-failed', 'Dismiss'] };
    } else if (u.available) {
      const behind = u.behind > 1 ? ` · ${u.behind} versions behind` : ' · 1 version behind';
      s = { mode: 'new', eyebrow: `Update available${behind}`, title: `Simple Budget v${l.version} is ready`, secondary: ['check-updates', 'Check again'] };
      s.extra = extraStepsCard(u, stepsBetween(u, u.current, l.version), 'for this update');
      if (u.can_install && u.building) {
        s.title = `Simple Budget v${l.version} is on its way`;
        s.sub = "It's still being built on GitHub, which takes a few minutes after it's published. This page checks again by itself.";
        updWatchBuild();
      } else if (u.can_install) {
        s.sub = main ? "About 1–2 minutes. Your data is backed up first, and the page reloads by itself when it's done."
          : 'Ask whoever has the main login to install it. It takes about 1–2 minutes.';
        if (main) s.primary = ['install-update', 'Update now'];
      } else if (u.track === 'pinned') {
        s.sub = html`This copy is kept on v${u.image_tag} by <code>IMAGE_TAG</code> in .env. Change it to <code>latest</code> and run <code>sudo docker compose up -d</code> to follow new releases.`;
      } else {
        s.sub = "This copy is updated from the terminal. In its folder on the server, run the two commands below. Your data stays as it is.";
        s.primary = ['copy-update-cmd', 'Copy commands'];
        s.extra = html`<pre class="upd-cmd">git pull
sudo docker compose up -d --build</pre>${s.extra}`;
      }
    } else if (u.waiting) {
      s = { mode: 'ok', eyebrow: 'New version · waiting a day', title: `Simple Budget v${u.waiting.version} is out`,
        sub: `It'll be offered ${offerWhen(u.waiting.offer_at)}, a day after it came out, in case it's pulled. You can turn the wait off under Preferences.`,
        secondary: ['check-updates', 'Check again'] };
    } else if (u.just_updated) {
      s = { mode: 'done', eyebrow: 'Updated', title: `Welcome to v${u.current}`,
        sub: u.just_updated.backup ? 'Everything went smoothly. Your backup is listed under Backups if you ever need it.' : 'Everything went smoothly.',
        primary: ['upd-see-new', "See what's new"], secondary: ['upd-dismiss', 'Dismiss'] };
      // Steps the versions just installed need, if they haven't been done.
      if (u.just_updated.from) s.extra = extraStepsCard(u, stepsBetween(u, u.just_updated.from, u.current), 'to finish this update');
    } else if (u.error) {
      s = { mode: 'warn', eyebrow: "Couldn't check", title: "Couldn't reach GitHub", sub: u.error, secondary: ['check-updates', 'Try again'] };
    } else if (!u.checkedAt) {
      s = { mode: 'ok', eyebrow: 'Not checked yet', title: `You're on v${u.current}`, sub: 'Automatic checks are off. Check now and then for new versions.', secondary: ['check-updates', 'Check now'] };
    } else if (!l) {
      s = { mode: 'ok', eyebrow: 'Up to date', title: 'No releases on GitHub yet', sub: `Simple Budget v${u.current}.`, secondary: ['check-updates', 'Check now'] };
    } else {
      const installed = u.installed_at ? ` · installed ${fmtDate(localDate(new Date(u.installed_at)), true)}` : '';
      s = { mode: 'ok', eyebrow: 'Up to date', title: "You're on the latest version",
        sub: `Simple Budget v${u.current}${installed}. ${u.auto_check ? "We'll let you know when there's something new." : 'Automatic checks are off, so check now and then.'}`,
        secondary: ['check-updates', 'Check now'] };
    }
    const icon = s.mode === 'done' ? html`<span class="upd-tick">✓</span>` : s.mode === 'bad' || s.mode === 'warn' ? html`<span class="upd-tick">!</span>` : ringSvg(s.mode === 'busy' ? 'spin' : '');
    const channel = u.track === 'pinned' ? `Pinned to v${u.image_tag}` : u.track === 'beta' ? 'Beta' : 'Stable';
    return html`<section class="card upd-main" data-mode="${s.mode}" ${i ? raw('aria-live="polite"') : ''}>
      ${ringSvg('upd-bg-ring')}
      <div class="upd-row">
        <div class="upd-tile">${icon}</div>
        <div class="upd-text">
          <div class="upd-eyebrow">${s.eyebrow}</div>
          <h2 class="upd-title">${s.title}</h2>
          <p class="upd-sub">${s.sub}</p>
        </div>
        ${s.primary || s.secondary ? html`<div class="upd-actions">
          ${s.primary ? html`<button class="primary upd-primary" data-action="${s.primary[0]}">${s.primary[1]}</button>` : ''}
          ${s.secondary ? html`<button class="linkish" data-action="${s.secondary[0]}">${s.secondary[1]}</button>` : ''}
        </div>` : ''}
      </div>
      ${s.extra || ''}
      ${i ? updSteps(i) : ''}
      <div class="upd-foot">
        <span>This copy <b class="mono">v${u.current}</b>${tag ? html` <span class="build-tag" data-channel="${u.channel}">${tag}</span>` : ''}</span>
        <span>Latest <b class="mono">${l ? `v${l.version}` : '—'}</b></span>
        <span>Channel <b>${channel}</b></span>
        <span>Checked <b>${u.checkedAt ? updWhen(u.checkedAt) : 'not yet'}</b> · ${u.auto_check ? everyHours(u.interval_hours) : 'automatic checks off'}</span>
      </div>
    </section>`;
  }

  // While a new version's image is still being built, look again every minute.
  function updWatchBuild() {
    if (state.buildTimer) return;
    state.buildTimer = setTimeout(async () => {
      state.buildTimer = null;
      if (!state.updates || !state.updates.building || state.updateInstall) return;
      await loadUpdates(true);
      if (location.hash.startsWith('#/settings/updates')) render();
    }, 60 * 1000);
  }

  // "later today at 7:42 pm", "tomorrow at …" or "on Wed 14 Oct at …".
  function offerWhen(iso) {
    const d = new Date(iso);
    const day = localDate(d);
    const today = localDate(new Date());
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (day <= today) return `later today at ${time}`;
    return `${day === addDaysIso(today, 1) ? 'tomorrow' : `on ${fmtDate(day)}`} at ${time}`;
  }
  const everyHours = (h) => (h === 1 ? 'every hour' : h === 24 ? 'once a day' : `every ${h} hours`);

  // The four steps of an update. The server says when the backup is done; the rest
  // is seen from here: it stops answering while it restarts, then answers on the new version.
  function updSteps(i) {
    const steps = [
      ['Backing up', i.backup ? html`<span class="mono">${i.backup}</span>` : 'Saving a copy of your data'],
      ['Downloading', `v${i.version} from GitHub`],
      ['Restarting', 'Usually 20–40 seconds'],
      ['Checking', 'Making sure your data opens'],
    ];
    return html`<ol class="upd-steps">${steps.map(([label, sub], n) => {
      const st = n + 1 < i.step ? 'done' : n + 1 === i.step ? 'active' : 'wait';
      return html`<li class="${st}"><span class="upd-bar"></span>
        <span class="upd-step-lbl">${st === 'done' ? '✓' : st === 'active' ? '●' : '○'} ${label}</span>
        <span class="upd-step-sub">${sub}</span></li>`;
    })}</ol>`;
  }

  function updNotesCard(u) {
    const all = u.releases || [];
    // What's offered (u.latest), which may not be the newest release while a new one waits a day.
    const latest = u.latest && all.find((r) => r.version === u.latest.version);
    const waiting = u.waiting && all.find((r) => r.version === u.waiting.version);
    const mine = all.find((r) => r.version === u.current);
    const show = u.available ? [...new Set([waiting, latest, mine].filter(Boolean))] : all.slice(0, 2);
    const repo = all[0] ? all[0].url.replace(/\/releases\/.*$/, '/releases') : null;
    const kindLabel = { new: 'New', improved: 'Improved', fixed: 'Fixed' };
    return html`<section class="card upd-notes-card" id="upd-notes">
      <div class="upd-card-head"><div><h3>What's new</h3>
        <p class="upd-card-sub">${u.available ? "What you'll get, plus what's in your current version" : 'Recent releases'}</p></div>
        ${repo ? html`<a href="${repo}" target="_blank" rel="noopener">Full notes on GitHub ↗</a>` : ''}</div>
      ${show.length ? show.map((r) => {
        const items = noteItems(r.notes);
        const badge = r.version === u.current ? html`<span class="upd-badge">Installed</span>`
          : u.available && r === latest ? html`<span class="upd-badge new">Not installed</span>`
          : u.waiting && r.version === u.waiting.version ? html`<span class="upd-badge">Waiting a day</span>` : '';
        return html`<div class="upd-release ${r.version === u.current ? 'mine' : ''}">
          <div class="upd-release-head"><a class="mono" href="${r.url}" target="_blank" rel="noopener">v${r.version}</a>
            ${r.published_at ? html`<span class="upd-date">${fmtDate(localDate(new Date(r.published_at)), true)}</span>` : ''}
            ${r.prerelease ? html`<span class="build-tag" data-channel="beta">Beta</span>` : ''}${badge}</div>
          ${items.length ? html`<ul class="upd-items">${items.map((it) => html`<li><span class="upd-kind ${it.kind}">${kindLabel[it.kind]}</span><span>${noteInline(it.text)}</span></li>`)}</ul>`
            : html`<div class="upd-notes">${releaseNotes(r.notes)}</div>`}
        </div>`;
      }) : html`<p class="muted small">${u.checkedAt ? 'No releases on GitHub yet.' : 'Check for updates to see the latest release notes.'}</p>`}
    </section>`;
  }

  // Backups & Updates → Backups: the copies kept on the server, a file to download or restore, and
  // how much room it all takes.
  function settingsBackups() {
    const main = Boolean(state.me && state.me.main);
    return html`
      ${updBackupsCard(main)}
      <div class="card">
        <h2>Download or restore a backup file</h2>
        <p class="muted small">Download everything (accounts, income, payees, categories, expenses, savings, loans, goals, debts, shopping and these settings)
          as a file you can keep somewhere safe. Restoring a backup <b>replaces</b> what's in the app now. Your password isn't included or changed.</p>
        <div class="row">
          <a class="btn" href="api/export" download>Download backup</a>
          ${main ? html`<label class="btn" style="margin:0;font-size:inherit">Restore from backup…
            <input type="file" accept="application/json,.json" data-input="restore" hidden></label>` : ''}
        </div>
        ${main ? '' : html`<p class="muted small">Only the main login can restore a backup.</p>`}
      </div>
      ${storageCard()}`;
  }

  // Read-only: what the app's files take up on the server.
  function storageCard() {
    const st = state.storage;
    const row = (label, sub, bytes) => html`<li><span class="grow"><span>${label}</span>${sub ? html`<span class="muted small"> · ${sub}</span>` : ''}</span><b>${bytes == null ? '—' : bytes ? fileSize(bytes) : 'None'}</b></li>`;
    return html`<div class="card storage-card" id="storage">
      <h2>Storage</h2>
      ${!st ? html`<p class="muted small">Couldn't load how much room the app takes.</p>` : html`<ul class="list adv-info">
        ${row('Database', 'your budget, shopping and settings', st.database)}
        ${row('Backups', `${st.backups_count} kept on the server`, st.backups)}
        ${st.free != null ? row('Free space on the server', 'where the app keeps its data', st.free) : ''}
      </ul>`}
    </div>`;
  }

  // Apps → Price Checker: whether the optional price-checker is set up and answering, and the Coles button.
  const CHECKER_CMD = "printf '\\nCOMPOSE_PROFILES=prices\\nPRICE_CHECKER_URL=http://price-checker:8090\\nPRICE_CHECKER_TOKEN=%s\\n' \"$(openssl rand -hex 24)\" | sudo tee -a .env\nsudo docker compose up -d";
  function settingsPriceChecker() {
    const c = state.checkerStatus;
    const names = { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Aldi' };
    let status;
    if (!c) status = html`<p class="muted small">Couldn't load the price checker's status.</p>`;
    else if (!c.set_up) {
      status = html`<div class="pc-state"><span class="pc-dot off"></span><b>Not set up</b></div>
        <p class="small">The price checker is an optional second container that looks up Woolworths, Coles and Aldi prices for the Shopping tab, the way a person would in a browser.
          It's a big download the first time (about 2 GB). To add it, run these in the app's folder on the server:</p>
        <pre class="upd-cmd">${CHECKER_CMD}</pre>
        <div class="row"><button type="button" data-action="copy-checker-cmd">Copy commands</button></div>`;
    } else if (!c.reachable) {
      status = html`<div class="pc-state"><span class="pc-dot bad"></span><b>Not answering</b></div>
        <p class="small">${c.error || "Couldn't reach it."} In the app's folder on the server, <code>sudo docker compose up -d</code> starts it again.</p>`;
    } else if (!c.token_ok) {
      status = html`<div class="pc-state"><span class="pc-dot bad"></span><b>Wrong password</b></div>
        <p class="small">It's running, but didn't accept the app's password. <code>PRICE_CHECKER_TOKEN</code> in .env should be the same for both. After fixing it, run <code>sudo docker compose up -d</code>.</p>`;
    } else {
      status = html`<div class="pc-state"><span class="pc-dot ok"></span><b>Running</b>${c.busy ? html`<span class="muted small"> · checking prices now</span>` : ''}</div>
        <p class="small muted">It updates with the app from Backups & Updates.</p>`;
    }
    return html`
      <div class="card">
        <h2>Price Checker</h2>
        ${status}
        ${c && c.stores ? html`<p class="small muted">Stores it knows: ${c.stores.map((k) => names[k] || k).join(', ')}. Pick which of your stores use it under Shopping → Change store → a store's ⋯ → Colour and automatic prices.</p>` : ''}
      </div>
      <div class="card">
        <h2>Coles button</h2>
        <p class="small">Coles turns automatic price checkers away, so its prices come from a button in your own browser instead (Brave, Chrome or Edge on a computer).</p>
        <div class="row"><button type="button" data-action="shop-helper">Set up the Coles button</button></div>
      </div>`;
  }

  function updBackupsCard(main) {
    const b = state.backups;
    const label = (x) => (x.kind === 'manual' ? 'Manual backup' : x.kind === 'restore' ? 'Before a restore' : `Before v${x.version}`);
    return html`<section class="card upd-backups" id="upd-backups">
      <div class="upd-card-head"><div><h3>Kept on the server</h3>
        <p class="upd-card-sub">Made automatically before every update. Kept for the last ${b ? b.keep || 5 : 5}. Up to 20 made by hand.</p></div>
        ${b && b.available ? html`<button class="linkish" data-action="backup-now">Back up now</button>` : ''}</div>
      ${!b ? html`<p class="muted small">Couldn't load the backups.</p>`
        : !b.available ? html`<p class="muted small">This copy doesn't keep backups on the server. Download a backup file below instead.</p>`
        : b.backups.length ? html`<ul class="upd-backup-list">${b.backups.map((x) => html`<li>
            <div><div class="upd-backup-name">${label(x)}</div><div class="upd-card-sub">${updWhen(x.created_at)} · ${fileSize(x.size)}</div></div>
            ${main ? html`<div class="upd-backup-btns">${x.kind === 'manual' ? html`<button class="linkish danger-link" data-action="backup-delete" data-name="${x.name}">Delete</button>` : ''}
              <button class="linkish" data-action="backup-restore" data-name="${x.name}" data-when="${fmtDate(localDate(new Date(x.created_at)), true)} at ${new Date(x.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}">Restore</button></div>` : ''}
          </li>`)}</ul>`
        : html`<p class="muted small upd-empty">No backups yet. One is made before every update.</p>`}
      ${b && b.available ? html`<div class="upd-folder mono">${b.folder}</div>` : ''}
    </section>`;
  }

  function updPrefsCard(u, main) {
    const betaNote = u.track === 'pinned' ? `This copy is pinned to v${u.image_tag}`
      : u.beta_locked ? `Set by IMAGE_TAG in .env (${u.image_tag})` : 'Get new features early. May be less stable';
    const row = (key, on, title, sub, disabled) => html`<button type="button" class="upd-pref" role="switch" aria-checked="${on ? 'true' : 'false'}"
        data-action="upd-pref" data-key="${key}" ${disabled ? raw('disabled') : ''}>
        <span><span class="upd-pref-title">${title}</span><span class="upd-card-sub">${sub}</span></span>
        <span class="upd-switch" aria-hidden="true"></span></button>`;
    const pick = (key, value, title, sub, options, disabled) => html`<label class="upd-pref upd-pick">
        <span><span class="upd-pref-title">${title}</span><span class="upd-card-sub">${sub}</span></span>
        <select data-pref="${key}" ${disabled ? raw('disabled') : ''}>${options.map(([v, text]) => html`<option value="${v}" ${v === value ? raw('selected') : ''}>${text}</option>`)}</select></label>`;
    const keep = state.backups && state.backups.keep;
    return html`<section class="card upd-prefs" id="upd-prefs">
      <h3>Preferences</h3>
      ${row('auto_check', u.auto_check, 'Check for updates automatically', 'From GitHub, in the background', !main)}
      ${pick('interval_hours', u.interval_hours, 'How often to check', u.auto_check ? 'Or press Check now any time' : 'Automatic checks are off',
        [[1, 'Every hour'], [3, 'Every 3 hours'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Once a day']], !main || !u.auto_check)}
      ${row('wait_day', u.wait_day, 'Wait a day before offering updates', "A new version shows up 24 hours after it's released, so one that's pulled never reaches you", !main)}
      ${row('beta', u.beta, 'Include beta versions', betaNote, !main || u.beta_locked)}
      ${keep ? pick('backups_keep', keep, 'Backups to keep', 'Made before updates and restores. Manual backups are always kept', [[5, 'Last 5'], [10, 'Last 10'], [20, 'Last 20']], !main) : ''}
      <form class="upd-pref upd-folder-pref" data-folder-form>
        <label for="upd-folder"><span class="upd-pref-title">Server folder</span><span class="upd-card-sub">Where the app's docker-compose.yml is, like /opt/docker/simple-budget. Used for the commands an update's extra steps show</span></label>
        <span class="upd-folder-in"><input id="upd-folder" name="folder" value="${u.server_folder || ''}" placeholder="/opt/docker/simple-budget" autocomplete="off" spellcheck="false" ${main ? '' : raw('disabled')}>
          <button type="submit" class="mini" ${main ? '' : raw('disabled')}>Save</button></span></form>
      ${main ? '' : html`<p class="upd-card-sub" style="margin:8px 0 0">Only the main login can change these.</p>`}
    </section>`;
  }

  // Preferences picked from a list (how often to check, backups to keep).
  document.addEventListener('change', async (ev) => {
    const el = ev.target.closest && ev.target.closest('select[data-pref]');
    if (!el) return;
    el.disabled = true;
    try {
      state.updates = await api('PUT', '/updates/prefs', { [el.dataset.pref]: Number(el.value) });
      if (el.dataset.pref === 'backups_keep') state.backups = await api('GET', '/backups');
      toast('Saved');
    } catch (err) { toast(err.message); }
    render();
  });

  // The server folder, under Preferences.
  document.addEventListener('submit', async (ev) => {
    if (!ev.target.matches || !ev.target.matches('[data-folder-form]')) return;
    ev.preventDefault();
    try {
      state.updates = await api('PUT', '/updates/prefs', { server_folder: ev.target.elements.folder.value });
      toast('Saved');
      render();
    } catch (err) { toast(err.message); }
  });

  // After "Update now": watch the app go down and come back on the new version, then reload.
  async function waitForUpdate() {
    const i = state.updateInstall;
    const started = Date.now();
    const set = (changes) => { Object.assign(i, changes); if (state.updateInstall === i) render(); };
    while (state.updateInstall === i) {
      await new Promise((r) => { setTimeout(r, 2000); });
      let v = null;
      try {
        const res = await fetch('api/version', { cache: 'no-store' });
        if (res.ok) v = (await res.json()).version;
      } catch { /* restarting */ }
      // Any change of version counts: a release built from a branch can report a slightly different one.
      if (v && v !== i.from) {
        set({ step: 4, version: v });
        // Make sure the data opens on the new version before showing it.
        try { await api('GET', '/updates'); } catch { /* the reload shows any problem */ }
        location.reload();
        return;
      }
      if (v === null && i.step < 3) set({ step: 3 });
      else if (v && i.step === 3) {
        // It came back, but on the old version.
        state.updateInstall = null;
        state.updateFailed = { version: i.version, error: `The app restarted on v${v}. The new version may not have downloaded. Check the updater with sudo docker compose logs updater.` };
        render();
        return;
      } else if (i.step === 2 && Date.now() - started > 4 * 60 * 1000) {
        // The app never went down: the updater didn't find anything to install.
        state.updateInstall = null;
        state.updateFailed = { version: i.version, error: "The updater didn't restart the app, so it may not have found the new version yet. Try again in a minute. If it happens again, check the updater with sudo docker compose logs updater." };
        render();
        return;
      } else if (!i.slow && Date.now() - started > 5 * 60 * 1000) set({ slow: true });
    }
  }

  function settingsSecurity() {
    const list = state.logins || [];
    return html`
      <div class="card">
        <h2>Your password</h2>
        <p class="muted small">You're logged in as <b>${state.me ? state.me.name : ''}</b>. Changing your password logs this login out on your other devices.
          Logins last 30 days from when the device was last used.</p>
        <div class="row"><button data-action="change-password">Change my password</button><button data-action="logout">Log out on this device</button>
          ${state.me ? html`<button data-action="logout-everywhere" data-id="${state.me.id}" data-you="1">Log out my other devices</button>` : ''}</div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Logins</h2>
          <p class="muted small" style="margin:0">Everyone sees the same budget. Each login has its own password and its own theme.
            There's no username: the password you log in with says who you are.</p></div>
          <button class="primary" data-action="new-login">+ Add login</button></div>
        <ul class="list logins-list">${list.map((l) => html`<li>
          <span class="login-dot" style="--c:${l.colour || 'var(--muted)'}" title="${l.colour ? 'Icon colour' : 'Icon colour: follows the theme'}"></span>
          <div class="grow"><div class="title">${l.name} ${l.you ? html`<span class="chip current">You</span>` : ''} ${l.main ? html`<span class="chip">Main</span>` : ''}</div>
            <div class="meta">${l.main ? "Can't be removed, and only Main can change its password. It can be reset from the server if forgotten." : 'Extra login'}</div></div>
          <div class="row login-btns">
            <button type="button" class="small" data-action="rename-login" data-id="${l.id}">Edit</button>
            ${l.you ? html`<button type="button" class="small" data-action="change-password">Change password</button>`
              : l.main ? '' : html`<button type="button" class="small" data-action="set-login-password" data-id="${l.id}" data-name="${l.name}">Set password</button>`}
            ${l.you ? '' : html`<button type="button" class="small" data-action="logout-everywhere" data-id="${l.id}" data-name="${l.name}">Log out everywhere</button>`}
            ${!l.main && !l.you ? html`<button type="button" class="small danger" data-action="remove-login" data-id="${l.id}" data-name="${l.name}">Remove</button>` : ''}
          </div></li>`)}</ul>
      </div>`;
  }

  // Settings → Advanced: server settings, locked behind a warning until ticked.
  function settingsAdvanced() {
    const a = state.advanced;
    if (!a) return html`<div class="card"><p class="muted">Couldn't load the advanced settings.</p></div>`;
    const v = a.values;
    const open = a.can_edit && state.advancedUnlocked;
    const envTag = (key, name) => (a.locked[key] ? html` <span class="chip env-chip" title="Remove ${name} from .env to change it here">Set in .env</span>` : '');
    const off = (key) => (!open || a.locked[key] ? raw('disabled') : '');
    return html`
      <div class="card adv-warning">
        <h2>⚠ Advanced settings</h2>
        <p>These control how the server runs: which addresses it answers to, cookies and where it looks for updates.
          <b>You shouldn't need to change them.</b> A wrong value can stop the app loading, log everyone out, or make it less secure.</p>
        <p class="small">Anything set in <code>.env</code> on the server wins and can't be changed here.</p>
        ${a.can_edit
          ? html`<label class="check adv-agree"><input type="checkbox" data-action="adv-unlock" ${state.advancedUnlocked ? raw('checked') : ''}> I understand, let me change these settings</label>`
          : html`<p class="small"><b>Only the main login can change these.</b></p>`}
      </div>
      <form class="card" id="adv-form">
        <fieldset class="adv-fields" ${open ? '' : raw('disabled')}>
        <div class="field"><label for="adv-hosts">Extra web addresses${envTag('allowed_hosts', 'ALLOWED_HOSTS')}</label>
          <input id="adv-hosts" name="allowed_hosts" value="${v.allowed_hosts}" placeholder="e.g. budget.example.com" autocomplete="off" ${off('allowed_hosts')}>
          <div class="hint">Only needed if you open the app through your own domain (a reverse proxy or a Cloudflare Tunnel). Separate several with commas.
            IP addresses, plain names like <code>nas</code>, and <code>.local</code>, <code>.lan</code> and Tailscale names always work.
            You're on <b>${a.host}</b>${a.host_is_home ? ', which always works' : ', so it has to stay in this list'}.</div></div>
        <div class="field"><label for="adv-proxy">Reverse proxy${envTag('trust_proxy', 'TRUST_PROXY')}</label>
          <input id="adv-proxy" name="trust_proxy" value="${v.trust_proxy}" placeholder="Off" autocomplete="off" ${off('trust_proxy')}>
          <div class="hint">Only if a reverse proxy sits in front of the app: its address (e.g. <code>172.18.0.1</code>) or <code>1</code>.
            Then the login limit sees each visitor's own address. Leave it empty otherwise, or anyone could get round the limit.</div></div>
        <div class="field"><label class="check"><input type="checkbox" name="secure_cookies" ${v.secure_cookies ? raw('checked') : ''} ${off('secure_cookies')} ${!a.https && !v.secure_cookies ? raw('disabled') : ''}> Secure cookies (HTTPS only)${envTag('secure_cookies', 'SECURE_COOKIES')}</label>
          <div class="hint">${a.https ? 'Logins only work over https://. Turn this on if the app is always opened with https://.'
            : "Logins would only work over https://. It can only be turned on while you're using the app over https://, so you can't lock yourself out."}</div></div>
        <div class="field"><label for="adv-channel">Build tag${envTag('app_channel', 'APP_CHANNEL')}</label>
          <select id="adv-channel" name="app_channel" ${off('app_channel')}>
            ${[['', 'None (a normal copy)'], ['test', 'Test'], ['beta', 'Beta']].map(([k, label]) => html`<option value="${k}" ${k === v.app_channel ? raw('selected') : ''}>${label}</option>`)}</select>
          <div class="hint">Puts a Test or Beta tag in the header and page title.
            ${a.image_tag ? html`Which versions are offered and installed is set by <code>IMAGE_TAG</code> in .env (this copy: <b>${a.image_tag}</b>; use <code>beta</code> for pre-releases).`
              : 'Test and Beta copies are also offered beta releases.'}</div></div>
        <div class="field"><label for="adv-repo">Check for updates from${envTag('update_repo', 'UPDATE_REPO')}</label>
          <input id="adv-repo" name="update_repo" value="${v.update_repo}" placeholder="kirtangl/Simple-Budget" autocomplete="off" ${off('update_repo')}>
          <div class="hint">The GitHub repository, as owner/name. Only change it for your own fork.</div></div>
        <div class="field"><label for="adv-token">GitHub token${envTag('github_token', 'GITHUB_TOKEN')}</label>
          <input id="adv-token" name="github_token" type="password" value="" placeholder="${a.github_token_set ? 'Saved (type a new one to replace it)' : 'None'}" autocomplete="off" ${off('github_token')}>
          ${a.github_token_set && !a.locked.github_token ? html`<label class="check small"><input type="checkbox" name="remove_github_token" ${off('github_token')}> Remove the saved token</label>` : ''}
          <div class="hint">Only for a private fork: a fine-grained token with read-only Contents access. It's never shown again once saved.</div></div>
        <p class="error" id="adv-error"></p>
        <div class="row"><button class="primary" type="submit">Save advanced settings</button></div>
        </fieldset>
      </form>
      <div class="card">
        <h2>Server</h2>
        <ul class="list adv-info">
          <li><span class="grow">Version</span><b>v${a.version}</b></li>
          <li><span class="grow">Time zone</span><b>${a.timezone}</b></li>
          <li><span class="grow">Connection</span><b>${a.https ? 'HTTPS' : 'Plain http'}</b></li>
        </ul>
        <p class="hint">The time zone, port and container name can only be changed in <code>.env</code>, followed by a rebuild.</p>
      </div>`;
  }

  async function saveAdvanced(form) {
    const el = form.elements;
    const body = {};
    for (const k of ['allowed_hosts', 'trust_proxy', 'app_channel', 'update_repo']) if (!el[k].disabled) body[k] = el[k].value;
    if (!el.secure_cookies.disabled) body.secure_cookies = el.secure_cookies.checked;
    if (!el.github_token.disabled && el.github_token.value.trim()) body.github_token = el.github_token.value.trim();
    if (el.remove_github_token && el.remove_github_token.checked) body.remove_github_token = true;
    const err = form.querySelector('#adv-error');
    err.textContent = '';
    try {
      state.advanced = await api('PUT', '/advanced', body);
    } catch (e) { err.textContent = e.message; return; }
    state.updates = null;
    showVersion();
    await render();
    toast('Saved');
  }
  document.addEventListener('submit', (ev) => { if (ev.target.id === 'adv-form') { ev.preventDefault(); saveAdvanced(ev.target); } });

  async function reloadLogins() {
    state.logins = await api('GET', '/logins');
    const me = state.logins.find((l) => l.you);
    if (me && state.me) { state.me.name = me.name; state.me.colour = me.colour; showMe(); }
  }

  function loginForm({ id = null, name = '', colour = null, mode = 'new' } = {}) {
    const pw = mode !== 'rename';
    // No colour yet: start from the theme's icon colour (edit) or a fresh one (new).
    const start = colour || (mode === 'new' ? PALETTE[(state.logins || []).length % PALETTE.length]
      : getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
    openForm({
      title: mode === 'new' ? 'Add login' : mode === 'rename' ? 'Edit login' : `New password for ${name}`,
      body: html`<div class="fields">
        ${mode !== 'password' ? html`<div class="field"><label for="lg-name">Name</label><input id="lg-name" name="name" value="${name}" maxlength="40" placeholder="e.g. Sam" required></div>
          <div class="field color-field"><label for="lg-colour">Icon colour</label><input id="lg-colour" type="color" name="colour" value="${/^#[0-9a-f]{6}$/i.test(start) ? start : '#9ca3af'}">
            <div class="hint">The account icon, top right. It stays the same whatever theme is picked.</div></div>` : ''}
        ${pw ? html`<div class="field"><label for="lg-pw">Password</label><input id="lg-pw" name="password" ${PASSWORD_ATTRS} autocomplete="new-password" required>
          <div class="hint">At least 8 characters, and different from every other login's.</div></div>
          <div class="field"><label for="lg-pw2">Type it again</label><input id="lg-pw2" name="confirm" ${PASSWORD_ATTRS} autocomplete="new-password" required></div>` : ''}
        </div>
        ${mode === 'new' ? html`<p class="hint">They log in with this password and pick their own theme. They'll see and can change the same budget as everyone else.</p>` : ''}`,
      onSave: async (form) => {
        const body = {};
        if (mode !== 'password') { body.name = val(form, 'name'); body.colour = form.elements.colour.value; }
        if (pw) {
          if (form.elements.password.value !== form.elements.confirm.value) throw new Error("The two passwords don't match.");
          body.password = form.elements.password.value;
        }
        await (mode === 'new' ? api('POST', '/logins', body) : api('PATCH', `/logins/${id}`, body));
        await reloadLogins();
        toast(mode === 'new' ? `Added ${body.name}` : 'Saved');
      },
    });
  }

  // The logged-in name in the menu, and their own icon colour, which no theme changes.
  function showMe() {
    document.querySelector('#user-menu .menu-head').textContent = state.me.name;
    window.applyAccountColour(state.me.colour);
  }

  // ---------- Themes ----------
  // Saved to each login, so it follows you to any device. This device also
  // remembers the last one, so the page doesn't flash before it loads.
  // Every theme keeps the account, category and chart colours as they are.
  const THEMES = [
    ['system', 'Match this device', 'Light or dark, following the device setting'],
    ['light', 'Light', 'Clean and bright'],
    ['dark', 'Dark', 'Charcoal with teal'],
    ['warm', 'Warm', 'Light, on soft cream'],
    ['ocean', 'Ocean', 'Light, with cool blues'],
    ['slate', 'Slate', 'Dark blue-grey'],
    ['midnight', 'Midnight', 'Pure black, for OLED screens'],
    ['custom', 'Custom', 'Your own colours'],
  ];
  // The colours a custom theme sets, grouped as they appear in the editor.
  const THEME_GROUPS = [
    ['Backgrounds', [['bg', 'Page'], ['card', 'Cards'], ['inset', 'Fields, table headers and tiles'], ['line', 'Lines and borders']]],
    ['Text', [['text', 'Text'], ['muted', 'Quieter text'], ['info', 'Links']]],
    ['Accent', [['brand', 'Accent'], ['brand-soft', 'Accent background'], ['on-brand', 'Text on accent buttons']]],
    ['Status', [['paid', 'Paid / good'], ['paid-soft', 'Paid background'], ['due', 'Due'], ['due-soft', 'Due background'],
      ['danger', 'Overdue / bad'], ['danger-soft', 'Overdue background'], ['upcoming', 'Upcoming'], ['upcoming-soft', 'Upcoming background'], ['firm', 'Firm date']]],
  ];
  const THEME_KEYS = THEME_GROUPS.flatMap(([, keys]) => keys.map(([k]) => k));
  const currentTheme = () => (state.me && state.me.theme) || (() => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } })();
  function applyTheme(t, custom) {
    window.applyCustomTheme(t === 'custom' ? custom : null);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    window.updateFavicon();
    try {
      localStorage.setItem('theme', t);
      localStorage.setItem('custom-theme', JSON.stringify(custom || null));
    } catch { /* not remembered here, still applied */ }
  }
  async function saveTheme(t, custom) {
    const saved = await api('PUT', '/me/theme', { theme: t, ...(custom ? { custom_theme: custom } : {}) });
    state.me = { ...state.me, theme: saved.theme, custom_theme: saved.custom_theme };
    applyTheme(saved.theme, saved.custom_theme);
  }
  // A built-in theme's colours, read from the stylesheet by switching to it for a moment.
  function themeColours(t) {
    const root = document.documentElement;
    const before = root.dataset.theme;
    if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
    const cs = getComputedStyle(root);
    const out = {};
    for (const k of THEME_KEYS) {
      let v = cs.getPropertyValue(`--${k}`).trim().toLowerCase();
      if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
      out[k] = /^#[0-9a-f]{6}$/.test(v) ? v : '#888888';
    }
    if (before == null) delete root.dataset.theme; else root.dataset.theme = before;
    return out;
  }

  // A small Overview drawn with the theme's colours, to try them out before saving.
  function themePreview(vars) {
    const style = Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';');
    return html`<div class="tp" style="${style}" aria-hidden="true">
      <div class="tp-top"><svg class="tp-logo" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="var(--brand)"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="var(--on-brand)" stroke-width="3.6" pathLength="100" stroke-dasharray="44 6 25 6 13 6" transform="rotate(-90 12 12)"/></svg><b>Simple Budget</b>
        <span class="tp-nav on">Overview</span><span class="tp-nav">Budget</span><span class="tp-nav">Goals</span><span class="tp-acct"><svg viewBox="0 0 24 24" width="11" height="11"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></span></div>
      <div class="tp-body">
        <div class="tp-tabs"><span class="on">This fortnight</span><span>Analytics</span></div>
        <div class="tp-stats">
          <div class="tp-card"><div class="tp-lbl">Income</div><div class="tp-big">$4,200</div><div class="tp-sub">2 pays</div></div>
          <div class="tp-card"><div class="tp-lbl">Expenses · this fortnight</div><div class="tp-big">$3,050</div>
            <div class="tp-bar"><i style="width:72%"></i></div></div>
          <div class="tp-card"><div class="tp-lbl">Remaining</div><div class="tp-big good">$1,150</div><div class="tp-sub">left over</div></div>
        </div>
        <div class="tp-card tp-list">
          <div class="tp-head"><b>Deposits</b><span class="tp-link">See all</span></div>
          <div class="tp-search">⌕ Search name, payee, category</div>
          <div class="tp-th"><span>Bill</span><span>Status</span><span>Amount</span></div>
          <div class="tp-row"><span><i class="tp-dot" style="background:#3fb950"></i>Everyday</span><span class="tp-tag paid">Paid</span><b>$600</b></div>
          <div class="tp-row"><span><i class="tp-dot" style="background:#f0883e"></i>Bills</span><span class="tp-tag due">Due today</span><b>$900</b></div>
          <div class="tp-row"><span><i class="tp-dot" style="background:#f04848"></i>Car</span><span class="tp-tag up">Upcoming</span><b>$450</b></div>
          <div class="tp-row"><span><i class="tp-dot" style="background:#a371f7"></i>Holiday fund</span><span class="tp-tag bad">Overdue</span><b>$200</b></div>
          <div class="tp-btns"><span class="tp-btn">Cancel</span><span class="tp-btn primary">+ Add expense</span></div>
        </div>
      </div>
    </div>`;
  }

  function themeEditor() {
    const d = state.themeDraft;
    return html`<div class="te-editor">
      <div class="te-fields">
        <div class="te-start"><label for="te-from">Start from</label><select id="te-from" data-theme-from>
          <option value="">Pick a theme…</option>${THEMES.filter(([k]) => k !== 'custom').map(([k, name]) => html`<option value="${k}">${name}</option>`)}</select></div>
        ${THEME_GROUPS.map(([group, keys]) => html`<fieldset class="te-group"><legend>${group}</legend>
          ${keys.map(([k, label]) => html`<label class="te-colour"><input type="color" value="${d[k]}" data-tvar="${k}"><span>${label}</span><code>${d[k]}</code></label>`)}
        </fieldset>`)}
      </div>
      <div class="te-side"><div class="te-preview-wrap"><div class="te-preview-lbl">Preview</div>${themePreview(d)}</div>
        <div class="te-btns"><button type="button" data-action="theme-cancel">Cancel</button><button type="button" class="primary" data-action="theme-save">Save custom theme</button></div></div>
    </div>`;
  }

  function themeCard() {
    const now = currentTheme();
    const custom = state.me && state.me.custom_theme;
    return html`<div class="card" id="theme">
      <div class="card-head"><div><h2>Theme</h2>
        <p class="muted small" style="margin:0">Saved to your login${state.me ? ` (${state.me.name})` : ''}, so it follows you to any device.</p></div>
        ${state.themeDraft ? '' : html`<button type="button" data-action="theme-edit">Customise colours…</button>`}</div>
      <div class="themes">${THEMES.map(([k, name, note]) => html`
        <button type="button" class="theme-pick ${k === now ? 'on' : ''}" data-action="set-theme" data-theme="${k}" aria-pressed="${k === now ? 'true' : 'false'}">
          <span class="swatch" data-preview="${k}" ${raw(k === 'custom' && custom ? `style="--pbg:${custom.bg};--pcard:${custom.card};--pbrand:${custom.brand}"` : '')}><i></i><b></b></span>
          <span class="theme-name">${name}</span><span class="meta">${note}</span></button>`)}</div>
      ${state.themeDraft ? themeEditor() : ''}
      <div class="dark-icon"><label class="check"><input type="checkbox" data-dark-icon ${raw(darkIcon() ? 'checked' : '')}> Dark home-screen icon</label>
        <p class="muted small">For a phone's home screen: a near-black icon with the ring in your theme's colour, to sit with dark icons. The phone keeps the icon it had when you tapped <b>Add to Home Screen</b>, so after changing this, remove the app from the home screen and add it again. Saved on this device.</p></div>
    </div>`;
  }
  const darkIcon = () => { try { return localStorage.getItem('dark-icon') === '1'; } catch { return false; } };
  document.addEventListener('change', (ev) => {
    if (!ev.target.matches || !ev.target.matches('[data-dark-icon]')) return;
    try { localStorage.setItem('dark-icon', ev.target.checked ? '1' : ''); } catch { /* not remembered here */ }
    window.updateFavicon();
    toast(ev.target.checked ? 'Dark home-screen icon on' : 'Dark home-screen icon off');
  });
  // Colour pickers update the preview as you go; nothing changes in the app until Save.
  document.addEventListener('input', (ev) => {
    const key = ev.target.dataset && ev.target.dataset.tvar;
    if (!key || !state.themeDraft) return;
    state.themeDraft[key] = ev.target.value;
    ev.target.parentElement.querySelector('code').textContent = ev.target.value;
    document.querySelector('.te-editor .tp')?.style.setProperty(`--${key}`, ev.target.value);
  });
  document.addEventListener('change', (ev) => {
    if (!ev.target.matches || !ev.target.matches('[data-theme-from]') || !ev.target.value) return;
    state.themeDraft = themeColours(ev.target.value);
    render().then(() => document.getElementById('theme')?.scrollIntoView({ block: 'start' }));
  });

  // ---------- Actions (event delegation) ----------

  const findById = (list, el) => byId(list, Number(el.dataset.id));

  const actions = {
    cycle: (el) => { const step = Number(el.dataset.step); state.offset = step === 0 ? 0 : state.offset + step; render(); },
    'account-details': (el) => showAccountDetails(Number(el.dataset.id)),
    'keep-details': (el) => keepDetails(Number(el.dataset.id)),
    'copy-account': (el) => {
      const a = account(Number(el.dataset.id));
      copyText([a.bsb, a.account_number].filter(Boolean).join(' '), 'Bank details');
    },
    'new-expense': (el) => expenseForm(undefined, el.dataset.kind || 'expense'),
    'edit-expense': (el) => { const e = findById(state.data.expenses, el); if (e) expenseForm(e); },
    'new-goal': (el) => goalForm(el.dataset.kind),
    'goal-list': (el) => goalListPopup(el.dataset.kind),
    'goal-who': (el) => setGoalWho(el.dataset.who),
    'loan-history': () => { if (openLoan) loanHistoryPopup(openLoan); },
    'show-more': (el) => { el.parentElement.querySelectorAll('.more[hidden]').forEach((m) => { m.hidden = false; }); el.remove(); },
    'history-remove': async (el) => {
      const { kind, item, id, what } = el.dataset;
      const pending = id === 'pending';
      const ok = await askChoice({ title: pending ? 'Cancel this price change?' : 'Remove this entry?',
        text: html`<p><b>${what}</b></p><p>${pending ? "The bill stays at its current price, and this change won't happen."
          : `It comes out of the history. If it's the newest one, the ${kind === 'loan' ? 'loan goes' : 'bill goes'} back to the one before it.`}</p>`,
        choices: [{ label: pending ? 'Keep it' : 'Cancel', value: 'no' }, { label: pending ? 'Cancel change' : 'Remove', value: 'yes', danger: true }] });
      if (ok !== 'yes') return;
      await api('DELETE', pending ? `/expenses/${item}/pending` : `/history/${kind}/${item}/${id}`);
      await reload();
      await render();
      toast('Removed');
      if (kind === 'loan') {
        openLoan = await api('GET', `/loans/${item}/details`);
        loanHistoryPopup(openLoan);
        return;
      }
      // Redraw the price history where it is (the bill popup or the edit form), and the amount if it went back.
      const e = await api('GET', `/expenses/${item}/details`);
      const box = el.closest('.ph');
      if (box) box.outerHTML = priceHistory(e.history, e).s;
      const form = document.querySelector('#modal form');
      const amt = form && form.elements.amount;
      if (amt && !amt.closest('[hidden]')) amt.value = (e.amount_cents / 100).toFixed(2);
    },
    'review-update': (el) => { const e = findById(state.data.expenses, el); if (e) amountForm(e, { review: true }); },
    'update-amount': (el) => { const e = findById(state.data.expenses, el); if (e) amountForm(e); },
    'update-balance': (el) => { const l = openLoan && openLoan.id === Number(el.dataset.id) ? openLoan : findById(state.data.loans, el); if (l) balanceForm(l); },
    'review-snooze': (el) => { const e = findById(state.data.expenses, el); if (e) return reviewLater(e, 'snooze'); },
    'review-skip': (el) => { const e = findById(state.data.expenses, el); if (e) return reviewLater(e, 'skip'); },
    'edit-goal': (el) => { const g = findById(state.data.goals, el); if (g) goalForm(g.kind, g); },
    'ld-working': (el) => {
      const box = el.closest('.ld').querySelector('.ld-working');
      box.hidden = !box.hidden;
      el.textContent = box.hidden ? 'How is this worked out?' : 'Hide working';
    },
    'dd-open': (el) => {
      const menu = el.parentElement.querySelector('.dd-menu');
      const open = menu.hidden;
      closeDropdowns();
      if (open) {
        menu.hidden = false;
        el.setAttribute('aria-expanded', 'true');
        (menu.querySelector('[aria-selected=true]') || menu.querySelector('[role=option]')).focus();
      }
    },
    'dd-pick': (el) => {
      state[el.dataset.key] = el.dataset.value;
      const key = el.dataset.key;
      render().then(() => document.querySelector(`.dd[data-dd="${key}"] .dd-btn`)?.focus());
    },
    'goal-panel': (el) => { const g = findById(state.data.goals, el); if (g) openGoalPanel(g, el.dataset.mode); },
    'goal-quick': (el) => { const input = el.closest('.g-panel').querySelector('input'); input.value = moneyInput(Number(el.dataset.cents)); input.focus(); },
    'goal-panel-cancel': (el) => el.closest('.g-panel').remove(),
    'goal-panel-save': (el) => saveGoalPanel(el.closest('.g-panel')),
    'goal-menu': (el) => {
      const menu = el.parentElement.querySelector('.g-menu');
      const open = menu.hidden;
      closeGoalMenus();
      if (open) {
        menu.hidden = false;
        el.setAttribute('aria-expanded', 'true');
        if (window.matchMedia('(max-width: 720px)').matches) document.body.classList.add('g-sheet-open');
        menu.querySelector('[role=menuitem]').focus({ preventScroll: true });
      }
    },
    'delete-goal': async (el) => {
      const g = findById(state.data.goals, el);
      closeGoalMenus();
      if (!g || !confirm(`Delete "${g.name}"? This cannot be undone.`)) return;
      await api('DELETE', `/goals/${g.id}`);
      await reload();
      render();
      toast('Deleted');
    },
    'toggle-goals-done': () => { try { localStorage.setItem('goals-done-open', doneOpen() ? '0' : '1'); } catch { /* not remembered */ } render(); },
    'edit-goal-group': (el) => goalGroupForm(el.dataset.kind, el.dataset.name),
    'toggle-goal': async (el) => {
      const g = findById(state.data.goals, el);
      closeGoalMenus();
      await api('PATCH', `/goals/${el.dataset.id}`, { done: !g.done });
      await reload();
      render();
    },
    'new-income': () => incomeForm(),
    'new-loan': () => loanForm(),
    'edit-loan': (el) => { const l = findById(state.data.loans, el); if (l) loanForm(l); },
    'delete-loan': async (el) => {
      const l = findById(state.data.loans, el);
      if (!l) return;
      const ok = await askChoice({ title: `Delete ${l.name}?`, text: html`<p>Are you sure? The loan, its repayments in the budget and its history are removed. This can't be undone.</p>`,
        choices: [{ label: 'Cancel', value: 'no' }, { label: 'Delete', value: 'yes', danger: true }] });
      if (ok !== 'yes') return;
      await api('DELETE', `/loans/${l.id}`);
      await reload();
      await render();
      toast('Loan deleted');
    },
    'loan-details': async (el) => loanDetails(Number(el.dataset.id)),
    'update-balances': () => updateBalances(),
    'toggle-calc': () => { try { localStorage.setItem('calc-open', calcOpen() ? '0' : '1'); } catch { /* not remembered */ } render(); },
    'calc-freq': (el) => {
      state.calc.frequency = el.dataset.value;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
      runCalc();
    },
    'set-filter': (el) => { state[el.dataset.key] = el.dataset.value; render(); },
    'toggle-group': (el) => toggleGroup(el.dataset.key),
    'expense-filters': (el) => expenseFilterSheet(el.dataset.kind),
    'sheet-filter': async (el) => { state[el.dataset.key] = el.dataset.value; await render(); expenseFilterSheet(el.dataset.kind); },
    'expense-reset': () => { Object.assign(state, EXPENSE_FILTERS, { expenseQuery: '' }); render(); },
    'sheet-reset': async (el) => { Object.assign(state, EXPENSE_FILTERS); await render(); expenseFilterSheet(el.dataset.kind); },
    'ana-period': (el) => { state.anaPeriod = el.dataset.period; render(); },
    'ya-view': (el) => { state.yaView = el.dataset.view; render(); },
    'bill-details': async (el) => billDetails(Number(el.dataset.id), el.dataset),
    'toggle-incomes': () => { state.showIncomes = !state.showIncomes; render(); },
    'toggle-unused': () => { state.showUnused = !state.showUnused; render(); },
    'edit-income': (el) => incomeForm(findById(state.data.incomes, el)),
    'new-account': () => accountForm(),
    'edit-account': (el) => accountForm(findById(state.data.accounts, el)),
    'move-account': async (el) => {
      const ids = state.data.accounts.map((a) => a.id);
      const i = ids.indexOf(Number(el.dataset.id));
      const j = i + Number(el.dataset.dir);
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api('POST', '/accounts/reorder', { ids });
      await reload();
      render();
    },
    'new-payee': () => payeeForm(),
    'edit-payee': (el) => payeeForm(findById(state.data.payees, el)),
    'new-category': () => categoryForm(),
    'edit-category': (el) => categoryForm(findById(state.data.categories, el)),
    'new-subcategory': async (el) => {
      const name = await askText(`New sub category in ${category(Number(el.dataset.id)).name}`, 'Name');
      if (!name) return;
      await api('POST', '/subcategories', { category_id: Number(el.dataset.id), name });
      await reload();
      render();
    },
    'rename-subcategory': async (el) => {
      const s = subcategory(Number(el.dataset.id));
      const name = await askText('Rename sub category', 'Name', s.name);
      if (!name || name === s.name) return;
      await api('PATCH', `/subcategories/${s.id}`, { name });
      await reload();
      render();
    },
    'delete-subcategory': async (el) => {
      const s = subcategory(Number(el.dataset.id));
      if (!confirm(`Remove "${s.name}"? Expenses using it will keep their category.`)) return;
      await api('DELETE', `/subcategories/${s.id}`);
      await reload();
      render();
    },
    'change-password': () => { closeMenu(); changePasswordForm(); },
    'new-login': () => loginForm(),
    'rename-login': (el) => { const l = (state.logins || []).find((x) => String(x.id) === el.dataset.id); if (l) loginForm({ ...l, mode: 'rename' }); },
    'set-login-password': (el) => loginForm({ id: el.dataset.id, name: el.dataset.name, mode: 'password' }),
    'logout-everywhere': async (el) => {
      const you = Boolean(el.dataset.you);
      if (!confirm(you ? 'Log out your login on every other device? This device stays logged in.'
        : `Log out "${el.dataset.name}" on every device? They'll need their password to log in again.`)) return;
      await api('POST', `/logins/${el.dataset.id}/logout-everywhere`);
      toast(you ? 'Logged out on your other devices' : `${el.dataset.name} is logged out everywhere`);
    },
    'remove-login': async (el) => {
      if (!confirm(`Remove the login "${el.dataset.name}"? Anyone using it will be logged out. The budget isn't affected.`)) return;
      await api('DELETE', `/logins/${el.dataset.id}`);
      await reloadLogins();
      render();
      toast('Login removed');
    },
    'set-theme': async (el) => {
      const t = el.dataset.theme;
      // Custom with nothing saved yet starts from the theme in use.
      if (t === 'custom' && !(state.me && state.me.custom_theme)) { state.themeDraft = themeColours(currentTheme()); render(); return; }
      await saveTheme(t);
      render();
    },
    'theme-edit': () => { state.themeDraft = (state.me && state.me.custom_theme) ? { ...themeColours(currentTheme()), ...state.me.custom_theme } : themeColours(currentTheme()); render(); },
    'theme-cancel': () => { state.themeDraft = null; render(); },
    'theme-save': async () => {
      await saveTheme('custom', state.themeDraft);
      state.themeDraft = null;
      await render();
      toast('Custom theme saved');
    },
    'toggle-menu': (el) => {
      const menu = $userMenu.querySelector('.menu');
      menu.hidden = !menu.hidden;
      el.setAttribute('aria-expanded', String(!menu.hidden));
    },
    'menu-theme': () => { closeMenu(); location.hash = '#/settings/appearance'; },
    'menu-settings': () => { closeMenu(); location.hash = '#/settings'; },
    logout: async () => { closeMenu(); await api('POST', '/logout'); state.data = null; state.advanced = null; state.backups = null; state.advancedUnlocked = false; state.me = null; state.logins = null; state.themeDraft = null; window.applyAccountColour(null); location.hash = '#/overview'; showLogin(); },
    'menu-security': () => { closeMenu(); location.hash = '#/settings/security'; },
    'menu-updates': () => { closeMenu(); location.hash = '#/settings/updates'; },
    'adv-unlock': (el) => { state.advancedUnlocked = el.checked; render(); },
    'install-update': async () => {
      const v = state.updates.latest.version;
      if (!state.updateFailed && !confirm(`Update to version ${v} now? The app restarts, so anyone using it will see it reload.`)) return;
      state.updateFailed = null;
      const i = { version: v, from: state.updates.current, step: 1 };
      state.updateInstall = i;
      await render();
      try {
        const r = await api('POST', '/updates/install');
        Object.assign(i, { version: r.version, backup: r.backup, step: 2 });
      } catch (err) {
        state.updateInstall = null;
        state.updateFailed = { version: v, error: err.message };
        await render();
        return;
      }
      await render();
      waitForUpdate();
    },
    'upd-dismiss': async () => { state.updates = await api('POST', '/updates/dismiss'); render(); },
    'upd-dismiss-failed': () => { state.updateFailed = null; render(); },
    // The notes are often already on screen, so the new version's are lit up as well as scrolled to.
    'upd-see-new': () => {
      const el = document.querySelector('.upd-release.mine') || document.getElementById('upd-notes');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth; // restart the highlight if pressed again
      el.classList.add('flash');
    },
    'upd-to-backups': () => { location.hash = '#/settings/backups'; },
    'open-bell': async () => { closeMenu(); bellPanel(await api('GET', '/notifications')); },
    'copy-checker-cmd': () => copyText(CHECKER_CMD, 'Commands'),
    'upd-pref': async (el) => {
      const key = el.dataset.key;
      el.disabled = true;
      try {
        state.updates = await api('PUT', '/updates/prefs', { [key]: el.getAttribute('aria-checked') !== 'true' });
      } finally { el.disabled = false; }
      showUpdateBadge();
      render();
    },
    'backup-now': async (el) => {
      el.disabled = true; el.textContent = 'Backing up…';
      try { state.backups = await api('POST', '/backups'); } finally { el.disabled = false; el.textContent = 'Back up now'; }
      render();
      toast('Backup made');
    },
    'backup-delete': async (el) => {
      if (!confirm('Delete this backup? It can\'t be brought back.')) return;
      el.disabled = true;
      try { state.backups = await api('DELETE', `/backups/${encodeURIComponent(el.dataset.name)}`); } catch (err) { el.disabled = false; throw err; }
      render();
      toast('Backup deleted');
    },
    'backup-restore': async (el) => {
      if (!confirm(`Restore your data to how it was on ${el.dataset.when}? Changes since then will be lost. Your current data is backed up first.\n\nLogins and passwords stay as they are now.`)) return;
      el.disabled = true; el.textContent = 'Restoring…';
      try { state.backups = await api('POST', '/backups/restore', { name: el.dataset.name }); } catch (err) { el.disabled = false; el.textContent = 'Restore'; throw err; }
      state.updateFailed = null;
      await reload();
      render();
      toast('Backup restored');
    },
    'check-updates': async (el) => {
      el.disabled = true; el.textContent = 'Checking…';
      await loadUpdates(true);
      await render();
      toast(state.updates && state.updates.available ? `Version ${state.updates.latest.version} is available` : 'Checked for updates');
    },
    'copy-update-cmd': async () => {
      await copyText('git pull\nsudo docker compose up -d --build', 'Commands');
    },
    'copy-token-cmd': async () => { await copyText(TOKEN_CMD, 'Commands'); },
    'copy-extra-steps': async (el) => { await copyText(el.dataset.cmds, 'Commands'); },
    'toggle-token-card': () => { state.tokenOpen = !state.tokenOpen; render(); },
    'ignore-token': async (el) => {
      state.updates = await api('PUT', '/updates/prefs', { token_ignored: el.dataset.on === '1' });
      state.tokenOpen = false;
      showUpdateBadge();
      render();
    },
  };

  function closeMenu() {
    $userMenu.querySelector('.menu').hidden = true;
    $userMenu.querySelector('.menu-btn').setAttribute('aria-expanded', 'false');
  }
  // Clicking anywhere else, or pressing Escape, closes the household menu.
  document.addEventListener('click', (ev) => { if (!ev.target.closest('#user-menu')) closeMenu(); }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });

  document.addEventListener('click', async (ev) => {
    const copy = ev.target.closest('[data-copy]');
    if (copy) { ev.preventDefault(); return copyText(copy.dataset.copy, copy.dataset.label); }
    const el = ev.target.closest('[data-action]');
    if (!el || !actions[el.dataset.action]) return;
    ev.stopPropagation();
    try {
      await actions[el.dataset.action](el);
    } catch (err) {
      toast(err.message);
    }
  });

  let searchTimer;
  document.addEventListener('input', (ev) => {
    const key = ev.target.dataset.input;
    if (key === 'expense-query') {
      state.expenseQuery = ev.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const pos = ev.target.selectionStart;
        render().then(() => {
          const input = [...document.querySelectorAll('[data-input="expense-query"]')].find((i) => i.offsetParent);
          if (input) { input.focus(); input.setSelectionRange(pos, pos); }
        });
      }, 200);
    }
    if (key === 'bsb' || key === 'account-number') formatDigits(ev.target, key === 'bsb');
    if (ev.target.id === 'payfreq') document.querySelector('#custom-days').hidden = ev.target.value !== 'custom';
  });

  // Keeps only digits as you type, adding the BSB dash after the third digit,
  // and keeps the cursor in the same place among the digits.
  function formatDigits(input, isBsb) {
    const before = input.value;
    const caretDigits = before.slice(0, input.selectionStart ?? before.length).replace(/\D/g, '').length;
    const digits = before.replace(/\D/g, '').slice(0, isBsb ? 6 : 20);
    const value = isBsb && digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
    if (value === before) return;
    input.value = value;
    let pos = 0;
    for (let seen = 0; pos < value.length && seen < caretDigits; pos += 1) if (/\d/.test(value[pos])) seen += 1;
    input.setSelectionRange(pos, pos);
  }

  document.addEventListener('change', async (ev) => {
    if (ev.target.dataset.input !== 'restore') return;
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (!confirm(`Restore "${file.name}"? This replaces your current accounts, income, payees, categories, expenses, savings, loans, goals and debts.`)) return;
    try {
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error("That file isn't a valid backup."); }
      const result = await api('POST', '/import', data);
      state.backups = null; // the copy saved before the restore is new, so load the list again
      await reload();
      state.offset = 0;
      render();
      const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
      toast(result.backup ? `Restored ${total} items. What was there before is under Settings → Backups.` : `Restored ${total} items`);
      if (result.warnings.length) alert(`Restored, with a few things to check:\n\n${result.warnings.join('\n')}`);
    } catch (err) {
      alert(`Restore failed: ${err.message}`);
    }
  });

  document.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'cycle-form') return;
    ev.preventDefault();
    const f = ev.target.elements;
    try {
      await api('PUT', '/settings', { pay_anchor_date: f.pay_anchor_date.value, pay_frequency: f.pay_frequency.value,
        pay_custom_days: f.pay_frequency.value === 'custom' ? Number(f.pay_custom_days.value) : null });
      state.offset = 0;
      await reload();
      toast('Settings saved');
      render();
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Shopping ----------
  //
  // Its own data (GET /shop), kept apart from the budget. The location being shopped at, and
  // which sections are folded away, are remembered on each device, since people shop at different stores.

  const remember = (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)); } catch { /* not remembered */ } };
  const recall = (key) => { try { return localStorage.getItem(key); } catch { return null; } };

  async function loadShop(list) {
    state.shop = await api('GET', `/shop?list=${list}`);
  }
  const shopReload = async () => { await loadShop(state.shop.list); render(); };
  const shopProduct = (id) => state.shop.products.find((p) => p.id === id);
  const storeName = (id) => state.shop.stores.find((s) => s.id === id)?.name || 'that store';
  const storeColour = (id) => state.shop.stores.find((s) => s.id === id)?.color || 'var(--muted)';
  // A store's name in its colour, or a login's name in theirs, as a small tag.
  const shopTag = (text, colour) => html`<span class="shop-tag" style="--tag:${colour || 'var(--brand)'}">${text}</span>`;
  const storeDot = (id) => html`<span class="dot store-dot" style="background:${storeColour(id)}"></span>`;
  // Product pictures: a store's, fetched for the app by the price-checker, and the small one kept
  // with a product's match at a store (at this store if it has one, else the first that does).
  const pictureUrl = (u) => `api/shop/picture?u=${encodeURIComponent(u)}`;
  function productPicture(p, store) {
    const at = (sid) => (p.matches?.[sid]?.image_v ? `api/shop/products/${p.id}/picture/${sid}?v=${p.matches[sid].image_v}` : null);
    if (store != null && at(store)) return at(store);
    for (const s of state.shop.stores) if (at(s.id)) return at(s.id);
    return null;
  }
  // A picture made small (96 pixels on its longer side) in the browser, as a JPEG to keep.
  async function thumbOf(url) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const k = Math.min(1, 96 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } catch { return null; }
  }
  // A picture that won't load is hidden rather than shown broken.
  document.addEventListener('error', (ev) => { if (ev.target instanceof HTMLImageElement && ev.target.classList.contains('pic')) ev.target.classList.add('gone'); }, true);
  const shopLocation = () => {
    const id = Number(recall('shop:location'));
    return state.shop.locations.find((l) => l.id === id) || null;
  };
  const locLabel = (l) => `${storeName(l.store_id)} ${l.name}`;
  const sectionsAt = (locId) => state.shop.sections.filter((s) => s.location_id === locId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const sizeLabel = (p) => (p.size ? `${p.size} ${p.unit}` : p.unit || '');
  // Prices by weight or volume: how many g or mL each is for (see PRICE_PER in src/shop.js).
  const PER = { each: null, kg: 1000, '100g': 100, L: 1000, '100mL': 100 };
  const PER_LABELS = { each: 'Each', kg: 'Per kg', '100g': 'Per 100 g', L: 'Per L', '100mL': 'Per 100 mL' };
  const BASE = { g: 1, kg: 1000, mL: 1, L: 1000 };
  const pricePerText = (p) => (PER[p.price_per] ? `/${p.price_per.replace(/^100/, '100 ')}` : '');
  // What one of a product costs at a store, or null with no price there. $10 per kg for 500 g is $5.
  function itemCost(p, store) {
    const c = store == null ? null : p.prices[store];
    if (c == null) return null;
    const per = PER[p.price_per];
    return per && p.size && BASE[p.unit] ? Math.round((c * p.size * BASE[p.unit]) / per) : c;
  }
  const productLabel = (p) => (sizeLabel(p) ? `${p.name} · ${sizeLabel(p)}` : p.name);
  // For the search's suggestions: each product's price at this store and the best price anywhere.
  function priceHints(store) {
    const out = {};
    for (const p of state.shop.products) {
      if (out[p.name]) continue;
      const here = itemCost(p, store);
      const best = bestPrice(p, store);
      const parts = [];
      if (here != null) parts.push(`${storeName(store)} ${money(here)}`);
      if (best && (here == null || best.cents < here)) parts.push(`best ${money(best.cents)} ${storeName(best.store)}`);
      if (parts.length) out[p.name] = parts.join(' · ');
    }
    return out;
  }

  // Looking a product up on a store's website: its search page, searched for the name and size.
  const lookupUrl = (s, name, size = '') => (s && s.search_url && name
    ? s.search_url.replace(/\{q\}/g, encodeURIComponent(`${name} ${size}`.trim())) : null);
  const lookupLink = (s, name, size) => {
    const url = lookupUrl(s, name, size);
    return url ? html`<a class="lookup" href="${url}" target="_blank" rel="noopener noreferrer" data-lookup="${s.id}">Look up ↗</a>` : '';
  };
  // The store's own product a price is kept up to date from, or that it couldn't be found last time.
  const matchLine = (p, s) => {
    const m = p.matches?.[s.id];
    if (!m || !state.shop.checker || !s.checker) return '';
    if (!m.url) return html`<div class="match-line muted small">No automatic price here <button type="button" class="linkish small" data-find-store="${s.id}">Find</button></div>`;
    return m.missing_at ? html`<div class="match-line warn small">Couldn't find at ${s.name} <button type="button" class="linkish small" data-find-store="${s.id}">Find new match</button></div>`
      : html`<div class="match-line muted small" title="${m.name}">Auto: ${m.name}</div>`;
  };
  // Days since a time the server wrote (in UTC), by the calendar here: 0 today, 1 yesterday.
  const daysSince = (at) => {
    if (!at) return null;
    const d = new Date(`${at.replace(' ', 'T')}Z`);
    const now = new Date();
    return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  };
  function checkedText(at) {
    const d = daysSince(at);
    if (d === null) return 'Not checked yet';
    if (d < 1) return 'Checked today';
    if (d < 2) return 'Checked yesterday';
    if (d < 14) return `Checked ${d} days ago`;
    if (d < 60) return `Checked ${Math.floor(d / 7)} weeks ago`;
    return `Checked ${Math.floor(d / 30)} months ago`;
  }

  // A day as short as it can be said: Today, Thu 15 within the week, or 5 Oct.
  function shortDay(at) {
    if (!at) return '';
    const d = new Date(`${at.replace(' ', 'T')}Z`);
    const days = daysSince(at);
    if (days <= 0) return 'Today';
    if (days > 0 && days < 7) return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric' });
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  }

  // Where a product is at a location, as a group to list it under: { key, label, order }.
  function shopSpot(p, loc) {
    const spot = loc && p.spots[loc.id];
    if (!spot) return { key: 'unsorted', label: 'Unsorted', order: -1 };
    if (spot.missing) return { key: 'missing', label: `Not at ${storeName(loc.store_id)}`, order: 1000 };
    if (spot.aisle != null) return { key: `a${spot.aisle}`, label: `Aisle ${spot.aisle}`, order: spot.aisle, aisle: true };
    const s = state.shop.sections.find((x) => x.id === spot.section_id);
    return s ? { key: `s${s.id}`, label: s.name, order: s.position, section: s } : { key: 'unsorted', label: 'Unsorted', order: -1 };
  }
  // Groups in walking order: by number, a section before an aisle with the same number, then by name.
  const groupOrder = (a, b) => a.order - b.order || (a.aisle ? 1 : 0) - (b.aisle ? 1 : 0) || a.label.localeCompare(b.label);
  function groupBy(rows, loc, product) {
    const groups = new Map();
    for (const r of rows) {
      const g = shopSpot(product(r), loc);
      if (!groups.has(g.key)) groups.set(g.key, { ...g, rows: [] });
      groups.get(g.key).rows.push(r);
    }
    return [...groups.values()].sort(groupOrder);
  }

  // The cheapest store for a product, keeping the one being shopped at when it's as cheap.
  function bestPrice(p, store) {
    const here = itemCost(p, store);
    let best = here != null ? { store, cents: here } : null;
    for (const s of state.shop.stores) {
      const c = itemCost(p, s.id);
      if (c != null && (!best || c < best.cents)) best = { store: s.id, cents: c };
    }
    return best;
  }

  // The trip so far and still to come. What's been ticked off counts at the store it was bought
  // at. What's left counts at this store, and at whichever store is cheapest for each item; only
  // items with a price here count, so the two can be compared.
  function shopTotals(rows, store) {
    const out = { spent: new Map(), spentTotal: 0, remaining: 0, unpriced: 0, split: new Map(), saving: 0 };
    for (const { it, p } of rows) {
      if (it.done_at) {
        const at = boughtAt(it, p, store);
        const c = lineCost(it, p, at);
        if (c != null) { out.spent.set(at, (out.spent.get(at) || 0) + c); out.spentTotal += c; }
        continue;
      }
      const here = lineCost(it, p, store);
      if (here == null) { out.unpriced += 1; continue; }
      const best = lineBest(it, p, store);
      out.remaining += here;
      out.split.set(best.store, (out.split.get(best.store) || 0) + best.cents);
      out.saving += here - best.cents;
    }
    return out;
  }
  // The store a ticked item counts at: where it was bought, or this one when that isn't known
  // (ticked before a store was chosen) or has no price.
  const boughtAt = (it, p, store) => (it.done_store_id && lineCost(it, p, it.done_store_id) != null ? it.done_store_id : store);
  // What a row costs: at the store it was bought at once ticked off, otherwise at this one.
  const rowCost = ({ it, p }, store) => lineCost(it, p, it.done_at ? boughtAt(it, p, store) : store);
  // The same, buying it wherever is cheapest if it's still to get.
  const rowBest = (r, store) => { const b = !r.it.done_at && lineCost(r.it, r.p, store) != null ? lineBest(r.it, r.p, store) : null; return b ? b.cents : rowCost(r, store); };

  // The totals under the list: tiles for the whole shop, what's spent, what's left and the best
  // it could be; a bar of where the money goes; and a line per store.
  function shopSummary(t, store) {
    const money2 = (c) => moneyFmt.format((c || 0) / 100);
    const best = t.remaining - t.saving;
    const after = t.spentTotal + best;
    const used = state.shop.stores.filter((s) => t.spent.get(s.id) || t.split.get(s.id));
    const across = state.shop.stores.filter((s) => t.spent.get(s.id)).length;
    const whole = t.spentTotal + best;
    const seg = (s, cents, hatch) => (cents ? html`<span class="sum-seg ${hatch ? 'hatch' : ''}" style="--seg:${s.color || 'var(--muted)'};flex-grow:${cents}"
      title="${s.name}: ${money2(cents)} ${hatch ? 'to buy' : 'spent'}"></span>` : '');
    const tile = (label, cents, sub, cls = '') => html`<div class="sum-tile"><span class="sum-label">${label}</span><b class="sum-num num">${money2(cents)}</b><span class="sum-sub ${cls}">${sub}</span></div>`;
    return html`<div class="card shop-sum">
      <div class="sum-tiles">
        ${tile('Total shop', t.spentTotal + t.remaining, 'before savings')}
        ${tile('Spent so far', t.spentTotal, across ? `across ${across} ${across === 1 ? 'store' : 'stores'}` : 'nothing ticked yet')}
        ${tile('Still to buy', t.remaining, !store ? 'choose a store to price it' : t.unpriced ? `${t.unpriced} ${t.unpriced === 1 ? 'item' : 'items'} without a price` : `at ${storeName(store)}`, t.unpriced || !store ? 'warn' : '')}
        <div class="sum-tile sum-best">
          <div class="sum-best-head"><span class="sum-label">Total after savings</span>${t.saving ? html`<span class="sum-pill">Save ${money2(t.saving)}</span>` : ''}</div>
          <b class="sum-num num">${money2(after)}</b>
          <span class="sum-sub">${t.saving ? `${money2(best)} left to buy by shopping around` : 'Already the best price for what\'s left'}</span>
        </div>
      </div>
      ${whole ? html`<div class="sum-bar" role="img" aria-label="Spent and still to buy, by store">
          ${used.map((s) => seg(s, t.spent.get(s.id), false))}${used.map((s) => seg(s, t.split.get(s.id), true))}</div>
        <div class="sum-legend"><span><i class="sum-key"></i>Spent</span><span><i class="sum-key hatch"></i>Still to buy (cheapest store)</span></div>` : ''}
      ${used.length ? html`<div class="sum-table" role="table">
        <div class="sum-tr sum-th" role="row"><span role="columnheader">Store</span><span role="columnheader">Spent</span><span role="columnheader">To buy</span><span role="columnheader">Store total</span></div>
        ${used.map((s) => {
          const sp = t.spent.get(s.id) || 0; const tb = t.split.get(s.id) || 0;
          return html`<div class="sum-tr" role="row"><span role="cell">${shopTag(s.name, s.color)}</span><span role="cell" class="num">${sp ? money2(sp) : '—'}</span>
            <span role="cell" class="num ${tb ? 'good' : 'muted'}">${tb ? `+ ${money2(tb)}` : '—'}</span><span role="cell" class="num"><b>${money2(sp + tb)}</b></span></div>`;
        })}
        <div class="sum-tr sum-tt" role="row"><span role="cell">Total</span><span role="cell" class="num">${money2(t.spentTotal)}</span>
          <span role="cell" class="num good">${money2(best)}</span><span role="cell" class="num good">${money2(after)}</span></div>
      </div>` : ''}
    </div>`;
  }

  const shopCollapsed = () => { try { return new Set(JSON.parse(recall('shop:collapsed') || '[]')); } catch { return new Set(); } };

  // Best buy here: as cheap here as anywhere, or with no price anywhere yet (so nothing is hidden
  // that might be cheapest here).
  function bestHere(p, store) {
    if (itemCost(p, store) == null) return state.shop.stores.every((s) => itemCost(p, s.id) == null);
    return bestPrice(p, store).store === store;
  }
  const bestOnly = () => recall('shop:best') === '1';
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const NOTE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h7l3 3v8H3z"/><path d="M5.5 7.5h5M5.5 10h3.5"/></svg>';
  const LIST_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function renderShopping() {
    const shop = state.shop;
    const loc = shopLocation();
    const store = loc ? loc.store_id : null;
    const money2 = (c) => moneyFmt.format((c || 0) / 100);
    const rows = shop.items.map((it) => ({ it, p: shopProduct(it.product_id) })).filter((r) => r.p);
    const filter = store && bestOnly();
    const left = rows.filter((r) => !r.it.done_at);
    const bestCount = store ? left.filter((r) => bestHere(r.p, store)).length : 0;
    const shown = filter ? rows.filter((r) => r.it.done_at || bestHere(r.p, store)) : rows;
    const groups = groupBy(shown, loc, (r) => r.p);
    const collapsed = shopCollapsed();
    const keyOf = (g) => `${loc ? loc.id : 0}:${g.key}`;
    const anyShut = groups.some((g) => collapsed.has(keyOf(g)));
    const done = rows.length - left.length;
    const similarCount = left.filter((r) => r.p.similar).length;

    const head = loc
      ? html`<div class="shop-store">
          <span class="store-badge" style="--tag:${storeColour(store)}" aria-hidden="true">${storeName(store).slice(0, 1).toUpperCase()}</span>
          <div class="grow"><div class="store-kicker">Shopping at</div>
            <div class="store-title"><b>${storeName(store)}</b> <span>${loc.name}</span></div></div>
          <button type="button" data-action="shop-change">Change store</button></div>`
      : shop.locations.length
        ? html`<div class="shop-store"><div class="grow"><div class="store-kicker">Shopping at</div><div class="store-title"><b>Choose a store</b></div></div>
            <button type="button" class="primary" data-action="shop-change">Choose store</button></div>`
        : html`<div class="shop-store"><p class="muted small grow">Add the stores you shop at to sort the list by aisle and compare prices.</p>
            <button type="button" class="primary" data-action="shop-stores">+ Add a store location</button></div>`;

    const U = window.UnitPrice;
    // One pack at a store as it's priced there: its price, and the size it's matched to there (an
    // Aldi 400 g against a 500 g product), else the product's own. Swapped: the pack it's swapped to.
    const packAt = (it, p, s) => {
      const swap = swappedAt(it, p, s);
      if (swap) return { cents: swap.price_cents, size: U.parse(swap.size) || U.parse(swap.name) };
      const cents = itemCost(p, s);
      if (cents == null) return null;
      const m = p.matches?.[s];
      const matched = (!PER[p.price_per] && m && m.url && U.parse(m.size)) || null;
      return { cents, size: matched || U.parse(p.size, p.unit) };
    };
    // Its price per kg, L or each at a store, for comparing stores and packs.
    const unitAt = (it, p, s) => {
      if (isWeighed(p)) return U.perKg(perKgAt(p, s));
      const pk = packAt(it, p, s);
      return pk && U.of(pk.cents, pk.size);
    };
    const unitSpan = (u) => (u ? html`<span class="unit">${U.text(u)}</span>` : '');
    const MINUS = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
    const PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
    const SWAP_ICON = '<span class="swap-mark" aria-hidden="true">⇆</span>';

    // A row is two lines on a computer: the name, aisle, amount and total, then a cheaper similar
    // product on the left and a cheaper store on the right, each in its own cell so they can't run
    // into the amount. On a phone it folds to the name, amount and total, with a chevron to open
    // the rest.
    // Pictures show once any product on the list has one, with a blank space for the rest.
    const pics = rows.some((r) => productPicture(r.p, store));
    const row = ({ it, p }) => {
      const g = shopSpot(p, loc);
      const price = store ? lineCost(it, p, store) : null;
      const cost = rowCost({ it, p }, store);
      const best = store && price != null ? lineBest(it, p, store) : null;
      const weighed = isWeighed(p) && it.grams != null;
      const amountText = weighed ? gramsText(it.grams) : `${it.qty}×`;
      // Swapped for this shop, at whichever store it's swapped at.
      const swap = it.swap_store_id ? swappedAt(it, p, it.swap_store_id) : null;
      const swapLabel = swap && (it.swap_kind === 'similar' ? `${storeProduct(it.swap_store_id, swap.name)}${sizeAfter(swap.name, swap.size)}`
        : `${swap.size || 'other size'}${it.swap_store_id !== store ? ` at ${storeName(it.swap_store_id)}` : ''}`);
      const cheaper = best && best.store !== store ? best : null;
      const got = Boolean(it.done_at);
      const at = got && it.done_store_id;
      const open = !got && state.shopOpen.has(it.id);
      const unitHere = store != null ? unitAt(it, p, store) : null;
      const pic = productPicture(p, store);
      const sizeText = swap ? '' : isWeighed(p) ? 'by the kg' : sizeLabel(p);
      const sim = !got && p.similar && !swap ? p.similar : null;
      // The cheaper store, said the way its shelf would: per pack, each, or for the weight.
      let cheapLine = '';
      if (!got && cheaper) {
        const there = unitAt(it, p, cheaper.store);
        const pk = isWeighed(p) ? null : packAt(it, p, cheaper.store);
        const one = pk && pk.size && pk.size.kind === 'count' && pk.size.amount === 1;
        const grams = isWeighed(p) ? itemGrams(it, p) : null;
        const what = isWeighed(p) ? `${money2(cheaper.cents)}${grams ? ` for ${gramsText(grams)}` : ''}`
          : one ? `${money2(pk.cents)} each` : `${money2(pk ? pk.cents : cheaper.cents)} per pack`;
        // Cheaper for what's on the list, but dearer for the amount (a smaller pack): said so.
        const dearer = there && unitHere && there.per === unitHere.per && there.cents > unitHere.cents;
        cheapLine = html`<div class="si-cheap" id="si-c-${it.id}">${storeDot(cheaper.store)}<span class="ct">${what} at ${storeName(cheaper.store)}${there && !one ? html` · ${U.text(there)}` : ''}</span>
          ${dearer ? html`<span class="dearer" title="${storeName(cheaper.store)}'s pack costs less, but more per ${there.per} than ${U.text(unitHere)} here">dearer per ${there.per}</span>` : ''}
          <span class="save-chip" title="Save ${money2(price - cheaper.cents)} at ${storeName(cheaper.store)}">−${money2(price - cheaper.cents)}</span></div>`;
      }
      const swapLine = sim ? html`<button type="button" class="si-swap" id="si-s-${it.id}" data-action="shop-item" data-id="${it.id}" title="A similar product costs less for the amount: tap to swap to it for this shop">
          ${raw(SWAP_ICON)}<span class="st">${storeProduct(sim.store_id, sim.name)}${sizeAfter(sim.name, sim.size)} · <b>${money2(sim.price_cents)}</b></span>${unitSpan(U.of(sim.price_cents, U.parse(sim.size) || U.parse(sim.name)))}</button>` : '';
      const setAisle = !got && loc && g.key === 'unsorted' ? html`<button type="button" class="linkish small" data-action="shop-spot" data-id="${p.id}">Set aisle</button>` : '';
      const sizeBits = [sizeText, unitHere ? U.text(unitHere) : ''].filter(Boolean).join(' · ');
      const cls = ['shop-item', got ? 'got' : '', sim ? 'has-swap' : 'no-swap', cheapLine ? 'has-cheap' : '', pics ? 'with-pic' : ''].filter(Boolean).join(' ');
      return html`<li class="${cls}" data-expanded="${open ? 'true' : 'false'}" data-name="${productLabel(p).toLowerCase()}" data-pname="${p.name.toLowerCase()}">
        <input type="checkbox" data-action="shop-tick" data-id="${it.id}" ${raw(got ? 'checked' : '')} aria-label="${got ? 'Not got' : 'Got'} ${p.name}">
        <div class="si-name" data-action="shop-item" data-id="${it.id}">
          ${pics ? html`<span class="si-pic">${pic ? html`<img class="pic" src="${pic}" alt="" loading="lazy">` : ''}</span>` : ''}
          <div class="si-text"><div class="title"><span class="nm">${p.name}</span>${swap ? html` <span class="shop-size swapped" title="Swapped for this shop">⇄ ${swapLabel}${unitHere ? html` · ${U.text(unitHere)}` : ''}</span>`
            : sizeBits ? html` <span class="shop-size wide-only">${sizeBits}</span>` : ''}
            ${it.note ? html`<span class="note-mark" title="Note: ${it.note}" aria-label="Has a note">${raw(NOTE_ICON)}</span>` : ''}
            ${p.setup ? html`<button type="button" class="setup-tag" data-action="shop-setup" data-id="${p.id}">Set up</button>` : ''}</div>
          <div class="si-size phone-only"><span class="qty-badge">${got && !weighed ? `×${it.qty}` : amountText}</span>${swap ? '' : html`<span>${sizeBits}</span>`}</div></div>
        </div>
        <div class="si-who">${got ? html`${it.done_by_name ? html`<span class="who-init" style="--tag:${it.done_by_colour || 'var(--brand)'}" title="Checked off by ${it.done_by_name}">${it.done_by_name.slice(0, 1).toUpperCase()}</span>` : ''}
          ${at ? html`<span class="who-at">${storeDot(at)}${storeName(at)}</span>` : ''}` : setAisle}</div>
        <div class="si-qty" id="si-q-${it.id}">${got ? html`<span class="shop-qty">${weighed ? gramsText(it.grams) : `×${it.qty}`}</span>` : html`<span class="stepper ${weighed ? 'weighed' : ''}">
          <button type="button" data-action="shop-qty" data-id="${it.id}" data-step="-1" aria-label="Decrease: ${weighed ? `${gramsText(stepOf(p))} less` : 'one less'} ${p.name}">${raw(MINUS)}</button>
          <span class="shop-qty" aria-label="${weighed ? gramsText(it.grams) : it.qty} of ${p.name}">${weighed ? gramsText(it.grams) : it.qty}</span>
          <button type="button" data-action="shop-qty" data-id="${it.id}" data-step="1" aria-label="Increase: ${weighed ? `${gramsText(stepOf(p))} more` : 'one more'} ${p.name}">${raw(PLUS)}</button></span>
          ${setAisle ? html`<span class="phone-only">${setAisle}</span>` : ''}`}</div>
        <div class="si-total num">${cost != null ? money2(cost) : got ? '—'
          : store != null && p.not_sold?.[store] ? html`<span class="muted small">Not sold here</span>`
          : html`<button type="button" class="linkish small" data-action="shop-item" data-id="${it.id}">+ price</button>`}
          ${sim || cheapLine ? html`<span class="si-flags phone-only">${sim ? html`<span class="flag-swap" title="A cheaper similar product">${raw(SWAP_ICON)}</span>` : ''}${cheapLine ? html`<span class="save-chip">−${money2(price - cheaper.cents)}</span>` : ''}</span>` : ''}</div>
        ${got ? '' : html`<button type="button" class="si-chev phone-only" data-action="shop-open" data-id="${it.id}" aria-expanded="${open ? 'true' : 'false'}"
          aria-controls="si-q-${it.id}${cheapLine ? ` si-c-${it.id}` : ''}${sim ? ` si-s-${it.id}` : ''}" aria-label="${open ? 'Hide' : 'Show'} details for ${p.name}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`}
        ${swapLine}${cheapLine}
      </li>`;
    };

    const section = (g) => {
      const key = keyOf(g);
      const shut = collapsed.has(key);
      const gotShut = collapsed.has(`${key}:got`);
      const todo = g.rows.filter((r) => !r.it.done_at).sort((a, b) => a.p.name.localeCompare(b.p.name));
      const got = g.rows.filter((r) => r.it.done_at).sort((a, b) => a.p.name.localeCompare(b.p.name));
      const sub = g.rows.reduce((t, r) => t + (rowCost(r, store) ?? 0), 0);
      const optimal = g.rows.reduce((t, r) => t + (rowBest(r, store) ?? 0), 0);
      // A folded section has no rows on the page, so the search reads its names from here.
      const names = shut ? { names: g.rows.map((r) => productLabel(r.p).toLowerCase()).join('|'), pnames: g.rows.map((r) => r.p.name.toLowerCase()).join('|') } : {};
      return html`<section class="card shop-sec ${shut ? 'shut' : ''} ${g.key === 'unsorted' ? 'unsorted' : ''} ${todo.length ? '' : 'all-got'}" data-names="${names.names ?? ''}" data-pnames="${names.pnames ?? ''}">
        <button type="button" class="shop-gtoggle" data-action="shop-fold" data-key="${key}" aria-expanded="${shut ? 'false' : 'true'}">
          <span class="chev">${shut ? '▸' : '▾'}</span><span class="g-name">${g.label}</span>
          <span class="g-count">${todo.length ? `${todo.length} left` : 'All got'}</span>
          <span class="g-right">${optimal < sub ? html`<span class="g-save" title="Cheapest everywhere: ${money2(optimal)}">Save ${money2(sub - optimal)} at other stores</span>` : ''}
            <b class="num g-total">${sub ? money2(sub) : '—'}</b></span></button>
        ${shut ? '' : html`
          ${g.key === 'unsorted' && loc && todo.length ? html`<p class="muted small shop-hint">Set where these are at ${locLabel(loc)} and they'll be sorted from now on.</p>` : ''}
          <ul class="shop-rows">${todo.map(row)}
            ${got.length ? html`<li class="shop-gothead"><button type="button" class="linkish small" data-action="shop-fold" data-key="${key}:got" aria-expanded="${gotShut ? 'false' : 'true'}">
              <span class="chev">${gotShut ? '▸' : '▾'}</span>Got ${got.length}</button></li>${gotShut ? '' : got.map(row)}` : ''}</ul>`}
      </section>`;
    };

    const tools = rows.length ? html`<div class="shop-tools">
        ${store ? html`<button type="button" class="best-toggle" role="switch" aria-checked="${filter ? 'true' : 'false'}" data-action="shop-best">
          <span class="switch" aria-hidden="true"></span>Best buys at ${storeDot(store)}<b>${storeName(store)}</b><span class="muted">${bestCount} of ${left.length}</span></button>` : ''}
        ${similarCount ? html`<button type="button" class="similar-chip" data-action="shop-similar">${similarCount} cheaper similar</button>` : ''}
        <span class="spacer"></span>
        ${groups.length ? html`<button type="button" class="linkish small" data-action="shop-fold-all" data-open="${anyShut ? '1' : ''}">${anyShut ? 'Expand all' : 'Collapse all'}</button>` : ''}
        <button type="button" class="mini icon-only" data-action="shop-copy" title="Copy the list" aria-label="Copy the list">${COPY_ICON}</button>
        <button type="button" class="mini" data-action="shop-check">Check prices</button>
        ${loc ? html`<button type="button" class="mini" data-action="shop-sections" data-id="${loc.id}">${raw(LIST_ICON)} Edit categories</button>` : ''}
      </div>
      <div class="shop-cols" aria-hidden="true"><span></span><span>Item</span><span>${done ? 'Aisle · got by' : 'Aisle'}</span><span>Qty</span><span>Total</span></div>` : '';

    const totals = rows.length ? shopSummary(shopTotals(rows, store), store) : '';

    return html`
      <div class="card shop-top">
        ${head}
        <div class="shop-add">
          <form id="shop-add" class="shop-search" autocomplete="off">
            <span class="search-ico">${raw(SEARCH_ICON)}</span>
            <label for="shop-name" class="sr-only">Search or add an item</label>
            ${combo({ id: 'shop-name', name: 'name', value: '', options: [...new Set(shop.products.map((p) => p.name))], meta: priceHints(store), placeholder: 'Search or add an item, like Milk' })}
            <span class="search-end">
              <button type="button" class="search-clear" data-action="shop-search-clear" aria-label="Clear the search" hidden>✕</button>
              <button type="submit" class="primary">Add</button>
            </span>
          </form>
          <button type="button" data-action="shop-products">${raw(LIST_ICON)} Saved products</button>
        </div>
        ${rows.length ? html`<div class="shop-progress"><span><b>${done} of ${rows.length}</b> got</span>
          <span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${rows.length}" aria-valuenow="${done}"><i style="width:${Math.round((done / rows.length) * 100)}%"></i></span></div>` : ''}
      </div>
      ${autoBanner()}
      ${rows.length && !loc ? html`<div class="setup-banner shop-noloc"><span class="grow"><b>${shop.locations.length ? 'Which store are you at?' : 'Add the store you shop at'}</b>
          Prices on the list, totals and aisles all need a store location, like Woolworths Castletown.</span>
        <button type="button" class="mini primary" data-action="${shop.locations.length ? 'shop-change' : 'shop-stores'}">${shop.locations.length ? 'Choose store' : '+ Add a store location'}</button></div>` : ''}
      ${tools}
      ${rows.length ? html`<div class="shop-list">${groups.length ? groups.map(section)
          : html`<div class="card"><p class="empty">Nothing left that's cheapest at ${storeName(store)}. Turn off Best buys to see everything.</p></div>`}</div>
        <p class="empty shop-nomatch" hidden>Nothing on the list matches. Press Add to add it.</p>
        ${done ? html`<div class="shop-clear"><button type="button" class="danger" data-action="shop-clear">Clear ${done} ticked ${done === 1 ? 'item' : 'items'}</button></div>` : ''}
        ${totals}`
        : html`<div class="card"><p class="empty">Nothing on this list. Add an item above, or pick from your saved products.</p></div>`}
      <p class="tab-hint">Tick things off as they go in the trolley. They drop to the bottom of their category until you clear them, and stay in Saved products for next time.</p>`;
  }

  // Typing in the box filters the list as you go; Add puts it on the list.
  // Typing an item's full name highlights it on the list and scrolls to it.
  let shopFound = null;
  function shopFilter(q) {
    const words = q.trim().toLowerCase();
    let any = false;
    let found = null;
    document.querySelectorAll('.shop-sec').forEach((sec) => {
      let seen = 0;
      if (sec.classList.contains('shut')) {
        const same = Boolean(words) && sec.dataset.pnames.split('|').includes(words);
        seen = !words || same || sec.dataset.names.split('|').some((n) => n.includes(words)) ? 1 : 0;
        sec.classList.toggle('found', same);
        if (same && !found) found = sec;
      }
      sec.querySelectorAll('.shop-item').forEach((li) => {
        const hit = !words || li.dataset.name.includes(words);
        const same = Boolean(words) && li.dataset.pname === words;
        li.hidden = !hit;
        li.classList.toggle('found', same);
        if (same && !found) found = li;
        if (hit) seen += 1;
      });
      sec.hidden = Boolean(words) && !seen;
      if (seen) any = true;
    });
    const none = document.querySelector('.shop-nomatch');
    if (none) none.hidden = !words || any;
    const clear = document.querySelector('.search-clear');
    if (clear) clear.hidden = !q;
    if (found && found !== shopFound) {
      // It's already on the list, so close the suggestions that would cover it.
      const input = document.getElementById('shop-name');
      setTimeout(() => { if (input) closeCombo(input); found.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
    }
    shopFound = found;
  }
  document.addEventListener('input', (ev) => { if (ev.target.id === 'shop-name') shopFilter(ev.target.value); });

  async function shopAdd(name) {
    if (!name) return;
    const before = state.shop.items.length;
    await api('POST', '/shop/items', { list: state.shop.list, name });
    await loadShop(state.shop.list);
    render();
    if (state.shop.items.length === before) toast(`Added another ${name}`);
  }

  document.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'shop-add') return;
    ev.preventDefault();
    const input = ev.target.elements.name;
    try {
      await shopAdd(input.value.trim());
      document.getElementById('shop-name')?.focus();
    } catch (err) { toast(err.message); }
  });
  // Picking a known item from the suggestions adds it straight away.
  document.addEventListener('change', async (ev) => {
    if (ev.target.id === 'shop-name' && ev.target.dataset.picked) {
      delete ev.target.dataset.picked;
      try { await shopAdd(ev.target.value.trim()); document.getElementById('shop-name')?.focus(); } catch (err) { toast(err.message); }
    }
  });

  // Live updates: while the list is open, check every few seconds whether anyone changed it.
  // A change waits while a popup is open or something is being typed.
  setInterval(async () => {
    if (!state.shop || !location.hash.startsWith('#/shopping') || document.visibilityState !== 'visible') return;
    if ($modal.open || $prompt.open || document.getElementById('shop-name')?.value) return;
    try {
      const { rev } = await api('GET', '/shop/rev');
      if (rev === state.shop.rev || $modal.open || $prompt.open) return;
      await shopReload();
    } catch { /* tried again shortly */ }
  }, 5000);

  // Which store location is being shopped at, grouped by store.
  // How many products have a place set at a location, and when it was last picked to shop at.
  const aislesAt = (l) => state.shop.products.filter((p) => p.spots[l.id] && !p.spots[l.id].missing).length;
  function usedText(at) {
    const d = daysSince(at);
    if (d === null) return '';
    if (d < 1) return 'Today';
    if (d < 2) return 'Yesterday';
    if (d < 7) return `${d} days ago`;
    if (d < 14) return 'Last week';
    if (d < 30) return `${Math.floor(d / 7)} weeks ago`;
    if (d < 60) return 'Last month';
    return `${Math.floor(d / 30)} months ago`;
  }
  const aislesText = (l) => { const n = aislesAt(l); return n ? `${n} ${n === 1 ? 'item' : 'items'} with aisles` : 'Aisles not set'; };
  const aOrAn = (name) => (/^[aeiou]/i.test(name) ? 'an' : 'a');
  const AISLE_ICON = raw('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 2v12M13 2v12M3 6h10M3 10h10"/></svg>');
  const SLIDERS_ICON = raw('<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 2.5v11M8 2.5v11M13 2.5v11"/><path d="M1.5 10h3M6.5 5h3M11.5 9h3"/></svg>');

  // Where are you shopping: each chain's locations as tiles, with when each was last used. A tap
  // picks one and closes; Shop at keeps the one already picked. Adding, renaming and deleting
  // are in Manage stores.
  function shopChange() {
    const loc = shopLocation();
    const newest = state.shop.locations.filter((l) => l.used_at).sort((a, b) => b.used_at.localeCompare(a.used_at))[0];
    const sub = (l) => (newest && l.id === newest.id ? 'Last used' : usedText(l.used_at) || aislesText(l));
    openForm({
      title: null,
      cls: 'store-pick',
      noActions: true,
      body: html`${popHead('Where are you shopping?', {}, html`<p class="pop-sub">Your list is sorted by this store's aisles.</p>`)}
        ${state.shop.stores.map((s) => {
          const locs = state.shop.locations.filter((l) => l.store_id === s.id);
          return html`<section class="pk-chain"><h3 class="pk-head">${storeDot(s.id)}${s.name}</h3>
            ${locs.length ? html`<div class="pk-grid">${locs.map((l) => html`<button type="button" class="pk-tile ${loc && loc.id === l.id ? 'on' : ''}" data-pick-loc="${l.id}">
                <span class="pk-name">${l.name}</span><span class="pk-sub">${sub(l)}</span>${loc && loc.id === l.id ? html`<span class="pk-tick" aria-hidden="true">✓</span>` : ''}</button>`)}</div>`
              : html`<div class="pk-empty"><span class="muted small">No locations yet</span>
                <button type="button" class="linkish small" data-action="shop-loc-new" data-id="${s.id}" data-back="change">+ Add ${aOrAn(s.name)} ${s.name} location</button></div>`}</section>`;
        })}
        <div class="dialog-actions pk-actions"><button type="button" data-action="shop-stores" data-back="change">${SLIDERS_ICON} Manage stores</button><span class="spacer"></span>
          ${loc ? html`<button type="button" class="primary" data-modal="cancel">Shop at ${locLabel(loc)}</button>` : ''}</div>`,
      afterRender: (form) => {
        form.onclick = (ev) => {
          const b = ev.target.closest('[data-pick-loc]');
          if (!b) return;
          remember('shop:location', b.dataset.pickLoc);
          closeForm();
          render();
          api('POST', `/shop/locations/${b.dataset.pickLoc}/use`).then(() => loadShop(state.shop.list)).catch(() => {});
        };
      },
    });
  }

  // The aisle picker: every aisle and this location's sections as buttons, one tap to choose.
  function spotPicker(p, loc, onPick) {
    state.spotFor = p.id;
    const spot = p.spots[loc.id];
    const on = (k) => (spot && ((k.aisle != null && spot.aisle === k.aisle) || (k.section && spot.section_id === k.section) || (k.missing && spot.missing)) ? 'on' : '');
    const btn = (k, label) => html`<button type="button" class="spot-btn ${on(k)}" data-spot="${JSON.stringify(k)}">${label}</button>`;
    const aisles = Array.from({ length: state.shop.max_aisle + 1 }, (_, n) => btn({ aisle: n }, String(n)));
    openForm({
      title: `Where's ${p.name}?`,
      body: html`<p class="muted small">At ${locLabel(loc)}. It's remembered for this store only.</p>
        <h3 class="form-section">Aisle</h3><div class="spot-grid">${aisles}</div>
        <h3 class="form-section">Category</h3><div class="spot-grid named">${sectionsAt(loc.id).map((s) => btn({ section: s.id }, s.name))}
          <button type="button" class="spot-btn add" data-action="shop-section-new" data-id="${loc.id}">+ Category</button></div>
        <div class="spot-grid named other">${btn({ missing: true }, `Not sold at ${storeName(loc.store_id)}`)}${spot ? btn({}, 'Unsorted') : ''}</div>`,
      noActions: true,
      afterRender: (form) => {
        form.onclick = async (ev) => {
          const b = ev.target.closest('[data-spot]');
          if (!b) return;
          const k = JSON.parse(b.dataset.spot);
          try {
            await api('PUT', `/shop/products/${p.id}/spot`, { location_id: loc.id, aisle: k.aisle ?? null, section_id: k.section ?? null, missing: Boolean(k.missing) });
            form.onclick = null;
            closeForm();
            await shopReload();
            if (onPick) onPick();
          } catch (err) { form.querySelector('#form-error').textContent = err.message; }
        };
      },
    });
  }

  // The same aisle or category at every location at once, like Produce. A category a location
  // hasn't got is added there. It replaces wherever it's set now. back is called after, or on ✕.
  function spotAllPicker(p, back) {
    const locs = state.shop.locations;
    const set = locs.filter((l) => p.spots[l.id]).length;
    const names = new Map();
    for (const sec of [...state.shop.sections].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))) {
      const k = sec.name.toLowerCase();
      if (!names.has(k)) names.set(k, { name: sec.name, at: 0 });
      names.get(k).at += 1;
    }
    const btn = (k, label, sub = '') => html`<button type="button" class="spot-btn" data-spot="${JSON.stringify(k)}" ${sub ? raw(`title="${sub}"`) : ''}>${label}</button>`;
    openForm({
      title: `${p.name} at every store`,
      body: html`<p class="muted small">Sets the same aisle or category at all ${locs.length} store locations.</p>
        ${set ? html`<p class="setup-banner"><span class="grow">This replaces where it's set now at ${set === locs.length ? `all ${set}` : `${set} of ${locs.length}`} locations.</span></p>` : ''}
        <h3 class="form-section">Category</h3><div class="spot-grid named">${[...names.values()].map((n) => btn({ section: n.name }, n.name,
          n.at < locs.length ? `Added at the ${locs.length - n.at} ${locs.length - n.at === 1 ? 'location' : 'locations'} without it` : ''))}</div>
        <h3 class="form-section">Aisle</h3><div class="spot-grid">${Array.from({ length: state.shop.max_aisle + 1 }, (_, n) => btn({ aisle: n }, String(n)))}</div>
        ${set ? html`<div class="spot-grid named other">${btn({}, 'Unsorted everywhere')}</div>` : ''}`,
      noActions: true,
      afterRender: (form) => {
        form.querySelector('[data-modal="cancel"]')?.addEventListener('click', () => setTimeout(back), { once: true });
        form.onclick = async (ev) => {
          const b = ev.target.closest('[data-spot]');
          if (!b) return;
          try {
            await api('PUT', `/shop/products/${p.id}/spots`, JSON.parse(b.dataset.spot));
            form.onclick = null;
            closeForm();
            await shopReload();
            toast(`${p.name} set at every store`);
            back();
          } catch (err) { form.querySelector('#form-error').textContent = err.message; }
        };
      },
    });
  }

  // ---------- A product on the list, and editing a product ----------
  //
  // Tapping something on the list opens what's on this list: how much (a weight, a count or packs),
  // its price at every store for that much, the other size a store sells, and a note for this shop.
  // Edit product changes the product itself: how it's sold, its usual amount, its prices and its
  // aisle at every store location.

  const SOLD_LABELS = { pack: 'Pack / each', weight: 'Weight (kg)', volume: 'Volume (L)' };
  const SOLD_UNITS = { pack: ['g', 'kg', 'mL', 'L', 'each', 'pack'], weight: ['g', 'kg'], volume: ['mL', 'L'] };
  const STEPS = [100, 250, 500, 1000];
  const isWeighed = (p) => p.sold_by === 'weight';
  // A weight in g as people say it: 250 g, 1 kg, 1.5 kg.
  const gramsText = (g) => (g >= 1000 ? `${+(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`);
  const stepOf = (p) => p.step_g || 250;
  // A product's size in g or mL, when it has one.
  const sizeIn = (p) => (p.size && BASE[p.unit] ? p.size * BASE[p.unit] : null);
  // A weighed product's price per kg at a store.
  function perKgAt(p, store) {
    const c = store == null ? null : p.prices[store];
    if (c == null) return null;
    if (p.price_per === 'kg' || p.price_per === '100g') return Math.round((c * 1000) / PER[p.price_per]);
    const g = sizeIn(p);
    return g && MEASURE_OF[p.unit] === 'weight' ? Math.round((itemCost(p, store) * 1000) / g) : null;
  }
  const MEASURE_OF = { g: 'weight', kg: 'weight', mL: 'volume', L: 'volume' };
  // How much of a weighed item is on the list, in g: its weight, or how many × what one weighs.
  const itemGrams = (it, p) => (it.grams != null ? it.grams : p.each_g ? it.qty * p.each_g : null);
  // The other size or close match a store sells, when the list has swapped to it for this shop.
  const swappedAt = (it, p, store) => (it.swap_store_id === store ? p.options?.[store]?.[it.swap_kind || 'size'] || null : null);
  // A store's product, naming the store once: "Woolworths Rolled Oats", or "Aldi · Rolled Oats".
  const storeProduct = (storeId, name) => (String(name).toLowerCase().startsWith(storeName(storeId).toLowerCase()) ? name : `${storeName(storeId)} · ${name}`);
  // What a list item costs at a store: its weight at the price per kg, or how many packs (of the
  // other size, if it's swapped to that at this store). Null with no price there.
  function lineCost(it, p, store) {
    if (store == null) return null;
    if (isWeighed(p)) {
      const k = perKgAt(p, store);
      const g = itemGrams(it, p);
      return k == null || g == null ? null : Math.round((k * g) / 1000);
    }
    const swap = swappedAt(it, p, store);
    if (swap) return swap.price_cents * it.qty;
    const c = itemCost(p, store);
    return c == null ? null : c * it.qty;
  }
  // The cheapest store for a list item, keeping this one when it's as cheap.
  function lineBest(it, p, store) {
    const here = lineCost(it, p, store);
    let best = here != null ? { store, cents: here } : null;
    for (const s of state.shop.stores) {
      const c = lineCost(it, p, s.id);
      if (c != null && (!best || c < best.cents)) best = { store: s.id, cents: c };
    }
    return best;
  }
  // Checked since the stores last changed their prices (Wednesday 9am) shows green, before that orange.
  const freshness = (at) => (at && state.shop.price_day && at >= state.shop.price_day ? 'fresh' : 'stale');
  const checkedTag = (at) => html`<span class="checked-tag ${freshness(at)}">${checkedText(at)}</span>`;
  // A price per kg or L for the amount: "$3.67/kg".
  const perUnitText = (cents, amount, unit) => (amount ? `${money(Math.round((cents * 1000) / amount))}/${unit === 'volume' ? 'L' : 'kg'}` : '');

  function shopItemPopup(itemId) {
    const it = state.shop.items.find((x) => x.id === itemId);
    const p = it && shopProduct(it.product_id);
    if (!p) { closeForm(); return; }
    const money2 = (c) => moneyFmt.format((c || 0) / 100);
    const loc = shopLocation();
    const store = loc ? loc.store_id : null;
    const weighed = isWeighed(p);
    const counting = weighed && it.grams == null;
    const spot = loc ? shopSpot(p, loc) : null;
    const measure = MEASURE_OF[p.unit];
    const sub = [spot && spot.key !== 'unsorted' ? spot.label : '',
      weighed ? `sold by the kg${p.each_g ? ` · about ${gramsText(p.each_g)} each` : ''}`
        : sizeLabel(p) ? `${sizeLabel(p)} ${p.sold_by === 'volume' ? 'bottle' : 'pack'}` : ''].filter(Boolean).join(' · ');

    // How much: a weight with − / + by the step and quick picks, a count, or packs.
    let amount;
    if (weighed && !counting) {
      const step = stepOf(p);
      const picks = [2, 4, 6, 8].map((n) => n * step);
      amount = html`<div class="ip-amount"><button type="button" class="ip-step" data-grams="${Math.max(0, it.grams - step)}" aria-label="${gramsText(step)} less">−</button>
          <div class="ip-big"><b>${gramsText(it.grams)}</b><span>steps of ${gramsText(step)}</span></div>
          <button type="button" class="ip-step plus" data-grams="${Math.min(100000, it.grams + step)}" aria-label="${gramsText(step)} more">+</button></div>
        <div class="ip-picks">${picks.map((g) => html`<button type="button" class="ip-pick ${g === it.grams ? 'on' : ''}" data-grams="${g}">${gramsText(g)}</button>`)}
          <button type="button" class="ip-pick other" data-other>Other…</button></div>`;
    } else {
      // Swapped to the other size at this store: that size.
      const swapHere = swappedAt(it, p, store);
      const packSize = swapHere ? swapHere.size || (it.swap_kind === 'similar' ? swapHere.name : 'other size') : sizeLabel(p);
      const each = weighed ? (p.each_g ? `about ${gramsText(it.qty * p.each_g)} · ${gramsText(p.each_g)} each` : '') : packSize ? `${it.qty} × ${packSize} ${p.sold_by === 'volume' ? 'bottle' : 'pack'}` : '';
      amount = html`<div class="ip-amount"><button type="button" class="ip-step" data-qty="${it.qty - 1}" aria-label="One less">−</button>
          <div class="ip-big"><b>× ${it.qty}</b><span>${each}</span></div>
          <button type="button" class="ip-step plus" data-qty="${Math.min(99, it.qty + 1)}" aria-label="One more">+</button></div>
        ${weighed && !p.each_g ? html`<div class="ip-each"><label for="ip-each">What does one weigh?</label>
          <span class="ip-each-in"><input id="ip-each" name="each_g" inputmode="numeric" placeholder="Like 180"><span>g each</span></span>
          <button type="button" class="mini" data-each>Save</button></div>` : ''}`;
    }
    const swapNow = swappedAt(it, p, store);
    const swapSize = swapNow && measureText(swapNow.size || swapNow.name);
    const packAmount = swapNow ? (swapSize ? swapSize[1] : null) : sizeIn(p) && measure ? sizeIn(p) : null;
    const packMeasure = swapNow ? swapSize && swapSize[0] : measure;
    const total = !weighed && packAmount ? `Total ${packMeasure === 'weight' ? gramsText(packAmount * it.qty) : `${+((packAmount * it.qty) / 1000).toFixed(2)} L`}` : '';
    const toggle = weighed ? html`<span class="seg small" role="group" aria-label="Weigh or count">
        <button type="button" class="${counting ? '' : 'on'}" data-mode="weight" aria-pressed="${counting ? 'false' : 'true'}">Weight</button>
        <button type="button" class="${counting ? 'on' : ''}" data-mode="count" aria-pressed="${counting ? 'true' : 'false'}">Count</button></span>` : html`<span class="muted small">${total}</span>`;

    // The other size each store sells (from its last search), to swap to for this shop.
    const sizes = weighed ? [] : state.shop.stores.filter((s) => p.options?.[s.id]?.size && p.matches?.[s.id]?.url)
      .sort((a, b) => Number(b.id === store) - Number(a.id === store));
    const sizeLine = (s) => {
      const o = p.options[s.id].size;
      const m = measureText(o.size || o.name);
      const per = m ? perUnitText(o.price_cents, m[1], m[0]) : '';
      const kind = p.sold_by === 'volume' ? 'bottle' : 'pack';
      if (it.swap_store_id === s.id && (it.swap_kind || 'size') === 'size') {
        return html`<div class="ip-size on">${storeDot(s.id)}<span class="grow">Swapped to the ${o.size || 'other'} ${kind} at ${s.name} for this shop · ${money2(o.price_cents)}${per ? ` (${per})` : ''}</span>
          <button type="button" class="mini" data-swap="">Undo</button></div>`;
      }
      return html`<div class="ip-size">${storeDot(s.id)}<span class="grow">${s.name} also sells ${o.size ? `a ${o.size} ${kind}` : o.name} for ${money2(o.price_cents)}${per ? ` (${per})` : ''}</span>
        <button type="button" class="mini primary" data-swap="${s.id}" data-kind="size">Swap</button></div>`;
    };

    // Each store's close match (from its last search), cheapest for the amount first, to swap to for
    // this shop. The cheapest is set apart when it's the one the list calls cheaper similar.
    const similars = weighed ? [] : state.shop.stores.filter((s) => p.options?.[s.id]?.similar).map((s) => {
      const o = p.options[s.id].similar;
      const m = measureText(o.size || o.name);
      return { s, o, m, per: m ? o.price_cents / m[1] : Infinity };
    }).sort((a, b) => a.per - b.per);
    const simLine = ({ s, o, m }) => {
      const per = m ? perUnitText(o.price_cents, m[1], m[0]) : '';
      const on = it.swap_store_id === s.id && it.swap_kind === 'similar';
      return html`<div class="ip-size ${on ? 'on' : ''}">${storeDot(s.id)}<span class="grow">${on ? 'Swapped to ' : ''}<b>${storeProduct(s.id, o.name)}</b>${sizeAfter(o.name, o.size)}
          · ${money2(o.price_cents)}${per ? ` (${per})` : ''}${on ? ' for this shop' : ''} <a class="lookup" href="${o.url}" target="_blank" rel="noopener noreferrer">View ↗</a></span>
        ${on ? html`<button type="button" class="mini" data-swap="">Undo</button>` : html`<button type="button" class="mini primary" data-swap="${s.id}" data-kind="similar">Swap</button>`}</div>`;
    };
    const topSimilar = similars.length && p.similar && p.similar.store_id === similars[0].s.id ? similars[0] : null;
    const restSimilar = topSimilar ? similars.slice(1) : similars;

    // Every store's price for that much, cheapest first.
    const priced = state.shop.stores.map((s) => ({ s, c: lineCost(it, p, s.id) })).filter((x) => x.c != null).sort((a, b) => a.c - b.c);
    const unpriced = state.shop.stores.filter((s) => lineCost(it, p, s.id) == null);
    const cheapest = priced.length ? priced[0].c : null;
    const priceSub = (s) => {
      if (weighed) { const k = perKgAt(p, s.id); return k != null ? `${money2(k)}/kg` : ''; }
      const swap = swappedAt(it, p, s.id);
      if (swap) { const m = measureText(swap.size || swap.name); return [`${money2(swap.price_cents)} each`, m ? perUnitText(swap.price_cents, m[1], m[0]) : ''].filter(Boolean).join(' · '); }
      const one = itemCost(p, s.id);
      return [`${money2(one)} each`, sizeIn(p) && measure ? perUnitText(one, sizeIn(p), measure) : ''].filter(Boolean).join(' · ');
    };
    const priceRow = ({ s, c }) => html`<li class="ip-price ${c === cheapest ? 'best' : ''}">
        ${storeDot(s.id)}<div class="grow"><b>${s.name}</b><span class="muted small">${priceSub(s)}${priceIsAuto(p, s.id) ? ' · auto' : ''}</span></div>
        ${c === cheapest ? html`<span class="ip-best">Best</span>` : html`<span class="ip-more">+${money2(c - cheapest)}</span>`}
        <b class="num">${money2(c)}</b></li>`;
    const oldest = priced.map(({ s }) => p.checked?.[s.id]).filter(Boolean).sort()[0] || null;
    const forWhat = weighed ? (counting ? `${it.qty}${p.each_g ? ` (about ${gramsText(it.qty * p.each_g)})` : ''}` : gramsText(it.grams))
      : `${it.qty} ${it.qty === 1 ? (p.sold_by === 'volume' ? 'bottle' : 'pack') : (p.sold_by === 'volume' ? 'bottles' : 'packs')}`;
    const auto = autoStores().some((s) => p.matches?.[s.id]?.url);

    openForm({
      title: null,
      cls: 'item-pop',
      noActions: true,
      focus: false,
      body: html`${popHead(p.name, {}, sub ? html`<p class="pop-sub">${sub}</p>` : '')}
        ${p.setup ? html`<div class="setup-banner"><span class="grow">New here. Say whether it's bought by the pack or by weight.</span><button type="button" class="mini primary" data-edit>Set up</button></div>` : ''}
        <section class="ip-card">
          <div class="ip-card-head"><span class="ip-kicker">On this list</span>${toggle}</div>
          ${amount}
          ${sizes.length ? html`<div class="ip-sizes">${sizes.map(sizeLine)}</div>` : ''}
        </section>
        <div class="ip-prices-head"><b>Price for ${forWhat}</b>
          <span class="ip-checked">${oldest ? checkedTag(oldest) : ''}${auto ? html`<button type="button" class="mini" data-refresh>Refresh prices</button>` : ''}</span></div>
        ${priced.length ? html`<ul class="ip-prices">${priced.map(priceRow)}</ul>`
          : html`<p class="muted small">${counting && !p.each_g ? 'Say what one weighs to price them.' : 'No prices yet. Add them in Edit product.'}</p>`}
        ${priced.length && unpriced.length ? html`<p class="muted small ip-none">No price at ${unpriced.map((s) => s.name).join(', ')}.</p>` : ''}
        ${similars.length ? html`<section class="ip-similar">
          ${topSimilar ? html`<div class="ip-sim-head"><b>Cheaper similar</b><span class="muted small">for this shop only</span></div><div class="ip-sizes best">${simLine(topSimilar)}</div>` : ''}
          ${restSimilar.length ? html`<div class="ip-sim-head"><b>${topSimilar ? 'Other close matches' : 'Close matches'}</b>${topSimilar ? '' : html`<span class="muted small">for this shop only</span>`}</div>
            <div class="ip-sizes">${restSimilar.map(simLine)}</div>` : ''}</section>` : ''}
        <div class="field ip-note"><label for="ip-note">Note for this shop</label>
          <input id="ip-note" name="note" maxlength="200" value="${it.note || ''}" placeholder="${weighed ? 'Like a bit green, not too ripe' : 'Like only if it\'s on special'}"></div>
        <div class="dialog-actions ip-actions"><button type="button" class="danger" data-off>Take off list</button><span class="spacer"></span>
          <button type="button" data-edit>${PENCIL_ICON} Edit product</button><button type="button" class="primary" data-done>Done</button></div>`,
      afterRender: (form) => {
        const fail = (err) => { form.querySelector('#form-error').textContent = err.message; };
        const change = async (body) => {
          try {
            await api('PATCH', `/shop/items/${it.id}`, body);
            await loadShop(state.shop.list);
            render();
            shopItemPopup(it.id);
          } catch (err) { fail(err); }
        };
        const saveNote = async () => {
          const note = form.elements.note.value.trim();
          if (note === (it.note || '')) return;
          await api('PATCH', `/shop/items/${it.id}`, { note });
          it.note = note;
          await loadShop(state.shop.list);
        };
        form.elements.note.addEventListener('change', () => saveNote().catch(fail));
        form.onclick = async (ev) => {
          const t = ev.target;
          if (solveClick(form, ev)) return;
          if (t.closest('[data-done]')) { try { await saveNote(); closeForm(); render(); } catch (err) { fail(err); } return; }
          if (t.closest('[data-edit]')) { try { await saveNote(); } catch { /* the note waits */ } productEditor(p, { back: () => shopItemPopup(it.id) }); return; }
          if (t.closest('[data-off]')) {
            try { await api('DELETE', `/shop/items/${it.id}`); closeForm(); await shopReload(); toast('Taken off the list'); } catch (err) { fail(err); }
            return;
          }
          const g = t.closest('[data-grams]');
          if (g) {
            const grams = Number(g.dataset.grams);
            if (grams < 1) { form.querySelector('[data-off]').focus(); fail(new Error('That\'s none. Take it off the list instead.')); return; }
            change({ grams });
            return;
          }
          if (t.closest('[data-other]')) {
            const typed = await askText('How much?', 'In g, or kg like 1.2 kg', it.grams != null ? gramsText(it.grams) : '');
            if (typed == null) { shopItemPopup(it.id); return; }
            const m = /^\s*(\d+(?:\.\d+)?)\s*(kg|g)?\s*$/i.exec(typed);
            const grams = m ? Math.round(Number(m[1]) * ((m[2] || (Number(m[1]) < 20 ? 'kg' : 'g')).toLowerCase() === 'kg' ? 1000 : 1)) : NaN;
            if (!(grams >= 1 && grams <= 100000)) { shopItemPopup(it.id); toast('Type a weight, like 750 g or 1.2 kg'); return; }
            change({ grams });
            return;
          }
          const q = t.closest('[data-qty]');
          if (q) {
            const qty = Number(q.dataset.qty);
            if (qty < 1) { fail(new Error('That\'s none. Take it off the list instead.')); return; }
            change({ qty });
            return;
          }
          const mode = t.closest('[data-mode]');
          if (mode && (mode.dataset.mode === 'count') !== counting) {
            if (mode.dataset.mode === 'count') change({ grams: null, qty: Math.min(99, Math.max(1, p.each_g ? Math.round(it.grams / p.each_g) : 1)) });
            else change({ grams: Math.max(1, Math.min(100000, p.each_g ? it.qty * p.each_g : stepOf(p) * 4)) });
            return;
          }
          if (t.closest('[data-each]')) {
            const g = Number(form.elements.each_g.value.trim());
            if (!Number.isInteger(g) || g < 1 || g > 100000) { fail(new Error('Type what one weighs in g, like 180.')); return; }
            try { await api('PATCH', `/shop/products/${p.id}`, { each_g: g }); await loadShop(state.shop.list); render(); shopItemPopup(it.id); } catch (err) { fail(err); }
            return;
          }
          const sw = t.closest('[data-swap]');
          if (sw) { change(sw.dataset.swap ? { swap_store_id: Number(sw.dataset.swap), swap_kind: sw.dataset.kind || 'size' } : { swap_store_id: null }); return; }
          if (t.closest('[data-refresh]')) refreshProduct(p, form, () => shopItemPopup(it.id));
        };
      },
    });
  }

  // A store's size, like "1.5kg" or "2 L", as [weight or volume, g or mL].
  // A store product's size after its name, unless the name already says it ("365g" and "365 g",
  // or "1kg" and "1000 g", are the same).
  function sizeAfter(name, size) {
    if (!size) return '';
    const squash = (t) => String(t || '').toLowerCase().replace(/\s+/g, '');
    if (squash(name).includes(squash(size))) return '';
    const a = measureText(size);
    const b = measureText(name);
    return a && b && a[0] === b[0] && a[1] === b[1] ? '' : ` ${size}`;
  }
  function measureText(text) {
    const m = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i.exec(String(text || ''));
    if (!m) return null;
    const u = m[2].toLowerCase();
    return [u === 'kg' || u === 'g' ? 'weight' : 'volume', Number(m[1]) * (u === 'kg' || u === 'l' ? 1000 : 1)];
  }

  // Gets one product's prices from the stores again (with its other sizes and close matches), then
  // calls done. The button and a line per store (spinner, then a tick) show it's going; a store
  // that wants a person opens for them to solve.
  async function refreshProduct(p, form, done) {
    const btn = form.querySelector('[data-refresh]');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    const anchor = btn && btn.closest('.ip-prices-head, .auto-bubble');
    let box = form.querySelector('.refresh-progress');
    if (!box && anchor) { box = document.createElement('div'); box.className = 'refresh-progress'; anchor.after(box); }
    const progress = (j) => {
      if (!box) return;
      box.innerHTML = state.shop.stores.filter((s) => j.stores[s.id]).map((s) => autoProgress(j, s).s).join('');
    };
    try {
      const job = await api('POST', '/shop/checker/update', { product_ids: [p.id] });
      if (!job.id) { done(); return; }
      followJob(job, async (j) => {
        progress(j);
        if (jobRunning(j) || !j.changes) return;
        // Long enough to see the ticks.
        await new Promise((r) => setTimeout(r, 900));
        if (!form.isConnected) return;
        const stuck = Object.entries(j.stores).filter(([, st]) => st.state === 'try_later' || st.state === 'error').map(([id]) => storeName(Number(id)));
        await loadShop(state.shop.list);
        render();
        done();
        toast(stuck.length ? `Couldn't check ${stuck.join(' or ')} just now` : j.changes.length ? `${j.changes.length} ${j.changes.length === 1 ? 'price' : 'prices'} changed` : 'Prices checked: no changes');
      }, form);
    } catch (err) {
      form.querySelector('#form-error').textContent = err.message;
      if (box) box.remove();
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Refresh prices'; }
    }
  }

  // Editing a product: how it's sold, its usual amount, its price at each store (per kg when it's
  // bought by weight), keeping its prices up to date, and its aisle at every store location. back
  // goes back to where it was opened from. draft is what was typed before going to the aisles.
  function productEditor(p, { back = null, draft = null } = {}) {
    const d = draft || {};
    const v = (name, fallback) => (d[name] !== undefined ? d[name] : fallback);
    const sold = v('sold_by', p.sold_by || 'pack');
    const weighedNow = isWeighed(p);
    // Prices as typed in: per kg for weighed things, per pack otherwise.
    const priceShown = (s) => (sold === 'weight' ? perKgAt(p, s.id) : weighedNow ? (perKgAt(p, s.id) != null && sizeIn(p) ? Math.round((perKgAt(p, s.id) * sizeIn(p)) / 1000) : null) : itemCost(p, s.id));
    const unitOptions = (mode, picked) => SOLD_UNITS[mode].map((u) => html`<option ${raw(picked === u ? 'selected' : '')}>${u}</option>`);
    const usualUnit = v('unit', p.unit && SOLD_UNITS[sold].includes(p.unit) ? p.unit : sold === 'weight' ? 'kg' : sold === 'volume' ? 'L' : p.unit || '');
    const usualSize = v('size', p.unit && SOLD_UNITS[sold].includes(p.unit) ? (p.size ?? '') : sold === 'weight' ? 1 : '');
    const checker = autoStores();
    // Not sold at a store: saved in place of its price, and cleared by typing one.
    const notSold = (s) => v(`notsold-${s.id}`, p.not_sold?.[s.id] ? '1' : '') === '1';
    const matched = checker.filter((s) => p.matches?.[s.id]?.url);
    const stale = matched.filter((s) => freshness(p.checked?.[s.id]) === 'stale');
    const stores = state.shop.stores;
    const spotsOf = (s) => state.shop.locations.filter((l) => l.store_id === s.id);
    // Aisles: one box when it's in the same place at every location, otherwise a row per location.
    const locs = state.shop.locations;
    const spotKey = (l) => { const sp = shopSpot(p, l); return sp.aisle || sp.section ? sp.label.toLowerCase() : null; };
    const same = locs.length > 1 && spotKey(locs[0]) && locs.every((l) => spotKey(l) === spotKey(locs[0]));
    const oneBox = same && !state.aisleSplit?.has(p.id);
    const spotText = (l) => { const sp = shopSpot(p, l); return sp.key === 'unsorted' ? html`<b class="warn-text">Not set</b>` : sp.key === 'missing' ? html`<b class="muted">Not sold here</b>` : html`<b>${sp.label}</b>`; };
    const aislesHtml = !locs.length ? html`<p class="muted small">Add the store locations you shop at (Manage stores) to set aisles.</p>`
      : oneBox ? html`<h3 class="form-section pe-aisles-head"><span>Aisle</span><span class="muted small">Used to sort your list</span></h3>
          <div class="pe-one"><span class="pe-one-icon" aria-hidden="true">${AISLE_ICON}</span><div class="grow"><b>${shopSpot(p, locs[0]).label}</b>
            <span class="muted small">Same at all ${locs.length} locations</span></div><button type="button" class="linkish" data-aisle-all>Change</button></div>
          <p class="pe-one-stores muted small">${stores.filter((s) => spotsOf(s).length).map((s, i) => html`${i ? ' · ' : ''}${storeDot(s.id)}${s.name} ×${spotsOf(s).length}`)}</p>
          <button type="button" class="linkish small" data-aisle-split>Different at some stores? Set per location ›</button>`
      : html`<h3 class="form-section pe-aisles-head"><span>Aisle by location</span>${locs.length > 1 ? html`<button type="button" class="linkish small" data-aisle-all>Set all the same</button>` : ''}</h3>
          <div class="pe-locs">${stores.filter((s) => spotsOf(s).length).map((s) => html`<h4>${storeDot(s.id)}${s.name}</h4>
            ${spotsOf(s).map((l) => html`<button type="button" class="pe-loc" data-aisle="${l.id}"><span class="grow">${l.name}</span>${spotText(l)}<span class="pe-chev" aria-hidden="true">›</span></button>`)}`)}</div>`;

    openForm({
      title: null,
      cls: 'item-pop',
      body: html`<div class="pop-head"><div class="pop-title pe-title">${back ? html`<button type="button" class="pop-btn pe-back" data-back aria-label="Back">‹</button>` : ''}<h2>Edit product</h2></div>
          <div class="pop-btns"><button type="button" class="pop-btn x" data-modal="cancel" aria-label="Close">✕</button></div></div>
        ${p.setup ? html`<p class="setup-banner"><span class="grow">New product: choose how it's sold, then Save.</span></p>` : ''}
        <div class="field"><label for="pe-name">Name</label><input id="pe-name" name="name" value="${v('name', p.name)}" required></div>
        <div class="field"><span class="label">Sold by</span>
          <div class="seg pe-sold" role="radiogroup" aria-label="Sold by">${Object.entries(SOLD_LABELS).map(([k, label]) => html`<label class="${k === sold ? 'on' : ''}">
            <input type="radio" name="sold_by" value="${k}" ${raw(k === sold ? 'checked' : '')}>${label}</label>`)}</div>
          <p class="muted small" id="pe-sold-hint"></p></div>
        <div class="fields three">
          <div class="field"><label for="pe-size" id="pe-size-label"></label><input id="pe-size" name="size" inputmode="decimal" value="${usualSize}" placeholder="Like 2 or 500"></div>
          <div class="field"><label for="pe-unit">Unit</label><select id="pe-unit" name="unit">${sold === 'pack' ? html`<option value="">None</option>` : ''}${unitOptions(sold, usualUnit)}</select></div>
          <div class="field pe-weight"><label for="pe-step">+/− step</label><select id="pe-step" name="step_g">${STEPS.map((g) => html`<option value="${g}" ${raw(Number(v('step_g', stepOf(p))) === g ? 'selected' : '')}>${gramsText(g)}</option>`)}</select></div>
        </div>
        <div class="field pe-each"><label for="pe-each">About how much one weighs</label>
          <span class="ip-each-in"><input id="pe-each" name="each_g" inputmode="numeric" value="${v('each_g', p.each_g ?? '')}" placeholder="Like 180"><span>g each</span></span>
          <p class="muted small" id="pe-each-hint"></p></div>
        <h3 class="form-section"><span id="pe-price-label">${sold === 'weight' ? 'Price per kg' : 'Price per pack'}</span><span class="muted small">Leave blank if unknown</span></h3>
        <div class="fields three">${stores.map((s) => html`<div class="field price-field"><label for="pe-${s.id}">${storeDot(s.id)}${s.name}</label>
          <input id="pe-${s.id}" name="price-${s.id}" inputmode="decimal" class="${notSold(s) ? 'not-sold' : ''}" placeholder="${notSold(s) ? '⊘ Not sold' : '$'}" value="${v(`price-${s.id}`, moneyInput(priceShown(s)))}">
          <input type="hidden" name="notsold-${s.id}" value="${notSold(s) ? '1' : ''}">
          <div class="price-meta">${p.prices[s.id] != null ? checkedTag(p.checked?.[s.id])
            : notSold(s) ? html`<span class="checked-tag">Not sold${p.not_sold?.[s.id] ? ` · ${shortDay(p.not_sold[s.id])}` : ''}</span><button type="button" class="linkish small" data-sold="${s.id}">Undo</button>`
            : html`<button type="button" class="linkish small" data-not-sold="${s.id}">Not sold here</button>`}
            ${p.was?.[s.id] ? html`<span class="price-special">Special · was ${money(p.was[s.id])}</span>` : ''}
            ${lookupLink(s, p.name, sold === 'weight' ? '' : sizeLabel(p))}</div>
          ${p.matches?.[s.id]?.url ? html`<div class="match-line muted small" title="${p.matches[s.id].name}">Price is for ${p.matches[s.id].name}${sizeAfter(p.matches[s.id].name, p.matches[s.id].size)}</div>` : notSold(s) ? '' : matchLine(p, s)}</div>`)}</div>
        ${checker.length ? (matched.length ? html`<div class="auto-bubble ${stale.length ? 'stale' : 'fresh'}"><div class="grow">
              <b>${stale.length ? `${stale.length} ${stale.length === 1 ? 'price is' : 'prices are'} from before Wednesday` : 'Prices are up to date'}</b>
              <span class="muted small">Kept up to date from ${matched.map((s) => s.name).join(', ')}. <button type="button" class="linkish small" data-auto-find>Change matches</button></span></div>
              <button type="button" class="mini primary" data-refresh>Refresh now</button></div>`
          : html`<div class="auto-bubble"><div class="grow"><b>Prices aren't automatic yet</b>
              <span class="muted small">Search ${checker.map((s) => s.name).join(', ')} for this product and pick the one you buy at each, and its prices are kept up to date.</span></div>
              <button type="button" class="mini primary" data-auto-find>Search and match</button></div>`) : ''}
        ${aislesHtml}`,
      lead: html`<button type="button" class="danger" data-forget>${BIN_ICON} Delete product</button>`,
      afterRender: (form) => {
        const mode = () => form.querySelector('input[name=sold_by]:checked').value;
        const keep = () => ({ ...Object.fromEntries(new FormData(form)), sold_by: mode() });
        const again = (extra = {}) => productEditor(shopProduct(p.id) || p, { back, draft: { ...keep(), ...extra } });
        // Back from Find prices: its prices (and how it's sold, if that was switched to by weight)
        // as just saved, with the rest of what was typed kept.
        const fromFind = () => {
          const draftNow = keep();
          return () => {
            const now = shopProduct(p.id) || p;
            const draft = Object.fromEntries(Object.entries(draftNow).filter(([k]) => !/^(price|notsold)-/.test(k)));
            if (now.sold_by !== p.sold_by || now.price_per !== p.price_per) for (const k of ['sold_by', 'size', 'unit']) delete draft[k];
            productEditor(now, { back, draft });
          };
        };
        const show = () => {
          const m = mode();
          form.querySelectorAll('.pe-sold label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
          form.querySelectorAll('.pe-weight').forEach((el) => { el.hidden = m !== 'weight'; });
          // What one weighs: for counting things bought by weight, and for pricing things bought
          // each (2 onions) at a store that only gives a price per kg, like Aldi.
          const counted = m === 'pack' && !MEASURE_OF[form.elements.unit.value];
          form.querySelector('.pe-each').hidden = !(m === 'weight' || counted);
          form.querySelector('#pe-each-hint').textContent = m === 'weight' ? 'For counting them on the list, like 6 bananas. Filled in from Woolworths when it says.'
            : 'For a store that only gives a price per kg (like Aldi\'s loose onions): its price for one is worked out from this. Press Refresh now after changing it.';
          form.querySelector('#pe-size-label').textContent = m === 'weight' ? 'Usual amount' : m === 'volume' ? 'Bottle size' : 'Pack size';
          form.querySelector('#pe-price-label').textContent = m === 'weight' ? 'Price per kg' : 'Price per pack';
          form.querySelector('#pe-sold-hint').textContent = m === 'weight' ? `Goes on the list as a weight (or a count), with − / + by the step. Prices are per kg.${before ? ' Its size wasn\'t a weight, so type the price per kg.' : ''}`
            : m === 'volume' ? 'Goes on the list as bottles, with − / +. Prices are per bottle, compared per L.' : 'Goes on the list as packs, with − / +. Prices are per pack.';
        };
        // Switching how it's sold: the unit list changes, and typed prices become per kg or per pack.
        // Without a weight to work from (like a 2 L bottle), per kg starts blank, and switching back
        // before changing anything puts the size and prices back as they were.
        let was = mode();
        let before = null;
        const setUnits = (m, picked) => {
          form.elements.unit.innerHTML = html`${m === 'pack' ? html`<option value="">None</option>` : ''}${unitOptions(m, picked)}`.s;
          form.elements.unit.value = picked;
        };
        form.addEventListener('input', (ev) => { if (before && ev.target.name !== 'sold_by') before = null; });
        form.addEventListener('change', (ev) => {
          if (ev.target.name !== 'sold_by') { if (ev.target.name === 'unit') { if (before) before = null; show(); } return; }
          const m = mode();
          const unit = form.elements.unit;
          if (was === 'weight' && m !== 'weight' && before) {
            form.elements.size.value = before.size;
            setUnits(m, SOLD_UNITS[m].includes(before.unit) || (m === 'pack' && before.unit === '') ? before.unit : m === 'volume' ? 'L' : '');
            for (const s of stores) form.elements[`price-${s.id}`].value = before.prices[s.id];
            before = null;
            was = m;
            show();
            return;
          }
          const size = Number(form.elements.size.value) || null;
          const grams = size && BASE[unit.value] && MEASURE_OF[unit.value] === 'weight' ? size * BASE[unit.value] : null;
          if (m === 'weight' && was !== 'weight' && !grams) {
            before = { size: form.elements.size.value, unit: unit.value, prices: Object.fromEntries(stores.map((s) => [s.id, form.elements[`price-${s.id}`].value])) };
          }
          for (const s of stores) {
            const input = form.elements[`price-${s.id}`];
            const c = parseMoney(input.value);
            if (c == null || Number.isNaN(c)) continue;
            if (m === 'weight' && was !== 'weight') input.value = grams ? moneyInput(Math.round((c * 1000) / grams)) : '';
            if (m !== 'weight' && was === 'weight') input.value = grams ? moneyInput(Math.round((c * grams) / 1000)) : '';
          }
          const keepUnit = SOLD_UNITS[m].includes(unit.value) ? unit.value : m === 'weight' ? 'kg' : m === 'volume' ? 'L' : unit.value;
          setUnits(m, keepUnit);
          if (m === 'weight' && !grams) { form.elements.size.value = '1'; unit.value = 'kg'; }
          was = m;
          show();
        });
        show();
        // Prices typed in (rather than shown, or worked out by switching) count as checked today.
        for (const s of stores) {
          const input = form.elements[`price-${s.id}`];
          if (input.value !== moneyInput(priceShown(s))) input.dataset.edited = '1';
          input.addEventListener('input', () => {
            input.dataset.edited = '1';
            if (input.value.trim() && input.classList.contains('not-sold')) {
              input.classList.remove('not-sold');
              input.placeholder = '$';
              form.elements[`notsold-${s.id}`].value = '';
            }
          });
        }
        form.onclick = async (ev) => {
          const t = ev.target;
          if (solveClick(form, ev)) return;
          if (t.closest('[data-back]')) { back(); return; }
          const a = t.closest('[data-aisle]');
          if (a) { const loc = state.shop.locations.find((l) => l.id === Number(a.dataset.aisle)); const draftNow = keep(); spotPicker(p, loc, () => productEditor(shopProduct(p.id), { back, draft: draftNow })); return; }
          if (t.closest('[data-aisle-all]')) {
            const draftNow = keep();
            spotAllPicker(p, () => { state.aisleSplit?.delete(p.id); productEditor(shopProduct(p.id), { back, draft: draftNow }); });
            return;
          }
          if (t.closest('[data-aisle-split]')) { (state.aisleSplit ||= new Set()).add(p.id); again(); return; }
          const ns = t.closest('[data-not-sold], [data-sold]');
          if (ns) {
            const sid = ns.dataset.notSold || ns.dataset.sold;
            again(ns.dataset.notSold ? { [`notsold-${sid}`]: '1', [`price-${sid}`]: '' } : { [`notsold-${sid}`]: '' });
            return;
          }
          if (t.closest('[data-auto-find]')) { findPrices(p, fromFind()); return; }
          const f = t.closest('[data-find-store]');
          if (f) { findPrices(p, fromFind(), { only: Number(f.dataset.findStore) }); return; }
          if (t.closest('[data-refresh]')) { refreshProduct(p, form, () => again(Object.fromEntries(stores.map((s) => [`price-${s.id}`, undefined])))); return; }
          if (t.closest('[data-forget]')) {
            const ok = await askChoice({ title: 'Delete this product?', text: html`<p><b>${productLabel(p)}</b></p><p>It comes off every list, and its prices and aisles are forgotten.</p>`,
              choices: [{ label: 'Keep it', value: 'no' }, { label: 'Delete', value: 'yes', danger: true }] });
            if (ok !== 'yes') return;
            try {
              await api('DELETE', `/shop/products/${p.id}`);
              closeForm();
              await shopReload();
              toast(`${p.name} deleted`);
            } catch (err) { form.querySelector('#form-error').textContent = err.message; }
          }
        };
      },
      onSave: async (form) => {
        const m = form.querySelector('input[name=sold_by]:checked').value;
        const size = val(form, 'size');
        if (size && Number.isNaN(Number(size))) throw new Error('The size should be a number, like 2 or 500.');
        if (m === 'weight' && !(Number(size) > 0)) throw new Error('Give the usual amount, like 1 kg or 500 g.');
        const each = val(form, 'each_g');
        const counted = m === 'pack' && !MEASURE_OF[val(form, 'unit')];
        if ((m === 'weight' || counted) && each && !(Number.isInteger(Number(each)) && Number(each) > 0)) throw new Error('What one weighs should be a whole number of g, like 180.');
        // Prices left alone stay as they were checked, even when they're now said per kg or per pack.
        const prices = {};
        const converted = [];
        const sameWay = m === 'weight' ? p.price_per === 'kg' : p.price_per === 'each';
        const notSoldNow = [];
        for (const s of stores) {
          const edited = form.elements[`price-${s.id}`].dataset.edited === '1';
          const ns = form.elements[`notsold-${s.id}`].value === '1' && !val(form, `price-${s.id}`);
          if (ns) { if (!p.not_sold?.[s.id]) notSoldNow.push(s.id); continue; }
          if (p.not_sold?.[s.id] && !val(form, `price-${s.id}`)) { prices[s.id] = null; continue; }
          if (!edited && sameWay) continue;
          prices[s.id] = moneyVal(form, `price-${s.id}`, `The ${s.name} price`);
          if (!edited) converted.push(s.id);
        }
        await api('PATCH', `/shop/products/${p.id}`, {
          name: val(form, 'name'), size: size === '' ? null : Number(size), unit: val(form, 'unit') || null,
          sold_by: m, price_per: m === 'weight' ? 'kg' : 'each', prices, converted, not_sold: notSoldNow,
          ...(m === 'weight' ? { step_g: Number(val(form, 'step_g')) || null } : {}),
          ...(m === 'weight' || counted ? { each_g: each ? Number(each) : null } : {}),
        });
        await loadShop(state.shop.list);
        if (back) setTimeout(back); // once this popup has closed
      },
    });
  }

  // A product's price per 100 g or mL, or per kg or L, like the shelf labels: "$2.20/100g".
  function unitPrice(p, cents) {
    if (cents == null || !p.size || !BASE[p.unit]) return '';
    const big = p.unit === 'kg' || p.unit === 'L';
    const per = big ? 1000 : 100;
    return `${money(Math.round((cents * per) / (p.size * BASE[p.unit])))}/${big ? p.unit : `100${p.unit}`}`;
  }
  // Whether a store's price is kept up to date automatically (matched on its website) or typed in.
  const priceIsAuto = (p, sid) => Boolean(state.shop.checker && p.matches?.[sid]?.url && !p.matches[sid].missing_at);
  const PENCIL_ICON = raw('<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/></svg>');

  // Products being deleted, for a few seconds while Undo is offered: id -> timer.
  const forgetting = new Map();

  // Everything bought before, under its aisle here, with its price here and the best price
  // anywhere. + puts it on the list (or adds one more); tapping a name opens it. Edit switches to
  // renaming and deleting.
  function productList() {
    const loc = shopLocation();
    const store = loc ? loc.store_id : null;
    const editing = () => Boolean(state.productEdit);
    const money2 = (c) => moneyFmt.format((c || 0) / 100);
    const body = () => {
      const q = (state.productQuery || '').trim().toLowerCase();
      const onList = new Map(state.shop.items.filter((it) => !it.done_at).map((it) => [it.product_id, it]));
      const list = state.shop.products.filter((p) => !forgetting.has(p.id) && (!q || productLabel(p).toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!list.length) return html`<p class="empty">${state.shop.products.length ? 'Nothing matches.' : 'Things you add to a list show here.'}</p>`;
      const groups = loc ? groupBy(list, loc, (p) => p) : [{ key: 'all', label: 'All products', rows: list }];
      const row = (p) => {
        const it = onList.get(p.id);
        const here = itemCost(p, store);
        const best = bestPrice(p, store);
        const bestHereToo = best && (best.store === store || (here != null && best.cents === here));
        if (editing()) {
          const meta = [sizeLabel(p), here != null ? `${storeName(store)} ${money2(here)}` : '', best ? `best ${money2(best.cents)}` : ''].filter(Boolean).join(' · ');
          return html`<li class="sp-row edit"><button type="button" class="sp-main" data-open="${p.id}"><span class="sp-name">${p.name}</span>
              ${meta ? html`<span class="sp-meta">${meta}</span>` : ''}</button>
            <button type="button" class="icon ghost" data-open="${p.id}" aria-label="Edit ${p.name}" title="Edit">${PENCIL_ICON}</button>
            <button type="button" class="icon sp-del" data-del="${p.id}" aria-label="Delete ${p.name}" title="Delete">${BIN_ICON}</button></li>`;
        }
        const meta = [sizeLabel(p), unitPrice(p, here ?? (best && best.cents))].filter(Boolean).join(' · ');
        const pic = productPicture(p, store);
        return html`<li class="sp-row ${it ? 'on' : ''}">
          <button type="button" class="sp-main ${pic ? 'with-pic' : ''}" data-open="${p.id}">${pic ? html`<img class="pic sp-pic" src="${pic}" alt="" loading="lazy">` : ''}<span class="sp-txt"><span class="sp-name">${p.name}</span>${meta ? html`<span class="sp-meta">${meta}</span>` : ''}</span></button>
          ${store ? html`<span class="sp-here num">${here != null ? money2(here) : '—'}${here != null ? html`<small class="${priceIsAuto(p, store) ? 'sp-auto' : ''}">${priceIsAuto(p, store) ? 'auto' : 'manual'}</small>` : ''}</span>` : ''}
          <span class="sp-best num ${best ? (bestHereToo ? 'here' : 'away') : ''}">${best ? money2(best.cents) : '—'}${best ? html`<small>${bestHereToo ? 'here' : storeName(best.store)}${!bestHereToo && priceIsAuto(p, best.store) ? ' · auto' : ''}</small>` : ''}</span>
          <button type="button" class="sp-qty ${it ? 'on' : ''}" data-add="${p.id}" aria-label="${it ? `One more ${p.name}, ${it.qty} on the list` : `Add ${p.name} to the list`}">${it ? `×${it.qty}` : '+'}</button></li>`;
      };
      return html`${editing() ? '' : html`<div class="sp-cols ${store ? '' : 'no-here'}" aria-hidden="true"><span>Product</span>${store ? html`<span>${storeName(store)}</span>` : ''}<span>Best</span><span>Qty</span></div>`}
        ${groups.map((g) => html`<h3 class="form-section">${g.label}</h3><ul class="sp-list ${store ? '' : 'no-here'}">${g.rows.map(row)}</ul>`)}`;
    };
    // The list's total here, and if everything on it were bought where it's cheapest.
    const foot = () => {
      if (editing() || !store) return '';
      let here = 0;
      let best = 0;
      for (const it of state.shop.items) {
        const p = it.done_at ? null : shopProduct(it.product_id);
        const c = p ? itemCost(p, store) : null;
        if (c == null) continue;
        here += c * it.qty;
        best += bestPrice(p, store).cents * it.qty;
      }
      return here ? html`<div class="sp-foot"><b>List total ${money2(here)} at ${storeName(store)}</b>
        ${best < here ? html`<span class="sp-save">${money2(best)} if bought at the best prices</span>` : ''}</div>` : '';
    };
    const anyAuto = autoStores().length && state.shop.products.some((p) => Object.values(p.matches || {}).some((m) => m.url));
    openForm({
      title: editing() ? 'Edit saved products' : 'Saved products',
      cls: 'saved-pop',
      body: html`<div class="prod-tools sp-tools">
          <label for="prod-q" class="sr-only">Search saved products</label>
          <input id="prod-q" type="search" placeholder="Search" value="${state.productQuery || ''}" autocomplete="off">
          ${editing() ? html`<button type="button" class="mini primary" id="prod-edit">Done</button>`
            : html`<button type="button" class="mini" id="prod-edit">Edit</button>
              ${state.shop.products.length ? html`<button type="button" class="mini" data-action="shop-check">Check prices</button>` : ''}
              ${anyAuto ? html`<button type="button" class="mini" data-refresh-all>Refresh prices</button>` : ''}`}
        </div>
        ${editing() ? html`<p class="muted small">Tap a product to change its name, size, prices or aisle. Deleting it also takes it off your lists.</p>` : ''}
        <div id="prod-body">${body()}</div>
        <div class="undo-bar" hidden><span></span><button type="button" class="mini" data-undo>Undo</button></div>`,
      // The list total sits beside Close, so the bottom bar has no empty space.
      lead: html`<div id="prod-foot">${foot()}</div>`,
      afterRender: (form) => {
        const redraw = () => {
          form.querySelector('#prod-body').innerHTML = body().s;
          form.querySelector('#prod-foot').innerHTML = html`${foot()}`.s;
        };
        let undo = null;
        const undoBar = form.querySelector('.undo-bar');
        form.querySelector('#prod-q').oninput = (ev) => { state.productQuery = ev.target.value; redraw(); };
        form.onclick = async (ev) => {
          if (ev.target.closest('#prod-edit')) { state.productEdit = !state.productEdit; productList(); return; }
          if (ev.target.closest('[data-refresh-all]')) { updatePrices({ all: true }); return; }
          if (ev.target.closest('[data-undo]') && undo) { undo(); return; }
          const open = ev.target.closest('[data-open]');
          if (open) { productEditor(shopProduct(Number(open.dataset.open)), { back: productList }); return; }
          const del = ev.target.closest('[data-del]');
          if (del) {
            const p = shopProduct(Number(del.dataset.del));
            if (!p) return;
            // Gone from here now; deleted for real once Undo has had its chance.
            forgetting.set(p.id, setTimeout(async () => {
              forgetting.delete(p.id);
              try { await api('DELETE', `/shop/products/${p.id}`); } catch (err) { toast(err.message); }
              await loadShop(state.shop.list);
              render();
              if (form.isConnected && $modal.open) redraw();
            }, 5000));
            undo = () => { clearTimeout(forgetting.get(p.id)); forgetting.delete(p.id); undo = null; undoBar.hidden = true; redraw(); };
            undoBar.querySelector('span').textContent = `${p.name} deleted`;
            undoBar.hidden = false;
            redraw();
            return;
          }
          const add = ev.target.closest('[data-add]');
          if (!add) return;
          try {
            await api('POST', '/shop/items', { list: state.shop.list, product_id: Number(add.dataset.add) });
            await loadShop(state.shop.list);
            redraw();
            render();
          } catch (err) { form.querySelector('#form-error').textContent = err.message; }
        };
      },
    });
  }

  // Copies what's left on the list as plain text, under a heading for each aisle, to paste
  // somewhere that works away from home (the app is only on the home network for now).
  const COPY_ICON = raw('<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>');
  function copyList() {
    const loc = shopLocation();
    const items = state.shop.items.filter((it) => !it.done_at && shopProduct(it.product_id));
    if (!items.length) { toast('Nothing on the list to copy'); return; }
    const line = (it) => {
      const p = shopProduct(it.product_id);
      const amount = isWeighed(p) && it.grams != null ? gramsText(it.grams) : `${sizeLabel(p) ? `${sizeLabel(p)} ` : ''}${it.qty > 1 ? `×${it.qty}` : ''}`;
      return `${p.name} ${amount}`.trim();
    };
    const byName = (x, y) => shopProduct(x.product_id).name.localeCompare(shopProduct(y.product_id).name);
    const groups = loc ? groupBy(items, loc, (it) => shopProduct(it.product_id)) : [{ rows: items }];
    copyText(groups.map((g) => [...(g.label ? [g.label.toUpperCase()] : []), ...[...g.rows].sort(byName).map(line)].join('\n')).join('\n\n'), 'List');
  }


  // What's on the list with a cheaper similar product somewhere (a hint, not counted in totals).
  function similarList() {
    const loc = shopLocation();
    const store = loc ? loc.store_id : null;
    const list = state.shop.items.filter((it) => !it.done_at).map((it) => ({ it, p: shopProduct(it.product_id) })).filter(({ p }) => p && p.similar);
    openForm({
      title: 'Cheaper similar',
      body: html`<p class="muted small">Similar products that cost less for the amount, found by Automatic price search. Open one to swap to it for this shop. Until then, best buys and totals don't count them.</p>
        <ul class="list upd-list">${list.map(({ it, p }) => {
          const here = itemCost(p, store) ?? bestPrice(p, store)?.cents;
          return html`<li><div class="grow"><div class="title">${productLabel(p)}${here != null ? html` <span class="muted small">${money(here)}</span>` : ''}</div>
            <div class="small">${storeDot(p.similar.store_id)}${storeProduct(p.similar.store_id, p.similar.name)}${sizeAfter(p.similar.name, p.similar.size)} <b>${money(p.similar.price_cents)}</b>
              <a class="lookup" href="${p.similar.url}" target="_blank" rel="noopener noreferrer">View ↗</a></div></div>
            <button type="button" class="mini" data-open="${it.id}">Open</button></li>`;
        })}</ul>${list.length ? '' : html`<p class="empty">Nothing on the list has a cheaper similar product.</p>`}`,
      afterRender: (form) => {
        form.onclick = (ev) => {
          const o = ev.target.closest('[data-open]');
          if (o) shopItemPopup(Number(o.dataset.open));
        };
      },
    });
  }

  // Checking prices: what's on the list, with its price at each store (automatic ones dashed, with
  // a pencil to type over them; typed ones solid; striped where it's not sold) and when each was
  // checked (green since the stores' Wednesday price change, orange before). Each row can refresh
  // its automatic prices or search the stores for it. Saved products checks everything else.
  const REFRESH_ICON = raw('<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>');
  const LENS_ICON = raw('<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>');
  function priceCheck() {
    const stores = state.shop.stores;
    if (!stores.length) return;
    const money2 = (c) => moneyFmt.format((c || 0) / 100);
    const auto = autoStores();
    const onList = new Map();
    for (const it of state.shop.items) if (!it.done_at) onList.set(it.product_id, it);
    const items = () => state.shop.products.filter((p) => onList.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
    const typing = new Set(); // "product:store" boxes opened for typing over an automatic price or Not sold
    const typed = new Map(); // what's been typed, kept while the rows are drawn again
    const busy = new Set(); // products being refreshed
    const key = (p, s) => `${p.id}:${s.id}`;
    const isAuto = (p, s) => priceIsAuto(p, s.id) && !typing.has(key(p, s));
    const fresh = (p, s) => freshness(p.checked?.[s.id]) === 'fresh';
    const stale = (p) => stores.some((s) => p.prices[s.id] != null && !fresh(p, s));
    // Typed prices at a store with automatic prices: worth matching so they're kept up to date.
    const typedAt = (p) => auto.some((s) => p.prices[s.id] != null && !priceIsAuto(p, s.id));
    const hasAuto = (p) => auto.some((s) => priceIsAuto(p, s.id));
    const shown = () => {
      const q = (state.checkQuery || '').trim().toLowerCase();
      return items().filter((p) => (!state.checkDue || stale(p)) && (!q || productLabel(p).toLowerCase().includes(q)));
    };
    const cheapest = (p) => {
      const set = stores.map((s) => p.prices[s.id]).filter((c) => c != null);
      return set.length > 1 ? Math.min(...set) : null;
    };
    const onListText = (p) => { const it = onList.get(p.id); return isWeighed(p) && it.grams != null ? gramsText(it.grams) : `×${it.qty}`; };

    const cell = (p, s) => {
      const k = key(p, s);
      const c = p.prices[s.id];
      const cheap = c != null && c === cheapest(p) ? ' cheap' : '';
      const label = html`<span class="ck-store">${storeDot(s.id)}${s.name}</span>`;
      const when = c != null ? html`<span class="ck-when ${fresh(p, s) ? 'fresh' : 'stale'}"><i aria-hidden="true"></i>${shortDay(p.checked?.[s.id]) || 'Not checked'}</span>`
        : html`<span class="ck-when">not set</span>`;
      if (p.not_sold?.[s.id] && c == null && !typing.has(k)) {
        return html`<div class="ck-cell">${label}<button type="button" class="ck-box ck-none" data-ck-type="${k}" title="Not sold at ${s.name}. Tap to type a price">⊘ Not sold</button>
          <span class="ck-when">Searched ${shortDay(p.not_sold[s.id])}</span></div>`;
      }
      if (isAuto(p, s)) {
        return html`<div class="ck-cell">${label}<button type="button" class="ck-box ck-auto${cheap}" data-ck-type="${k}" title="Kept up to date from ${s.name}. Tap to type over it"
          aria-label="${p.name} at ${s.name}, ${money2(c)} automatic. Type over it"><span class="num">${money2(c)}</span>${PENCIL_ICON}</button>${when}</div>`;
      }
      const value = typed.has(k) ? typed.get(k) : c != null ? money2(c) : '';
      return html`<div class="ck-cell">${label}<input class="ck-box ck-typed${cheap}" name="ck-${k}" inputmode="decimal" placeholder="$" value="${value}"
        aria-label="${productLabel(p)} at ${s.name}${PER[p.price_per] ? ` ${pricePerText(p)}` : ''}">${when}</div>`;
    };
    const rows = () => shown().map((p) => html`<li class="ck-row${busy.has(p.id) ? ' busy' : ''}">
        <div class="ck-name"><b>${p.name}</b><span class="ck-meta">${sizeLabel(p) || 'pack'} · <span class="check-on">on list ${onListText(p)}</span></span></div>
        ${stores.map((s) => cell(p, s))}
        ${auto.length ? html`<div class="ck-btns"><button type="button" class="ck-btn" data-ck-refresh="${p.id}" ${raw(hasAuto(p) && !busy.size ? '' : 'disabled')} title="Refresh automatic prices" aria-label="Refresh ${p.name}'s automatic prices">${REFRESH_ICON}</button>
          <button type="button" class="ck-btn${typedAt(p) ? ' hint' : ''}" data-ck-find="${p.id}" title="${typedAt(p) ? 'Has typed prices: find it at the stores to keep them up to date' : 'Find store matches'}" aria-label="Find ${p.name} at the stores">${LENS_ICON}</button></div>` : ''}</li>`);
    const summary = () => {
      let set = 0;
      let ok = 0;
      for (const p of items()) for (const s of stores) if (p.prices[s.id] != null) { set += 1; if (fresh(p, s)) ok += 1; }
      return html`<div class="ck-sum"><b>${ok} of ${set} ${set === 1 ? 'price' : 'prices'} checked since Wed 9am</b>
        ${set - ok ? html`<span class="warn-text">${set - ok} out of date</span>` : set ? html`<span class="good-text">All up to date</span>` : ''}</div>`;
    };
    const tools = () => {
      const n = shown().length;
      const due = items().filter(stale).length;
      return html`<label for="ck-q" class="sr-only">Search</label>
        <input id="ck-q" type="search" placeholder="Search" value="${state.checkQuery || ''}" autocomplete="off">
        <button type="button" class="best-toggle ck-due" role="switch" aria-checked="${state.checkDue ? 'true' : 'false'}" data-check-due><span class="switch" aria-hidden="true"></span>Out of date only<span class="muted">· ${due}</span></button>
        ${auto.length ? html`<button type="button" class="ck-all" data-ck-refresh-all ${raw(n && shown().some(hasAuto) && !busy.size ? '' : 'disabled')}>${REFRESH_ICON} Refresh ${n === 1 ? 'this one' : html`<span class="ck-these">these </span>${n}`}</button>` : ''}`;
    };
    const legend = html`<details class="ck-legend" ${raw(window.matchMedia('(min-width: 721px)').matches ? 'open' : '')}><summary>What the boxes mean</summary><div class="ck-key">
      <div><h4>Prices</h4>
        <p><span class="ck-swatch ck-auto"></span>Auto: updates itself</p>
        <p><span class="ck-swatch ck-typed"></span>Typed by you</p>
        <p><span class="ck-swatch ck-typed">$</span>Not set yet</p>
        <p><span class="ck-swatch ck-none"></span>Not sold there</p>
        <p><span class="ck-swatch plain cheap">$</span>Cheapest</p></div>
      <div><h4>Last checked</h4>
        <p><span class="ck-when fresh"><i aria-hidden="true"></i></span>Since Wed 9am</p>
        <p><span class="ck-when stale"><i aria-hidden="true"></i></span>Out of date</p></div>
      ${auto.length ? html`<div><h4>Buttons</h4>
        <p><span class="ck-swatch plain">${REFRESH_ICON}</span>Refresh auto prices</p>
        <p><span class="ck-swatch plain">${LENS_ICON}</span>Find store matches</p>
        <p><span class="ck-swatch plain hint">${LENS_ICON}</span>Has typed prices: match to keep them up to date</p></div>` : ''}</div></details>`;
    const cols = `minmax(110px, 1.2fr) repeat(${stores.length}, minmax(72px, 1fr))${auto.length ? ' 78px' : ''}`;
    const count = items().length;
    openForm({
      title: null,
      cls: 'wide-pop check-pop',
      body: html`${popHead('Check prices', {}, html`<p class="pop-sub">The ${count} ${count === 1 ? 'item' : 'items'} on your list. Specials change Wednesday 9am.</p>`)}
        <div class="ck-tools" id="ck-tools">${tools()}</div>
        <div class="ck-progress" id="ck-progress" hidden></div>
        ${legend}
        <div class="ck-head" style="grid-template-columns:${cols}" aria-hidden="true"><span>Product</span>${stores.map((s) => html`<span>${storeDot(s.id)}${s.name}</span>`)}${auto.length ? html`<span></span>` : ''}</div>
        <ul class="ck-list" style="--ck-cols:${cols}">${rows()}</ul>
        <p class="empty" id="ck-none" ${raw(shown().length ? 'hidden' : '')}>${count ? 'Nothing matches.' : 'Nothing on your list yet.'}</p>
        <button type="button" class="ck-more" data-ck-saved>Check all ${state.shop.products.length} saved products ›</button>`,
      lead: html`<div id="ck-sum">${summary()}</div>`,
      afterRender: (form) => {
        const list = form.querySelector('.ck-list');
        const redraw = (focus) => {
          list.innerHTML = rows().map((r) => r.s).join('');
          form.querySelector('#ck-none').hidden = list.children.length > 0;
          form.querySelector('#ck-sum').innerHTML = summary().s;
          const q = form.querySelector('#ck-q');
          const at = document.activeElement === q ? q.selectionStart : null;
          form.querySelector('#ck-tools').innerHTML = tools().s;
          if (at != null) { const nq = form.querySelector('#ck-q'); nq.focus(); nq.setSelectionRange(at, at); }
          if (focus) form.elements[`ck-${focus}`]?.focus();
        };
        form.oninput = (ev) => {
          if (ev.target.id === 'ck-q') { state.checkQuery = ev.target.value; redraw(); return; }
          if (ev.target.name?.startsWith('ck-')) typed.set(ev.target.name.slice(3), ev.target.value);
        };
        // Refreshes products' automatic prices, saving what's typed first.
        const refresh = async (ids) => {
          try { await saveTyped(); } catch (err) { form.querySelector('#form-error').textContent = err.message; return; }
          form.querySelector('#form-error').textContent = '';
          try {
            const job = await api('POST', '/shop/checker/update', { product_ids: ids });
            if (!job.id) { toast('Nothing automatic to refresh'); return; }
            ids.forEach((id) => busy.add(id));
            redraw();
            const box = form.querySelector('#ck-progress');
            box.hidden = false;
            followJob(job, (j) => {
              box.innerHTML = stores.filter((s) => j.stores[s.id]).map((s) => autoProgress(j, s).s).join('');
              if (jobRunning(j)) return;
              busy.clear();
              loadShop(state.shop.list).then(() => { render(); box.hidden = true; redraw(); toast(j.changes?.length ? `${j.changes.length} ${j.changes.length === 1 ? 'price' : 'prices'} changed` : 'Prices checked'); });
            }, form);
          } catch (err) { form.querySelector('#form-error').textContent = err.message; }
        };
        form.onclick = async (ev) => {
          if (solveClick(form, ev)) return;
          const t = ev.target;
          if (t.closest('[data-check-due]')) { state.checkDue = !state.checkDue; redraw(); return; }
          const box = t.closest('[data-ck-type]');
          if (box) { typing.add(box.dataset.ckType); redraw(box.dataset.ckType); return; }
          const r = t.closest('[data-ck-refresh]');
          if (r) { refresh([Number(r.dataset.ckRefresh)]); return; }
          if (t.closest('[data-ck-refresh-all]')) { refresh(shown().filter(hasAuto).map((p) => p.id)); return; }
          const f = t.closest('[data-ck-find]');
          const saved = t.closest('[data-ck-saved]');
          if (f || saved) {
            try { await saveTyped(); } catch (err) { form.querySelector('#form-error').textContent = err.message; return; }
            if (saved) { productList(); return; }
            const p = shopProduct(Number(f.dataset.ckFind));
            if (p) findPrices(p, priceCheck);
          }
        };
      },
      onSave: async () => {
        const saved = await saveTyped();
        if (saved) toast(`Saved ${saved} ${saved === 1 ? 'price' : 'prices'}`);
      },
    });
    // Saves the prices typed so far, so nothing's lost going elsewhere. Typing over an automatic
    // price makes it a typed one. Returns how many changed.
    async function saveTyped() {
      let saved = 0;
      for (const p of items()) {
        const prices = {};
        const unmatch = [];
        for (const s of stores) {
          const k = key(p, s);
          if (!typed.has(k)) continue;
          const c = parseMoney(typed.get(k).trim());
          if (Number.isNaN(c) || (c != null && c < 0)) throw new Error(`The ${s.name} price of ${p.name} must be a dollar amount, like 4.50`);
          if (c === (p.prices[s.id] ?? null)) continue;
          prices[s.id] = c;
          if (priceIsAuto(p, s.id)) unmatch.push(s.id);
        }
        if (!Object.keys(prices).length) continue;
        await api('PATCH', `/shop/products/${p.id}`, { prices, checked: [], unmatch });
        saved += Object.keys(prices).length;
      }
      typed.clear();
      typing.clear();
      if (saved) { await loadShop(state.shop.list); render(); }
      return saved;
    }
  }

  // ---------- Automatic prices (the price-checker) ----------
  //
  // With a price-checker set up (see the README), a product can be searched for at the stores it
  // knows, and the one bought at each picked: its price is then kept up to date from the store's
  // website. The list shows a banner when its matched prices were checked before the stores'
  // Wednesday price changes.

  const autoStores = () => (state.shop.checker ? state.shop.stores.filter((s) => s.checker && state.shop.checker.stores.includes(s.checker)) : []);
  const dateText = (at) => (at ? new Date(`${at.replace(' ', 'T')}Z`).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
  // Products on the list with a matched price checked before this week's price day.
  function outOfDate() {
    const since = state.shop.checker?.since;
    const stores = autoStores();
    const products = new Set();
    let prices = 0;
    let last = null;
    if (!since || !stores.length) return { count: 0, prices, last };
    for (const it of state.shop.items) {
      const p = !it.done_at && shopProduct(it.product_id);
      if (!p) continue;
      for (const s of stores) {
        const at = p.matches?.[s.id]?.url ? p.checked?.[s.id] : since;
        if (at && at >= since) continue;
        products.add(p.id);
        prices += 1;
        if (at && (!last || at > last)) last = at;
      }
    }
    return { count: products.size, prices, last };
  }
  function autoBanner() {
    const { count, prices, last } = outOfDate();
    if (!count) return '';
    return html`<div class="card auto-banner" role="status"><div class="grow"><b>${prices} ${prices === 1 ? 'price' : 'prices'} out of date</b>
      <span class="muted small">${last ? `Last checked ${dateText(last)}. ` : ''}Stores change their prices on Wednesday mornings.</span></div>
      <button type="button" class="mini primary" data-action="shop-update">Update ${count} ${count === 1 ? 'product' : 'products'}</button></div>`;
  }

  // How a store is going in a check, as a line: a tick, a count, "waiting for you" with Solve, or try later.
  function autoProgress(job, s) {
    const st = job.stores[s.id];
    if (!st) return '';
    const count = st.total > 1 ? ` ${st.done} of ${st.total}` : '';
    const line = {
      waiting: html`<span class="muted">Waiting${job.waiting_for ? ' for another check to finish' : ''}…</span>`,
      working: html`<span class="auto-spin" aria-hidden="true"></span><span>Checking${count}…</span>`,
      done: html`<span class="good">✓${count}</span>`,
      needs_person: html`<span class="warn">Waiting for you</span><button type="button" class="mini primary" data-solve="${s.id}">Solve</button>`,
      try_later: html`<span class="warn">Try again later${st.until ? ` (after ${new Date(st.until).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })})` : ''}</span>`,
      error: html`<span class="warn">Didn't work${st.message ? `: ${st.message}` : ''}</span>`,
      cancelled: html`<span class="muted">Stopped</span>`,
    }[st.state] || '';
    const hint = s.checker === 'coles' && st.state === 'try_later' ? html`<button type="button" class="linkish small" data-action="shop-helper">Use the Coles button</button>` : '';
    return html`<div class="auto-store">${storeDot(s.id)}<b>${s.name}</b>${line}${hint}</div>`;
  }
  const jobRunning = (job) => job && (job.state === 'queued' || job.state === 'running');

  // Follows a check: asks how it's going every second, calling draw each time, until it's finished
  // or the popup it belongs to has gone. A store waiting for a person opens its page for them
  // (and Solve opens it again, through form.solve).
  function followJob(job, draw, form) {
    let current = job;
    let solving = null;
    const asked = new Set();
    const solve = (id) => {
      if (solving !== null || $prompt.open) return;
      solving = id;
      solvePopup(current, id, () => current).finally(() => { solving = null; });
    };
    form.solve = solve;
    const tick = async () => {
      if (!form.isConnected || !$modal.open || form.dataset.job !== String(current.id)) return;
      try { current = await api('GET', `/shop/checker/jobs/${current.id}`); } catch (err) {
        form.querySelector('#form-error').textContent = err.message;
        return;
      }
      if (form.dataset.job !== String(current.id)) return;
      draw(current);
      const waiting = Object.entries(current.stores).find(([, st]) => st.state === 'needs_person');
      // Opened once by itself; hidden, it waits for Solve.
      if (waiting && !asked.has(waiting[0])) { asked.add(waiting[0]); solve(Number(waiting[0])); }
      if (jobRunning(current)) setTimeout(tick, 1000);
    };
    form.dataset.job = String(job.id);
    draw(job);
    setTimeout(tick, 600);
  }
  const solveClick = (form, ev) => {
    const b = ev.target.closest('[data-solve]');
    if (b && form.solve) form.solve(Number(b.dataset.solve));
    return Boolean(b);
  };

  // A store's page as the price-checker sees it, for a person to get past its bot check. Clicks,
  // drags and typing go to that page. It closes by itself once the check is gone. Nothing here
  // solves anything: that's the person's job.
  function solvePopup(job, storeId, latest) {
    return new Promise((resolve) => {
      const s = state.shop.stores.find((x) => x.id === storeId);
      const src = () => `/api/shop/checker/screen/${storeId}?t=${Date.now()}`;
      $promptForm.innerHTML = html`
        ${promptHead(`${s ? s.name : 'The store'} wants to check you're a person`)}
        <p class="muted small">This is the store's page in the price-checker. Solve the puzzle on it as you normally would: click, drag or type below. It carries on by itself once it's done.</p>
        <div class="solve-screen"><img id="solve-img" alt="The store's page" draggable="false" src="${src()}"></div>
        <div class="solve-type"><label for="solve-text" class="sr-only">Type into the page</label>
          <input id="solve-text" placeholder="Type into the page" autocomplete="off"><button type="button" class="mini" data-solve-send>Send</button></div>
        <p class="error" id="solve-error"></p>
        <div class="dialog-actions"><button type="button" class="danger" data-p="skip">Give up (try later)</button><button type="button" data-p="">Hide</button></div>`.s;
      const img = $promptForm.querySelector('#solve-img');
      let open = true;
      const done = async (how) => {
        if (!open) return;
        open = false;
        $promptForm.onclick = null;
        if ($prompt.open) $prompt.close();
        if (how === 'skip') { try { await api('POST', `/shop/checker/jobs/${job.id}/skip`, { store_id: storeId }); } catch { /* finished anyway */ } }
        resolve(how);
      };
      // A fresh picture after each one loads, while the store still waits.
      img.onload = () => setTimeout(() => {
        if (!open) return;
        const st = latest().stores[storeId];
        if (!st || st.state !== 'needs_person') { done('solved'); return; }
        img.src = src();
      }, 700);
      img.onerror = () => setTimeout(() => {
        if (!open) return;
        const st = latest().stores[storeId];
        if (!st || st.state !== 'needs_person') done('solved'); else img.src = src();
      }, 1500);
      const at = (ev) => {
        const r = img.getBoundingClientRect();
        return { x: Math.round(((ev.clientX - r.left) / r.width) * img.naturalWidth), y: Math.round(((ev.clientY - r.top) / r.height) * img.naturalHeight) };
      };
      const send = (ev) => api('POST', `/shop/checker/input/${storeId}`, ev).catch((err) => { $promptForm.querySelector('#solve-error').textContent = err.message; });
      // A press and release in the same spot is a click; moving in between is a drag (for slider puzzles).
      let down = null;
      let moved = false;
      let lastMove = 0;
      img.onpointerdown = (ev) => { ev.preventDefault(); img.setPointerCapture(ev.pointerId); down = at(ev); moved = false; };
      img.onpointermove = (ev) => {
        if (!down) return;
        const p = at(ev);
        if (!moved && Math.hypot(p.x - down.x, p.y - down.y) < 6) return;
        if (!moved) { moved = true; send({ type: 'down', ...down }); }
        if (Date.now() - lastMove > 80) { lastMove = Date.now(); send({ type: 'move', ...p }); }
      };
      img.onpointerup = (ev) => {
        if (!down) return;
        const p = at(ev);
        send(moved ? { type: 'up', ...p } : { type: 'click', ...down });
        down = null;
      };
      const text = $promptForm.querySelector('#solve-text');
      const typeIt = async () => { if (text.value) { await send({ type: 'text', text: text.value }); text.value = ''; } };
      text.onkeydown = async (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (text.value) await typeIt(); else send({ type: 'key', key: 'Enter' }); } };
      $promptForm.onsubmit = (e) => e.preventDefault();
      $promptForm.onclick = (e) => {
        if (e.target.closest('[data-solve-send]')) { typeIt(); return; }
        const p = e.target.closest('[data-p]');
        if (p) done(p.dataset.p || 'hidden');
      };
      $prompt.oncancel = () => done('hidden');
      $prompt.showModal();
      watchScroll();
    });
  }

  // Automatic price search for a product: a tab for each store with how its search is going, and
  // the one bought there is picked from its likely matches. only is a store id, to find a new
  // match at just that store.
  function findPrices(p, back, { only = null, q = null, job = null } = {}) {
    const money2 = (c) => moneyFmt.format((c || 0) / 100);
    const stores = autoStores().filter((s) => !only || s.id === only);
    let current = job;
    let words = q || job?.q || p.name;
    // The store showing: the first one without a match, until another is picked.
    const mineAt = (sid) => shopProduct(p.id)?.matches?.[sid];
    let tab = (stores.find((s) => !mineAt(s.id)?.url) || stores[0])?.id;
    const opened = new Set(); // stores showing their other results
    let byPrice = false; // best match first, or cheapest per kg first
    // A store that sells it by the kg, picked while it's bought by the pack: offer to switch.
    let byKg = null;

    // Likely matches name what was searched for (its last word, like Pears in Packham Pears) and
    // aren't something made from it, like pear juice or pear baby food.
    const MADE = /\b(juice|nectar|cheese|yogh?urt|baby|toddler|pouch(?:es)?|puree|drinks?|cider|sauce|jam|spread|flavou?red|snacks?|bars?|chips|crisps|cereal|muesli|cakes?|muffins?|biscuits?|cookies?|lollies|soap|shampoo|candles?|dog|cat)\b/i;
    const stem = (w) => w.toLowerCase().replace(/(?:es|s)$/, '');
    const wordsOf = (t) => String(t || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
    const split = (list, sid) => {
      const asked = wordsOf(words).map(stem);
      const head = asked[asked.length - 1];
      const madeOf = (r) => { const m = MADE.exec(r.name); return m && !asked.includes(stem(m[1])) ? m[1].toLowerCase() : null; };
      const likely = [];
      const others = [];
      for (const r of list) {
        const named = !head || wordsOf(r.name).map(stem).includes(head);
        (mineAt(sid)?.url === r.url || (named && !madeOf(r)) ? likely : others).push(r);
      }
      if (!likely.length) return { likely: others, others: [], kinds: [] };
      const kinds = [...new Set(others.map((r) => madeOf(r)).filter(Boolean))];
      return { likely, others, kinds };
    };
    // Its price per kg (or L), from the store's or worked out from its size.
    const perUnit = (r) => {
      if (r.per_kg_cents) return { cents: r.per_kg_cents, per: /\b(m?l|litre)\b/i.test(r.size || '') ? 'L' : 'kg' };
      const m = measureText(r.size) || measureText(r.name);
      return m && m[1] ? { cents: Math.round((r.price_cents * 1000) / m[1]), per: m[0] === 'weight' ? 'kg' : 'L' } : null;
    };
    const byUnit = (a, b) => (perUnit(a)?.cents ?? Infinity) - (perUnit(b)?.cents ?? Infinity) || (a.cost_cents ?? a.price_cents) - (b.cost_cents ?? b.price_cents);
    // A store's "approx. 180g" as ≈ 180 g.
    const approx = (t) => String(t || '').replace(/approx\.?\s*/i, '≈ ').replace(/(\d)(kg|g|ml|l)\b/i, '$1 $2');

    const row = (s, r, on) => {
      const cost = r.cost_cents ?? r.price_cents;
      const unit = perUnit(r);
      const loose = cost !== r.price_cents;
      const size = r.sold === 'kg' || /^(each|per kg)$/i.test(r.size || '') ? '' : r.each_grams && !/approx/i.test(r.size || '') ? `≈ ${r.each_grams} g` : approx(r.size);
      const bits = [
        loose && r.sold === 'each' ? `${money2(r.price_cents)} each` : '',
        size,
        unit ? `${money2(unit.cents)}/${unit.per}` : r.unit_price || '',
        r.available === false ? 'In store only' : '',
      ].filter(Boolean).join(' · ');
      const note = r.special ? html`${bits ? ' · ' : ''}<span class="fp-special">Special${r.was_cents ? ` · was ${money2(r.was_cents)}` : ''}</span>` : '';
      const one = !loose && r.sold === 'each' && !r.per_kg_cents && BASE[p.unit] ? html`<div class="fp-sub">Price of one; the store doesn't say what one weighs.</div>` : '';
      const per = loose ? (p.price_per !== 'each' ? (PER_LABELS[p.price_per] || '').toLowerCase() : !sizeIn(p) && p.each_g ? `each (≈ ${gramsText(p.each_g)})` : `for ${sizeLabel(p)}`) : '';
      return html`<li class="fp-row${on ? ' on' : ''}"><label class="fp-pick"><input type="radio" name="fp-${s.id}" data-match="${s.id}" data-i="${r.i}" ${raw(on ? 'checked' : '')}>
          <span class="fp-pic">${r.image ? html`<img class="pic" src="${pictureUrl(r.image)}" alt="" loading="lazy">` : ''}</span>
          <span class="fp-text"><b class="fp-name">${r.name}</b><span class="fp-sub">${bits}${note}</span>${one}</span>
          <span class="fp-price"><b class="num">${money2(cost)}</b>${per ? html`<span class="fp-per">${per}</span>` : ''}</span></label>
        <a class="fp-view" href="${r.url}" target="_blank" rel="noopener noreferrer" aria-label="View ${r.name} at ${s.name}" title="View at ${s.name}">↗</a></li>`;
    };

    // Each store's tab: searching, matched, pick one, not sold, or what went wrong.
    const tabState = (j, s) => {
      const st = j?.stores?.[s.id];
      const mine = mineAt(s.id);
      if (!st || st.state === 'waiting' || st.state === 'working') return html`<span class="fp-state"><span class="auto-spin" aria-hidden="true"></span>Searching…</span>`;
      if (st.state === 'needs_person') return html`<span class="fp-state warn-text">Waiting for you</span>`;
      if (st.state !== 'done') return html`<span class="fp-state warn-text">${st.state === 'cancelled' ? 'Stopped' : st.state === 'try_later' ? 'Try later' : "Didn't work"}</span>`;
      if (mine?.url) return html`<span class="fp-state good-text">✓ Matched</span>`;
      if (mine) return html`<span class="fp-state muted">Not sold here</span>`;
      if (!(j.results?.[s.id] || []).length) return html`<span class="fp-state muted">Nothing found</span>`;
      return html`<span class="fp-state warn-text">Pick one</span>`;
    };
    const panel = (j, s) => {
      const st = j?.stores?.[s.id];
      if (!st || st.state === 'waiting' || st.state === 'working') return html`<div class="fp-wait"><span class="auto-spin" aria-hidden="true"></span>${st?.state === 'waiting' && j.waiting_for ? 'Waiting for another check to finish…' : `Searching ${s.name}…`}</div>`;
      if (st.state !== 'done') return html`<div class="auto-stores">${autoProgress(j, s)}</div>`;
      const list = (j.results && j.results[s.id]) || [];
      const mine = mineAt(s.id);
      const none = mine && !mine.url ? html`<p class="fp-none muted small">Not sold at ${s.name} ✓ (no automatic price there)</p>`
        : html`<p class="fp-none"><button type="button" class="linkish small" data-unmatch="${s.id}">Not sold at ${s.name}</button></p>`;
      if (!list.length) return html`<p class="muted small">Nothing found at ${s.name}. Try different words above.</p>${none}`;
      const { likely, others, kinds } = split(list, s.id);
      const unitWord = likely.some((r) => perUnit(r)?.per === 'L') && !likely.some((r) => perUnit(r)?.per === 'kg') ? 'L' : 'kg';
      const show = opened.has(s.id);
      // Closest to the product first (its words, brand and size; see relevance in src/shop.js), or cheapest for the amount.
      const order = byPrice ? byUnit : (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.i - b.i;
      return html`<div class="fp-list-head"><span>Likely matches</span><button type="button" class="fp-sort linkish" data-fp-sort>${byPrice ? `Cheapest per ${unitWord} first` : 'Best match first'} ⇅</button></div>
        <ul class="fp-list ${list.some((r) => r.image) ? 'with-pics' : ''}">${likely.slice().sort(order).map((r) => row(s, r, mine?.url === r.url))}</ul>
        ${others.length ? html`<button type="button" class="fp-more" data-fp-more="${s.id}" aria-expanded="${show ? 'true' : 'false'}">${show ? 'Hide' : 'Show'} ${others.length} other ${others.length === 1 ? 'result' : 'results'}${kinds.length ? html` <span class="muted">${kinds.slice(0, 3).join(', ')}</span>` : ''}</button>
          ${show ? html`<ul class="fp-list fp-others ${list.some((r) => r.image) ? 'with-pics' : ''}">${others.slice().sort(order).map((r) => row(s, r, mine?.url === r.url))}</ul>` : ''}` : ''}
        ${none}`;
    };
    const draw = (j) => {
      current = j;
      const box = $modalForm.querySelector('#find-body');
      if (!box) return;
      const s = stores.find((x) => x.id === tab) || stores[0];
      const offer = byKg && !isWeighed(shopProduct(p.id) || p) ? html`<div class="setup-banner kg-offer"><span class="grow">${storeName(byKg)} sells this by the kg. Switch to By weight?</span>
        <button type="button" class="mini primary" data-by-kg>Switch</button><button type="button" class="mini" data-by-kg-no>No thanks</button></div>` : '';
      const tabs = $modalForm.querySelector('#fp-tabs');
      tabs.innerHTML = stores.map((x) => html`<button type="button" role="tab" class="fp-tab${x.id === s.id ? ' on' : ''}" aria-selected="${x.id === s.id ? 'true' : 'false'}" data-fp-tab="${x.id}">
        <span class="fp-store">${storeDot(x.id)}${x.name}</span>${tabState(j, x)}</button>`.s).join('');
      box.innerHTML = html`${offer}${s ? panel(j, s) : ''}`.s;
      const matched = stores.filter((x) => mineAt(x.id)?.url).length;
      $modalForm.querySelector('#fp-count').textContent = `${matched} of ${stores.length} ${stores.length === 1 ? 'store' : 'stores'} matched`;
      const next = stores[stores.indexOf(s) + 1];
      const go = $modalForm.querySelector('[data-fp-next]');
      go.textContent = next ? `Next: ${next.name}` : 'Done';
      go.dataset.fpNext = next ? String(next.id) : '';
    };
    const start = async (form) => {
      form.querySelector('#form-error').textContent = '';
      opened.clear();
      try {
        const j = await api('POST', '/shop/checker/find', { product_id: p.id, store_ids: only ? [only] : undefined, q: words !== p.name ? words : undefined });
        followJob(j, draw, form);
      } catch (err) { form.querySelector('#form-error').textContent = err.message; }
    };
    openForm({
      title: null,
      cls: 'find-pop',
      body: html`${popHead(`${only ? 'Find a new match' : 'Find prices'} · ${productLabel(p)}`, {}, html`<p class="pop-sub">Pick the one you buy at ${only ? storeName(only) : 'each store'}. Its price is kept up to date.</p>`)}
        <div class="fp-search"><label for="find-q" class="sr-only">Search the stores for</label>
          <input id="find-q" type="search" value="${words}" autocomplete="off">
          <button type="button" data-find-go>Search again</button></div>
        <div class="fp-tabs" id="fp-tabs" role="tablist" style="--n: ${stores.length}"></div>
        <div id="find-body"></div>`,
      lead: html`<span class="fp-count" id="fp-count"></span><span class="spacer"></span><button type="button" data-find-back>Back</button><button type="button" class="primary" data-fp-next>Next</button>`,
      afterRender: (form) => {
        if (current) followJob(current, draw, form); else start(form);
        const again = () => { words = form.querySelector('#find-q').value.trim() || p.name; start(form); };
        form.querySelector('#find-q').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); again(); } };
        const pick = async (store, i) => {
          try {
            const r = i != null && (current.results?.[store] || []).find((x) => x.i === i);
            const thumb = r && r.image ? await thumbOf(pictureUrl(r.image)) : null;
            await api('PUT', `/shop/products/${p.id}/matches`, { job: current.id, picks: { [store]: i }, ...(thumb ? { images: { [store]: thumb } } : {}) });
            if (r && (r.sold === 'kg' || r.sold === 'each') && r.per_kg_cents) byKg = store;
            await loadShop(state.shop.list);
            render();
            draw(current);
          } catch (err) { form.querySelector('#form-error').textContent = err.message; }
        };
        form.onchange = (ev) => {
          const m = ev.target.closest('[data-match]');
          if (m && current) pick(Number(m.dataset.match), Number(m.dataset.i));
        };
        form.onclick = async (ev) => {
          if (solveClick(form, ev)) return;
          if (ev.target.closest('[data-find-go]')) { again(); return; }
          if (ev.target.closest('[data-fp-sort]')) { byPrice = !byPrice; if (current) draw(current); return; }
          if (ev.target.closest('[data-find-back]')) { back(); return; }
          const t = ev.target.closest('[data-fp-tab]');
          if (t) { tab = Number(t.dataset.fpTab); if (current) draw(current); return; }
          const n = ev.target.closest('[data-fp-next]');
          if (n) {
            if (!n.dataset.fpNext) { back(); return; }
            tab = Number(n.dataset.fpNext);
            if (current) draw(current);
            form.scrollTop = 0;
            return;
          }
          const more = ev.target.closest('[data-fp-more]');
          if (more) {
            const sid = Number(more.dataset.fpMore);
            if (opened.has(sid)) opened.delete(sid); else opened.add(sid);
            if (current) draw(current);
            return;
          }
          if (ev.target.closest('[data-by-kg-no]')) { byKg = null; draw(current); return; }
          if (ev.target.closest('[data-by-kg]') && current) {
            // By weight, priced per kg, 1 kg usually (or its weight if it has one); its matches are
            // picked again so their prices are worked out per kg.
            const now = shopProduct(p.id) || p;
            const g = BASE[now.unit] && MEASURE_OF[now.unit] === 'weight' ? now.size * BASE[now.unit] : null;
            const picks = {};
            for (const s of stores) {
              const url = now.matches?.[s.id]?.url;
              const r = url && (current.results?.[s.id] || []).find((x) => x.url === url);
              if (r) picks[s.id] = r.i;
            }
            // Other prices become per kg from its weight (not checked again), or go without one.
            const prices = {};
            const converted = [];
            if (now.price_per !== 'kg') {
              for (const s of state.shop.stores) {
                if (picks[s.id] != null || now.prices[s.id] == null) continue;
                const k = perKgAt(now, s.id);
                prices[s.id] = k;
                if (k != null) converted.push(s.id);
              }
            }
            try {
              await api('PATCH', `/shop/products/${p.id}`, { sold_by: 'weight', price_per: 'kg', size: g ? now.size : 1, unit: g ? now.unit : 'kg', prices, converted });
              if (Object.keys(picks).length) await api('PUT', `/shop/products/${p.id}/matches`, { job: current.id, picks });
              await loadShop(state.shop.list);
              render();
              byKg = null;
              draw(current);
              toast(`${p.name} is now bought by weight`);
            } catch (err) { form.querySelector('#form-error').textContent = err.message; }
            return;
          }
          const u = ev.target.closest('[data-unmatch]');
          if (u && current) pick(Number(u.dataset.unmatch), null);
        };
      },
    });
  }

  // Updating the list's out-of-date prices: each store's progress, then what changed, what
  // couldn't be found, and what isn't matched yet.
  function updatePrices({ all = false } = {}) {
    const back = all ? productList : updateAgain;
    const money2 = (c) => (c == null ? '—' : moneyFmt.format(c / 100));
    const stores = autoStores();
    const name = (id) => { const p = shopProduct(id); return p ? productLabel(p) : 'A product'; };
    const findLink = (pid, sid, label) => html`<button type="button" class="linkish small" data-find-for="${pid}" data-find-store="${sid}">${label}</button>`;
    const draw = (j) => {
      const box = $modalForm.querySelector('#upd-body');
      if (!box) return;
      const finished = !jobRunning(j);
      const unmatched = new Map();
      for (const u of j.unmatched || []) unmatched.set(u.product_id, [...(unmatched.get(u.product_id) || []), u.store_id]);
      box.innerHTML = html`
        ${j.id ? html`<div class="auto-stores">${stores.filter((s) => j.stores[s.id]).map((s) => autoProgress(j, s))}</div>` : html`<p class="muted">${all ? 'No saved product has an automatic price yet.' : 'Every matched price on the list is up to date.'}</p>`}
        ${finished && j.changes ? html`<h3 class="form-section">${j.changes.length ? `${j.changes.length} ${j.changes.length === 1 ? 'price' : 'prices'} changed` : 'No prices changed'}</h3>
          ${j.changes.length ? html`<ul class="list upd-list">${j.changes.map((c) => html`<li><div class="grow"><div class="title">${name(c.product_id)}</div>
            <div class="muted small">${storeDot(c.store_id)}${storeName(c.store_id)}${c.special ? html` · <span class="good">Special</span>` : ''}</div></div>
            <span class="num upd-change"><s class="muted">${money2(c.old_cents)}</s> → <b class="${c.old_cents != null && c.new_cents < c.old_cents ? 'good' : ''}">${money2(c.new_cents)}</b></span></li>`)}</ul>` : ''}` : ''}
        ${finished && j.missing && j.missing.length ? html`<h3 class="form-section">Couldn't find</h3><ul class="list upd-list">${j.missing.map((m) => html`<li><div class="grow">
            <div class="title">${name(m.product_id)}</div><div class="muted small">Not found at ${storeName(m.store_id)}. It may be gone or renamed.</div></div>
            ${findLink(m.product_id, m.store_id, 'Find new match')}</li>`)}</ul>` : ''}
        ${finished && unmatched.size ? html`<h3 class="form-section">Not matched yet</h3>
          <p class="muted small">These have no automatic price at a store yet. Find them once and they're kept up to date from then on.</p>
          <ul class="list upd-list">${[...unmatched].map(([pid, sids]) => html`<li><div class="grow"><div class="title">${name(pid)}</div>
            <div class="muted small">${sids.map((sid) => storeName(sid)).join(', ')}</div></div>${findLink(pid, sids.length === 1 ? sids[0] : '', 'Find')}</li>`)}</ul>` : ''}`.s;
      const stop = $modalForm.querySelector('[data-upd-stop]');
      if (stop) stop.hidden = finished;
      if (finished) loadShop(state.shop.list).then(render);
    };
    openForm({
      title: 'Update prices',
      body: html`<p class="muted small">Gets this week's prices from the stores' websites for ${all ? 'every saved product with an automatic price' : 'what\'s on the list'}. One check runs at a time, a few seconds per product.</p>
        <div id="upd-body"><div class="auto-store"><span class="auto-spin" aria-hidden="true"></span>Starting…</div></div>`,
      lead: html`${all ? html`<button type="button" data-upd-back>Back</button>` : ''}<button type="button" class="danger" data-upd-stop>Stop</button>`,
      afterRender: async (form) => {
        let job = null;
        form.onclick = async (ev) => {
          if (solveClick(form, ev)) return;
          if (ev.target.closest('[data-upd-back]')) { productList(); return; }
          if (ev.target.closest('[data-upd-stop]') && job && job.id) {
            try { await api('POST', `/shop/checker/jobs/${job.id}/cancel`); } catch { /* finished */ }
            return;
          }
          const f = ev.target.closest('[data-find-for]');
          if (f) {
            const p = shopProduct(Number(f.dataset.findFor));
            if (p) findPrices(p, back, { only: f.dataset.findStore ? Number(f.dataset.findStore) : null });
          }
        };
        try {
          job = await api('POST', '/shop/checker/update', all ? { all: true } : { list: state.shop.list });
          if (job.id) followJob(job, (j) => { job = j; draw(j); }, form); else draw(job);
        } catch (err) { form.querySelector('#form-error').textContent = err.message; }
      },
    });
  }
  // The Coles button: a Simple Budget extension for Brave or Chrome that gets Coles prices for
  // what's on the list, in the household's own browser (Coles turns the price-checker away).
  function helperPopup() {
    openForm({
      title: 'Coles button',
      body: html`<p>Coles doesn't let automatic price checkers in, so its prices come from a button in your own browser instead.
          Press it and it opens Coles in a tab, searches for what's on your lists a few seconds apart, and sends the prices here.
          The first time, you pick which Coles product you buy for each item.</p>
        <p class="muted small">It works in Brave, Chrome or Edge on a computer. Phones can't run it, but the prices show on every device.</p>
        <h3 class="form-section">Set it up (once per computer)</h3>
        <ol class="helper-steps">
          <li><a class="button-like" href="/api/shop/helper/extension.zip" download>Download the Coles button</a> and unzip it somewhere it can stay, like Documents.</li>
          <li>In Brave, go to <b>brave://extensions</b> (or <b>chrome://extensions</b>) and turn on <b>Developer mode</b>, top right.</li>
          <li>Press <b>Load unpacked</b> and pick the unzipped <b>simple-budget-coles-button</b> folder. Pin it from the puzzle-piece menu.</li>
          <li>Open it and put in this address and key:
            <div class="helper-copy"><span class="muted small">Address</span><code>${location.origin}</code><button type="button" class="mini" data-copy-origin>Copy</button></div>
            <div class="helper-copy"><span class="muted small">Key</span><code id="helper-key">••••••••</code><button type="button" class="mini" data-helper-key>Show</button></div></li>
        </ol>
        <p class="muted small">The key lets the button read your shopping lists and save prices, nothing else. <button type="button" class="linkish small" data-helper-new>Make a new key</button> if it's been shared by mistake; the old one stops working.</p>`,
      afterRender: (form) => {
        let key = null;
        const show = async (fresh) => {
          try {
            key = (await api('POST', '/shop/helper/key', fresh ? { new: true } : {})).key;
            form.querySelector('#helper-key').textContent = key;
            form.querySelector('[data-helper-key]').textContent = 'Copy';
          } catch (err) { form.querySelector('#form-error').textContent = err.message; }
        };
        form.onclick = async (ev) => {
          if (ev.target.closest('[data-copy-origin]')) copyText(location.origin, 'Address');
          if (ev.target.closest('[data-helper-key]')) { if (key) copyText(key, 'Key'); else show(false); }
          if (ev.target.closest('[data-helper-new]')) {
            const ok = await askChoice({ title: 'Make a new key?', text: html`<p>The Coles button stops working until the new key is put into it.</p>`,
              choices: [{ label: 'Keep this one', value: 'no' }, { label: 'New key', value: 'yes', danger: true }] });
            if (ok === 'yes') show(true);
          }
        };
      },
    });
  }

  // Back from finding a match, to a fresh look at what's left (nothing is checked twice: what was
  // just updated is up to date).
  const updateAgain = () => updatePrices();

  // The household's stores, each with its locations, and a section list for each location.
  // A ⋯ button with a menu of actions (each a data-action button). Popups that use it call kebabClick.
  const kebab = (label, items) => html`<div class="kebab"><button type="button" class="kb-btn" data-kebab aria-label="More for ${label}" aria-haspopup="menu" aria-expanded="false">⋯</button>
    <div class="kb-menu" role="menu" hidden>${items}</div></div>`;
  function kebabClick(form, ev) {
    const b = ev.target.closest('[data-kebab]');
    const open = b && b.nextElementSibling.hidden;
    form.querySelectorAll('.kb-menu:not([hidden])').forEach((m) => { m.hidden = true; m.previousElementSibling.setAttribute('aria-expanded', 'false'); });
    if (open) { b.nextElementSibling.hidden = false; b.setAttribute('aria-expanded', 'true'); }
    return Boolean(b);
  }

  // Managing stores: each chain with its locations, how many products have aisles at each, and a
  // ⋯ menu for each. back is where ‹ (and Done) go, like the store picker it was opened from.
  function shopStores(back = state.storesBack || null) {
    state.storesBack = back;
    const shut = (state.storesShut ||= new Set());
    openForm({
      title: null,
      cls: 'store-manage',
      noActions: true,
      body: html`<div class="pop-head"><div class="pop-title pe-title">${back ? html`<button type="button" class="pop-btn pe-back" data-back aria-label="Back">‹</button>` : ''}<div><h2>Manage stores</h2>
          <p class="pop-sub">Each location remembers its own aisles.</p></div></div>
          <div class="pop-btns"><button type="button" class="pop-btn x" data-modal="cancel" aria-label="Close">✕</button></div></div>
        ${state.shop.stores.map((s) => {
          const list = state.shop.locations.filter((l) => l.store_id === s.id);
          const open = !shut.has(s.id);
          return html`<section class="sm-chain ${open ? 'open' : ''}">
            <div class="sm-head"><button type="button" class="sm-toggle" data-chain="${s.id}" aria-expanded="${open ? 'true' : 'false'}">${storeDot(s.id)}<b>${s.name}</b>
                <span class="muted small">${list.length ? `${list.length} ${list.length === 1 ? 'location' : 'locations'}` : 'No locations'}</span><span class="sm-chev" aria-hidden="true">${open ? '▴' : '▾'}</span></button>
              ${kebab(s.name, html`<button type="button" role="menuitem" data-action="shop-store-edit" data-id="${s.id}" data-focus="name">Rename</button>
                <button type="button" role="menuitem" data-action="shop-store-edit" data-id="${s.id}" data-focus="search_url">Search link</button>
                <button type="button" role="menuitem" data-action="shop-store-edit" data-id="${s.id}" data-focus="color">Colour${state.shop.checker ? ' and automatic prices' : ''}</button>
                <button type="button" role="menuitem" class="danger-text" data-action="shop-store-delete" data-id="${s.id}">Delete ${s.name}</button>`)}</div>
            ${open ? html`<div class="sm-body">${list.length ? list.map((l) => {
                const n = aislesAt(l);
                return html`<div class="sm-loc"><div class="grow"><b>${l.name}</b><span class="small ${n ? 'muted' : 'warn-text'}">${n ? `${n} ${n === 1 ? 'item' : 'items'} with aisles` : 'Aisles not set'}</span></div>
                  ${kebab(locLabel(l), html`<button type="button" role="menuitem" data-action="shop-sections" data-id="${l.id}">Set aisles…</button>
                    <button type="button" role="menuitem" data-action="shop-loc-rename" data-id="${l.id}">Rename</button>
                    <button type="button" role="menuitem" class="danger-text" data-action="shop-loc-delete" data-id="${l.id}">Delete location</button>`)}</div>`;
              }) : html`<p class="muted small sm-none">No locations yet.</p>`}
              <button type="button" class="linkish small sm-add" data-action="shop-loc-new" data-id="${s.id}">+ Add ${aOrAn(s.name)} ${s.name} location</button></div>` : ''}
          </section>`;
        })}
        <button type="button" class="sm-add-chain" data-action="shop-store-new">+ Add a store chain</button>
        <div class="dialog-actions"><span class="spacer"></span><button type="button" class="primary" data-done>Done</button></div>`,
      afterRender: (form) => {
        form.onclick = (ev) => {
          if (kebabClick(form, ev)) return;
          const c = ev.target.closest('[data-chain]');
          if (c) { const id = Number(c.dataset.chain); if (shut.has(id)) shut.delete(id); else shut.add(id); shopStores(back); return; }
          if (ev.target.closest('[data-back], [data-done]')) {
            if (back) back(); else closeForm();
            state.storesBack = null;
          }
          if (ev.target.closest('[data-modal="cancel"]')) state.storesBack = null;
        };
      },
    });
  }

  const ORDER_HELP = 'The order puts a category among the aisles: 0.1 to 0.9 come before Aisle 1, and 21 comes after Aisle 20. It isn\'t shown on the list.';
  function orderVal(s, name) {
    const n = Number(s);
    if (s === '' || !Number.isFinite(n) || n < 0 || n > 99 || Math.round(n * 100) !== n * 100) throw new Error(`The order for ${name} should be a number from 0 to 99, like 3 or 0.2.`);
    return n;
  }

  // A location's named sections, and where each sits among the aisles.
  function shopSections(locId) {
    const loc = state.shop.locations.find((l) => l.id === locId);
    if (!loc) return shopStores();
    const list = sectionsAt(locId);
    openForm({
      title: `Edit categories at ${locLabel(loc)}`,
      body: html`<p class="muted small">${ORDER_HELP}</p>
        <div class="sec-head muted small"><span>Name</span><span>Order</span></div>
        <ul class="list sec-list">${list.map((s) => html`<li>
          <input name="name-${s.id}" value="${s.name}" aria-label="Category name">
          <input name="pos-${s.id}" inputmode="decimal" value="${s.position}" aria-label="Order of ${s.name}" class="sec-pos">
          <button type="button" class="icon ghost" data-action="shop-section-delete" data-id="${s.id}" aria-label="Remove ${s.name}" title="Remove">${BIN_ICON}</button></li>`)}</ul>
        <button type="button" class="mini" data-action="shop-section-new" data-id="${loc.id}">+ Add a category</button>`,
      lead: html`<button type="button" data-action="shop-stores" data-back="keep">Back</button>`,
      onSave: async (form) => {
        for (const s of list) {
          const name = val(form, `name-${s.id}`);
          if (!name) throw new Error('Every category needs a name.');
          const position = orderVal(val(form, `pos-${s.id}`), name);
          if (name !== s.name || position !== s.position) await api('PATCH', `/shop/sections/${s.id}`, { name, position });
        }
        await loadShop(state.shop.list);
      },
    });
  }

  Object.assign(actions, {
    'shop-tick': async (el) => {
      const it = state.shop.items.find((x) => x.id === Number(el.dataset.id));
      if (!it) return;
      el.closest('li')?.classList.toggle('got', !it.done_at);
      await api('PATCH', `/shop/items/${it.id}`, { done: !it.done_at, store_id: shopLocation()?.store_id ?? null });
      await shopReload();
      // That was the last one: offer to clear the list for next time.
      if (!it.done_at && state.shop.items.length && state.shop.items.every((x) => x.done_at)) {
        const ok = await askChoice({ title: 'Complete shopping list?',
          text: html`<p>Everything on this list is ticked off.</p>
            <p><b>Complete</b> clears the list, ready for next time. Everything stays in Saved products.</p>
            <p><b>Keep</b> leaves the list as it is. You can clear it later with the <b>Clear ticked items</b> button at the bottom.</p>`,
          choices: [{ label: 'Keep', value: 'no' }, { label: 'Complete', value: 'yes', primary: true }] });
        if (ok === 'yes') {
          await api('POST', '/shop/items/clear', { list: state.shop.list });
          await shopReload();
          toast('Shopping list complete');
        }
      }
    },
    'shop-qty': async (el) => {
      const it = state.shop.items.find((x) => x.id === Number(el.dataset.id));
      if (!it) return;
      const p = shopProduct(it.product_id);
      // Weighed: by its step; counted or packs: one at a time.
      const weighed = p && isWeighed(p) && it.grams != null;
      const qty = weighed ? it.grams + Number(el.dataset.step) * stepOf(p) : it.qty + Number(el.dataset.step);
      if (qty < 1) {
        const ok = await askChoice({ title: 'Take this off the list?', text: html`<p><b>${p ? productLabel(p) : 'This item'}</b></p><p>It stays in Saved products for next time.</p>`,
          choices: [{ label: 'Keep it', value: 'no' }, { label: 'Take off', value: 'yes', danger: true }] });
        if (ok !== 'yes') return;
        await api('DELETE', `/shop/items/${it.id}`);
      } else if (weighed) {
        await api('PATCH', `/shop/items/${it.id}`, { grams: Math.min(100000, qty) });
      } else if (qty <= 99) {
        await api('PATCH', `/shop/items/${it.id}`, { qty });
      }
      await shopReload();
    },
    'shop-search-clear': () => {
      const input = document.getElementById('shop-name');
      if (!input) return;
      input.value = '';
      shopFilter('');
      input.focus();
    },
    'shop-best': () => { remember('shop:best', bestOnly() ? null : '1'); render(); },
    'shop-fold-all': (el) => {
      const set = shopCollapsed();
      const keys = [...document.querySelectorAll('.shop-gtoggle[data-key]')].map((b) => b.dataset.key);
      for (const k of keys) { if (el.dataset.open) set.delete(k); else set.add(k); }
      remember('shop:collapsed', JSON.stringify([...set]));
      render();
    },
    'shop-fold': (el) => {
      const set = shopCollapsed();
      if (set.has(el.dataset.key)) set.delete(el.dataset.key); else set.add(el.dataset.key);
      remember('shop:collapsed', JSON.stringify([...set]));
      render();
    },
    'shop-clear': async () => {
      const list = state.shop.items;
      const got = list.filter((it) => it.done_at).length;
      const left = list.length - got;
      const ok = await askChoice({ title: 'Clear ticked items?',
        text: html`<p>${got} ticked ${got === 1 ? 'item comes' : 'items come'} off the list.${left ? ` The ${left} not ticked stay${left === 1 ? 's' : ''} on it for next time.` : ''}</p><p>They stay in Saved products.</p>`,
        choices: [{ label: 'Keep them', value: 'no' }, { label: 'Clear', value: 'yes', primary: true }] });
      if (ok !== 'yes') return;
      await api('POST', '/shop/items/clear', { list: state.shop.list });
      await shopReload();
      toast(`Cleared ${got} ${got === 1 ? 'item' : 'items'}`);
    },
    // On a phone, a list row opens to show its amount, cheaper store and similar product.
    'shop-open': (el) => {
      const id = Number(el.dataset.id);
      const open = !state.shopOpen.has(id);
      if (open) state.shopOpen.add(id); else state.shopOpen.delete(id);
      el.setAttribute('aria-expanded', String(open));
      el.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} details for ${shopProduct(state.shop.items.find((x) => x.id === id)?.product_id)?.name || 'this item'}`);
      el.closest('li')?.setAttribute('data-expanded', String(open));
    },
    'shop-item': (el) => {
      const it = state.shop.items.find((x) => x.id === Number(el.dataset.id));
      if (it) shopItemPopup(it.id);
    },
    'shop-remove': async (el) => {
      await api('DELETE', `/shop/items/${el.dataset.id}`);
      closeForm();
      await shopReload();
      toast('Taken off the list');
    },
    'shop-forget': async (el) => {
      const p = shopProduct(Number(el.dataset.id));
      if (!p) return;
      const ok = await askChoice({ title: 'Forget this product?', text: html`<p><b>${productLabel(p)}</b></p><p>It comes off every list, and its prices and aisles are forgotten.</p>`,
        choices: [{ label: 'Keep it', value: 'no' }, { label: 'Forget', value: 'yes', danger: true }] });
      if (ok !== 'yes') return;
      await api('DELETE', `/shop/products/${p.id}`);
      await shopReload();
      productList();
    },
    'shop-setup': (el) => {
      const p = shopProduct(Number(el.dataset.id));
      if (p) productEditor(p);
    },
    'shop-spot': (el) => {
      const loc = shopLocation();
      const p = shopProduct(Number(el.dataset.id));
      if (loc && p) spotPicker(p, loc);
    },
    'shop-products': () => { state.productQuery = ''; state.productEdit = false; productList(); },
    'shop-check': () => { state.checkQuery = ''; priceCheck(); },
    'shop-similar': () => similarList(),
    'shop-copy': () => copyList(),
    'shop-update': () => updatePrices(),
    'shop-helper': () => helperPopup(),
    'shop-change': () => shopChange(),
    'shop-stores': (el) => shopStores(el.dataset.back === 'change' ? shopChange : el.dataset.back === 'keep' ? state.storesBack : null),
    'shop-sections': (el) => shopSections(Number(el.dataset.id)),
    'shop-store-new': async () => {
      const name = await askText('Add a store', 'Name, like IGA');
      if (!name) return;
      await api('POST', '/shop/stores', { name });
      await shopReload();
      shopStores();
    },
    'shop-store-edit': (el) => {
      const s = state.shop.stores.find((x) => x.id === Number(el.dataset.id));
      if (!s) return;
      const back = el.dataset.back === 'change' ? shopChange : () => shopStores();
      openForm({
        title: `Edit ${s.name}`,
        body: html`<div class="fields">
          <div class="field"><label for="st-name">Name</label><input id="st-name" name="name" value="${s.name}" required></div>
          <div class="field color-field"><label for="st-color">Colour</label><input id="st-color" type="color" name="color" value="${/^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#64748b'}"></div></div>
          <div class="field"><label for="st-search">Search link</label><input id="st-search" name="search_url" inputmode="url" value="${s.search_url || ''}" placeholder="https://www.example.com.au/search?q={q}">
          <p class="muted small">The store's search page, with {q} where the product goes. Search the store's website for anything, copy the address, and put {q} in place of what you searched for. Leave it blank to turn off Look up.</p></div>
          ${state.shop.checker ? html`<div class="field"><label for="st-checker">Automatic prices</label><select id="st-checker" name="checker">
            <option value="">None</option>${state.shop.checker.stores.map((k) => html`<option value="${k}" ${raw(s.checker === k ? 'selected' : '')}>From ${k[0].toUpperCase()}${k.slice(1)}'s website</option>`)}</select>
            <p class="muted small">Which website the price-checker gets this store's prices from.</p></div>` : ''}`,
        lead: html`<button type="button" data-action="${back === shopChange ? 'shop-change' : 'shop-stores'}" data-back="keep">Back</button>`,
        afterRender: (form) => { const f = el.dataset.focus && form.elements[el.dataset.focus]; if (f) setTimeout(() => f.focus()); },
        onSave: async (form) => {
          await api('PATCH', `/shop/stores/${s.id}`, { name: val(form, 'name'), color: val(form, 'color'), search_url: val(form, 'search_url'),
            ...(state.shop.checker ? { checker: val(form, 'checker') || null } : {}) });
          await loadShop(state.shop.list);
          setTimeout(back); // back where it was opened from, once this popup has closed
        },
      });
    },
    'shop-store-delete': async (el) => {
      const s = state.shop.stores.find((x) => x.id === Number(el.dataset.id));
      if (!s) return;
      const locs = state.shop.locations.filter((l) => l.store_id === s.id);
      const set = locs.reduce((n, l) => n + aislesAt(l), 0);
      const ok = await askChoice({ title: `Delete all of ${s.name}?`, text: html`<p class="setup-banner"><span class="grow"><b>This removes the whole store, not just one location.</b></span></p>
          <p>${locs.length ? `Its ${locs.length === 1 ? 'location' : `${locs.length} locations`} (${locs.map((l) => l.name).join(', ')})` : 'It'}${set ? `, the ${set === 1 ? 'aisle or category' : `${set} aisles and categories`} set at them,` : ''} and every price and automatic match kept for ${s.name} are deleted. This can't be undone.</p>
          <p class="muted small">Your lists and products stay.</p>`,
        choices: [{ label: 'Keep it', value: 'no' }, { label: `Delete ${s.name}`, value: 'yes', danger: true }] });
      if (ok !== 'yes') return;
      await api('DELETE', `/shop/stores/${s.id}`);
      await shopReload();
      (el.dataset.back === 'change' ? shopChange : () => shopStores())();
    },
    'shop-loc-new': async (el) => {
      const store = Number(el.dataset.id);
      const name = await askText(`Add a ${storeName(store)}`, 'Suburb or name, like Castletown');
      if (!name) return;
      const l = await api('POST', '/shop/locations', { store_id: store, name });
      if (!shopLocation()) remember('shop:location', l.id);
      await shopReload();
      (el.dataset.back === 'change' ? shopChange : shopStores)();
    },
    'shop-loc-rename': async (el) => {
      const l = state.shop.locations.find((x) => x.id === Number(el.dataset.id));
      const name = l && await askText(`Rename ${locLabel(l)}`, 'Suburb or name', l.name);
      if (!name) return;
      await api('PATCH', `/shop/locations/${l.id}`, { name });
      await shopReload();
      shopStores();
    },
    'shop-loc-delete': async (el) => {
      const l = state.shop.locations.find((x) => x.id === Number(el.dataset.id));
      if (!l) return;
      const ok = await askChoice({ title: 'Delete this location?', text: html`<p><b>${locLabel(l)}</b></p><p>Its aisles and categories are forgotten${aislesAt(l) ? ` (${aislesAt(l)} items have one here)` : ''}. Your lists, prices and the store's other locations stay.</p>`,
        choices: [{ label: 'Keep it', value: 'no' }, { label: 'Delete', value: 'yes', danger: true }] });
      if (ok !== 'yes') return;
      await api('DELETE', `/shop/locations/${l.id}`);
      await shopReload();
      (el.dataset.back === 'change' ? shopChange : shopStores)();
    },
    'shop-section-new': async (el) => {
      const locId = Number(el.dataset.id);
      const name = await askText('Add a category', 'Name, like Pet food');
      if (!name) return;
      const pos = await askText(`Where does ${name} go?`, 'Order among the aisles (0.1 is before Aisle 1, 21 after Aisle 20)', '21', { inputmode: 'decimal' });
      if (pos === null) return;
      await api('POST', '/shop/sections', { location_id: locId, name, position: orderVal(pos.trim(), name) });
      await shopReload();
      // Added while choosing where something is: back to that choice.
      const p = el.closest('.spot-grid') && shopProduct(state.spotFor);
      if (p && shopLocation()) spotPicker(p, shopLocation()); else shopSections(locId);
    },
    'shop-section-delete': async (el) => {
      const s = state.shop.sections.find((x) => x.id === Number(el.dataset.id));
      if (!s) return;
      const ok = await askChoice({ title: 'Remove this category?', text: html`<p><b>${s.name}</b></p><p>Anything in it goes back to Unsorted at this store.</p>`,
        choices: [{ label: 'Keep it', value: 'no' }, { label: 'Remove', value: 'yes', danger: true }] });
      if (ok !== 'yes') return;
      await api('DELETE', `/shop/sections/${s.id}`);
      await shopReload();
      shopSections(s.location_id);
    },
  });

  // ---------- Combo box (see combo()) ----------

  function openCombo(input, showAll) {
    const list = input.parentElement.querySelector('.combo-list');
    const options = JSON.parse(input.dataset.combo || '[]');
    const q = input.value.trim().toLowerCase();
    const exact = options.some((o) => o.toLowerCase() === q);
    const matches = showAll || exact || !q ? options : options.filter((o) => o.toLowerCase().includes(q));
    const meta = JSON.parse(input.dataset.comboMeta || '{}');
    const items = matches.map((o) => ({ value: o, label: o, meta: meta[o] }));
    if (q && !exact) items.push({ value: input.value.trim(), label: `Add "${input.value.trim()}"`, add: true });
    list.innerHTML = html`${items.map((it) => html`<li role="option" data-value="${it.value}" class="${it.add ? 'add' : ''} ${it.value.toLowerCase() === q ? 'active' : ''}">${it.meta ? html`<span>${it.label}</span><span class="combo-meta">${it.meta}</span>` : it.label}</li>`)}`.s;
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  }
  function closeCombo(input) {
    const list = input.parentElement.querySelector('.combo-list');
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }
  function pickCombo(input, value) {
    input.value = value;
    input.dataset.picked = '1'; // chosen from the list, not just typed
    closeCombo(input);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  document.addEventListener('focusin', (ev) => { if (ev.target.dataset?.combo) openCombo(ev.target, true); });
  document.addEventListener('focusout', (ev) => { if (ev.target.dataset?.combo) closeCombo(ev.target); });
  document.addEventListener('mousedown', (ev) => {
    const li = ev.target.closest('.combo-list li');
    if (!li) return;
    ev.preventDefault(); // keep focus in the box
    pickCombo(li.closest('.combo').querySelector('input'), li.dataset.value);
  });
  document.addEventListener('input', (ev) => { if (ev.target.dataset?.combo) openCombo(ev.target, false); });
  document.addEventListener('keydown', (ev) => {
    const input = ev.target;
    if (!input.dataset?.combo) return;
    const list = input.parentElement.querySelector('.combo-list');
    const items = [...list.querySelectorAll('li')];
    const at = items.findIndex((li) => li.classList.contains('active'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (list.hidden) return openCombo(input, true);
      const next = items[(at + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      items.forEach((li) => li.classList.toggle('active', li === next));
      if (next) next.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter' && !list.hidden && at >= 0) {
      ev.preventDefault();
      pickCombo(input, items[at].dataset.value);
    } else if (ev.key === 'Escape' && !list.hidden) {
      ev.preventDefault(); // close the list, not the dialog
      closeCombo(input);
    }
  });

  // ---------- Router ----------

  let renderSeq = 0;
  // ---------- Sections: Budget (expenses, savings, loans) and Goals (saving for, paying back) ----------

  const SECTIONS = {
    budget: {
      title: 'Budget', sub: 'Everything that sets your deposits',
      tabs: {
        expenses: { label: 'Expenses', add: 'Add expense', action: 'new-expense', kind: 'expense', count: () => state.data.expenses.filter((e) => kindOf(e) === 'expense' || e.show_as_expense).length, render: () => renderExpenses('expense') },
        savings: { label: 'Savings', add: 'Add saving', action: 'new-expense', kind: 'saving', count: () => state.data.expenses.filter((e) => kindOf(e) === 'saving').length, render: () => renderExpenses('saving') },
        loans: { label: 'Loans', add: 'Add loan', action: 'new-loan', count: () => state.data.loans.length,
          render: () => html`${renderLoans()}<p class="tab-hint">Loan repayments feed into deposits like any other bill.</p>` },
      },
    },
    shopping: {
      title: 'Shopping', sub: 'What to buy, in aisle order',
      tabs: {
        shared: { label: 'Shared', count: () => state.shop.counts.shared, render: renderShopping },
        mine: { label: 'Mine', count: () => state.shop.counts.mine, render: renderShopping },
      },
    },
    goals: {
      title: 'Goals', sub: 'Things to save for and pay back',
      tabs: {
        'saving-for': { label: 'Saving for', add: 'Add goal', action: 'new-goal', kind: 'goal', count: () => state.data.goals.filter((g) => g.kind === 'goal' && !g.done).length, render: () => html`${renderGoals('goal')}<p class="tab-hint">Suggested amounts spread what's left evenly across the ${cycleWord()}s until each target date.</p>` },
        'paying-back': { label: 'Paying back', add: 'Add repayment', action: 'new-goal', kind: 'debt', count: () => state.data.goals.filter((g) => g.kind === 'debt' && !g.done).length, alert: () => debtPressing(),
          render: () => html`${renderGoals('debt')}<p class="tab-hint">Personal IOUs, e.g. a friend who covered concert tickets. Bank loans live under Budget → Loans.</p>` },
      },
    },
  };
  const OLD_ROUTES = { expenses: '#/budget/expenses', savings: '#/budget/savings', loans: '#/budget/loans', debts: '#/goals/paying-back' };
  // The tab last opened in a section on this device, or its first tab.
  function lastTab(section) {
    let t = null;
    try { t = localStorage.getItem(`tab:${section}`); } catch { /* use the first */ }
    return SECTIONS[section].tabs[t] ? t : Object.keys(SECTIONS[section].tabs)[0];
  }
  // Anything still to pay back whose date has passed.
  const debtOverdue = () => state.data.goals.some((g) => g.kind === 'debt' && !g.done && g.target_date && g.target_date < state.data.settings.today
    && (!g.target_cents || g.current_cents < g.target_cents));

  function renderSection(name, tab) {
    const sec = SECTIONS[name];
    const t = sec.tabs[tab];
    return html`<div class="sec-pin ${name === 'budget' ? 'on' : ''}">
      <div class="page-head sec-head">
        <div><h1>${sec.title}</h1><p class="muted small">${sec.sub}</p></div>
        ${t.add ? html`<button class="primary add-btn" data-action="${t.action}" ${raw(t.kind ? `data-kind="${t.kind}"` : '')} aria-label="${t.add}"><span class="add-full">+ ${t.add}</span><span class="add-short" aria-hidden="true">+</span></button>` : ''}
      </div>
      <div class="sec-tabs" role="tablist" aria-label="${sec.title}">${Object.entries(sec.tabs).map(([key, x]) => {
        const on = key === tab;
        const bad = x.alert && x.alert();
        return html`<a role="tab" href="#/${name}/${key}" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}">${x.label}<span class="tab-count ${bad || ''}" ${raw(bad ? `title="${bad === 'bad' ? 'Overdue' : 'Due soon'}"` : '')}>${x.count()}</span></a>`;
      })}</div></div>
      ${t.render()}`;
  }

  // Arrow keys move between the Budget or Goals tabs.
  document.addEventListener('keydown', (ev) => {
    const tab = ev.target.closest && ev.target.closest('[role=tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll('[role=tab]')];
    const i = tabs.indexOf(tab);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    ev.preventDefault();
    state.focusTab = true;
    location.hash = tabs[next].getAttribute('href');
  });

  async function render() {
    if (!state.data) return;
    const [, page = 'overview', sub] = (location.hash || '#/overview').split('/');
    // Old addresses, and a section without a tab, go to the right tab.
    if (OLD_ROUTES[page]) return location.replace(OLD_ROUTES[page]);
    if (SECTIONS[page] && !SECTIONS[page].tabs[sub]) return location.replace(`#/${page}/${lastTab(page)}`);
    if (SECTIONS[page]) { try { localStorage.setItem(`tab:${page}`, sub); } catch { /* not remembered */ } }
    $nav.hidden = false;
    $userMenu.hidden = false;
    $nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
    for (const name of Object.keys(SECTIONS)) $nav.querySelector(`[data-tab="${name}"]`).href = `#/${name}/${lastTab(name)}`;
    document.getElementById('goals-dot').hidden = !debtOverdue();
    // The year ahead is kept only while switching views on Analytics; arriving there always fetches fresh figures.
    if (!(page === 'overview' && sub === 'analytics')) state.trends = null;
    const seq = ++renderSeq;
    try {
      let out;
      if (page === 'shopping' && (!state.shop || state.shop.list !== sub)) await loadShop(sub);
      if (SECTIONS[page]) out = renderSection(page, sub);
      else if (page === 'overview' && sub === 'analytics') out = await renderAnalytics();
      else if (page === 'settings') {
        if (sub === 'updates' && !state.updates) await loadUpdates();
        if ((sub === 'updates' || sub === 'backups') && !state.backups) state.backups = await api('GET', '/backups').catch(() => null);
        if (sub === 'backups') state.storage = await api('GET', '/storage').catch(() => null);
        if (sub === 'price-checker') state.checkerStatus = await api('GET', '/apps/price-checker').catch(() => null);
        if (sub === 'advanced' && !state.advanced) state.advanced = await api('GET', '/advanced');
        if ((sub === 'security' || sub === 'logins') && !state.logins) state.logins = await api('GET', '/logins');
        out = renderSettings(sub);
      }
      else out = await renderOverview();
      if (seq === renderSeq) {
        $app.innerHTML = out.s;
        pinUnderTopbar();
        makeKeyboardReachable($app);
        scrollBillsToToday();
        if ($app.querySelector('#calc-form')) runCalc();
        if (state.focusTab) { state.focusTab = false; $app.querySelector('[role=tab][aria-selected=true]')?.focus(); }
      }
    } catch (err) {
      if (seq === renderSeq && err.message !== 'Please log in.') {
        $app.innerHTML = html`<div class="card"><p class="error">${err.message}</p><button data-action="cycle" data-step="0">Try again</button></div>`.s;
      }
    }
  }

  // Headings pinned while the page scrolls sit just under the top bar, whatever its height.
  function pinUnderTopbar() {
    const bar = document.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--top-h', `${bar.offsetHeight}px`);
    const head = document.querySelector('.sec-pin.on');
    document.documentElement.style.setProperty('--sec-h', `${head && getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0}px`);
  }
  window.addEventListener('resize', pinUnderTopbar);

  // Rows and cards that open something when clicked aren't buttons, so give them
  // a place in the Tab order; Enter or Space then clicks them (see below).
  const NOT_NATIVE = '[data-action]:not(button):not(a):not(input):not(select):not(textarea):not(label):not(option)';
  function makeKeyboardReachable(root) {
    root.querySelectorAll(NOT_NATIVE).forEach((el) => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    });
  }
  document.addEventListener('keydown', (ev) => {
    if ((ev.key !== 'Enter' && ev.key !== ' ') || ev.repeat || !ev.target.matches || !ev.target.matches(NOT_NATIVE)) return;
    ev.preventDefault();
    ev.target.click();
  });

  // A tab or home-screen app left open overnight would still think it was yesterday.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.me) api('GET', '/notifications/unread').then(showBell).catch(() => { /* next time */ });
    if (document.visibilityState !== 'visible' || !state.data || state.data.settings.today === localDate(new Date())) return;
    try { await reload(); await render(); } catch { /* shown on the next action */ }
  });

  // Brings the Today line to the top of the Overview's bill list (the list only, not the page).
  function scrollBillsToToday() {
    const list = $app.querySelector('.bills-scroll');
    const line = list && list.querySelector('.today-line');
    if (list && line && list.scrollHeight > list.clientHeight) list.scrollTop = line.offsetTop - list.offsetTop;
  }

  window.addEventListener('hashchange', () => { closeForm(); render(); window.scrollTo(0, 0); });

  // The version under the menu, and a Test / Beta tag in the header and page title.
  async function showVersion() {
    try {
      const { version, channel } = await api('GET', '/version');
      const label = { test: 'Test', beta: 'Beta' }[channel] || '';
      document.getElementById('menu-version').textContent = `v${version}${label ? ` · ${label}` : ''}`;
      const tag = document.getElementById('build-tag');
      tag.textContent = label; tag.hidden = !label; tag.dataset.channel = channel;
      document.title = label ? `Simple Budget (${label})` : 'Simple Budget';
    } catch { /* leave it off */ }
  }

  async function start() {
    showVersion();
    try {
      const session = await api('GET', '/session');
      if (!session.loggedIn) return showLogin(session.defaultPassword);
      if (session.mustChangePassword) return showChangePassword();
      await reload();
      // Who's logged in: their name in the menu, and their theme.
      state.me = await api('GET', '/me');
      state.goalWho = null;
      state.logins = await api('GET', '/logins').catch(() => null);
      applyTheme(state.me.theme, state.me.custom_theme);
      showMe();
      render();
      // New versions: on start, then every hour (the server itself asks GitHub every few hours).
      loadUpdates();
      if (!state.updateTimer) {
        state.updateTimer = setInterval(() => {
          if (!state.me) return;
          loadUpdates();
          api('GET', '/notifications/unread').then(showBell).catch(() => { /* next time */ });
        }, 60 * 60 * 1000);
      }
    } catch (err) {
      if (err.message !== 'Please log in.') $app.innerHTML = html`<div class="card"><p class="error">Could not reach the server: ${err.message}</p></div>`.s;
    }
  }

  start();
})();
