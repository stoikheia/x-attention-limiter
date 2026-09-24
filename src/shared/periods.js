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

// `days` absent = every day; an explicit empty array = never (a disabled period).
function dayMatches(p, dayOfStart) {
  if (!Array.isArray(p.days)) return true;
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
// Candidate boundaries are probed on wall-clock HH:MM for the next 8 days, so DST shifts and
// day-of-week restrictions cannot produce a boundary an hour off or on a day the period is off.
export function nextBoundary(periods, date = new Date()) {
  let best = Infinity;
  const now = date.getTime();
  for (const p of periods || []) {
    if (!isValidPeriod(p)) continue;
    for (const t of [p.start, p.end]) {
      const mins = toMinutes(t);
      for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, Math.floor(mins / 60), mins % 60, 0, 0);
        if (d.getTime() <= now) continue;
        // Only keep a boundary if isUnlimited() actually differs just before and just after it.
        const before = isUnlimited([p], new Date(d.getTime() - 60e3));
        const after = isUnlimited([p], d);
        if (before !== after) {
          best = Math.min(best, d.getTime());
          break;
        }
      }
    }
  }
  return Number.isFinite(best) ? best : null;
}
