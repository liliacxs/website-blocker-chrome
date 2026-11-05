// Local-time helpers. They rely on the JS Date local getters, so they follow the
// system timezone and handle DST correctly without any manual offset maths.

const pad = (n) => String(n).padStart(2, '0');

export function localDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Next local 00:00 strictly after ts (DST-safe: setHours(24) rolls the calendar day). */
export function nextLocalMidnight(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function currentTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "HH:MM" -> minutes since midnight, or null. */
export function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
