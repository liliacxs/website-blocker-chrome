// Usage accounting. Exactly one in-flight segment exists: state.tracking = {domain, since}.
//
// Crash/suspension safety: every checkpoint (events + a 30s alarm) closes the segment and opens a
// new one at `now`. If a segment is found older than MAX_GAP_MS the worker (or Chrome, or the
// machine) was not running, so that unverified time is NOT counted.
//
// Clock safety: the usage date only ever moves forward, so setting the clock back never
// reopens a spent allowance; negative elapsed time is never credited.
import { localDateKey, nextLocalMidnight } from './timeutil.js';
import { emptyUsage } from './state.js';

export const MAX_GAP_MS = 90_000;
export const HISTORY_LIMIT = 400;

/** Archives the finished day and starts a fresh one if `now` is on a later date. */
export function rollover(state, now) {
  const today = localDateKey(now);
  const u = state.dailyUsage;
  if (today <= u.date) return false;
  if (u.totalSeconds > 0 || u.blocks > 0) {
    state.history = state.history.filter((h) => h.date !== u.date);
    state.history.push({ date: u.date, totalSeconds: u.totalSeconds, byDomain: u.byDomain, blocks: u.blocks });
    state.history = state.history.slice(-HISTORY_LIMIT);
  }
  state.dailyUsage = emptyUsage(today);
  return true;
}

function credit(state, domain, seconds) {
  if (!(seconds > 0)) return;
  const u = state.dailyUsage;
  u.totalSeconds += seconds;
  u.byDomain[domain] = (u.byDomain[domain] ?? 0) + seconds;
}

/** Closes the in-flight segment (crediting verified time) and applies the daily rollover. */
export function settleTracking(state, now) {
  const t = state.tracking;
  state.tracking = null;
  if (t) {
    const gap = now - t.since;
    if (gap > 0 && gap <= MAX_GAP_MS) {
      rollover(state, t.since);
      const midnight = nextLocalMidnight(t.since);
      if (now > midnight && localDateKey(now) > state.dailyUsage.date) {
        credit(state, t.domain, (midnight - t.since) / 1000);
        rollover(state, now);
        credit(state, t.domain, (now - midnight) / 1000);
      } else {
        credit(state, t.domain, gap / 1000);
      }
    }
  }
  rollover(state, now);
}

/** Read-only view of the state as it would be after settling at `now`. Never mutates `state`. */
export function projectState(state, now) {
  const s = {
    ...state,
    dailyUsage: structuredClone(state.dailyUsage),
    history: [...state.history],
    tracking: state.tracking,
  };
  settleTracking(s, now);
  return s;
}
