// Restriction engine: the single source of truth for "is access blocked right now, and why".
import { projectState } from './usage.js';
import { nextLocalMidnight } from './timeutil.js';
import { activeSchedules, scheduleBlockEnd, nextScheduleStart, nextScheduleTransition } from './schedule.js';

export function focusEndsAt(state, now) {
  const f = state.focusSession;
  return f?.active && f.endTimestamp > now ? f.endTimestamp : null;
}

/** Blocked if ANY of: focus session, scheduled window, daily allowance exhausted. */
export function evaluate(state, now) {
  const s = projectState(state, now);
  const limit = s.settings.dailyLimitMinutes;
  const used = s.dailyUsage.totalSeconds;
  const reasons = [];

  const focusEnd = focusEndsAt(s, now);
  if (focusEnd) reasons.push({ type: 'focus', until: focusEnd });

  const active = activeSchedules(s.schedules, now);
  if (active.length) {
    reasons.push({
      type: 'schedule',
      until: scheduleBlockEnd(s.schedules, now),
      schedules: active.map(({ name, startTime, endTime }) => ({ name, startTime, endTime })),
    });
  }

  if (limit != null && used >= limit * 60) {
    reasons.push({ type: 'limit', until: nextLocalMidnight(now) });
  }

  const blocked = reasons.length > 0;
  return {
    blocked,
    reasons,
    primary: reasons[0]?.type ?? null,
    accessAt: blocked && reasons.every((r) => r.until != null) ? Math.max(...reasons.map((r) => r.until)) : null,
    usedSeconds: used,
    limitMinutes: limit,
    remainingSeconds: limit == null ? null : Math.max(0, limit * 60 - used),
    nextScheduleStart: active.length ? null : nextScheduleStart(s.schedules, now),
    date: s.dailyUsage.date,
  };
}

/** Earliest future moment the evaluation could change on its own (for the boundary alarm). */
export function nextWakeTime(state, now, isTracking) {
  const s = projectState(state, now);
  const c = [nextLocalMidnight(now)];
  const focusEnd = focusEndsAt(s, now);
  if (focusEnd) c.push(focusEnd);
  const sched = nextScheduleTransition(s.schedules, now);
  if (sched) c.push(sched);
  for (const p of s.pendingChanges) c.push(p.effectiveAt);
  const limit = s.settings.dailyLimitMinutes;
  if (isTracking && limit != null) c.push(now + Math.max(0, limit * 60 - s.dailyUsage.totalSeconds) * 1000);
  return Math.min(...c.filter((t) => t > now));
}
