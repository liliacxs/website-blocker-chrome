// Shared helpers for popup / options / blocked pages. All DOM is built with textContent
// (never innerHTML) so user-supplied values can't inject markup.

export const send = (msg) => chrome.runtime.sendMessage(msg);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s === 0 ? '0 min' : '<1 min';
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export function fmtCountdown(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtClock(ts, now = Date.now()) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export function usageBar(used, limitMinutes) {
  const pct = limitMinutes ? Math.min(100, (used / (limitMinutes * 60)) * 100) : 0;
  return h('div', { class: 'bar' }, h('div', { class: 'bar-fill' + (pct >= 100 ? ' full' : ''), style: `width:${pct}%` }));
}

export const FOCUS_PRESETS = [25, 50, 90, 120];
