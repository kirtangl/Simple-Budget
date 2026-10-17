'use strict';

// When to visit the stores' home pages, so the browser's cookies stay those of a regular visitor:
// twice a week, once some time Monday to Wednesday and once Thursday to Sunday, at a random time
// between 8am and 9pm (the server's own time zone).

const HALVES = [[1, 2, 3], [4, 5, 6, 0]]; // days of the week (Sunday is 0)
const FROM = 8;
const TO = 21;

// The windows of one half of the week starting on the Monday of `monday`'s week.
function windows(half, monday) {
  return HALVES[half].map((day) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + ((day + 6) % 7));
    const a = new Date(d); a.setHours(FROM, 0, 0, 0);
    const b = new Date(d); b.setHours(TO, 0, 0, 0);
    return [a.getTime(), b.getTime()];
  });
}

const mondayOf = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};

// The next random time in that half of the week, after `after`.
function nextTime(half, after, random = Math.random) {
  const monday = mondayOf(after);
  for (let week = 0; week < 3; week++) {
    const parts = windows(half, monday).map(([a, b]) => [Math.max(a, after + 60e3), b]).filter(([a, b]) => b > a);
    const total = parts.reduce((n, [a, b]) => n + b - a, 0);
    if (total > 0) {
      let at = random() * total;
      for (const [a, b] of parts) {
        if (at < b - a) return Math.floor(a + at);
        at -= b - a;
      }
      return parts[parts.length - 1][1] - 1;
    }
    monday.setDate(monday.getDate() + 7);
  }
  return null;
}

// Keeps the two times (one per half of the week) in `state.warmups`, running `warm` when one comes.
// After a visit, the next one in that half is in the week after it. A time that went by while the server
// was off is run once, then moved on.
function tick(state, now, warm, random = Math.random) {
  const at = Array.isArray(state.warmups) ? state.warmups : [];
  let changed = false;
  for (let half = 0; half < HALVES.length; half++) {
    if (typeof at[half] !== 'number') { at[half] = nextTime(half, now, random); changed = true; continue; }
    if (at[half] <= now) {
      warm();
      const monday = mondayOf(at[half]);
      monday.setDate(monday.getDate() + 7);
      at[half] = nextTime(half, Math.max(monday.getTime(), now), random);
      changed = true;
    }
  }
  state.warmups = at;
  return changed;
}

module.exports = { nextTime, tick, HALVES, FROM, TO };
