'use strict';

// Copies of the whole database in <data>/backups, listed in Settings → Updates.
//   budget-before-v0.7.1-<time>.db    made before an update (the newest 5, 10 or 20 kept,
//   budget-before-restore-<time>.db   with the ones made before a restore)
//   budget-manual-<time>.db           made with "Back up now" (up to 20, kept until deleted)
// Restoring one puts back the budget itself. Logins, passwords and the app's own
// settings stay as they are now, so nobody is logged out or locked out.

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, transaction } = require('./db');
const { BACKUP_SETTINGS } = require('./api');

const MAX_MANUAL = 20; // so a page pressing "Back up now" in a loop can't fill the disk
const NAME = /^budget-(?:before-(v.+|restore)|manual)-(\d{4}-\d\d-\d\dT[\d-]+)\.db$/;

class BackupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// keep() is how many automatic backups to keep (Settings → Updates → Preferences).
function createBackups({ db, dataDir, keep = () => 5 }) {
  const dir = dataDir ? path.join(dataDir, 'backups') : null;

  function list() {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((name) => {
      const m = NAME.exec(name);
      if (!m) return null;
      const stat = fs.statSync(path.join(dir, name));
      const kind = !m[1] ? 'manual' : m[1] === 'restore' ? 'restore' : 'update';
      return { name, kind, version: kind === 'update' ? m[1].slice(1) : null, created_at: stat.mtime.toISOString(), size: stat.size };
    }).filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.name.localeCompare(a.name));
  }

  // kind: 'update' (with the version about to be installed), 'restore' or 'manual'.
  // `keepName` is never tidied away, so restoring the oldest backup doesn't delete it.
  function create(kind, version, { keepName = null } = {}) {
    if (!dir) throw new BackupError(400, "This copy doesn't keep backups on the server.");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const what = kind === 'manual' ? 'manual' : kind === 'restore' ? 'before-restore' : `before-v${String(version).replace(/[^\w.-]/g, '')}`;
    if (kind === 'manual' && list().filter((b) => b.kind === 'manual').length >= MAX_MANUAL) {
      throw new BackupError(409, `There are already ${MAX_MANUAL} backups made by hand. Delete an older one first.`);
    }
    const name = `budget-${what}-${stamp}.db`;
    db.exec(`VACUUM INTO '${path.join(dir, name).replace(/'/g, "''")}'`);
    // A backup holds the logins' password hashes, so only the app can read it.
    try { fs.chmodSync(path.join(dir, name), 0o600); } catch { /* e.g. a share that has no file permissions */ }
    for (const old of list().filter((b) => b.kind !== 'manual' && b.name !== keepName).slice(keep())) {
      fs.rmSync(path.join(dir, old.name), { force: true });
    }
    return name;
  }

  function restore(name) {
    if (!dir || typeof name !== 'string' || !NAME.test(name) || !list().some((b) => b.name === name)) {
      throw new BackupError(404, "That backup isn't there any more.");
    }
    // Bring a copy up to date first, so a backup from an older version fits this one.
    const work = path.join(dir, `.restoring-${Date.now()}.db`);
    const cleanup = () => { for (const f of [work, `${work}-wal`, `${work}-shm`]) fs.rmSync(f, { force: true }); };
    let saved;
    try {
      fs.copyFileSync(path.join(dir, name), work);
      const ours = db.prepare('PRAGMA user_version').get().user_version;
      let looksRight; let theirs;
      try {
        const probe = openDatabase(work);
        looksRight = probe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'settings'").get().n > 0;
        theirs = probe.prepare('PRAGMA user_version').get().user_version;
        probe.close();
      } catch {
        throw new BackupError(400, "That backup can't be opened. It may be damaged.");
      }
      if (!looksRight) throw new BackupError(400, "That file doesn't look like a Simple Budget backup.");
      if (theirs > ours) throw new BackupError(400, 'That backup was made by a newer version of Simple Budget. Update the app, then try again.');
      saved = create('restore', null, { keepName: name });
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('ATTACH DATABASE ? AS r').run(work);
      try {
        transaction(db, () => {
          const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('settings', 'logins')").all().map((t) => t.name);
          for (const t of tables) {
            const theirCols = new Set(db.prepare(`PRAGMA r.table_info("${t}")`).all().map((c) => c.name));
            const cols = db.prepare(`PRAGMA main.table_info("${t}")`).all().map((c) => c.name).filter((c) => theirCols.has(c));
            db.exec(`DELETE FROM main."${t}"`);
            if (cols.length) {
              const list = cols.map((c) => `"${c}"`).join(', ');
              db.exec(`INSERT INTO main."${t}" (${list}) SELECT ${list} FROM r."${t}"`);
            }
          }
          // The budget's own settings (pay cycle, rounding...) come back too.
          const keys = BACKUP_SETTINGS.map((k) => `'${k}'`).join(', ');
          db.exec(`DELETE FROM main.settings WHERE key IN (${keys})`);
          db.exec(`INSERT INTO main.settings (key, value) SELECT key, value FROM r.settings WHERE key IN (${keys})`);
        });
      } finally {
        db.exec('DETACH DATABASE r');
        db.exec('PRAGMA foreign_keys = ON');
      }
    } finally {
      cleanup();
    }
    return { ok: true, restored: name, backup: saved };
  }

  // Deletes one listed backup, e.g. an old manual one.
  function remove(name) {
    if (!dir || typeof name !== 'string' || !NAME.test(name) || !list().some((b) => b.name === name)) {
      throw new BackupError(404, "That backup isn't there any more.");
    }
    fs.rmSync(path.join(dir, name), { force: true });
  }

  return { dir, list, create, restore, remove };
}

module.exports = { createBackups, BackupError };
