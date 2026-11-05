import { send, h, DAY_NAMES, fmtDuration, fmtClock, fmtCountdown, usageBar, FOCUS_PRESETS } from './common.js';

const TABS = [
  ['websites', 'Websites'],
  ['schedules', 'Schedules'],
  ['limit', 'Daily limit'],
  ['focus', 'Focus mode'],
  ['protection', 'Protection'],
  ['stats', 'Statistics'],
];

let view = null;
let tab = location.hash.slice(1) || 'websites';
let editing = null; // schedule being edited, or {} for new
let range = 7;
let lastSig = '';
let fetchedAt = Date.now();

const $ = (id) => document.getElementById(id);

function toast(msg, err = false) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

/** Confirms protected changes, then submits. Returns true if the request went through. */
async function request(change) {
  const preview = await send({ type: 'request', change, dryRun: true });
  if (preview.error) return toast(preview.error, true), false;
  if (preview.pending.length) {
    const list = preview.pending.map((p) => `• ${p.description}`).join('\n');
    const ok = confirm(
      `This weakens a restriction, so it is protected by a ${preview.cooldownMinutes}-minute cooldown:\n\n${list}\n\n` +
        'Your current rules stay fully active until then. You can cancel the change at any time before it takes effect. Confirm?',
    );
    if (!ok) return false;
  }
  const res = await send({ type: 'request', change });
  if (res.error) return toast(res.error, true), false;
  toast(res.pending?.length ? `Pending: takes effect in ${preview.cooldownMinutes} min` : 'Saved');
  await refresh(true);
  return true;
}

async function refresh(force = false) {
  view = await send({ type: 'getView' });
  fetchedAt = Date.now();
  renderPending();
  // Re-render forms only when data changed, so typing isn't wiped by polling.
  const sig = JSON.stringify([view.settings, view.restrictedDomains, view.schedules, view.pendingChanges.map((p) => p.id), view.focus.active, tab, range]);
  if (force || sig !== lastSig) {
    lastSig = sig;
    render();
  }
}

function renderPending() {
  const now = view.now + (Date.now() - fetchedAt);
  $('pending').replaceChildren(
    ...view.pendingChanges.map((p) =>
      h('div', { class: 'pending row between' },
        h('span', {}, h('strong', {}, 'Pending: '), p.description,
          h('span', { class: 'muted' }, ` — takes effect ${fmtClock(p.effectiveAt, now)} (in ${fmtCountdown(p.effectiveAt - now)})`)),
        h('button', { onclick: async () => { await send({ type: 'cancelPending', id: p.id }); refresh(true); } }, 'Cancel'))),
  );
}

function render() {
  $('nav').replaceChildren(
    ...TABS.map(([id, label]) =>
      h('button', { class: id === tab ? 'active' : '', onclick: () => { tab = id; location.hash = id; refresh(true); } }, label)));
  const pendingRemoval = new Set(view.pendingChanges.filter((p) => p.change.type === 'removeDomain').map((p) => p.change.domain));
  const sections = { websites: () => websites(pendingRemoval), schedules, limit, focus, protection, stats };
  $('content').replaceChildren((sections[tab] ?? sections.websites)());
}

// ---- Websites ------------------------------------------------------------------------------

function websites(pendingRemoval) {
  const input = h('input', { type: 'text', placeholder: 'reddit.com or https://…', style: 'flex:1' });
  const add = async () => { if (await request({ type: 'addDomain', value: input.value })) input.value = ''; };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  return h('div', { class: 'card' },
    h('h2', {}, 'Restricted websites'),
    h('p', { class: 'muted' }, 'Subdomains are included automatically. Adding applies immediately; removing or editing is subject to the cooldown.'),
    h('div', { class: 'row' }, input, h('button', { class: 'primary', onclick: add }, 'Add')),
    view.restrictedDomains.length === 0 ? h('p', { class: 'muted' }, 'No websites yet.') : null,
    view.restrictedDomains.map((d) =>
      h('div', { class: 'list-item' },
        h('span', {}, d, pendingRemoval.has(d) ? h('span', { class: 'pill' }, 'removal pending') : null),
        h('span', { class: 'row' },
          h('button', { onclick: () => { const to = prompt(`Replace ${d} with:`, d); if (to) request({ type: 'editDomain', from: d, to }); } }, 'Edit'),
          h('button', { class: 'danger', onclick: () => request({ type: 'removeDomain', value: d }) }, 'Remove')))));
}

// ---- Schedules -----------------------------------------------------------------------------

