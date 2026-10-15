'use strict';

// Server settings that can be changed in the app (Settings → Advanced) or set
// in .env. Anything set in .env wins and shows as locked in the app, so a
// setup that already works through .env keeps working exactly as before.

const express = require('express');
const { getSetting, setSetting, transaction } = require('./db');

const DEFAULT_REPO = 'kirtangl/Simple-Budget';

// key: [the .env variable, the settings-table key]
const KEYS = {
  allowed_hosts: ['ALLOWED_HOSTS', 'adv_allowed_hosts'],
  trust_proxy: ['TRUST_PROXY', 'adv_trust_proxy'],
  secure_cookies: ['SECURE_COOKIES', 'adv_secure_cookies'],
  app_channel: ['APP_CHANNEL', 'adv_app_channel'],
  update_repo: ['UPDATE_REPO', 'adv_update_repo'],
  github_token: ['GITHUB_TOKEN', 'adv_github_token'],
};

// The value .env gives, or undefined. SECURE_COOKIES=false (the old example
// file's line) counts as not set, so it can still be turned on in the app.
function fromEnv(key) {
  const v = String(process.env[KEYS[key][0]] ?? '').trim();
  if (!v) return undefined;
  if (key === 'secure_cookies') return v === 'true' ? 'true' : undefined;
  return v;
}

const splitHosts = (v) => String(v || '').split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);

class ConfigError extends Error {}

// Each setting's check: returns the value to store ('' for off), or throws.
const CHECKS = {
  allowed_hosts(v) {
    const hosts = splitHosts(v);
    if (hosts.length > 20) throw new ConfigError('Up to 20 addresses, please.');
    for (const h of hosts) {
      if (h !== '*' && !/^\.?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(h)) throw new ConfigError(`"${h}" doesn't look like a web address, like budget.example.com.`);
    }
    return hosts.join(', ');
  },
  trust_proxy(v) {
    const s = String(v ?? '').trim();
    if (!s || s === 'false') return '';
    try { express().set('trust proxy', /^\d+$/.test(s) ? Number(s) : s === 'true' ? true : s); } catch {
      throw new ConfigError("The proxy should be its address (like 172.18.0.1), a range (172.18.0.0/16), or a number of proxies (1).");
    }
    return s;
  },
  secure_cookies: (v) => (v === true || v === 'true' ? 'true' : ''),
  app_channel(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!['', 'test', 'beta'].includes(s)) throw new ConfigError('The tag should be none, Test or Beta.');
    return s;
  },
  update_repo(v) {
    const s = String(v ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (s && !/^[\w.-]+\/[\w.-]+$/.test(s)) throw new ConfigError('The repository should look like owner/name.');
    return s === DEFAULT_REPO ? '' : s;
  },
  github_token(v) {
    const s = String(v ?? '').trim();
    if (s && !/^[\w-]{10,300}$/.test(s)) throw new ConfigError("That doesn't look like a GitHub token.");
    return s;
  },
};

function createConfig(db) {
  // Saved values are kept in memory (the Host check runs on every request); .env is read each time.
  let saved = null;
  const load = () => {
    saved = Object.fromEntries(Object.keys(KEYS).map((key) => [key, getSetting(db, KEYS[key][1]) || '']));
    return saved;
  };
  const get = (key) => fromEnv(key) ?? (saved || load())[key];

  return {
    get,
    allowedHosts: () => splitHosts(get('allowed_hosts')),
    trustProxy() {
      const v = get('trust_proxy');
      if (!v || v === 'false') return false;
      // "true" trusts proxies on this machine or the home network only. Trusting any address
      // would let a visitor pick their own address and dodge the login limit.
      if (v === 'true') return 'loopback, linklocal, uniquelocal';
      return /^\d+$/.test(v) ? Number(v) : v;
    },
    secureCookies: () => get('secure_cookies') === 'true',
    channel() { const c = String(get('app_channel')).toLowerCase(); return ['test', 'beta'].includes(c) ? c : ''; },
    updateRepo: () => get('update_repo') || DEFAULT_REPO,
    githubToken: () => get('github_token'),
    // Which settings come from .env, and so can't be changed in the app.
    locked: () => Object.fromEntries(Object.keys(KEYS).map((k) => [k, fromEnv(k) !== undefined])),
    // Check every change first, then save them together. Returns the keys that changed.
    update(changes) {
      const out = {};
      for (const [key, value] of Object.entries(changes || {})) {
        if (!Object.hasOwn(CHECKS, key)) continue;
        if (fromEnv(key) !== undefined) throw new ConfigError(`${KEYS[key][0]} is set in .env, so it can only be changed there.`);
        out[key] = CHECKS[key](value);
      }
      transaction(db, () => { for (const [key, v] of Object.entries(out)) setSetting(db, KEYS[key][1], v); });
      load();
      return Object.keys(out);
    },
  };
}

module.exports = { createConfig, ConfigError, splitHosts };
