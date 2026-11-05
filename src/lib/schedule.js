// Schedule engine. Schedule: { id, name, days:[0-6 (Sun=0)], startTime:"HH:MM", endTime:"HH:MM", enabled }
// A window with start > end is overnight: it starts on the listed day and ends the next morning.
import { parseHHMM } from './timeutil.js';

const MINUTE = 60_000;
const WEEK_MINUTES = 7 * 24 * 60;

export function normalizeSchedule(input, id) {
  const days = [...new Set((input?.days ?? []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) throw new Error('Select at least one day.');
  const start = parseHHMM(input.startTime);
  const end = parseHHMM(input.endTime);
  if (start === null || end === null) throw new Error('Start and end times must be valid (HH:MM).');
  if (start === end) throw new Error('Start and end times must differ.');
  return {
    id,
    name: String(input.name ?? '').trim().slice(0, 40) || 'Schedule',
    days,
    startTime: input.startTime,
    endTime: input.endTime,
    enabled: input.enabled !== false,
  };
}

function activeAt(s, day, minute) {
  if (!s.enabled) return false;
  const start = parseHHMM(s.startTime);
  const end = parseHHMM(s.endTime);
  if (start < end) return s.days.includes(day) && minute >= start && minute < end;
  return (s.days.includes(day) && minute >= start) || (s.days.includes((day + 6) % 7) && minute < end);
}

function parts(ts) {
  const d = new Date(ts);
  return [d.getDay(), d.getHours() * 60 + d.getMinutes()];
}

export function activeSchedules(schedules, ts) {
  const [day, minute] = parts(ts);
  return schedules.filter((s) => activeAt(s, day, minute));
}

export function isScheduleBlocked(schedules, ts) {
  const [day, minute] = parts(ts);
  return schedules.some((s) => activeAt(s, day, minute));
}

const floorMinute = (ts) => Math.floor(ts / MINUTE) * MINUTE;

/** First minute boundary after ts at which no schedule blocks, or null if none within 8 days. */
export function scheduleBlockEnd(schedules, ts) {
  const base = floorMinute(ts);
  for (let i = 1; i <= WEEK_MINUTES + 1440; i++) {
    const t = base + i * MINUTE;
    if (!isScheduleBlocked(schedules, t)) return t;
  }
  return null;
}

/** Next time the (union) schedule state flips, or null if it never does. */
export function nextScheduleTransition(schedules, ts) {
  if (!schedules.some((s) => s.enabled)) return null;
  const base = floorMinute(ts);
  const now = isScheduleBlocked(schedules, base);
  for (let i = 1; i <= WEEK_MINUTES + 1440; i++) {
    const t = base + i * MINUTE;
    if (isScheduleBlocked(schedules, t) !== now) return t;
  }
  return null;
}

/** When not currently blocked: {start, end} of the next blocking period, else null. */
export function nextScheduleStart(schedules, ts) {
  if (!schedules.some((s) => s.enabled)) return null;
  const base = floorMinute(ts);
  for (let i = 1; i <= WEEK_MINUTES + 1440; i++) {
    const t = base + i * MINUTE;
    if (isScheduleBlocked(schedules, t)) return { start: t, end: scheduleBlockEnd(schedules, t) };
  }
  return null;
}

/** Bitmap of blocked minutes across a reference week; used to decide if an edit is stricter. */
export function weeklyCoverage(schedules) {
  const cov = new Uint8Array(WEEK_MINUTES);
  for (const s of schedules) {
    if (!s.enabled) continue;
    for (let day = 0; day < 7; day++) {
      for (let m = 0; m < 1440; m++) if (activeAt(s, day, m)) cov[day * 1440 + m] = 1;
    }
  }
  return cov;
}

/** True if every minute blocked by `before` is still blocked by `after`. */
export function coverageSubset(before, after) {
  const a = weeklyCoverage(before);
  const b = weeklyCoverage(after);
  for (let i = 0; i < a.length; i++) if (a[i] && !b[i]) return false;
  return true;
}