function schedules() {
  const list = h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', {}, 'Blocking schedules'),
      h('button', { class: 'primary', onclick: () => { editing = {}; render(); } }, 'New schedule')),
    h('p', { class: 'muted' }, 'Restricted sites are fully blocked inside these windows. End earlier than start for overnight windows (22:00–07:00). Times use your local timezone.'),
    view.schedules.length === 0 ? h('p', { class: 'muted' }, 'No schedules yet.') : null,
    view.schedules.map((s) =>
      h('div', { class: 'list-item' },
        h('span', {}, h('strong', {}, s.name), ` ${s.startTime}–${s.endTime} `,
          h('span', { class: 'muted' }, s.days.map((d) => DAY_NAMES[d]).join(' ')),
          s.enabled ? null : h('span', { class: 'pill' }, 'disabled')),
        h('span', { class: 'row' },
          h('button', { onclick: () => request({ type: 'updateSchedule', id: s.id, schedule: { ...s, enabled: !s.enabled } }) }, s.enabled ? 'Disable' : 'Enable'),
          h('button', { onclick: () => { editing = s; render(); } }, 'Edit'),
          h('button', { class: 'danger', onclick: () => request({ type: 'removeSchedule', id: s.id }) }, 'Delete')))));
  return h('div', {}, list, editing ? scheduleForm() : null);
}

function scheduleForm() {
  const s = editing;
  const name = h('input', { type: 'text', value: s.name ?? '', placeholder: 'Morning focus' });
  const start = h('input', { type: 'time', value: s.startTime ?? '09:00' });
  const end = h('input', { type: 'time', value: s.endTime ?? '12:00' });
  const enabled = h('input', { type: 'checkbox', checked: s.enabled !== false });
  const boxes = DAY_NAMES.map((n, i) => ({ i, el: h('input', { type: 'checkbox', checked: (s.days ?? [1, 2, 3, 4, 5]).includes(i) }) }));
  const setDays = (days) => boxes.forEach((b) => (b.el.checked = days.includes(b.i)));
  const save = async () => {
    const schedule = { name: name.value, days: boxes.filter((b) => b.el.checked).map((b) => b.i), startTime: start.value, endTime: end.value, enabled: enabled.checked };
    const change = s.id ? { type: 'updateSchedule', id: s.id, schedule } : { type: 'addSchedule', schedule };
    if (await request(change)) { editing = null; render(); }
  };
  return h('div', { class: 'card' },
    h('h3', {}, s.id ? 'Edit schedule' : 'New schedule'),
    h('div', { class: 'row' }, name, start, '–', end),
    h('div', { class: 'days row', style: 'margin:10px 0' },
      boxes.map((b) => h('label', {}, b.el, ' ', DAY_NAMES[b.i])),
      h('button', { onclick: () => setDays([1, 2, 3, 4, 5]) }, 'Weekdays'),
      h('button', { onclick: () => setDays([0, 6]) }, 'Weekend'),
      h('button', { onclick: () => setDays([0, 1, 2, 3, 4, 5, 6]) }, 'Every day')),
    h('label', {}, enabled, ' Enabled'),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'primary', onclick: save }, 'Save'),
      h('button', { onclick: () => { editing = null; render(); } }, 'Cancel')));
}

// ---- Daily limit ---------------------------------------------------------------------------

function limit() {
  const cur = view.settings.dailyLimitMinutes;
  const custom = h('input', { type: 'number', min: 1, max: 1440, placeholder: 'minutes', style: 'width:100px' });
  return h('div', { class: 'card' },
    h('h2', {}, 'Daily allowance'),
    h('p', {}, 'One allowance shared across every restricted website. Currently: ', h('strong', {}, cur == null ? 'no limit' : `${cur} minutes`)),
    h('p', { class: 'muted' }, 'Lowering the allowance applies immediately. Raising or removing it is subject to the cooldown. Resets at local midnight.'),
    h('div', { class: 'row' },
      [30, 60, 90, 120].map((m) => h('button', { class: m === cur ? 'primary' : '', onclick: () => request({ type: 'setDailyLimit', minutes: m }) }, `${m} min`)),
      custom, h('button', { onclick: () => request({ type: 'setDailyLimit', minutes: Number(custom.value) }) }, 'Set'),
      h('button', { class: 'danger', onclick: () => request({ type: 'setDailyLimit', minutes: null }) }, 'No limit')));
}

// ---- Focus ---------------------------------------------------------------------------------

