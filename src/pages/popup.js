import { send, h, fmtDuration, fmtClock, fmtCountdown, usageBar, FOCUS_PRESETS } from './common.js';

const root = document.getElementById('root');
let view = null;
let skew = 0; // background clock - local clock, for countdowns

async function refresh() {
  view = await send({ type: 'getView' });
  skew = view.now - Date.now();
  render();
}

async function startFocus(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1) return alert('Enter a whole number of minutes.');
  if (!confirm(`Start a ${minutes}-minute focus session?\n\nAll restricted websites are blocked immediately and the session cannot be cancelled early.`)) return;
  const res = await send({ type: 'startFocus', minutes });
  if (res?.error) alert(res.error);
  refresh();
}

function render() {
  const e = view.evaluation;
  const now = Date.now() + skew;
  const reasonText = {
    focus: 'Focus session active',
    schedule: 'Scheduled blocking',
    limit: 'Daily allowance used up',
  };

  const status = h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('strong', {}, 'FocusGuard'),
      h('span', { class: 'pill ' + (e.blocked ? 'blocked' : 'open') }, e.blocked ? 'Blocking' : 'Open')),
    e.blocked
      ? h('p', { class: 'muted' }, e.reasons.map((r) => reasonText[r.type]).join(' · '),
          e.accessAt ? ` — access at ${fmtClock(e.accessAt, now)}` : '')
      : h('p', { class: 'muted' }, e.nextScheduleStart
          ? `Next scheduled block: ${fmtClock(e.nextScheduleStart.start, now)}–${fmtClock(e.nextScheduleStart.end, now)}`
          : 'No scheduled block coming up.'));

  const limit = e.limitMinutes;
  const usage = h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('span', {}, 'Today'),
      h('span', {}, limit == null ? fmtDuration(e.usedSeconds) : `${fmtDuration(e.usedSeconds)} / ${limit} min`)),
    limit == null ? null : usageBar(e.usedSeconds, limit),
    limit == null ? null : h('div', { class: 'muted' }, `${fmtDuration(e.remainingSeconds)} remaining`));

  const focusBox = h('div', { class: 'card' });
  if (view.focus.active) {
    focusBox.append(
      h('div', { class: 'muted' }, 'Focus session'),
      h('div', { class: 'big', id: 'countdown' }, fmtCountdown(view.focus.endTimestamp - now)),
      h('div', { class: 'muted' }, 'Cannot be cancelled early.'));
  } else {
    const custom = h('input', { type: 'number', min: 1, max: 720, placeholder: 'min', style: 'width:70px' });
    focusBox.append(
      h('div', { class: 'muted' }, 'Start a focus session'),
      h('div', { class: 'row' },
        FOCUS_PRESETS.map((m) => h('button', { onclick: () => startFocus(m) }, `${m}`)),
        custom,
        h('button', { class: 'primary', onclick: () => startFocus(Number(custom.value)) }, 'Go')));
  }

  const pending = view.pendingChanges.length
    ? h('div', { class: 'card' }, h('strong', {}, `${view.pendingChanges.length} pending change(s)`),
        view.pendingChanges.map((p) => h('div', { class: 'muted' }, `${p.description} → ${fmtClock(p.effectiveAt, now)}`)))
    : null;

  root.replaceChildren(
    status, usage, focusBox, pending,
    h('button', { onclick: () => chrome.runtime.openOptionsPage() }, 'Settings & statistics'));
}

setInterval(() => {
  const el = document.getElementById('countdown');
  if (el && view?.focus.active) el.textContent = fmtCountdown(view.focus.endTimestamp - (Date.now() + skew));
}, 1000);
setInterval(refresh, 5000);
refresh();
