import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, matchRestricted } from '../src/lib/domain.js';
import { isScheduleBlocked, scheduleBlockEnd, normalizeSchedule } from '../src/lib/schedule.js';
import { settleTracking, rollover, MAX_GAP_MS } from '../src/lib/usage.js';
import { evaluate } from '../src/lib/engine.js';
import { defaultState } from '../src/lib/state.js';
import { nextLocalMidnight, localDateKey } from '../src/lib/timeutil.js';
import { proposeChange, applyDuePending, startFocus, expireFocus, cancelPending } from '../src/lib/changes.js';

// Local-time constructor. 2026-11-04 is a Wednesday, 2026-11-07 a Saturday.
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const sched = (o) => normalizeSchedule({ days: [0, 1, 2, 3, 4, 5, 6], enabled: true, ...o }, o.id ?? 's');

// ---- FR-01 domains ----
test('normalizes domains and URLs', () => {
  assert.equal(normalizeDomain('Reddit.com').domain, 'reddit.com');
  assert.equal(normalizeDomain('https://www.reddit.com/r/all?x=1').domain, 'reddit.com');
  assert.equal(normalizeDomain('münchen.de').domain, 'xn--mnchen-3ya.de');
});
test('rejects invalid domains', () => {
  for (const bad of ['', 'localhost', 'reddit', '192.168.0.1', 'a b.com', 'ftp://x.com', '-x.com', 'x.c']) {
    assert.ok(normalizeDomain(bad).error, `should reject ${bad}`);
  }
});
test('matches subdomains but not lookalikes', () => {
  const d = ['reddit.com'];
  assert.equal(matchRestricted('https://old.reddit.com/x', d), 'reddit.com');
  assert.equal(matchRestricted('http://www.reddit.com', d), 'reddit.com');
  assert.equal(matchRestricted('https://notreddit.com', d), null);
  assert.equal(matchRestricted('https://reddit.com.evil.io', d), null);
  assert.equal(matchRestricted('chrome://settings', d), null);
});

// ---- FR-02 schedules ----
test('weekday schedule only applies on its days', () => {
  const s = [sched({ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '12:00' })];
  assert.equal(isScheduleBlocked(s, at(2026, 11, 4, 10)), true); // Wed
  assert.equal(isScheduleBlocked(s, at(2026, 11, 4, 12)), false); // end exclusive
  assert.equal(isScheduleBlocked(s, at(2026, 11, 7, 10)), false); // Sat
});
test('overnight schedule crosses midnight', () => {
  const s = [sched({ days: [5], startTime: '22:00', endTime: '07:00' })]; // Friday night
  assert.equal(isScheduleBlocked(s, at(2026, 11, 6, 23)), true); // Fri 23:00
  assert.equal(isScheduleBlocked(s, at(2026, 11, 7, 6, 59)), true); // Sat 06:59
  assert.equal(isScheduleBlocked(s, at(2026, 11, 7, 7)), false);
  assert.equal(isScheduleBlocked(s, at(2026, 11, 7, 23)), false); // Sat night not included
  assert.equal(scheduleBlockEnd(s, at(2026, 11, 6, 23)), at(2026, 11, 7, 7));
});
test('adjacent windows are one continuous block', () => {
  const s = [sched({ id: 'a', startTime: '09:00', endTime: '12:00' }), sched({ id: 'b', startTime: '12:00', endTime: '14:00' })];
  assert.equal(scheduleBlockEnd(s, at(2026, 11, 4, 10)), at(2026, 11, 4, 14));
});
test('disabled schedules never block', () => {
  const s = [sched({ startTime: '00:00', endTime: '23:59', enabled: false })];
  assert.equal(isScheduleBlocked(s, at(2026, 11, 4, 10)), false);
});

// ---- FR-03/04 usage ----
const withDomains = (now) => ({ ...defaultState(now), restrictedDomains: ['reddit.com', 'youtube.com'] });