function focus() {
  const custom = h('input', { type: 'number', min: 1, max: 720, placeholder: 'minutes', style: 'width:100px' });
  const start = async (m) => {
    if (!Number.isInteger(m) || m < 1) return toast('Enter a whole number of minutes.', true);
    if (!confirm(`Start a ${m}-minute focus session? It cannot be cancelled early.`)) return;
    const res = await send({ type: 'startFocus', minutes: m });
    if (res.error) toast(res.error, true);
    refresh(true);
  };
  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Focus mode'),
      view.focus.active
        ? h('p', {}, `Active until ${fmtClock(view.focus.endTimestamp, view.now)} (${fmtCountdown(view.focus.endTimestamp - view.now)} left). It cannot be cancelled early.`)
        : h('div', { class: 'row' }, FOCUS_PRESETS.map((m) => h('button', { onclick: () => start(m) }, `${m} min`)),
            custom, h('button', { class: 'primary', onclick: () => start(Number(custom.value)) }, 'Start')),
      h('p', { class: 'muted' }, 'Focus sessions block all restricted websites immediately, alongside schedules and the daily allowance.')),
    h('div', { class: 'card' }, h('h3', {}, 'Recent sessions'),
      view.focusHistory.length === 0 ? h('p', { class: 'muted' }, 'None yet.') : null,
      view.focusHistory.map((f) => h('div', { class: 'list-item' }, new Date(f.startTimestamp).toLocaleString(), h('span', {}, `${f.durationMinutes} min`)))));
}

// ---- Protection ----------------------------------------------------------------------------

function protection() {
  const input = h('input', { type: 'number', min: 1, max: 1440, value: view.settings.cooldownMinutes, style: 'width:100px' });
  return h('div', { class: 'card' },
    h('h2', {}, 'Protection'),
    h('p', {}, 'Changes that loosen a restriction wait for a cooldown before taking effect. Stricter changes apply immediately. There is no override.'),
    h('div', { class: 'row' }, 'Cooldown (minutes):', input, h('button', { class: 'primary', onclick: () => request({ type: 'setCooldown', minutes: Number(input.value) }) }, 'Save')),
    h('p', { class: 'muted' }, 'Shortening the cooldown is itself subject to the current cooldown.'),
    h('p', { class: 'muted' }, 'Note: a browser extension cannot stop you from disabling or uninstalling it, using another browser or profile. FocusGuard adds friction; it is not tamper-proof.'));
}

// ---- Statistics ----------------------------------------------------------------------------

function stats() {
  const e = view.evaluation;
  const days = [...view.history, { date: view.usage.date, totalSeconds: e.usedSeconds, byDomain: view.usage.byDomain, blocks: view.usage.blocks }];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const series = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    series.push(byDate.get(key) ?? { date: key, totalSeconds: 0, byDomain: {}, blocks: 0 });
  }
  const max = Math.max(60, ...series.map((d) => d.totalSeconds));
  const totals = {};
  let blocks = 0;
  for (const d of series) {
    blocks += d.blocks ?? 0;
    for (const [k, v] of Object.entries(d.byDomain)) totals[k] = (totals[k] ?? 0) + v;
  }
  const sum = series.reduce((a, d) => a + d.totalSeconds, 0);
  const today = view.usage.byDomain;

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, "Today's activity"),
      h('div', { class: 'row', style: 'gap:32px' },
        h('div', {}, h('div', { class: 'muted' }, 'Time used'), h('div', { class: 'big' }, fmtDuration(e.usedSeconds))),
        h('div', {}, h('div', { class: 'muted' }, 'Remaining'), h('div', { class: 'big' }, e.remainingSeconds == null ? '∞' : fmtDuration(e.remainingSeconds))),
        h('div', {}, h('div', { class: 'muted' }, 'Allowance'), h('div', { class: 'big' }, e.limitMinutes == null ? 'None' : `${e.limitMinutes} min`)),
        h('div', {}, h('div', { class: 'muted' }, 'Blocks today'), h('div', { class: 'big' }, view.usage.blocks))),
      e.limitMinutes == null ? null : usageBar(e.usedSeconds, e.limitMinutes),
      h('h3', { style: 'margin-top:14px' }, 'Time by website'),
      Object.keys(today).length === 0 ? h('p', { class: 'muted' }, 'No restricted browsing yet today.') : null,
      Object.entries(today).sort((a, b) => b[1] - a[1]).map(([d, s]) => h('div', { class: 'list-item' }, d, fmtDuration(s)))),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, 'History'),
        h('span', { class: 'row' }, [7, 30].map((r) => h('button', { class: r === range ? 'primary' : '', onclick: () => { range = r; refresh(true); } }, `Last ${r} days`)))),
      h('div', { class: 'chart' }, series.map((d) =>
        h('div', { class: 'col' + (e.limitMinutes && d.totalSeconds >= e.limitMinutes * 60 ? ' over' : ''), style: `height:${(d.totalSeconds / max) * 100}%`, title: `${d.date}: ${fmtDuration(d.totalSeconds)}` }))),
      h('p', { class: 'muted' }, `Total ${fmtDuration(sum)} · average ${fmtDuration(sum / range)}/day · ${blocks} blocking events`),
      Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([d, s]) => h('div', { class: 'list-item' }, d, fmtDuration(s)))),
    h('p', { class: 'muted' }, 'All data stays in this browser.'));
}

setInterval(() => refresh(), 5000);
setInterval(() => view && renderPending(), 1000);
refresh(true);
