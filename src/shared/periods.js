// UNLIMITED period logic (SPEC §15-17). Periods may cross midnight and may carry
// an optional `days` array (0=Sun..6=Sat) that restricts the day the period STARTS.

export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function isValidPeriod(p) {
  return !!p && toMinutes(p.start) !== null && toMinutes(p.end) !== null && toMinutes(p.start) !== toMinutes(p.end);
}

function dayMatches(p, dayOfStart) {
  if (!Array.isArray(p.days) || p.days.length === 0) return true;
  return p.days.includes(dayOfStart);
}

export function isUnlimited(periods, date = new Date()) {
  const m = date.getHours() * 60 + date.getMinutes();
  const dow = date.getDay();
  for (const p of periods || []) {
    if (!isValidPeriod(p)) continue;
    const s = toMinutes(p.start);
    const e = toMinutes(p.end);
    if (s < e) {
      if (m >= s && m < e && dayMatches(p, dow)) return true;
    } else {
      // crosses midnight: [s, 24:00) belongs to today, [0, e) belongs to the period started yesterday
      if (m >= s && dayMatches(p, dow)) return true;
      if (m < e && dayMatches(p, (dow + 6) % 7)) return true;
    }
  }
  return false;
}

// Next minute boundary (timestamp) at which isUnlimited() may change, or null when no periods.
export function nextBoundary(periods, date = new Date()) {
  let best = Infinity;
  for (const p of periods || []) {
    if (!isValidPeriod(p)) continue;
    for (const t of [p.start, p.end]) {
      const mins = toMinutes(t);
      const d = new Date(date);
      d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      if (d.getTime() <= date.getTime()) d.setDate(d.getDate() + 1);
      best = Math.min(best, d.getTime());
    }
  }
  return Number.isFinite(best) ? best : null;
}
