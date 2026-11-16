// On-phone smart features: learn the household's usual delivery pattern from its own records,
// forecast the month's bill, and spot unusual days. Plain calculations — no model, no network.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => String(n).padStart(2, '0');
const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const weekdayOf = (day) => new Date(day + 'T00:00:00').getDay();

// How sure a weekday's habit must be before the app relies on it.
const MIN_SHARE = 0.75;
const MIN_SAMPLES = 2;
const MIN_DAYS = 14;

/**
 * Learn what usually happens on each weekday from the last `weeks` weeks of marked days.
 * Returns null until there's enough history to be useful. Each known weekday is
 * { one, half, none } — which quantities usually arrive, or that milk usually doesn't come.
 */
export function learnPattern(rows, today, weeks = 8) {
  const from = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - weeks * 7));
  const to = iso(today);
  const days = new Map(); // day -> { one, half } statuses
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    const entry = days.get(r.day) ?? {};
    entry[r.kind] = r.status;
    days.set(r.day, entry);
  }
  if (days.size < MIN_DAYS) return null;

  const stats = Array.from({ length: 7 }, () => ({ n: 0, one: 0, half: 0, none: 0 }));
  for (const [day, e] of days) {
    const s = stats[weekdayOf(day)];
    s.n++;
    if (e.one === 'y') s.one++;
    if (e.half === 'y') s.half++;
    if (e.one !== 'y' && e.half !== 'y') s.none++;
  }

  const byWeekday = stats.map((s) => {
    if (s.n < MIN_SAMPLES) return null;
    const one = s.one / s.n >= MIN_SHARE;
    const half = s.half / s.n >= MIN_SHARE;
    const none = s.none / s.n >= MIN_SHARE;
    return one || half || none ? { one, half, none } : null;
  });
  if (byWeekday.filter(Boolean).length < 5) return null;

  // The quantity to mark "not received" on when milk usually doesn't come.
  const primary = stats.reduce((a, s) => a + s.one, 0) >= stats.reduce((a, s) => a + s.half, 0) ? 'one' : 'half';
  return { byWeekday, primary, summary: describe(byWeekday) };
}

const label = (p) => (p.none ? 'none' : p.one && p.half ? '1½ L' : p.one ? '1 L' : '½ L');

function joinDays(list) {
  const names = list.map((w) => WEEKDAYS[w]);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// "1 L every day", "1 L every day except Sunday", "1 L most days, ½ L on Saturday and Sunday"
function describe(byWeekday) {
  const groups = new Map();
  byWeekday.forEach((p, w) => {
    if (!p) return;
    const l = label(p);
    groups.set(l, [...(groups.get(l) ?? []), w]);
  });
  const usual = [...groups.entries()].filter(([l]) => l !== 'none').sort((a, b) => b[1].length - a[1].length)[0];
  if (!usual) return 'No milk most days';
  const [main] = usual;
  const others = [...groups.entries()].filter(([l]) => l !== main && l !== 'none');
  const none = groups.get('none');
  if (!others.length) return none ? `${main} every day except ${joinDays(none)}` : `${main} every day`;
  const parts = others.map(([l, days]) => `${l} on ${joinDays(days)}`);
  if (none) parts.push(`none on ${joinDays(none)}`);
  return `${main} most days, ${parts.join('; ')}`;
}

/** What usually happens on this date, or null when the app isn't sure. */
export function expectedOn(pattern, date) {
  return pattern?.byWeekday[date.getDay()] ?? null;
}

/** Usual cost of a date at the given rates (0 for a no-milk day). */
export function expectedCost(pattern, date, rates) {
  const p = expectedOn(pattern, date);
  if (!p || p.none) return 0;
  return (p.one ? rates.one : 0) + (p.half ? rates.half : 0);
}

/**
 * Estimate the month's total for a month in progress. `days` describes each day of the month:
 * { date, marked, cost } where cost is what that marked day adds to the bill.
 * Unmarked past days and the rest of the month are filled in from the usual pattern when there
 * is one, otherwise from the average cost of the days marked so far.
 */
export function forecastMonth(days, today, pattern, rates) {
  const marked = days.filter((d) => d.marked);
  if (today.getDate() < 5 || marked.length < 4) return null;
  const soFar = marked.reduce((s, d) => s + d.cost, 0);
  const open = days.filter((d) => !d.marked);
  const average = soFar / marked.length;
  const rest = open.reduce((s, d) => s + (pattern ? expectedCost(pattern, d.date, rates) : average), 0);
  return { soFar, total: Math.round((soFar + rest) / 10) * 10 };
}
