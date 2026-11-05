// Cooldown manager + focus manager. Pure state transitions.
//
// Rule: a change that makes restrictions STRICTER applies immediately; one that LOOSENS them is
// queued in state.pendingChanges and applied automatically once its cooldown has elapsed.
// Judgement call vs. the PRD's protected list: adding a website is stricter, so it is immediate.
import { normalizeDomain } from './domain.js';
import { normalizeSchedule, coverageSubset } from './schedule.js';

const uuid = () => globalThis.crypto.randomUUID();
const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);

// ---- Preparation: user input -> normalised atomic changes ---------------------------------

export function prepareChange(state, input) {
  const dom = (v) => {
    const { domain, error } = normalizeDomain(v);
    if (error) throw new Error(error);
    return domain;
  };
  switch (input?.type) {
    case 'addDomain':
      return [{ type: 'addDomain', domain: dom(input.value) }];
    case 'removeDomain':
      return [{ type: 'removeDomain', domain: dom(input.value) }];
    case 'editDomain': {
      const from = dom(input.from);
      const to = dom(input.to);
      if (from === to) throw new Error('The domain is unchanged.');
      return [{ type: 'addDomain', domain: to }, { type: 'removeDomain', domain: from }];
    }
    case 'setDailyLimit':
      return [{ type: 'setDailyLimit', minutes: input.minutes === null ? null : int(input.minutes) }];
    case 'setCooldown':
      return [{ type: 'setCooldown', minutes: int(input.minutes) }];
    case 'addSchedule':
      return [{ type: 'addSchedule', schedule: normalizeSchedule(input.schedule, uuid()) }];
    case 'updateSchedule':
      return [{ type: 'updateSchedule', schedule: normalizeSchedule(input.schedule, String(input.id)) }];
    case 'removeSchedule':
      return [{ type: 'removeSchedule', id: String(input.id) }];
    default:
      throw new Error('Unknown change.');
  }
}

function pendingKey(c) {
  return JSON.stringify(c);
}

export function validateAtomic(state, c, { checkPending = false } = {}) {
  if (checkPending && state.pendingChanges.some((p) => pendingKey(p.change) === pendingKey(c))) {
    throw new Error('This change is already pending.');
  }
  const has = (id) => state.schedules.some((s) => s.id === id);
  switch (c.type) {
    case 'addDomain': {
      const cover = state.restrictedDomains.find((d) => c.domain === d || c.domain.endsWith('.' + d));
      if (cover === c.domain) throw new Error(`${c.domain} is already restricted.`);
      if (cover) throw new Error(`${c.domain} is already covered by ${cover}.`);
      break;
    }
    case 'removeDomain':
      if (!state.restrictedDomains.includes(c.domain)) throw new Error(`${c.domain} is not in your list.`);
      break;
    case 'setDailyLimit':
      if (c.minutes !== null && !(c.minutes >= 1 && c.minutes <= 1440)) throw new Error('Enter 1–1440 minutes.');
      if (c.minutes === state.settings.dailyLimitMinutes) throw new Error('That is already the daily allowance.');
      break;
    case 'setCooldown':
      if (!(c.minutes >= 1 && c.minutes <= 1440)) throw new Error('Cooldown must be 1–1440 minutes.');
      if (c.minutes === state.settings.cooldownMinutes) throw new Error('That is already the cooldown.');
      break;
    case 'addSchedule':
      if (has(c.schedule.id)) throw new Error('Schedule already exists.');
      break;
    case 'updateSchedule':
      if (!has(c.schedule.id)) throw new Error('Schedule not found.');
      break;
    case 'removeSchedule':
      if (!has(c.id)) throw new Error('Schedule not found.');
      break;
    default:
      throw new Error('Unknown change.');
  }
}

function schedulesAfter(state, c) {
  switch (c.type) {
    case 'addSchedule':
      return [...state.schedules, c.schedule];
    case 'updateSchedule':
      return state.schedules.map((s) => (s.id === c.schedule.id ? c.schedule : s));
    case 'removeSchedule':
      return state.schedules.filter((s) => s.id !== c.id);
    default:
      return state.schedules;
  }
}