test('credits verified elapsed time per domain and aggregates globally', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  st.tracking = { domain: 'reddit.com', since: t0 };
  settleTracking(st, t0 + 30_000);
  st.tracking = { domain: 'youtube.com', since: t0 + 30_000 };
  settleTracking(st, t0 + 50_000);
  assert.equal(st.dailyUsage.totalSeconds, 50);
  assert.deepEqual(st.dailyUsage.byDomain, { 'reddit.com': 30, 'youtube.com': 20 });
  assert.equal(st.tracking, null);
});
test('does not count unverified downtime', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  st.tracking = { domain: 'reddit.com', since: t0 };
  settleTracking(st, t0 + MAX_GAP_MS + 1); // worker/browser was gone
  assert.equal(st.dailyUsage.totalSeconds, 0);
});
test('midnight resets usage and archives yesterday', () => {
  const st = withDomains(at(2026, 11, 4, 12));
  st.dailyUsage.totalSeconds = 3600;
  rollover(st, at(2026, 11, 5, 0, 0, 1));
  assert.equal(st.dailyUsage.totalSeconds, 0);
  assert.equal(st.dailyUsage.date, '2026-11-05');
  assert.equal(st.history.at(-1).date, '2026-11-04');
  assert.equal(st.history.at(-1).totalSeconds, 3600);
});
test('a segment spanning midnight is split across both days', () => {
  const mid = at(2026, 11, 5, 0, 0, 0);
  const st = withDomains(mid - 20_000);
  st.tracking = { domain: 'reddit.com', since: mid - 20_000 };
  settleTracking(st, mid + 10_000);
  assert.equal(st.history.at(-1).totalSeconds, 20);
  assert.equal(st.dailyUsage.totalSeconds, 10);
});
test('moving the clock backwards never grants extra allowance', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  st.settings.dailyLimitMinutes = 1;
  st.dailyUsage.totalSeconds = 60;
  rollover(st, at(2026, 11, 3, 10)); // yesterday on the wall clock
  assert.equal(st.dailyUsage.totalSeconds, 60);
  assert.equal(evaluate(st, at(2026, 11, 3, 10)).reasons.some((r) => r.type === 'limit'), true);
  st.tracking = { domain: 'reddit.com', since: t0 };
  settleTracking(st, t0 - 5000); // negative elapsed time
  assert.equal(st.dailyUsage.totalSeconds, 60);
});
test('DST: local midnight handles 23h and 25h days', () => {
  // Differences exist only in zones with DST; assert generic invariants.
  const m = nextLocalMidnight(at(2026, 3, 29, 12));
  assert.equal(localDateKey(m), '2026-03-30');
  assert.equal(new Date(m).getHours(), 0);
  const m2 = nextLocalMidnight(at(2026, 10, 25, 12));
  assert.equal(localDateKey(m2), '2026-10-26');
  assert.equal(new Date(m2).getHours(), 0);
});

// ---- Section 6 restriction priority ----
test('limit reached blocks; scheduled end does not release it', () => {
  const t = at(2026, 11, 4, 12, 0, 30);
  const st = withDomains(t);
  st.schedules = [sched({ startTime: '09:00', endTime: '12:00' })];
  st.dailyUsage.totalSeconds = 3600;
  const e = evaluate(st, t);
  assert.equal(e.blocked, true);
  assert.deepEqual(e.reasons.map((r) => r.type), ['limit']);
  assert.equal(e.accessAt, at(2026, 11, 5));
});
test('focus expiring inside a schedule leaves the schedule block', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  st.schedules = [sched({ startTime: '09:00', endTime: '12:00' })];
  startFocus(st, 25, t0);
  assert.deepEqual(evaluate(st, t0 + 60_000).reasons.map((r) => r.type), ['focus', 'schedule']);
  const later = t0 + 26 * 60_000;
  expireFocus(st, later);
  assert.deepEqual(evaluate(st, later).reasons.map((r) => r.type), ['schedule']);
  assert.equal(st.focusHistory.length, 1);
});
test('open when no condition applies; live tracked time counts toward the limit', () => {
  const t0 = at(2026, 11, 4, 15);
  const st = withDomains(t0);
  st.settings.dailyLimitMinutes = 1;
  assert.equal(evaluate(st, t0).blocked, false);
  st.tracking = { domain: 'reddit.com', since: t0 };
  assert.equal(evaluate(st, t0 + 30_000).blocked, false); // 30s of 60s used
  assert.equal(evaluate(st, t0 + 61_000).blocked, true); // in-flight 61s >= 60s allowance
});
test('focus cannot start twice and has no cancel', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  startFocus(st, 25, t0);
  assert.throws(() => startFocus(st, 50, t0 + 1000));
});

