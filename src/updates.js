'use strict';

// Checks GitHub for a newer release of the app. A release copy only looks at
// full releases; a test or beta copy also looks at pre-releases (0.6.0-beta.1).
// A private fork can give a read-only token (GITHUB_TOKEN) so the server can
// see its releases. Results are kept in memory and refreshed every few
// hours, or straight away when someone presses "Check now".

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// An install problem, with the HTTP status to answer with.
class UpdateError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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

// `prefs()` gives { autoCheck, beta }, the household's choices in Settings →
// Updates (beta is null when not chosen). `info()` adds to what the page is sent.
// `settings()` gives { channel, repo, token }, read on every check so they can
// change while the app runs (Settings → Advanced). Fixed values work too.
// `updater()` gives { url, token, imageTag } for the updater container
// (Watchtower) that installs new versions; with no url, updates are installed
// by hand. imageTag is the IMAGE_TAG the copy runs, which decides what the
// updater can install, so it also decides which releases are offered.
function createUpdates({ version, channel, repo, token, settings, updater = () => ({}), prefs = () => ({}), info = () => ({}), fetchImpl = globalThis.fetch }) {
  const current = settings || (() => ({ channel, repo, token }));
  let installing = null; // { version, started_at } once an install has been asked for

  // Which releases this copy follows: "releases" (full releases), "beta" (pre-releases
  // too), or "pinned" (IMAGE_TAG is a fixed version, so Update now can't move it).
  function track() {
    const { url, imageTag } = updater();
    if (url) {
      const tag = String(imageTag || 'latest').trim().toLowerCase();
      if (tag === 'beta') return 'beta';
      return tag === 'latest' ? 'releases' : 'pinned';
    }
    // Updated by hand, so any release can be installed: "Include beta versions"
    // decides, or the build tag when it hasn't been chosen.
    const { beta } = prefs();
    if (beta === true || beta === false) return beta ? 'beta' : 'releases';
    const { channel: c } = current();
    return c === 'beta' || c === 'test' ? 'beta' : 'releases';
  }
  const EMPTY = { checkedAt: null, latest: null, releases: [], error: null };
  let state = EMPTY;
  let running = null;

  async function check() {
    if (running) return running;
    const { channel, repo, token } = current();
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
        const wantPre = track() === 'beta';
        const usable = releases.filter((r) => !r.draft && (wantPre || !r.prerelease) && parseVersion(r.tag_name));
        usable.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
        const tidy = (r) => ({
          version: r.tag_name.replace(/^v/, ''), name: r.name || r.tag_name, notes: r.body || '',
          url: /^https:\/\/github\.com\//.test(r.html_url || '') ? r.html_url : `https://github.com/${repo}/releases`,
          published_at: r.published_at, prerelease: Boolean(r.prerelease),
        });
        const list = usable.slice(0, 10).map(tidy);
        // The installed version's notes too, even if it's a beta no longer offered.
        const mine = releases.find((r) => !r.draft && parseVersion(r.tag_name) && compareVersions(r.tag_name, version) === 0);
        if (mine && !list.some((r) => r.version === tidy(mine).version)) list.push(tidy(mine));
        state = {
          checkedAt: new Date().toISOString(),
          error: null,
          latest: list[0] || null,
          releases: list,
          behind: usable.filter((r) => compareVersions(r.tag_name, version) > 0).length,
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
    ...info(),
    current: version,
    channel: current().channel,
    checkedAt: state.checkedAt,
    error: state.error,
    latest: state.latest,
    releases: state.releases,
    behind: state.behind || 0,
    auto_check: prefs().autoCheck !== false,
    // With the updater, IMAGE_TAG decides (it's what gets pulled), so the switch can't.
    beta: track() === 'beta',
    beta_locked: Boolean(updater().url),
    available: Boolean(state.latest && compareVersions(state.latest.version, version) > 0),
    can_install: Boolean(updater().url) && track() !== 'pinned',
    track: track(),
    image_tag: updater().url ? String(updater().imageTag || 'latest') : null,
    installing,
  });

  // Ask the updater to pull the new image and restart the app on it. It answers
  // straight away and does the work in the background, restarting this app.
  // `backup(version)` saves a copy of the data first and returns its name.
  async function install({ backup } = {}) {
    const { url, token: updaterToken } = updater();
    if (!url) throw new UpdateError(400, "This copy can't update itself. Update it from the terminal instead.");
    if (track() === 'pinned') throw new UpdateError(400, `This copy is kept on ${updater().imageTag} by IMAGE_TAG in .env. Change it to latest (or beta) to update.`);
    if (!view().available) throw new UpdateError(400, "You're already on the latest version.");
    const target = state.latest.version;
    const saved = backup ? backup(target) : null;
    let res;
    try {
      res = await fetchImpl(`${url.replace(/\/$/, '')}/v1/update?async=true`, {
        method: 'POST',
        headers: updaterToken ? { Authorization: `Bearer ${updaterToken}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new UpdateError(502, "Couldn't reach the updater. Check its container is running (sudo docker compose up -d).");
    }
    if (res.status === 429) throw new UpdateError(409, 'An update is already running. Give it a minute.');
    if (res.status === 401 || res.status === 403) throw new UpdateError(502, "The updater didn't accept the app's token. UPDATER_TOKEN must be the same for both.");
    if (!res.ok) throw new UpdateError(502, `The updater answered ${res.status}. Try again, or update from the terminal.`);
    installing = { version: target, started_at: new Date().toISOString() };
    return { ok: true, version: target, backup: saved };
  }

  return {
    check,
    view,
    install,
    // Forget the last result, e.g. after the repository or token changes.
    reset() { state = EMPTY; },
    // Check soon after starting, then every few hours, unless that's turned off.
    start() {
      const auto = () => { if (prefs().autoCheck !== false) check(); };
      setTimeout(auto, 5000).unref();
      setInterval(auto, CHECK_EVERY_MS).unref();
    },
    async get(req, res) {
      if (!state.checkedAt && prefs().autoCheck !== false) await check();
      res.json(view());
    },
    async checkNow(req, res) {
      await check();
      res.json(view());
    },
  };
}

module.exports = { createUpdates, compareVersions, parseVersion, UpdateError };
