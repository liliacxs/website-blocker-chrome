import { send, h, fmtDuration, fmtClock, usageBar } from './common.js';

const QUOTES = [
  'Your attention is your most valuable resource.',
  'What you do with your time is what you do with your life.',
  'Do the next right thing. The feed will still be there later.',
  'Focus is a decision you make again and again.',
];

const root = document.getElementById('root');
const raw = new URLSearchParams(location.search).get('d') ?? '';
// Only ever display a string that is a plausible hostname; otherwise a generic label.
const domain = /^[a-z0-9.-]{3,253}$/i.test(raw) ? raw.toLowerCase() : null;
const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];

function render(view) {
  const e = view.evaluation;
  const now = Date.now();
  const name = domain ?? 'this website';

  if (!e.blocked) {
    root.replaceChildren(
      h('h1', {}, 'Restrictions have ended.'),
      h('p', { class: 'muted' }, `${name} is available again.`),
      domain ? h('a', { href: `https://${domain}/` }, `Go to ${domain}`) : null);
    return;
  }

  const lines = e.reasons.map((r) => {
    if (r.type === 'schedule') {
      return h('div', { class: 'card reason' },
        h('strong', {}, 'Scheduled blocking'),
        r.schedules.map((s) => h('div', {}, `${s.name}: ${s.startTime} – ${s.endTime}`)),
        r.until ? h('div', { class: 'muted' }, `Block ends at ${fmtClock(r.until, now)}`) : null);
    }
    if (r.type === 'limit') {
      return h('div', { class: 'card reason' },
        h('strong', {}, 'Daily allowance used up'),
        h('div', { class: 'muted' }, `Resets at midnight (${fmtClock(r.until, now)})`));
    }
    return h('div', { class: 'card reason' },
      h('strong', {}, 'Focus session active'),
      h('div', { class: 'muted' }, `Ends at ${fmtClock(r.until, now)}`));
  });

  root.replaceChildren(
    h('h1', {}, 'Stay focused.'),
    h('p', {}, `Access to ${name} is restricted.`),
    lines,
    h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('span', {}, "Today's usage"),
        h('strong', {}, e.limitMinutes == null
          ? fmtDuration(e.usedSeconds)
          : `${Math.floor(e.usedSeconds / 60)} / ${e.limitMinutes} minutes`)),
      e.limitMinutes == null ? null : usageBar(e.usedSeconds, e.limitMinutes)),
    e.accessAt ? h('p', {}, `Access available at ${fmtClock(e.accessAt, now)}`) : null,
    h('p', { class: 'quote muted' }, quote));
}

send({ type: 'blockShown', domain: raw }).then(render);
setInterval(() => send({ type: 'getView' }).then(render), 5000);
