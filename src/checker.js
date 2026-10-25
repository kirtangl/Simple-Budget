'use strict';

// Talks to the price-checker (the separate container that looks up supermarket prices, see
// price-checker/ and the README), at PRICE_CHECKER_URL with PRICE_CHECKER_TOKEN. Without a URL
// there's no checker, and the app leaves automatic prices out.

class CheckerError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function createChecker({ url = process.env.PRICE_CHECKER_URL, token = process.env.PRICE_CHECKER_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  const base = url ? String(url).replace(/\/+$/, '') : null;

  async function call(method, path, body, { raw = false } = {}) {
    if (!base) throw new CheckerError('Automatic prices are not set up.', 400);
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { authorization: `Bearer ${token || ''}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20e3),
      });
    } catch {
      throw new CheckerError("Couldn't reach the price-checker. Check that its container is running.");
    }
    if (res.status === 401) throw new CheckerError("The price-checker didn't accept the password. PRICE_CHECKER_TOKEN should be the same for both.");
    if (raw && res.ok) return res;
    let data = null;
    try { data = await res.json(); } catch { /* none */ }
    if (!res.ok) throw new CheckerError((data && data.error) || `The price-checker answered ${res.status}.`, res.status === 404 || res.status === 409 ? res.status : 502);
    return data;
  }

  return {
    on: Boolean(base),
    // Whether it's running and takes the token: /health answers anyone, a made-up job needs the token.
    async status() {
      if (!base) return { set_up: false };
      let health;
      try { health = await call('GET', '/health'); } catch (err) { return { set_up: true, reachable: false, error: err.message }; }
      let tokenOk = true;
      try { await call('GET', '/jobs/status-check'); } catch (err) { if (err.status !== 404) tokenOk = false; }
      return { set_up: true, reachable: true, token_ok: tokenOk, busy: Boolean(health && health.busy) };
    },
    start: (job) => call('POST', '/jobs', job),
    get: (id) => call('GET', `/jobs/${encodeURIComponent(id)}`),
    cancel: (id) => call('POST', `/jobs/${encodeURIComponent(id)}/cancel`, {}),
    skip: (id, store) => call('POST', `/jobs/${encodeURIComponent(id)}/skip`, { store }),
    async screen(store) {
      const res = await call('GET', `/screen/${encodeURIComponent(store)}`, undefined, { raw: true });
      return { image: Buffer.from(await res.arrayBuffer()), width: Number(res.headers.get('x-width')) || null, height: Number(res.headers.get('x-height')) || null };
    },
    input: (store, ev) => call('POST', `/input/${encodeURIComponent(store)}`, ev),
    // A store's product picture, fetched by the checker: { type, body }.
    async image(url) {
      const res = await call('GET', `/image?url=${encodeURIComponent(url)}`, undefined, { raw: true });
      return { type: res.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

module.exports = { createChecker, CheckerError };
