'use strict';

// Checks GitHub for a newer release of the app. A release copy only looks at
// full releases; a test or beta copy also looks at pre-releases (0.6.0-beta.1).
// A private fork can give a read-only token (GITHUB_TOKEN) so the server can
// see its releases. Results are kept in memory and refreshed every few
// hours, or straight away when someone presses "Check now".

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// "v1.2.3-beta.4" → { nums: [1, 2, 3], pre: ['beta', 4] }, or null.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

// Negative when a is older than b. A pre-release comes before its release.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function createUpdates({ version, channel, repo, token, fetchImpl = globalThis.fetch }) {
  let state = { checkedAt: null, latest: null, error: null };
  let running = null;

  async function check() {
    if (running) return running;
    const p = (async () => {
      try {
        const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
          signal: AbortSignal.timeout(20_000),
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'simple-budget',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.status === 404 || res.status === 401) {
          throw new Error(token ? "GitHub didn't accept the token, or it can't see the repository."
            : "Couldn't find the repository on GitHub. For a private one, add a read-only GITHUB_TOKEN to .env.");
        }
        if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`);
        const releases = await res.json();
        const wantPre = channel === 'beta' || channel === 'test';
        const usable = releases.filter((r) => !r.draft && (wantPre || !r.prerelease) && parseVersion(r.tag_name));
        usable.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
        const top = usable[0];
        state = {
          checkedAt: new Date().toISOString(),
          error: null,
          latest: top ? {
            version: top.tag_name.replace(/^v/, ''), name: top.name || top.tag_name, notes: top.body || '',
            url: /^https:\/\/github\.com\//.test(top.html_url || '') ? top.html_url : `https://github.com/${repo}/releases`,
            published_at: top.published_at, prerelease: Boolean(top.prerelease),
          } : null,
        };
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        state = { ...state, checkedAt: new Date().toISOString(), error: timedOut ? 'GitHub took too long to answer. Try again later.' : (err.message || 'Could not reach GitHub.') };
      }
      return state;
    })();
    running = p;
    p.finally(() => { if (running === p) running = null; });
    return p;
  }

  const view = () => ({
    current: version,
    channel,
    checkedAt: state.checkedAt,
    error: state.error,
    latest: state.latest,
    available: Boolean(state.latest && compareVersions(state.latest.version, version) > 0),
  });

  return {
    check,
    view,
    // Check soon after starting, then every few hours.
    start() {
      setTimeout(check, 5000).unref();
      setInterval(check, CHECK_EVERY_MS).unref();
    },
    async get(req, res) {
      if (!state.checkedAt) await check();
      res.json(view());
    },
    async checkNow(req, res) {
      await check();
      res.json(view());
    },
  };
}

module.exports = { createUpdates, compareVersions, parseVersion };
