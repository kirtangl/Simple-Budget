'use strict';

// The bell in the top bar: notices the app posts for the household (a backup that failed, an
// update that was installed, and later deleted data and price checker alerts). Each is for
// everyone (login_id null) or for one login. Notices older than 90 days are tidied away.

const express = require('express');

const KINDS = ['info', 'warning', 'alert', 'deleted'];
// How serious each kind is, for the bell's dot: the most serious unread one sets its colour.
const RANK = { info: 1, warning: 2, alert: 3, deleted: 3 };
const KEEP_DAYS = 90;
const PAGE = 50;

// A route inside the app, like "#/settings/updates". Anything else is left off.
const linkOf = (v) => (typeof v === 'string' && /^#\/[\w/-]{0,120}$/.test(v) ? v : null);
const text = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

// Posts a notice. kind is info, warning, alert or deleted; link is an app route.
function notify(db, { kind = 'info', title, body = null, link = null, login_id: loginId = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown notice kind: ${kind}`);
  const t = text(title, 120);
  if (!t) throw new Error('A notice needs a title.');
  const { lastInsertRowid } = db.prepare('INSERT INTO notifications (created_at, kind, title, body, link, login_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), kind, t, text(body, 600) || null, linkOf(link), Number.isInteger(loginId) ? loginId : null);
  return Number(lastInsertRowid);
}

// The same, for places where a notice mustn't stop what they're doing (a failed backup).
function tryNotify(db, notice) {
  try { return notify(db, notice); } catch (err) { console.error('Could not post a notice:', err.message); return null; }
}

function cleanUp(db) {
  const before = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM notifications WHERE created_at < ?').run(before);
}

// What one login sees: their own notices and everyone's, until cleared.
const MINE = '(login_id IS NULL OR login_id = ?) AND cleared_at IS NULL';

// For the bell's dot: how many are unread, and the most serious of them.
function unread(db, loginId) {
  const rows = db.prepare(`SELECT kind, count(*) AS n FROM notifications WHERE ${MINE} AND read_at IS NULL GROUP BY kind`).all(loginId);
  const count = rows.reduce((s, r) => s + r.n, 0);
  const top = rows.reduce((best, r) => (RANK[r.kind] > (RANK[best] || 0) ? r.kind : best), null);
  return { unread: count, level: top === 'deleted' ? 'alert' : top };
}

function createNotifications(db) {
  cleanUp(db);
  const router = express.Router();
  const me = (req) => req.login.id;
  const view = (req) => {
    const items = db.prepare(`SELECT id, created_at, kind, title, body, link, read_at FROM notifications WHERE ${MINE} ORDER BY created_at DESC, id DESC LIMIT ${PAGE}`).all(me(req));
    return { items, ...unread(db, me(req)) };
  };

  router.get('/', (req, res) => {
    cleanUp(db);
    res.json(view(req));
  });
  router.get('/unread', (req, res) => res.json(unread(db, me(req))));
  // Opening one marks it read.
  router.post('/:id/read', (req, res) => {
    const r = db.prepare(`UPDATE notifications SET read_at = coalesce(read_at, ?) WHERE id = ? AND ${MINE}`).run(new Date().toISOString(), Number(req.params.id), me(req));
    if (!r.changes) return res.status(404).json({ error: "That notice isn't there any more." });
    res.json(view(req));
  });
  router.post('/read', (req, res) => {
    db.prepare(`UPDATE notifications SET read_at = ? WHERE ${MINE} AND read_at IS NULL`).run(new Date().toISOString(), me(req));
    res.json(view(req));
  });
  router.post('/clear', (req, res) => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE notifications SET cleared_at = ?, read_at = coalesce(read_at, ?) WHERE ${MINE}`).run(now, now, me(req));
    res.json(view(req));
  });
  return router;
}

module.exports = { createNotifications, notify, tryNotify, unread, KINDS, KEEP_DAYS };
