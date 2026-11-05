// Persistent state shape, defaults and migrations.
import { localDateKey, currentTimezone } from './timeutil.js';

export const SCHEMA_VERSION = 1;

export function emptyUsage(date) {
  return { date, totalSeconds: 0, byDomain: {}, blocks: 0 };
}

export function defaultState(now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { dailyLimitMinutes: 60, cooldownMinutes: 15, timezone: currentTimezone() },
    restrictedDomains: [],
    schedules: [],
    dailyUsage: emptyUsage(localDateKey(now)),
    history: [], // archived days: {date,totalSeconds,byDomain,blocks}
    focusSession: { active: false, startTimestamp: null, endTimestamp: null, durationMinutes: null },
    focusHistory: [], // {startTimestamp,endTimestamp,durationMinutes}
    pendingChanges: [], // {id,change,description,requestedAt,effectiveAt}
    tracking: null, // {domain, since} - the single in-flight usage segment
  };
}

/** Fills in anything missing so older/partial stored data never crashes the worker. */
export function migrate(raw, now = Date.now()) {
  const base = defaultState(now);
  if (!raw || typeof raw !== 'object') return base;
  const s = {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    focusSession: { ...base.focusSession, ...(raw.focusSession ?? {}) },
    dailyUsage: { ...base.dailyUsage, ...(raw.dailyUsage ?? {}) },
  };
  s.schemaVersion = SCHEMA_VERSION;
  return s;
}
