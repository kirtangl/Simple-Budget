'use strict';

(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  const $userMenu = document.getElementById('user-menu');
  const $modal = document.getElementById('modal');
  const $modalForm = document.getElementById('modal-form');
  const $prompt = document.getElementById('prompt');
  const $promptForm = document.getElementById('prompt-form');

  const state = { data: null, offset: 0, showIncomes: false, showUnused: false, calc: { amount: '', rate: '6', years: '30', frequency: 'monthly', limit: '70', result: null }, expenseQuery: '', expenseAccount: '', expenseWhen: '', expenseSort: 'due', expenseGroup: '', billAccount: '', billWhen: '' };

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

  // Mirrors src/budget.js: round the account's whole total up, then add the buffer %.
  const ROUNDING_STEP = { exact: 1, up5: 500, up10: 1000 };
  const HELD_LABELS = { year: 'Over the next 12 months', financial: 'Up to the end of the financial year (30 June)', calendar: 'Up to the end of the calendar year (31 December)' };
  const ROUNDING_LABELS = { exact: 'Exact (no rounding)', up5: 'Round up to the next $5', up10: 'Round up to the next $10' };
  function roundUp(cents) {
    const step = ROUNDING_STEP[state.data.settings.rounding] || 1;
    return Math.max(0, Math.ceil(cents / step - 1e-9) * step);
  }
  const withBuffer = (cents) => Math.round((cents * (100 + (state.data.settings.buffer_percent || 0))) / 100);

  // Rows that count today: active, and not a temporary one that has ended or not started.
  const current = (e) => e.active !== 0 && (!e.end_date || e.end_date >= state.data.settings.today) && (!e.start_date || e.start_date <= state.data.settings.today);

  function depositFor(accountId) {
    const avg = [...state.data.expenses.filter(current), ...state.data.loans]
      .filter((e) => e.account_id === accountId).reduce((s, e) => s + e.per_pay_exact_cents, 0);
    return withBuffer(roundUp(avg));
  }

  function depositNote() {
    const s = state.data.settings;
    const parts = [s.rounding === 'exact' ? 'not rounded' : s.rounding === 'up5' ? 'rounded up to $5' : 'rounded up to $10'];
    if (s.buffer_percent) parts.push(`plus ${s.buffer_percent}% buffer`);
    return parts.join(', ');
  }

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
  const combo = ({ id, name, value, options, placeholder = '' }) => html`
    <div class="combo"><input id="${id}" name="${name}" value="${value}" placeholder="${placeholder}" autocomplete="off"
      role="combobox" aria-autocomplete="list" aria-expanded="false" data-combo="${JSON.stringify(options)}"><ul class="combo-list" role="listbox" hidden></ul></div>`;

  function options(list, selected, { empty = '— None —', label = (x) => x.name } = {}) {
    return html`<option value="">${empty}</option>${list.map((x) => html`<option value="${x.id}" ${x.id === selected ? raw('selected') : ''}>${label(x)}</option>`)}`;
  }

  // ---------- Dialogs ----------

  let modalHandler = null;

  // Opens the shared form dialog. onSave receives the form element and
  // should throw an Error with a friendly message to keep the dialog open.
  function openForm({ title, body, onSave, onDelete, saveLabel = 'Save', afterRender, noActions = false, cls = '' }) {
    $modal.className = cls;
    $modalForm.innerHTML = html`
      ${title == null ? '' : html`<h2>${title}</h2>`}
      ${body}
      <p class="error" id="form-error"></p>
      <div class="dialog-actions" ${raw(noActions ? 'hidden' : '')}>
        ${onDelete ? html`<button type="button" class="danger" data-modal="delete">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" data-modal="cancel">${onSave ? 'Cancel' : 'Close'}</button>
        ${onSave ? html`<button type="submit" class="primary">${saveLabel}</button>` : ''}
      </div>`.s;
    modalHandler = { onSave, onDelete };
    if (afterRender) afterRender($modalForm);
    if (!$modal.open) $modal.showModal();
    const first = $modalForm.querySelector('input:not([type=checkbox]), select, textarea');
    if (first && window.matchMedia('(min-width: 721px)').matches) first.focus();
  }

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

  // A small "type a name" dialog used for adding categories, payees, etc.
  function askText(title, label, value = '', { inputmode = '' } = {}) {
    return new Promise((resolve) => {
      $promptForm.innerHTML = html`
        <h2>${title}</h2>
        <div class="field"><label for="prompt-input">${label}</label><input id="prompt-input" name="value" value="${value}" autocomplete="off" ${inputmode ? raw(`inputmode="${inputmode}"`) : ''}></div>
        <div class="dialog-actions"><button type="button" data-p="cancel">Cancel</button><button type="submit" class="primary">OK</button></div>`.s;
      const input = $promptForm.querySelector('input');
      const done = (v) => { $promptForm.onsubmit = null; $promptForm.onclick = null; if ($prompt.open) $prompt.close(); resolve(v); };
      $promptForm.onsubmit = (e) => { e.preventDefault(); done(input.value.trim() || null); };
      $promptForm.onclick = (e) => { if (e.target.dataset.p === 'cancel') done(null); };
      $prompt.oncancel = () => done(null);
      $prompt.showModal();
      input.focus();
      input.select();
    });
  }

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
        <div class="field"><label for="np1">New password</label><input id="np1" name="password" ${PASSWORD_ATTRS} autocomplete="new-password" minlength="6" required>
          <div class="hint">At least 6 characters.</div></div>
        <div class="field"><label for="np2">Type it again</label><input id="np2" name="confirm" ${PASSWORD_ATTRS} autocomplete="new-password" required></div>
        <p class="error" id="pw-error"></p>
        <button class="primary" type="submit" style="width:100%">Save password</button>
      </form>`.s;
    const form = document.getElementById('first-pw-form');
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
          <div class="hint">At least 6 characters. Other devices will need to log in again.</div></div>
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
  const INCOME_PER_YEAR = { weekly: 52, fortnightly: 26, monthly: 12 };
  // An income's after-tax pay, averaged per budget cycle ($3,000 fortnightly is $6,500 a month).
  const incomePerCycle = (i) => Math.round((i.after_tax_cents * (INCOME_PER_YEAR[i.frequency] || 26)) / state.data.settings.pays_per_year);
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

  async function renderOverview() {
    const c = await api('GET', `/cycle?offset=${state.offset}`);
    const t = c.totals;
    const accountsById = new Map(c.accounts.map((a) => [a.account_id, a]));
    const rows = state.data.accounts.map((a, i) => ({ a, r: accountsById.get(a.id), i })).filter((x) => x.r);
    // Accounts with nothing going in or out this cycle fold away.
    const isUsed = ({ r }) => r.deposit_cents || r.bills_cents || r.savings_cents || r.held_cents;
    const used = rows.filter(isUsed);
    const unused = rows.filter((x) => !isUsed(x));
    // Plain wording, so no (i) is needed: what to transfer, what's still to come out, and what to keep in the account.
    const depositRow = (a, r, i) => {
      const need = r.bills_cents + r.savings_cents;
      return html`
            <li class="acct-line deposit" style="--acct:${colorFor(a, i)}">
              <div class="grow">
                <div class="dep-top"><button class="acct-btn" data-action="account-details" data-id="${a.id}" data-tip="${bankTip(a) || 'No bank details yet'}">${a.name}</button>
                  <span class="dep-amt"><span class="muted">Transfer</span> <b class="num">${money(r.deposit_cents)}</b></span></div>
                <div class="figures">
                  <span class="figure" title="This ${cycleWord()}'s bills from this account that haven't come out yet (savings not included)"><span class="label">Still to come out</span> <b class="num">${money(r.remaining_cents)}</b></span>
                  <span class="figure" title="${c.cycle.is_current ? 'About what should be in the account today' : `About what should be in the account on ${fmtDate(c.held_on, true)}, once that deposit is in`} so every bill ${HELD_LABELS[state.data.settings.held_basis].toLowerCase()} can be paid, with the deposits still to come. Savings not included."><span class="label">Keep in account</span> <b class="num">${money(r.held_cents)}</b></span>
                  ${r.deposit_cents !== r.rounded_cents ? html`<span class="figure muted">incl. ${state.data.settings.buffer_percent}% buffer</span>` : ''}
                </div>
                ${r.spare_cents < 0 ? html`<div class="dep-warn">${r.savings_cents ? 'Bills + savings are' : 'Bills are'} ${money(need)}, ${money(-r.spare_cents)} more than this transfer</div>` : ''}
              </div>
            </li>`;
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
                <div class="meta">${a ? html`<span class="acct-tag"><span class="dot" style="background:${accountColor(a.id)}"></span>${a.name}</span>` : ''}${p && a ? ' · ' : ''}${p ? p.name : ''}</div></div>
              <div class="right">${b.status === 'paid' ? html`<div class="num"><span class="tick" aria-label="Paid">✓</span> ${money(b.amount_cents)}</div>`
                : html`<div class="num">${money(b.amount_cents)}</div>${b.status === 'due' ? html`<span class="status due">Due today</span>` : ''}`}</div>
            </li>`;
          })}</ul>` : bills.length ? '' : html`<p class="empty">No bills come out ${thisCycle()}.</p>`}
          </div>
          ${bills.length ? html`<div class="bills-foot"><b class="num">${money(sumOf(bills.filter((b) => inAccount(b) && b.status !== 'paid')))}</b> to pay · <b class="num">${money(sumOf(bills.filter((b) => inAccount(b) && b.status === 'paid')))}</b> paid</div>` : ''}
        </section></div>

        <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>Deposits ${thisCycle()}</h2><div class="muted head-sub">${cap(depositNote())} · <button class="linkish" data-action="edit-deposit-rules">Change</button></div></div>
            <b class="num dep-total">${money(t.deposits_cents)}</b></div>
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
      ...state.data.expenses.filter((e) => current(e) && !e.account_id).map((e) => ({ name: e.name, action: 'edit-expense', id: e.id })),
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
    return state.data.goals.filter((g) => !g.done && g.kind === kind)
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
    let when = '';
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
        <div class="dep-top"><span class="title">${g.name}</span>
          <span class="dep-amt">${g.target_cents ? html`<b class="num">${money(left)}</b> <span class="muted">to go</span>` : html`<b class="num">${money(g.current_cents)}</b> <span class="muted">${debt ? 'paid' : 'saved'}</span>`}</span></div>
        <div class="goal-when">${when}</div>${body}
      </div>${button ? html`<button type="button" data-action="edit-goal" data-id="${g.id}">Edit</button>` : ''}</li>`;
  }

  // Goals and debts that need attention: overdue or due soonest first, then the rest by progress.
  function goalsSummary() {
    const open = state.data.goals.filter((g) => !g.done);
    if (!open.length) return '';
    const pick = (kind) => openGoals(kind).slice(0, 3);
    const section = (kind, title) => {
      const list = pick(kind);
      const total = open.filter((g) => g.kind === kind).length;
      return html`
        <section class="card soft-${kind}">
          <div class="card-head"><h2>${title}</h2><button type="button" class="linkish small" data-action="goal-list" data-kind="${kind}">See all${total > list.length ? ` (${total})` : ''}</button></div>
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
    const perPayRows = [...state.data.expenses.filter(current), ...state.data.loans.filter((l) => l.per_pay_cents)];
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
    const savings = sc(state.data.expenses.filter((e) => current(e) && kindOf(e) === 'saving' && !e.show_as_expense).reduce((s, e) => s + e.per_pay_cents, 0));
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
    openForm({
      title: a.name,
      body: html`
        <ul class="list">
          ${line('BSB', a.bsb)}
          ${line('Account number', a.account_number)}
          ${a.bsb && a.account_number ? line('BSB and account', `${a.bsb} ${a.account_number}`) : ''}
        </ul>
        <p class="muted small">${[a.institution, a.type, a.owner && `Owner: ${a.owner}`].filter(Boolean).join(' · ')}</p>
        ${!a.bsb && !a.account_number ? html`<p>No bank details saved yet.</p>` : ''}
        <p><a href="#/settings/accounts" data-modal="cancel">Edit accounts</a></p>`,
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
        <button type="button" class="primary sheet-done" data-modal="cancel">Show ${n} ${n === 1 ? KIND_TEXT[kind].items.replace(/s$/, '') : KIND_TEXT[kind].items}</button>`,
    });
  }

  function renderExpenses(kind = 'expense') {
    const k = KIND_TEXT[kind];
    const sortBy = state.expenseSort || 'due';
    const byCategory = state.expenseGroup === 'category';
    const { all, list, accounts, noAccount } = expenseRows(kind);
    const perCycle = (items) => items.filter(current).reduce((s, e) => s + e.per_pay_cents, 0);

    const groups = (byCategory
      ? [...state.data.categories.map((c) => ({ id: c.id, name: c.name })), { id: null, name: 'No category' }]
        .map((g) => ({ ...g, color: 'var(--muted)', items: list.filter((e) => (e.category_id ?? null) === g.id) }))
      : [...state.data.accounts.map((a) => ({ id: a.id, name: a.name, color: accountColor(a.id), deposit: kind === 'expense' ? depositFor(a.id) : null })),
        { id: null, name: 'No account', color: 'var(--muted)' }]
        .map((g) => ({ ...g, items: list.filter((e) => (e.account_id ?? null) === g.id) })))
      .filter((g) => g.items.length)
      .map((g) => ({ ...g, key: `${kind}:${byCategory ? 'cat' : 'acct'}:${g.id ?? 'none'}`, total: perCycle(g.items) }));
    const collapsed = collapsedGroups();
    const total = perCycle(list);
    const word = cycleWord();
    const count = (n) => `${n} ${n === 1 ? k.items.replace(/s$/, '') : k.items}`;

    const nameLine = (e) => html`<span class="b-name">${e.name}</span>${payee(e.payee_id) ? html`<span class="b-payee"> · ${payee(e.payee_id).name}</span>` : ''}${e.active ? '' : html` <span class="chip">Paused</span>`}${kind === 'saving' && e.show_as_expense ? html` <span class="chip">In expenses</span>` : ''}${kind === 'expense' && kindOf(e) === 'saving' ? html` <span class="chip">Savings</span>` : ''}${untilTag(e)}`;
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
              <div class="b-line2">${e.active && e.next_date ? relDueHtml(e.next_date) : e.active ? FREQ_LABELS[e.frequency] : 'Paused'}${kindOf(e) === 'saving' && savingGoalText(e) ? ` · ${savingGoalText(e)}` : ''}</div></div>
            <div class="right"><div>${amountHtml(e)}</div>${showsPerCycle(e) ? html`<div class="b-line2 num">≈ ${money(e.per_pay_cents)} ${aCycle()}</div>` : ''}</div>
          </li>`)}</ul>`}
      </section>`;
    })}</div>`;

    // Desktop: one table, sortable by its headings.
    const sortHead = (key, text, cls = '') => html`<button type="button" class="th ${cls} ${sortBy === key ? 'on' : ''}" data-action="set-filter" data-key="expenseSort" data-value="${key}">${text}${sortBy === key ? ' ↓' : ''}</button>`;
    const table = html`<div class="exp-table" role="table">
      <div class="exp-tr exp-th" role="row">${sortHead('az', k.one === 'saving' ? 'Saving' : 'Bill')}<span class="th">Schedule</span>${sortHead('due', 'Next due')}${sortHead('amount', 'Amount', 'r')}<span class="th r">Per ${word}</span></div>
      ${groups.map((g) => {
        const shut = collapsed.has(g.key);
        return html`<div class="exp-tr exp-tg ${shut ? 'shut' : ''}" role="row" data-action="toggle-group" data-key="${g.key}" aria-expanded="${shut ? 'false' : 'true'}">
          <span class="g-cell"><span class="chev">${shut ? '▸' : '▾'}</span><span class="dot" style="background:${g.color}"></span><span class="g-name">${g.name}</span><span class="g-count">${count(g.items.length)}</span></span>
          <span class="g-dep r">${g.deposit != null ? `${money(g.deposit)} deposit` : ''}</span>
          <span class="r g-total ${g.deposit != null && g.total > g.deposit ? 'over' : ''}">${money(g.total)}</span></div>
          ${shut ? '' : g.items.map((e) => html`<div class="exp-tr exp-td clickable ${isToday(e) ? 'today' : ''} ${e.active ? '' : 'paused'}" role="row" style="--acct:${g.color}" data-action="edit-expense" data-id="${e.id}">
            <span class="b-cell">${nameLine(e)}</span>
            <span class="sched">${isSplit(e) ? `${money(e.yearly_cents)} a year, spread` : shortSchedule(e)}</span>
            <span>${dueHtml(e)}</span>
            <span class="r">${amountHtml(e)}</span>
            <span class="r per num">${money(e.per_pay_cents)}</span></div>`)}`;
      })}
      <div class="exp-tr exp-tt" role="row"><span>Total</span><span class="r num">${money(total)}</span></div>
    </div>`;

    return html`
      <div class="exp-mtools">
        <label class="exp-search-wrap"><span class="ico" aria-hidden="true">⌕</span><input type="search" class="exp-search" placeholder="Search" value="${state.expenseQuery}" data-input="expense-query" aria-label="Search"></label>
        <button type="button" class="filters-btn ${filtersOn() ? 'on' : ''}" data-action="expense-filters" data-kind="${kind}">Filters${filtersOn() ? html` <span class="tab-count">${filtersOn()}</span>` : ''}</button>
      </div>
      <p class="exp-mcount">${count(list.length)} · about ${money(Math.round(total))} ${aCycle()}</p>
      <div class="card exp-shell">
        <div class="exp-tools">
          <label class="exp-search-wrap"><span class="ico" aria-hidden="true">⌕</span><input type="search" class="exp-search" placeholder="${k.search}" value="${state.expenseQuery}" data-input="expense-query" aria-label="Search"></label>
          ${dropdown('expenseAccount', 'Account', [['', 'All accounts'], ...accounts.map((a) => [String(a.id), a.name]), ...(noAccount ? [['none', 'No account']] : [])])}
          ${dropdown('expenseWhen', 'Due', expenseWhenOptions())}
          ${dropdown('expenseGroup', 'Group by', [['', 'Account'], ['category', 'Category']])}
          <button type="button" class="exp-reset" data-action="expense-reset" ${filtersOn() || state.expenseQuery ? '' : raw('disabled')} title="Clear the search and filters">↺ Reset</button>
                  </div>
        <div class="exp-count">${count(list.length)} · about ${money(Math.round(total))} ${aCycle()}</div>
        ${groups.length ? table : html`<p class="empty">${all.length ? `No ${k.items} match.` : k.none}</p>`}
      </div>
      ${groups.length ? cards : ''}`;
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
          ${temporaryField(e)}
          <div class="field full"><label class="check"><input type="checkbox" name="active" ${e.active ? raw('checked') : ''}> Active (untick to pause without deleting)</label></div>
        </div>`,
      onSave: async (form) => {
        const saving = val(form, 'kind') === 'saving';
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
        };
        if (!body.name) throw new Error('Please give it a name.');
        await (e.id ? api('PATCH', `/expenses/${e.id}`, body) : api('POST', '/expenses', body));
        await reload();
        toast(body.kind === 'saving' ? 'Saving saved' : 'Expense saved');
      },
      onDelete: e.id ? async () => { await api('DELETE', `/expenses/${e.id}`); await reload(); toast('Deleted'); } : null,
      afterRender: (form) => {
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
        <div class="g-main">
          <div class="g-name">${g.name}${g.notes ? html`<span class="g-note"> · ${g.notes}</span>` : ''}</div>
          <div class="g-chips">${goalStatusChip(g)}
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
    const all = state.data.goals.filter((g) => g.kind === kind);
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
      <div class="card g-stat"><div class="g-stat-lbl">${debt ? 'Still owed' : 'Still to go'}</div><div class="g-stat-val num">${money(left)}</div>
        <div class="g-stat-sub">across ${items.length} item${items.length === 1 ? '' : 's'}</div></div>
      <div class="card g-stat"><div class="g-stat-lbl">To stay on track</div><div class="g-stat-val num track">${money(perCycle)} / ${cycleShort()}</div>
        <div class="g-stat-sub ${dueNow.length ? 'soon' : ''}">${dueNow.length ? `plus ${money(dueNowTotal)} due now (${dueNow.map((g) => g.name).join(', ')})` : 'covers every dated item'}</div></div>
    </div>`;

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

    return html`
      ${items.length || done.length ? summary : ''}
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

  // Saves a category's colour, creating the category if it's new. Returns its name as saved.
  async function saveGroup(kind, name, color) {
    if (!name) return null;
    const existing = findGroup(kind, name);
    if (!existing) return (await api('POST', '/goal_groups', { kind, name, color })).name;
    if (existing.color !== color) await api('PATCH', `/goal_groups/${existing.id}`, { color });
    return existing.name;
  }

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
        if (kind === 'debt') {
          body.start_date = val(form, 'start_date') || null;
          body.target_firm = form.elements.target_firm.checked;
          if (body.start_date && body.target_date && body.target_date < body.start_date) throw new Error('The pay off date is before the start date.');
        }
        if (!body.name) throw new Error('Please give it a name.');
        body.group_name = await saveGroup(kind, body.group_name, val(form, 'group_color'));
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
          // A category that only existed as a name on its goals: save it, then move the goals.
          await api('POST', '/goal_groups', { kind, ...body });
          if (newName !== name) {
            const moving = state.data.goals.filter((g) => g.kind === kind && (g.group_name || '').toLowerCase() === name.toLowerCase());
            for (const g of moving) await api('PATCH', `/goals/${g.id}`, { group_name: newName });
          }
        }
        await reload();
      },
      onDelete: async () => {
        if (existing) {
          await api('DELETE', `/goal_groups/${existing.id}`);
        } else {
          const moving = state.data.goals.filter((g) => g.kind === kind && (g.group_name || '').toLowerCase() === name.toLowerCase());
          for (const g of moving) await api('PATCH', `/goals/${g.id}`, { group_name: null });
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
          ${bal != null ? html`<div class="lc-bal"><div class="num">${money(bal)}</div><div class="muted">left to pay</div></div>` : ''}
          <button type="button" class="linkish lc-edit" data-action="edit-loan" data-id="${l.id}">Edit</button>
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

  // Month-by-month from today's balance: interest on what's not offset, then the monthly repayment (plus any extra).
  function payExtraSim(l, extra) {
    const b = l.budgeted;
    const perMonth = b.per_month_cents + (extra * LOAN_PER_YEAR[b.frequency]) / 12;
    const rate = (Number(l.interest_rate) || 0) / 100 / 12;
    const offset = Number(l.offset_cents) || 0;
    let bal = l.estimated_balance_cents || 0;
    let interest = 0;
    const points = [];
    while (bal > 0 && points.length < 600) {
      const i = Math.max(0, bal - offset) * rate;
      interest += i;
      bal = Math.max(0, bal + i - perMonth);
      points.push(bal);
    }
    return { months: points.length, interest, points, paidOff: bal <= 0 };
  }

  // Balance over time: your plan (history plus projection), the bank's schedule from today, and with extra.
  function loanChart(l, extraPoints) {
    const t = l.timeline;
    if (!t || t.points.length < 2) return '';
    const today = state.data.settings.today;
    const todayI = monthIdx(today) + (Number(today.slice(8)) - 1) / 30;
    const plan = t.points.map((p) => [monthIdx(p.month), p.balance_cents]);
    const startI = l.start_date ? monthIdx(l.start_date) : plan[0][0] - 1;
    if (l.start_date && l.principal_cents) plan.unshift([startI, l.principal_cents]);
    const bal = l.estimated_balance_cents || 0;
    const bank = l.bank ? [[todayI, bal], ...l.bank.points.map(([m, v]) => [monthIdx(m), v])] : [];
    const extra = extraPoints ? [[todayI, bal], ...extraPoints.map((v, k) => [monthIdx(today) + k + 1, v])] : [];
    const endI = Math.max(l.end_date ? monthIdx(l.end_date) : 0, plan.at(-1)[0], bank.length ? bank.at(-1)[0] : 0);
    const top = Math.max(l.principal_cents || 0, ...plan.map((p) => p[1]), 1);
    const W = 560; const H = 180;
    const x = (i) => ((i - startI) / (endI - startI || 1)) * W;
    const y = (v) => 6 + (1 - v / top) * (H - 6);
    const path = (pts) => pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const line = path(plan);
    const area = `${line}L${x(plan.at(-1)[0]).toFixed(1)},${H}L${x(plan[0][0]).toFixed(1)},${H}Z`;
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
        ${extra.length > 1 ? html`<path d="${path(extra)}" fill="none" stroke="#3fb950" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>` : ''}
        <line x1="${x(todayI)}" x2="${x(todayI)}" y1="0" y2="${H}" stroke="#5b6778" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"></line>
        <line class="ld-cursor" x1="0" x2="0" y1="0" y2="${H}" stroke="currentColor" stroke-width="1" opacity="0" vector-effect="non-scaling-stroke"></line>
      </svg>
      <span class="ld-today" style="left:${(x(todayI) / W) * 100}%">Today</span>
      <div class="ld-tip" hidden></div>
      <div class="ld-years">${years.map((yr) => html`<span style="left:${(x(yr * 12) / W) * 100}%">${yr}</span>`)}</div>
    </div>`;
  }

  // Hover, or tap, for a month's repayments, interest and balance. The tooltip flips left past 60% of the width.
  function loanChartTip(ev) {
    const chart = ev.target.closest && ev.target.closest('.ld-chart');
    if (!chart) return;
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

  // "What if I pay extra?": the slider's results, and the chart with the extra line.
  let openLoan = null;
  function payExtraResults(l, extra) {
    const base = payExtraSim(l, 0);
    const b = l.budgeted;
    const unit = FREQ_UNIT[b.frequency];
    const nowI = monthIdx(state.data.settings.today);
    let off; let sooner = '—'; let saved = '—'; let soonerCls = ''; let extraPts = null;
    if (!extra) {
      off = l.estimated_payoff_date ? monthName(monthIdx(l.estimated_payoff_date)) : '—';
    } else {
      const sim = payExtraSim(l, extra);
      extraPts = sim.points;
      off = sim.paidOff ? monthName(nowI + sim.months) : 'Not in 50 years';
      if (sim.paidOff && base.paidOff) {
        sooner = spanText(Math.max(0, base.months - sim.months));
        saved = `~${money(Math.max(0, Math.round((base.interest - sim.interest) / 100) * 100))}`;
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
  document.addEventListener('input', (ev) => {
    if (!ev.target.matches || !ev.target.matches('#ld-extra') || !openLoan) return;
    const extra = Number(ev.target.value) * 100;
    const r = payExtraResults(openLoan, extra);
    const root = ev.target.closest('.ld');
    root.querySelector('.ld-x-amt').innerHTML = r.head.s;
    root.querySelector('.ld-x-cells').innerHTML = r.cells.s;
    root.querySelector('.ld-chart-wrap').innerHTML = loanChart(openLoan, r.extraPts).s;
    root.querySelector('.ld-key-extra').hidden = !extra;
    ev.target.style.setProperty('--fill', `${(Number(ev.target.value) / Number(ev.target.max)) * 100}%`);
  });

  // Detail popup: balance and pay-off, how it's paid, what it costs, the balance over time and what paying extra would do.
  async function loanDetails(id) {
    const l = await api('GET', `/loans/${id}/details`);
    openLoan = l;
    const t = l.timeline;
    const sch = l.scheduled;
    const bud = l.budgeted;
    const a = account(l.account_id);
    const today = state.data.settings.today;
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
    const remainingMonths = l.end_date ? Math.max(1, monthIdx(l.end_date) - monthIdx(today)) : null;
    const rateRise = remainingMonths && l.estimated_balance_cents > 0 && l.interest_rate != null
      ? Math.round(amortised(l.estimated_balance_cents, Number(l.interest_rate) + 0.25, 12, remainingMonths) - amortised(l.estimated_balance_cents, Number(l.interest_rate), 12, remainingMonths)) : null;

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
          <div class="ld-head-btns"><button type="button" class="linkish" data-action="edit-loan" data-id="${l.id}">Edit</button>
            <button type="button" class="ld-x" data-modal="cancel" aria-label="Close">✕</button></div>
        </div>

        <div class="ld-sum">
          <div><div class="ld-lbl">Left to pay</div><div class="ld-bal num">${l.estimated_balance_cents != null ? money(l.estimated_balance_cents) : '—'}</div></div>
          <div class="ld-off"><div class="ld-lbl">Paid off around</div><div class="ld-date">${l.estimated_payoff_date ? fmtDate(l.estimated_payoff_date, true) : '—'}</div>
            ${off.text ? html`<div class="ld-vs ${off.cls}">${off.text}</div>` : ''}</div>
        </div>

        ${warn ? html`<div class="ld-warn"><span>The estimate is <b>${money(Math.abs(gap))}</b> ${gap < 0 ? 'below' : 'above'} your last statement (${fmtDate(h.to)}).
            <button type="button" class="linkish" data-action="ld-working">How is this worked out?</button></span>
          <button type="button" class="ld-warn-btn" data-action="edit-loan" data-id="${l.id}">Update balance</button></div>
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
          <h3>Balance over time</h3>
          <div class="ld-keys"><span><i class="k-plan"></i>Your plan</span>${l.bank ? html`<span><i class="k-bank"></i>Bank schedule</span>` : ''}<span class="ld-key-extra" hidden><i class="k-extra"></i>With extra</span></div>
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
        <div class="ld-btns"><button type="button" data-modal="cancel">Close</button><button type="button" class="primary" data-action="edit-loan" data-id="${l.id}">Edit loan</button></div>
      </div>`,
    });
  }
  // The usual repayment for a balance over a number of periods.
  function amortised(cents, ratePercent, perYear, periods) {
    const r = ratePercent / 100 / perYear;
    return r ? (cents * r) / (1 - (1 + r) ** -periods) : cents / periods;
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
    openForm({
      title: e.name,
      body: html`
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
          ${e.notes ? line('Notes', e.notes, false) : ''}
        </ul>
        <p class="hint">Paid so far counts every date it was due before today${e.start_date ? `, from ${fmtDate(e.start_date, true)}` : ''}.</p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="primary" data-action="edit-expense" data-id="${e.id}">Edit ${kindOf(e) === 'saving' ? 'saving' : 'expense'}</button></div>`,
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
    const word = cycleWord();
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
    if (loans.length === 1) return loanForm(loans[0]);
    openForm({
      title: 'Update balances',
      body: html`<p class="hint">Pick a loan and enter the balance from its latest statement.</p>
        <ul class="list">${loans.map((l) => html`<li><div class="grow"><div class="title">${l.name}</div>
          <div class="meta">${l.balance_cents != null && l.balance_date ? `${money(l.balance_cents)} as at ${fmtDate(l.balance_date, true)}` : 'No statement balance yet'}</div></div>
          <button type="button" data-action="edit-loan" data-id="${l.id}">Update</button></li>`)}</ul>`,
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
        await (l.id ? api('PATCH', `/loans/${l.id}`, body) : api('POST', '/loans', body));
        await reload();
        toast('Loan saved');
      },
      onDelete: l.id ? async () => { await api('DELETE', `/loans/${l.id}`); await reload(); } : null,
    });
  }

  // ---------- Settings ----------

  const SETTINGS_TABS = [['income', 'Income'], ['accounts', 'Accounts'], ['payees', 'Payees'], ['categories', 'Categories'], ['cycle', 'General'], ['appearance', 'Appearance'], ['security', 'Security'], ['updates', 'Updates'], ['advanced', 'Advanced']];

  // Setting up the budget, then the app itself.
  const SETTINGS_GROUPS = [['income', 'accounts', 'payees', 'categories'], ['cycle', 'appearance', 'security', 'updates'], ['advanced']];

  function renderSettings(sub) {
    if (sub === 'logins') sub = 'security'; // its old name
    const tab = SETTINGS_TABS.some(([k]) => k === sub) ? sub : 'income';
    const body = { income: settingsIncome, accounts: settingsAccounts, payees: settingsPayees, categories: settingsCategories, cycle: settingsCycle, appearance: themeCard, security: settingsSecurity, updates: settingsUpdates, advanced: settingsAdvanced }[tab]();
    return html`
      <div class="page-head"><h1>Settings</h1></div>
      <nav class="sec-tabs settings-tabs" aria-label="Settings">${SETTINGS_GROUPS.map((keys, i) => html`${i ? html`<span class="st-sep" aria-hidden="true"></span>` : ''}<div class="st-group st-${keys.length}">
        ${keys.map((k) => html`<a href="#/settings/${k}" ${k === tab ? raw('aria-current="page"') : ''} class="${k === tab ? 'active' : ''} ${k === 'advanced' ? 'st-advanced' : ''}">${SETTINGS_TABS.find(([x]) => x === k)[1]}${k === 'updates' ? html`<span class="st-dot" ${state.updates && state.updates.available ? '' : raw('hidden')}></span>` : ''}</a>`)}</div>`)}</nav>
      ${body}`;
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

  // Popup version of the Settings → General deposit rules, opened from the Overview.
  function depositRulesForm() {
    const s = state.data.settings;
    openForm({
      title: 'Deposit rounding',
      body: html`
        <p class="muted small">Each account's deposit is the per-cycle total of its bills, rounded up as a whole, then the buffer is added on top.
          For example $301 rounded up to $10 is $310, and a 10% buffer makes it $341.</p>
        <div class="fields">
          <div class="field"><label for="m-rounding">Rounding</label><select id="m-rounding" name="rounding">
            ${Object.entries(ROUNDING_LABELS).map(([k, v]) => html`<option value="${k}" ${k === s.rounding ? raw('selected') : ''}>${v}</option>`)}</select></div>
          <div class="field"><label for="m-buffer">Buffer (%)</label><input id="m-buffer" name="buffer_percent" type="number" inputmode="numeric" min="0" max="20" step="1" value="${s.buffer_percent}">
            <div class="hint">0 to 20.</div></div>
        </div>`,
      onSave: async (form) => {
        const f = form.elements;
        await api('PUT', '/settings', { rounding: f.rounding.value, buffer_percent: Number(f.buffer_percent.value || 0) });
        await reload();
      },
    });
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
        </div>`,
      onSave: async (form) => {
        const body = Object.fromEntries(['name', 'nickname', 'institution', 'type', 'owner', 'bsb', 'account_number', 'color'].map((k) => [k, val(form, k)]));
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
      </div>
      <div class="card">
        <h2>Deposits</h2>
        <p class="muted small">Each account's deposit is the per-cycle total of its bills, rounded up as a whole, then the buffer is added on top.
          For example $301 rounded up to $10 is $310, and a 10% buffer makes it $341.</p>
        <form id="deposit-form">
          <div class="fields">
            <div class="field"><label for="rounding">Rounding</label><select id="rounding" name="rounding">
              ${Object.entries(ROUNDING_LABELS).map(([k, v]) => html`<option value="${k}" ${k === s.rounding ? raw('selected') : ''}>${v}</option>`)}</select></div>
            <div class="field"><label for="buffer">Buffer (%)</label><input id="buffer" name="buffer_percent" type="number" inputmode="numeric" min="0" max="20" step="1" value="${s.buffer_percent}">
              <div class="hint">0 to 20. Adds extra on top of every account's deposit.</div></div>
            <div class="field full"><label for="held">"Should hold" looks ahead</label><select id="held" name="held_basis">
              ${Object.entries(HELD_LABELS).map(([k, v]) => html`<option value="${k}" ${k === s.held_basis ? raw('selected') : ''}>${v}</option>`)}</select>
              <div class="hint">A guide on the Overview to how much each account should have in it today, so that with the deposits still to come,
                every bill in that time can be paid. Savings aren't included. 12 months covers every yearly bill; the year-end options ignore bills after it.</div></div>
          </div>
          <button class="primary" type="submit">Save</button>
        </form>
      </div>
      <div class="card">
        <h2>Backup and restore</h2>
        <p class="muted small">Download everything (accounts, income, payees, categories, expenses, savings, loans, goals, debts and these settings)
          as a file you can keep somewhere safe. Restoring a backup <b>replaces</b> what's in the app now. Your password isn't included or changed.</p>
        <div class="row">
          <a class="btn" href="api/export" download>Download backup</a>
          <label class="btn" style="margin:0;font-size:inherit">Restore from backup…
            <input type="file" accept="application/json,.json" data-input="restore" hidden></label>
        </div>
      </div>
      <div class="card">
        <h2>Password and logins</h2>
        <p class="muted small">Your password, and logins for anyone else in the household, are under <a href="#/settings/security">Security</a>.</p>
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
    for (const dot of document.querySelectorAll('.st-dot')) dot.hidden = !on;
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

  // "Today, 7:42 pm", "Yesterday, …" or "Thu 1 Oct, …".
  function updWhen(iso) {
    const d = new Date(iso);
    const day = localDate(d);
    const today = localDate(new Date());
    const label = day === today ? 'Today' : day === addDaysIso(today, -1) ? 'Yesterday' : fmtDate(day, day.slice(0, 4) !== today.slice(0, 4));
    return `${label}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const fileSize = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  // The logo's ring, drawn in the current colour.
  const ringSvg = (cls = '') => raw(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="3.6" pathLength="100" stroke-dasharray="44 6 25 6 13 6" transform="rotate(-90 12 12)"/></svg>`);

  function settingsUpdates() {
    const u = state.updates;
    if (!u) return html`<div class="card"><p class="muted">Couldn't load update details.</p></div>`;
    const main = Boolean(state.me && state.me.main);
    return html`
      ${updMainCard(u, main)}
      <div class="upd-grid">
        ${updNotesCard(u)}
        <div class="upd-side">${updBackupsCard(main)}${updPrefsCard(u, main)}</div>
      </div>`;
  }

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
sudo docker compose up -d --build</pre>`;
      }
    } else if (u.just_updated) {
      s = { mode: 'done', eyebrow: 'Updated', title: `Welcome to v${u.current}`,
        sub: u.just_updated.backup ? 'Everything went smoothly. Your backup is listed under Backups if you ever need it.' : 'Everything went smoothly.',
        primary: ['upd-see-new', "See what's new"], secondary: ['upd-dismiss', 'Dismiss'] };
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
        <span>Channel <b>${channel}</b> · <button class="linkish" data-action="upd-to-prefs">change</button></span>
        <span>Checked <b>${u.checkedAt ? updWhen(u.checkedAt) : 'not yet'}</b> · ${u.auto_check ? 'every 6 hours' : 'automatic checks off'}</span>
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
    const latest = all[0];
    const mine = all.find((r) => r.version === u.current);
    const show = u.available ? [latest, mine].filter(Boolean) : all.slice(0, 2);
    const repo = latest ? latest.url.replace(/\/releases\/.*$/, '/releases') : null;
    const kindLabel = { new: 'New', improved: 'Improved', fixed: 'Fixed' };
    return html`<section class="card upd-notes-card" id="upd-notes">
      <div class="upd-card-head"><div><h3>What's new</h3>
        <p class="upd-card-sub">${u.available ? "What you'll get, plus what's in your current version" : 'Recent releases'}</p></div>
        ${repo ? html`<a href="${repo}" target="_blank" rel="noopener">Full notes on GitHub ↗</a>` : ''}</div>
      ${show.length ? show.map((r) => {
        const items = noteItems(r.notes);
        const badge = r.version === u.current ? html`<span class="upd-badge">Installed</span>`
          : u.available && r === latest ? html`<span class="upd-badge new">Not installed</span>` : '';
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

  function updBackupsCard(main) {
    const b = state.backups;
    const label = (x) => (x.kind === 'manual' ? 'Manual backup' : x.kind === 'restore' ? 'Before a restore' : `Before v${x.version}`);
    return html`<section class="card upd-backups" id="upd-backups">
      <div class="upd-card-head"><div><h3>Backups</h3>
        <p class="upd-card-sub">Made automatically before every update. Kept for the last 5.</p></div>
        ${b && b.available ? html`<button class="linkish" data-action="backup-now">Back up now</button>` : ''}</div>
      ${!b ? html`<p class="muted small">Couldn't load the backups.</p>`
        : !b.available ? html`<p class="muted small">This copy doesn't keep backups on the server. Download one under <a href="#/settings/cycle">General</a> instead.</p>`
        : b.backups.length ? html`<ul class="upd-backup-list">${b.backups.map((x) => html`<li>
            <div><div class="upd-backup-name">${label(x)}</div><div class="upd-card-sub">${updWhen(x.created_at)} · ${fileSize(x.size)}</div></div>
            ${main ? html`<button class="linkish" data-action="backup-restore" data-name="${x.name}" data-when="${fmtDate(localDate(new Date(x.created_at)), true)} at ${new Date(x.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}">Restore</button>` : ''}
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
    return html`<section class="card upd-prefs" id="upd-prefs">
      <h3>Preferences</h3>
      ${row('auto_check', u.auto_check, 'Check for updates automatically', 'Every 6 hours, from GitHub', !main)}
      ${row('beta', u.beta, 'Include beta versions', betaNote, !main || u.beta_locked)}
      ${main ? '' : html`<p class="upd-card-sub" style="margin:8px 0 0">Only the main login can change these.</p>`}
    </section>`;
  }

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
        <p class="muted small">You're logged in as <b>${state.me ? state.me.name : ''}</b>. Changing your password logs this login out on your other devices.</p>
        <div class="row"><button data-action="change-password">Change my password</button><button data-action="logout">Log out on this device</button></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Logins</h2>
          <p class="muted small" style="margin:0">Everyone sees the same budget. Each login has its own password and its own theme.
            There's no username: the password you log in with says who you are.</p></div>
          <button class="primary" data-action="new-login">+ Add login</button></div>
        <ul class="list logins-list">${list.map((l) => html`<li>
          <span class="login-dot" style="--c:${l.colour || 'var(--muted)'}" title="${l.colour ? 'Icon colour' : 'Icon colour: follows the theme'}"></span>
          <div class="grow"><div class="title">${l.name} ${l.you ? html`<span class="chip current">You</span>` : ''} ${l.main ? html`<span class="chip">Main</span>` : ''}</div>
            <div class="meta">${l.main ? 'The original household password. It can be reset from the server if forgotten.' : 'Extra login'}</div></div>
          <div class="row login-btns">
            <button type="button" class="small" data-action="rename-login" data-id="${l.id}">Edit</button>
            ${l.you ? html`<button type="button" class="small" data-action="change-password">Change password</button>`
              : html`<button type="button" class="small" data-action="set-login-password" data-id="${l.id}" data-name="${l.name}">Set password</button>`}
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
          <div class="hint">At least 6 characters, and different from every other login's.</div></div>
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
    </div>`;
  }
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
    'copy-account': (el) => {
      const a = account(Number(el.dataset.id));
      copyText([a.bsb, a.account_number].filter(Boolean).join(' '), 'Bank details');
    },
    'new-expense': (el) => expenseForm(undefined, el.dataset.kind || 'expense'),
    'edit-expense': (el) => { const e = findById(state.data.expenses, el); if (e) expenseForm(e); },
    'new-goal': (el) => goalForm(el.dataset.kind),
    'goal-list': (el) => goalListPopup(el.dataset.kind),
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
    'edit-deposit-rules': () => depositRulesForm(),
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
    'upd-to-prefs': () => document.getElementById('upd-prefs')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    'upd-to-backups': () => document.getElementById('upd-backups')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
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
      await reload();
      state.offset = 0;
      render();
      const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
      toast(`Restored ${total} items`);
      if (result.warnings.length) alert(`Restored, but some items were skipped:\n\n${result.warnings.join('\n')}`);
    } catch (err) {
      alert(`Restore failed: ${err.message}`);
    }
  });

  document.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'cycle-form' && ev.target.id !== 'deposit-form') return;
    ev.preventDefault();
    const f = ev.target.elements;
    try {
      if (ev.target.id === 'cycle-form') {
        await api('PUT', '/settings', { pay_anchor_date: f.pay_anchor_date.value, pay_frequency: f.pay_frequency.value,
          pay_custom_days: f.pay_frequency.value === 'custom' ? Number(f.pay_custom_days.value) : null });
        state.offset = 0;
      } else {
        await api('PUT', '/settings', { rounding: f.rounding.value, buffer_percent: Number(f.buffer_percent.value || 0), held_basis: f.held_basis.value });
      }
      await reload();
      toast('Settings saved');
      render();
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Combo box (see combo()) ----------

  function openCombo(input, showAll) {
    const list = input.parentElement.querySelector('.combo-list');
    const options = JSON.parse(input.dataset.combo || '[]');
    const q = input.value.trim().toLowerCase();
    const exact = options.some((o) => o.toLowerCase() === q);
    const matches = showAll || exact || !q ? options : options.filter((o) => o.toLowerCase().includes(q));
    const items = matches.map((o) => ({ value: o, label: o }));
    if (q && !exact) items.push({ value: input.value.trim(), label: `Add "${input.value.trim()}"`, add: true });
    list.innerHTML = html`${items.map((it) => html`<li role="option" data-value="${it.value}" class="${it.add ? 'add' : ''} ${it.value.toLowerCase() === q ? 'active' : ''}">${it.label}</li>`)}`.s;
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
    return html`
      <div class="page-head sec-head">
        <div><h1>${sec.title}</h1><p class="muted small">${sec.sub}</p></div>
        <button class="primary add-btn" data-action="${t.action}" ${raw(t.kind ? `data-kind="${t.kind}"` : '')} aria-label="${t.add}"><span class="add-full">+ ${t.add}</span><span class="add-short" aria-hidden="true">+</span></button>
      </div>
      <div class="sec-tabs" role="tablist" aria-label="${sec.title}">${Object.entries(sec.tabs).map(([key, x]) => {
        const on = key === tab;
        const bad = x.alert && x.alert();
        return html`<a role="tab" href="#/${name}/${key}" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}">${x.label}<span class="tab-count ${bad || ''}" ${raw(bad ? `title="${bad === 'bad' ? 'Overdue' : 'Due soon'}"` : '')}>${x.count()}</span></a>`;
      })}</div>
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
      if (SECTIONS[page]) out = renderSection(page, sub);
      else if (page === 'overview' && sub === 'analytics') out = await renderAnalytics();
      else if (page === 'settings') {
        if (sub === 'updates' && !state.updates) await loadUpdates();
        if (sub === 'updates' && !state.backups) state.backups = await api('GET', '/backups').catch(() => null);
        if (sub === 'advanced' && !state.advanced) state.advanced = await api('GET', '/advanced');
        if ((sub === 'security' || sub === 'logins') && !state.logins) state.logins = await api('GET', '/logins');
        out = renderSettings(sub);
      }
      else out = await renderOverview();
      if (seq === renderSeq) {
        $app.innerHTML = out.s;
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
      state.logins = null;
      applyTheme(state.me.theme, state.me.custom_theme);
      showMe();
      render();
      // New versions: on start, then every hour (the server itself asks GitHub every few hours).
      loadUpdates();
      if (!state.updateTimer) state.updateTimer = setInterval(() => { if (state.me) loadUpdates(); }, 60 * 60 * 1000);
    } catch (err) {
      if (err.message !== 'Please log in.') $app.innerHTML = html`<div class="card"><p class="error">Could not reach the server: ${err.message}</p></div>`.s;
    }
  }

  start();
})();