// ---- FR-06 cooldown ----
test('removal is queued, current config stays, survives restart, applies after cooldown', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  const r = proposeChange(st, { type: 'removeDomain', value: 'reddit.com' }, t0);
  assert.equal(r.pending.length, 1);
  assert.ok(st.restrictedDomains.includes('reddit.com'));
  const restored = JSON.parse(JSON.stringify(st)); // simulate restart via storage
  assert.equal(applyDuePending(restored, t0 + 14 * 60_000), false);
  assert.ok(restored.restrictedDomains.includes('reddit.com'));
  assert.equal(applyDuePending(restored, t0 + 15 * 60_000), true);
  assert.ok(!restored.restrictedDomains.includes('reddit.com'));
  assert.equal(restored.pendingChanges.length, 0);
});
test('pending changes can be cancelled', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  const { pending } = proposeChange(st, { type: 'removeDomain', value: 'reddit.com' }, t0);
  assert.equal(cancelPending(st, pending[0].id), true);
  assert.equal(applyDuePending(st, t0 + 3600_000), false);
  assert.ok(st.restrictedDomains.includes('reddit.com'));
});
test('stricter changes are immediate, looser ones wait', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  assert.equal(proposeChange(st, { type: 'addDomain', value: 'x.com' }, t0).applied.length, 1);
  assert.equal(proposeChange(st, { type: 'setDailyLimit', minutes: 30 }, t0).applied.length, 1);
  assert.equal(st.settings.dailyLimitMinutes, 30);
  const up = proposeChange(st, { type: 'setDailyLimit', minutes: 90 }, t0);
  assert.equal(up.pending.length, 1);
  assert.equal(st.settings.dailyLimitMinutes, 30);
  assert.equal(proposeChange(st, { type: 'setDailyLimit', minutes: null }, t0 + 1).pending.length, 1);
});
test('schedule edits: shrinking waits, extending is immediate, disabling waits', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  proposeChange(st, { type: 'addSchedule', schedule: { name: 'a', days: [1, 2, 3], startTime: '09:00', endTime: '12:00' } }, t0);
  const id = st.schedules[0].id;
  const upd = (startTime, endTime, enabled = true) =>
    proposeChange(st, { type: 'updateSchedule', id, schedule: { name: 'a', days: [1, 2, 3], startTime, endTime, enabled } }, t0);
  assert.equal(upd('08:00', '13:00').applied.length, 1); // wider => stricter
  assert.equal(upd('10:00', '11:00').pending.length, 1); // narrower => cooldown
  assert.equal(upd('08:00', '13:00', false).pending.length, 1); // disabling => cooldown
  assert.equal(proposeChange(st, { type: 'removeSchedule', id }, t0).pending.length, 1);
});
test('duplicate and covered domains are rejected', () => {
  const st = withDomains(Date.now());
  assert.throws(() => proposeChange(st, { type: 'addDomain', value: 'https://www.reddit.com' }, Date.now()), /already/);
  assert.throws(() => proposeChange(st, { type: 'addDomain', value: 'old.reddit.com' }, Date.now()), /covered/);
  assert.throws(() => proposeChange(st, { type: 'addDomain', value: 'nope' }, Date.now()), /valid/);
});
test('editing a domain adds the new one now and queues removal of the old', () => {
  const t0 = at(2026, 11, 4, 10);
  const st = withDomains(t0);
  const r = proposeChange(st, { type: 'editDomain', from: 'reddit.com', to: 'twitch.tv' }, t0);
  assert.equal(r.applied.length, 1);
  assert.equal(r.pending.length, 1);
  assert.ok(st.restrictedDomains.includes('twitch.tv') && st.restrictedDomains.includes('reddit.com'));
});