export function isStricter(state, c) {
  switch (c.type) {
    case 'addDomain':
      return true;
    case 'removeDomain':
      return false;
    case 'setDailyLimit': {
      const cur = state.settings.dailyLimitMinutes;
      return c.minutes !== null && (cur == null || c.minutes < cur);
    }
    case 'setCooldown':
      return c.minutes > state.settings.cooldownMinutes;
    default:
      // Schedules: stricter only if no previously blocked minute becomes unblocked.
      return coverageSubset(state.schedules, schedulesAfter(state, c));
  }
}

export function applyChange(state, c) {
  switch (c.type) {
    case 'addDomain':
      state.restrictedDomains = [...state.restrictedDomains, c.domain].sort();
      break;
    case 'removeDomain':
      state.restrictedDomains = state.restrictedDomains.filter((d) => d !== c.domain);
      break;
    case 'setDailyLimit':
      state.settings.dailyLimitMinutes = c.minutes;
      break;
    case 'setCooldown':
      state.settings.cooldownMinutes = c.minutes;
      break;
    default:
      state.schedules = schedulesAfter(state, c);
  }
}

export function describe(c) {
  const t = (s) => `${s.name} (${s.startTime}–${s.endTime})`;
  switch (c.type) {
    case 'addDomain':
      return `Restrict ${c.domain}`;
    case 'removeDomain':
      return `Stop restricting ${c.domain}`;
    case 'setDailyLimit':
      return c.minutes === null ? 'Remove the daily allowance' : `Set daily allowance to ${c.minutes} min`;
    case 'setCooldown':
      return `Set cooldown to ${c.minutes} min`;
    case 'addSchedule':
      return `Add schedule ${t(c.schedule)}`;
    case 'updateSchedule':
      return `Change schedule ${t(c.schedule)}`;
    case 'removeSchedule':
      return 'Delete a schedule';
    default:
      return 'Change settings';
  }
}

/**
 * Validates and applies/queues a user request. Throws Error(message) on invalid input.
 * With dryRun nothing is mutated; the result shows what would happen (used for confirmation).
 */
export function proposeChange(state, input, now, { dryRun = false } = {}) {
  const atoms = prepareChange(state, input);
  for (const a of atoms) validateAtomic(state, a, { checkPending: true });
  const result = { applied: [], pending: [] };
  for (const a of atoms) {
    if (isStricter(state, a)) {
      if (!dryRun) applyChange(state, a);
      result.applied.push(describe(a));
    } else {
      const p = {
        id: uuid(),
        change: a,
        description: describe(a),
        requestedAt: now,
        effectiveAt: now + state.settings.cooldownMinutes * 60_000,
      };
      if (!dryRun) state.pendingChanges.push(p);
      result.pending.push(p);
    }
  }
  return result;
}

export function cancelPending(state, id) {
  const before = state.pendingChanges.length;
  state.pendingChanges = state.pendingChanges.filter((p) => p.id !== id);
  return state.pendingChanges.length !== before;
}

/** Applies every pending change whose cooldown has elapsed (also catches up after Chrome was closed). */
export function applyDuePending(state, now) {
  const due = state.pendingChanges.filter((p) => p.effectiveAt <= now).sort((a, b) => a.effectiveAt - b.effectiveAt);
  if (!due.length) return false;
  state.pendingChanges = state.pendingChanges.filter((p) => p.effectiveAt > now);
  for (const p of due) {
    try {
      validateAtomic(state, p.change);
      applyChange(state, p.change);
    } catch {
      /* no longer applicable (e.g. already removed) - drop it */
    }
  }
  return true;
}

// ---- Focus manager -------------------------------------------------------------------------

export function startFocus(state, minutes, now) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) throw new Error('Choose 1–720 minutes.');
  const f = state.focusSession;
  if (f.active && f.endTimestamp > now) throw new Error('A focus session is already running.');
  state.focusSession = {
    active: true,
    startTimestamp: now,
    endTimestamp: now + minutes * 60_000,
    durationMinutes: minutes,
  };
}

/** Moves a finished session into history. There is deliberately no early-cancel function. */
export function expireFocus(state, now) {
  const f = state.focusSession;
  if (!f.active || f.endTimestamp > now) return false;
  state.focusHistory = [
    ...state.focusHistory,
    { startTimestamp: f.startTimestamp, endTimestamp: f.endTimestamp, durationMinutes: f.durationMinutes },
  ].slice(-100);
  state.focusSession = { active: false, startTimestamp: null, endTimestamp: null, durationMinutes: null };
  return true;
}
