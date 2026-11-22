// Fonts ship inside the app (SIL Open Font License), so it never contacts Google Fonts.
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { AppLauncher } from '@capacitor/app-launcher';
import { Share } from '@capacitor/share';
import { localStore, isoDay } from './store.js';
import { learnPattern, expectedOn, forecastMonth, WEEKDAYS } from './smart.js';
import { initReminders, allowReminders, cancelReminders, scheduleReminders, ensureTodayNotification } from './reminders.js';
import { checkAi, aiStatus, setUpAi, turnOffAi, understandNote, answerQuestion, friendlierBill } from './ai.js';
import { exportBackup, restoreBackup } from './backup.js';
import { PRIVACY_URL, TERMS_URL, SUPPORT_EMAIL, UPI_PATTERN } from './config.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LITRES = { one: 1, half: 0.5 };
const native = Capacitor.isNativePlatform();

const $ = (id) => document.getElementById(id);
const rupees = (n) => '₹' + n.toLocaleString('en-IN');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const today = new Date();

const state = {
  store: null,
  household: null,
  y: today.getFullYear(),
  m: today.getMonth(),
  kind: 'one',
  marks: { one: {}, half: {} }, // day number -> 'y' | 'n'
  rates: { one: {}, half: {} }, // day number -> rate saved with a received day
  payments: [],
  loadToken: 0,
  confirmClear: false,
  confirmDelete: false,
  confirmRestore: false,
  confirmRemove: null,
  prevBillTotal: 0,
  prevMissed: 0, // days milk didn't come last month
  prevDue: 0, // what's still unpaid for last month
  pattern: null, // the household's usual week, learned from its own records (smart.js)
  insightIndex: 0,
  insightsDismissed: false,
};

// ---------- Screens ----------
function show(screen) {
  for (const s of ['loading', 'signin', 'main']) $('screen-' + s).hidden = s !== screen;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function friendly(err) {
  const msg = String(err?.message || err || '');
  if (/fetch|network|Failed to/i.test(msg)) return "Couldn't reach the server. Check your internet connection.";
  return msg || 'Something went wrong. Try again.';
}

// ---------- Data ----------
async function enterApp(store) {
  state.store = store;
  show('loading');
  state.household = await store.household();
  show('main');
  render();
  await loadMonth();
  refreshReminders();
  // On-phone AI is opt-in: ML Kit isn't touched unless the household turned it on in Settings.
  if (native && state.household.ai_on && (await checkAi()) !== 'none') render();
}

async function loadMonth() {
  const token = ++state.loadToken;
  const { y, m } = state;
  try {
    const [rows, payments] = await Promise.all([state.store.deliveries(y, m), state.store.payments(y, m)]);
    if (token !== state.loadToken) return;
    state.marks = { one: {}, half: {} };
    state.rates = { one: {}, half: {} };
    for (const r of rows) {
      const d = Number(r.day.slice(8, 10));
      state.marks[r.kind][d] = r.status;
      if (r.status === 'y' && r.rate) state.rates[r.kind][d] = r.rate;
    }
    state.payments = payments;

    state.prevBillTotal = 0;
    state.prevMissed = 0;
    state.prevDue = 0;
    if (y === today.getFullYear() && m === today.getMonth()) {
      const prev = new Date(y, m - 1, 1);
      const [prevRows, prevPayments] = await Promise.all([
        state.store.deliveries(prev.getFullYear(), prev.getMonth()),
        state.store.payments(prev.getFullYear(), prev.getMonth()),
      ]);
      if (token !== state.loadToken) return;
      state.prevBillTotal = prevRows.reduce((sum, r) => (r.status === 'y' ? sum + (r.rate || 0) : sum), 0);
      state.prevDue = Math.max(0, state.prevBillTotal - prevPayments.reduce((s, p) => s + p.amount, 0));
      state.pattern = learnPattern(await state.store.allDeliveries(), today);
      state.prevMissed = countMissed(prevRows, state.pattern);
    } else {
      state.pattern = learnPattern(await state.store.allDeliveries(), today);
    }
    if (token !== state.loadToken) return;

    render();
  } catch (e) {
    if (token === state.loadToken) toast(friendly(e));
  }
}

// Writes go one after another so taps never overtake each other.
let writeChain = Promise.resolve();
function write(task) {
  writeChain = writeChain.then(task).catch((e) => {
    toast("Couldn't save. " + friendly(e));
    return loadMonth();
  });
  writeChain.then(refreshReminders);
  return writeChain;
}

// ---------- Reminders ----------
// Reschedules the next two weeks of "Did milk come today?" notifications after any change,
// skipping days already marked and days milk usually doesn't come.
let reminderTimer = null;
function refreshReminders() {
  if (!native || !state.household) return;
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(async () => {
    try {
      const h = state.household;
      if (!h.reminder_on) { await cancelReminders(); return; }
      const marked = new Set((await state.store.allDeliveries()).map((r) => r.day));
      const skip = (date) =>
        marked.has(isoDay(date.getFullYear(), date.getMonth(), date.getDate())) || expectedOn(state.pattern, date)?.none;
      await scheduleReminders(h.reminder_time || '08:00', skip);
      await ensureTodayNotification(!skip(today));
    } catch { /* reminders are a convenience; never block the app on them */ }
  }, 800);
}

// Answer from a reminder's Received / Not received button.
async function answerReminder(day, status) {
  const date = new Date(day + 'T00:00:00');
  const p = expectedOn(state.pattern, date);
  const kinds = status === 'n'
    ? [state.pattern?.primary ?? 'one']
    : p && !p.none ? [p.one && 'one', p.half && 'half'].filter(Boolean) : ['one'];
  const rate = (kind) => (kind === 'one' ? state.household.rate_one : state.household.rate_half);
  const rows = kinds.map((kind) => ({ day, kind, status, rate: status === 'y' ? rate(kind) : null }));
  await write(() => state.store.setDeliveries(rows));
  if (date.getFullYear() === state.y && date.getMonth() === state.m) await loadMonth();
  toast(status === 'y' ? 'Marked today as received.' : 'Marked today as not received.');
}

const rateNow = (kind) => (kind === 'one' ? state.household.rate_one : state.household.rate_half);
const rateFor = (kind, d) => state.rates[kind][d] ?? rateNow(kind);

function isFuture(y, m, d) {
  return new Date(y, m, d) > new Date(today.getFullYear(), today.getMonth(), today.getDate());
}
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

function bill() {
  const out = { one: { days: 0, amount: 0 }, half: { days: 0, amount: 0 } };
  for (const kind of ['one', 'half']) {
    for (const [d, s] of Object.entries(state.marks[kind])) {
      if (s !== 'y') continue;
      out[kind].days++;
      out[kind].amount += rateFor(kind, Number(d));
    }
  }
  out.total = out.one.amount + out.half.amount;
  out.litres = out.one.days * LITRES.one + out.half.days * LITRES.half;
  out.paid = state.payments.reduce((s, p) => s + p.amount, 0);
  out.due = Math.max(0, out.total - out.paid);
  return out;
}

// A date is "not delivered" only when no milk came at all that day, and milk normally comes on
// that weekday (the household's usual no-milk days, such as Sundays, aren't missed deliveries).
function missedDates() {
  const days = new Set([...Object.keys(state.marks.one), ...Object.keys(state.marks.half)].map(Number));
  return [...days]
    .filter((d) => state.marks.one[d] !== 'y' && state.marks.half[d] !== 'y')
    .filter((d) => state.marks.one[d] === 'n' || state.marks.half[d] === 'n')
    .filter((d) => !expectedOn(state.pattern, new Date(state.y, state.m, d))?.none)
    .sort((a, b) => a - b);
}

const received = (d) => state.marks.one[d] === 'y' || state.marks.half[d] === 'y';
const missedDay = (d) => !received(d) && (state.marks.one[d] === 'n' || state.marks.half[d] === 'n');

// Days in a set of delivery rows when no milk came at all (at least one "not received", nothing
// received), leaving out the household's usual no-milk days such as Sundays.
function countMissed(rows, pattern) {
  const days = new Map();
  for (const r of rows) days.set(r.day, (days.get(r.day) ?? '') + r.status);
  return [...days.entries()].filter(([day, s]) =>
    !s.includes('y') && s.includes('n') && !expectedOn(pattern, new Date(day + 'T00:00:00'))?.none).length;
}

const dateOf = (d) => new Date(state.y, state.m, d);
const fmtDays = (list) => {
  const shown = list.length > 6 ? [...list.slice(0, 5), '…'] : list;
  return `${shown.join(', ')} ${MONTHS[state.m].slice(0, 3)}`;
};

// Past days of the viewed month with nothing marked in either tab (today excluded).
function unmarkedPastDays() {
  const out = [];
  const isCurrent = state.y === today.getFullYear() && state.m === today.getMonth();
  const last = isCurrent ? today.getDate() - 1 : daysIn(state.y, state.m);
  for (let d = 1; d <= last; d++) if (!state.marks.one[d] && !state.marks.half[d]) out.push(d);
  return out;
}

// Things worth a second look, newest first. Each may offer a one-tap fix.
function computeAlerts() {
  const list = [];
  const isCurrent = state.y === today.getFullYear() && state.m === today.getMonth();
  if (!isCurrent) return list;

  if (state.prevDue > 0 && today.getDate() >= 3) {
    const prev = new Date(state.y, state.m - 1, 1);
    list.push({
      tone: 'alert',
      title: `${MONTHS[prev.getMonth()]} isn't fully paid`,
      sub: `${rupees(state.prevDue)} is still due for last month.`,
      action: { label: `Open ${MONTHS[prev.getMonth()]}`, run: () => goMonth(-1) },
    });
  }

  const blanks = unmarkedPastDays();
  if (blanks.length >= 2) {
    list.push({
      tone: 'alert',
      title: `${plural(blanks.length, 'day')} not marked yet`,
      sub: state.pattern ? `${fmtDays(blanks)}. Fill them with your usual pattern?` : `${fmtDays(blanks)}.`,
      action: state.pattern ? { label: 'Fill the usual way', run: () => fillUsual(blanks) } : null,
    });
  }

  // A day marked differently from the usual for its weekday may be a mis-tap.
  if (state.pattern) {
    for (let d = today.getDate(); d >= 1; d--) {
      const p = expectedOn(state.pattern, dateOf(d));
      const one = state.marks.one[d] === 'y';
      const half = state.marks.half[d] === 'y';
      if (!p || p.none || (!one && !half) || (one === p.one && half === p.half)) continue;
      const got = one && half ? '1½ litres' : one ? '1 litre' : '½ litre';
      const usual = p.one && p.half ? '1½ litres' : p.one ? '1 litre' : '½ litre';
      list.push({
        tone: 'alert',
        title: `${d} ${MONTHS[state.m].slice(0, 3)} is marked ${got}`,
        sub: `You usually get ${usual} on ${WEEKDAYS[dateOf(d).getDay()]}s. Tap the day to change it if that's a mistake.`,
      });
      break;
    }
  }

  const missed = missedDates().length;
  if (missed >= 3 && missed > state.prevMissed) {
    const seller = state.household.seller_name || 'your milk seller';
    list.push({
      tone: 'alert',
      title: `Milk didn't come ${missed} times this month`,
      sub: state.prevMissed
        ? `Last month it was ${state.prevMissed}. Worth mentioning to ${seller}?`
        : `It came every day last month. Worth mentioning to ${seller}?`,
    });
  }
  return list;
}

// The month's likely total, from the days marked so far and the usual pattern.
function computeForecast() {
  if (state.y !== today.getFullYear() || state.m !== today.getMonth()) return null;
  const rates = { one: rateNow('one'), half: rateNow('half') };
  const days = [];
  for (let d = 1; d <= daysIn(state.y, state.m); d++) {
    const marked = Boolean(state.marks.one[d] || state.marks.half[d]);
    const cost = (state.marks.one[d] === 'y' ? rateFor('one', d) : 0) + (state.marks.half[d] === 'y' ? rateFor('half', d) : 0);
    days.push({ date: dateOf(d), marked, cost });
  }
  const f = forecastMonth(days, today, state.pattern, rates);
  if (!f) return null;
  const vsLast = state.prevBillTotal > 0 ? f.total - state.prevBillTotal : 0;
  return {
    tone: Math.abs(vsLast) >= 0.1 * state.prevBillTotal && vsLast > 0 ? 'alert' : '',
    title: `Heading for about ${rupees(f.total)} in ${MONTHS[state.m]}`,
    sub: state.prevBillTotal > 0
      ? `${rupees(f.soFar)} so far. Last month was ${rupees(state.prevBillTotal)}${vsLast >= 50 ? `, so this is about ${rupees(Math.round(vsLast / 10) * 10)} more` : ''}.`
      : `${rupees(f.soFar)} so far this month.`,
  };
}

// Small, honest facts about the month in progress — nothing leaves the device to compute these.
function computeInsights() {
  const list = [...computeAlerts()];
  if (state.y !== today.getFullYear() || state.m !== today.getMonth()) return list;
  const forecast = computeForecast();
  if (forecast) list.push(forecast);
  const day = today.getDate();

  let receivedCount = 0;
  for (let d = 1; d <= day; d++) if (received(d)) receivedCount++;
  if (day >= 5 && receivedCount === day) {
    list.push({ title: 'Perfect month so far', sub: `No missed days in ${plural(day, 'day')}.` });
  }

  let d = day;
  while (d >= 1 && !received(d) && !missedDay(d)) d--;
  let streak = 0;
  while (d >= 1 && received(d)) { streak++; d--; }
  if (streak >= 5) {
    list.push({ title: `${streak}-day streak`, sub: 'Your current run of marked days.' });
  }

  if (state.prevBillTotal > 0 && !forecast) {
    const curTotal = bill().total;
    const diff = curTotal - state.prevBillTotal;
    if (Math.abs(diff) >= 50) {
      list.push({
        title: `${rupees(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than last month`,
        sub: `This month's bill is ${rupees(curTotal)} so far.`,
      });
    }
  }

  return list;
}

let currentInsightAction = null;

function renderInsights() {
  const card = $('insightCard');
  if (state.insightsDismissed) { card.hidden = true; return; }
  const list = computeInsights();
  if (!list.length) { card.hidden = true; return; }
  card.hidden = false;
  const i = Math.min(state.insightIndex, list.length - 1);
  card.classList.toggle('alert', list[i].tone === 'alert');
  $('insightTitle').textContent = list[i].title;
  $('insightSub').textContent = list[i].sub;
  const action = $('insightAction');
  action.hidden = !list[i].action;
  action.textContent = list[i].action?.label ?? '';
  currentInsightAction = list[i].action?.run ?? null;
  const dots = $('insightDots');
  dots.hidden = list.length < 2;
  dots.textContent = '';
  list.forEach((_, j) => {
    const dot = document.createElement('span');
    dot.className = j === i ? 'on' : '';
    dot.dataset.i = j;
    dots.appendChild(dot);
  });
}

// ---------- Render ----------
function render() {
  const { y, m, kind } = state;
  const h = state.household;
  const marks = state.marks[kind];
  const n = daysIn(y, m);

  $('setupCard').hidden = Boolean(h.upi_id);
  const aiReady = aiStatus() === 'ready';
  $('askCard').hidden = !aiReady;
  $('quickAddInput').placeholder = aiReady ? 'e.g. no milk on the 3rd and 5th' : 'yesterday and today received';
  renderInsights();
  $('quickAddForm').hidden = y !== today.getFullYear() || m !== today.getMonth();
  $('monthLabel').textContent = `${MONTHS[m]} ${y}`;
  $('nextMonth').disabled = y > today.getFullYear() || (y === today.getFullYear() && m >= today.getMonth());
  $('rateOne').textContent = `${rupees(h.rate_one)} per day`;
  $('rateHalf').textContent = `${rupees(h.rate_half)} per day`;

  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.kind === kind;
    t.setAttribute('aria-selected', on);
    if (on) $('panel').setAttribute('aria-labelledby', t.id);
  });

  const grid = $('grid');
  grid.textContent = '';
  for (let i = 0; i < new Date(y, m, 1).getDay(); i++) {
    const b = document.createElement('div');
    b.className = 'blank';
    grid.appendChild(b);
  }
  let yes = 0, no = 0, blank = 0;
  for (let d = 1; d <= n; d++) {
    const s = marks[d];
    const future = isFuture(y, m, d);
    const btn = document.createElement('button');
    btn.className = 'day' + (s === 'y' ? ' yes' : s === 'n' ? ' no' : '');
    if (y === today.getFullYear() && m === today.getMonth() && d === today.getDate()) btn.classList.add('today');
    btn.dataset.day = d;
    btn.disabled = future;
    btn.setAttribute('aria-label', `${MONTHS[m]} ${d}, ${s === 'y' ? 'received' : s === 'n' ? 'not received' : 'not marked'}`);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = s === 'y' ? '✓' : s === 'n' ? '✕' : '';
    btn.append(num, mark);
    grid.appendChild(btn);
    if (s === 'y') yes++;
    else if (s === 'n') no++;
    else if (!future) blank++;
  }
  $('cntYes').textContent = yes;
  $('cntNo').textContent = no;
  $('cntBlank').textContent = blank;
  const isCurrent = y === today.getFullYear() && m === today.getMonth();
  const todayOpen = isCurrent && !state.marks.one[today.getDate()] && !state.marks.half[today.getDate()];
  const usualBlanks = state.pattern ? unmarkedPastDays().length + (todayOpen ? 1 : 0) : 0;
  $('fillBtn').textContent = state.pattern ? 'Fill the usual way' : 'Mark unmarked days as received';
  $('fillBtn').disabled = state.pattern ? usualBlanks === 0 : blank === 0;
  $('patternLine').hidden = !state.pattern;
  $('patternLine').textContent = state.pattern ? `Your usual: ${state.pattern.summary}.` : '';
  $('clearBtn').textContent = state.confirmClear ? 'Tap again to clear both tabs' : 'Clear this month';

  const b = bill();
  $('billOneDays').textContent = plural(b.one.days, 'day');
  $('billHalfDays').textContent = plural(b.half.days, 'day');
  $('billOne').textContent = rupees(b.one.amount);
  $('billHalf').textContent = rupees(b.half.amount);
  $('billMonth').textContent = MONTHS[m];
  $('billLitres').textContent = `${b.litres.toLocaleString('en-IN')} L`;
  $('billTotal').textContent = rupees(b.total);

  renderPay(b);
}

function renderPay(b) {
  const h = state.household;
  $('payMonth').textContent = MONTHS[state.m];
  const pill = $('payPill');
  if (b.total === 0) {
    pill.textContent = 'Nothing to pay';
    pill.className = 'pill';
  } else if (b.due === 0) {
    pill.textContent = 'Paid in full';
    pill.className = 'pill paid';
  } else {
    pill.textContent = `${rupees(b.due)} due`;
    pill.className = 'pill due';
  }

  const seller = h.seller_name || 'your milk seller';
  $('payLine').textContent = b.total === 0
    ? 'Mark the days milk came, and the amount to pay shows here.'
    : b.paid === 0
      ? `Pay ${seller} ${rupees(b.due)} for ${MONTHS[state.m]}.`
      : b.due === 0
        ? `You paid ${rupees(b.paid)} for ${MONTHS[state.m]}.`
        : `You paid ${rupees(b.paid)} so far. ${rupees(b.due)} is left.`;

  const canPay = b.due > 0;
  $('upiBtn').hidden = !canPay;
  $('upiBtn').textContent = h.upi_id ? `Pay ${rupees(b.due)} with UPI` : 'Add UPI ID to pay';
  $('markPaidBtn').hidden = !canPay;
  $('shareBtn').hidden = b.total === 0;
  $('paidChoiceAmt').textContent = rupees(b.due);

  const list = $('history');
  list.textContent = '';
  for (const p of state.payments) {
    const li = document.createElement('li');
    const when = new Date(p.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const text = document.createElement('span');
    text.textContent = `${rupees(p.amount)} · ${p.method === 'cash' ? 'Cash' : p.method === 'upi' ? 'UPI' : 'Other'} · ${when}`;
    const rm = document.createElement('button');
    rm.className = 'btn ghost';
    rm.dataset.remove = p.id;
    rm.textContent = state.confirmRemove === p.id ? 'Tap to remove' : 'Remove';
    li.append(text, rm);
    list.appendChild(li);
  }
}

// ---------- Calendar actions ----------
$('grid').addEventListener('click', (e) => {
  const btn = e.target.closest('.day');
  if (!btn || btn.disabled) return;
  const d = Number(btn.dataset.day);
  const kind = state.kind;
  const prev = state.marks[kind][d];
  const next = prev === 'y' ? 'n' : prev === 'n' ? undefined : 'y';
  const { y, m } = state;
  const day = isoDay(y, m, d);
  if (next) state.marks[kind][d] = next; else delete state.marks[kind][d];
  if (next === 'y') state.rates[kind][d] = rateNow(kind); else delete state.rates[kind][d];
  state.confirmClear = false;
  render();
  const rate = next === 'y' ? rateNow(kind) : null;
  write(() => (next
    ? state.store.setDeliveries([{ day, kind, status: next, rate }])
    : state.store.clearDelivery(day, kind)));
});

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => { state.kind = t.dataset.kind; state.confirmClear = false; render(); }));

// ---------- Quick add ----------
// A small, honest parser — not a model. Understands relative days ("today",
// "yesterday", "3 days ago") and day numbers ("the 5th"), joined by "and" or
// commas, plus a status word (defaults to received).
function parseQuickAdd(text) {
  const raw = text.trim().toLowerCase();
  if (!raw) return null;

  let status = 'y';
  if (/\b(not received|missed|absent|no milk)\b/.test(raw)) status = 'n';
  else if (/\b(clear|remove|unmark)\b/.test(raw)) status = null;

  const stripped = raw.replace(/\bnot received\b|\bno milk\b|\bmark\b|\bas\b|\breceived\b|\bmissed\b|\babsent\b|\bclear\b|\bremove\b|\bunmark\b/g, ' ');
  const tokens = stripped.split(/,| and /).map((t) => t.trim()).filter(Boolean);

  const days = new Set();
  for (const token of tokens) {
    let match;
    if (token === 'today') days.add(today.getDate());
    else if (token === 'yesterday') days.add(today.getDate() - 1);
    else if ((match = token.match(/^(\d{1,2})\s*days?\s*ago$/))) days.add(today.getDate() - Number(match[1]));
    else if ((match = token.match(/^(?:the\s*|day\s*)?(\d{1,2})(?:st|nd|rd|th)?$/))) days.add(Number(match[1]));
  }

  const { y, m } = state;
  const valid = [...days].filter((d) => d >= 1 && d <= daysIn(y, m) && !isFuture(y, m, d));
  if (!valid.length) return null;
  return { status, days: valid.sort((a, b) => a - b) };
}

function applyQuickAdd(status, days, kind = state.kind) {
  const { y, m } = state;
  const rows = [];
  const cleared = [];
  for (const d of days) {
    const day = isoDay(y, m, d);
    if (status === null) {
      delete state.marks[kind][d];
      delete state.rates[kind][d];
      cleared.push(day);
    } else {
      state.marks[kind][d] = status;
      if (status === 'y') state.rates[kind][d] = rateNow(kind); else delete state.rates[kind][d];
      rows.push({ day, kind, status, rate: status === 'y' ? rateNow(kind) : null });
    }
  }
  state.confirmClear = false;
  render();
  if (rows.length) write(() => state.store.setDeliveries(rows));
  if (cleared.length) write(() => Promise.all(cleared.map((day) => state.store.clearDelivery(day, kind))));
}

function quickAddDone(status, days) {
  const n = days.length;
  toast(status === null ? `Cleared ${plural(n, 'day')}.`
    : status === 'y' ? `Marked ${plural(n, 'day')} as received.`
    : `Marked ${plural(n, 'day')} as not received.`);
  $('quickAddInput').value = '';
}

// What the on-phone AI understood, waiting for the household to confirm it.
let pendingNote = null;

$('quickAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('quickAddInput');
  const err = $('quickAddError');
  $('quickAddConfirm').hidden = true;
  const parsed = parseQuickAdd(input.value);
  if (parsed) {
    err.hidden = true;
    applyQuickAdd(parsed.status, parsed.days);
    quickAddDone(parsed.status, parsed.days);
    return;
  }

  // The simple parser didn't get it; on phones with Gemini Nano, let the AI read the note.
  if (aiStatus() === 'ready' && input.value.trim()) {
    err.hidden = true;
    const submit = $('quickAddForm').querySelector('button');
    submit.disabled = true;
    try {
      const note = await understandNote(input.value, {
        todayText: today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
        monthText: `${MONTHS[state.m]} ${state.y}`,
        lastDay: Math.min(daysIn(state.y, state.m), today.getDate()),
      });
      if (note) {
        // Use the usual quantity for "received" unless the note named one.
        const kind = note.kind ?? (note.status === 'y' ? state.kind : state.pattern?.primary ?? state.kind);
        pendingNote = { ...note, kind };
        const what = note.status === null ? 'Clear' : 'Mark';
        const how = note.status === null ? '' : note.status === 'y' ? ` as received (${kind === 'one' ? '1 litre' : '½ litre'})` : ' as not received';
        $('quickAddPreview').textContent = `${what} ${fmtDays(note.days)}${how}?`;
        $('quickAddConfirm').hidden = false;
        return;
      }
    } catch { /* fall through to the plain hint */ } finally {
      submit.disabled = false;
    }
  }
  err.textContent = 'Couldn’t understand that. Try "yesterday and today" or "the 5th not received".';
  err.hidden = false;
});

$('quickAddYes').addEventListener('click', () => {
  if (!pendingNote) return;
  const { status, days, kind } = pendingNote;
  pendingNote = null;
  $('quickAddConfirm').hidden = true;
  applyQuickAdd(status, days, kind);
  quickAddDone(status, days);
});
$('quickAddNo').addEventListener('click', () => {
  pendingNote = null;
  $('quickAddConfirm').hidden = true;
});

// ---------- Ask about your milk (on-phone AI) ----------
// A plain-text summary of the last six months for the model to read; the numbers are worked
// out here so the model only has to look them up.
async function recordsSummary() {
  const h = state.household;
  const lines = [
    `Today: ${today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`,
    `Milk seller: ${h.seller_name || 'not set'}. Rates: 1 litre ₹${h.rate_one} a day, half litre ₹${h.rate_half} a day.`,
  ];
  if (state.pattern) lines.push(`Usual pattern: ${state.pattern.summary}.`);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const [rows, pays] = await Promise.all([state.store.deliveries(d.getFullYear(), d.getMonth()), state.store.payments(d.getFullYear(), d.getMonth())]);
    if (!rows.length && !pays.length) continue;
    const got = (kind) => rows.filter((r) => r.kind === kind && r.status === 'y');
    const total = rows.reduce((s, r) => (r.status === 'y' ? s + (r.rate || 0) : s), 0);
    const paid = pays.reduce((s, p) => s + p.amount, 0);
    const byDay = new Map();
    rows.forEach((r) => byDay.set(r.day, (byDay.get(r.day) ?? '') + r.status));
    const missed = [...byDay].filter(([day, s]) => !s.includes('y') && s.includes('n') && !expectedOn(state.pattern, new Date(day + 'T00:00:00'))?.none)
      .map(([day]) => Number(day.slice(8))).sort((a, b) => a - b);
    lines.push(`${MONTHS[d.getMonth()]} ${d.getFullYear()}: 1 litre on ${plural(got('one').length, 'day')}, half litre on ${plural(got('half').length, 'day')}; ` +
      `bill ₹${total.toLocaleString('en-IN')}; paid ₹${paid.toLocaleString('en-IN')}; still due ₹${Math.max(0, total - paid).toLocaleString('en-IN')}; ` +
      `milk didn't come on ${missed.length ? missed.join(', ') : 'no days'}.`);
  }
  return lines.join('\n');
}

$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = $('askInput').value.trim();
  if (!question) return;
  const answer = $('askAnswer');
  answer.hidden = false;
  answer.textContent = 'Thinking…';
  $('askBtn').disabled = true;
  try {
    answer.textContent = await answerQuestion(question, await recordsSummary()) || "I couldn't find an answer in your records.";
  } catch (err) {
    answer.textContent = `Couldn't answer that. ${friendly(err)}`;
  } finally {
    $('askBtn').disabled = false;
  }
});

function goMonth(delta) {
  const d = new Date(state.y, state.m + delta, 1);
  state.y = d.getFullYear();
  state.m = d.getMonth();
  state.marks = { one: {}, half: {} };
  state.rates = { one: {}, half: {} };
  state.payments = [];
  state.confirmClear = false;
  state.insightsDismissed = false;
  state.insightIndex = 0;
  $('quickAddError').hidden = true;
  render();
  loadMonth();
}
$('prevMonth').addEventListener('click', () => goMonth(-1));
$('nextMonth').addEventListener('click', () => goMonth(1));

$('insightDismiss').addEventListener('click', () => {
  state.insightsDismissed = true;
  renderInsights();
});
$('insightDots').addEventListener('click', (e) => {
  const dot = e.target.closest('[data-i]');
  if (!dot) return;
  state.insightIndex = Number(dot.dataset.i);
  renderInsights();
});

// Swipe left/right on the card itself to move between insights, same as tapping the dots.
let swipeX = null;
const insightCard = $('insightCard');
insightCard.addEventListener('pointerdown', (e) => {
  swipeX = e.clientX;
  insightCard.setPointerCapture(e.pointerId);
});
insightCard.addEventListener('pointerup', (e) => {
  if (swipeX === null) return;
  const dx = e.clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) < 40) return; // a tap, not a swipe
  const list = computeInsights();
  if (list.length < 2) return;
  state.insightIndex = (state.insightIndex + (dx < 0 ? 1 : -1) + list.length) % list.length;
  renderInsights();
});
insightCard.addEventListener('pointercancel', () => { swipeX = null; });

$('insightAction').addEventListener('click', () => currentInsightAction?.());

// Fill unmarked days the way the household's usual week goes: both quantities, and
// "not received" on days milk usually doesn't come. Days the app isn't sure about stay blank.
function fillUsual(days) {
  const { y, m, pattern } = state;
  const rows = [];
  let filled = 0;
  for (const d of days) {
    if (state.marks.one[d] || state.marks.half[d] || isFuture(y, m, d)) continue;
    const p = expectedOn(pattern, dateOf(d));
    if (!p) continue;
    const marks = p.none ? [[pattern.primary, 'n']] : [p.one && ['one', 'y'], p.half && ['half', 'y']].filter(Boolean);
    for (const [kind, status] of marks) {
      state.marks[kind][d] = status;
      if (status === 'y') state.rates[kind][d] = rateNow(kind);
      rows.push({ day: isoDay(y, m, d), kind, status, rate: status === 'y' ? rateNow(kind) : null });
    }
    filled++;
  }
  state.confirmClear = false;
  render();
  if (rows.length) write(() => state.store.setDeliveries(rows));
  const skipped = days.length - filled;
  toast(filled
    ? `Filled ${plural(filled, 'day')} the usual way.${skipped ? ` ${plural(skipped, 'day')} left for you to mark.` : ''}`
    : 'Not sure about those days yet. Mark them yourself.');
}

$('fillBtn').addEventListener('click', () => {
  if (state.pattern) {
    const days = unmarkedPastDays();
    const t = today.getDate();
    if (state.y === today.getFullYear() && state.m === today.getMonth() && !state.marks.one[t] && !state.marks.half[t]) days.push(t);
    fillUsual(days);
    return;
  }
  const { y, m, kind } = state;
  const rows = [];
  for (let d = 1; d <= daysIn(y, m); d++) {
    if (state.marks[kind][d] || isFuture(y, m, d)) continue;
    state.marks[kind][d] = 'y';
    state.rates[kind][d] = rateNow(kind);
    rows.push({ day: isoDay(y, m, d), kind, status: 'y', rate: rateNow(kind) });
  }
  state.confirmClear = false;
  render();
  if (rows.length) write(() => state.store.setDeliveries(rows));
});

$('clearBtn').addEventListener('click', () => {
  if (!state.confirmClear) { state.confirmClear = true; render(); return; }
  state.confirmClear = false;
  state.marks = { one: {}, half: {} };
  state.rates = { one: {}, half: {} };
  render();
  const { y, m } = state;
  write(() => state.store.clearMonth(y, m));
});

// ---------- Paying ----------
function upiLink(amount) {
  const h = state.household;
  const params = new URLSearchParams({
    pa: h.upi_id,
    pn: h.seller_name || 'Milk seller',
    am: amount.toFixed(2),
    cu: 'INR',
    tn: `Milk ${MONTHS[state.m]} ${state.y}`,
  });
  return 'upi://pay?' + params.toString().replace(/\+/g, '%20');
}

$('upiBtn').addEventListener('click', async () => {
  if (!state.household.upi_id) { openSettings(); return; }
  const { due } = bill();
  try {
    if (native) await AppLauncher.openUrl({ url: upiLink(due) });
    else location.href = upiLink(due);
    // Coming back from the UPI app, ask how it went.
    $('payActions').hidden = true;
    $('paidChoice').hidden = false;
  } catch {
    toast('No UPI app found. Install Google Pay, PhonePe or another UPI app.');
  }
});

$('markPaidBtn').addEventListener('click', () => {
  $('payActions').hidden = true;
  $('paidChoice').hidden = false;
});
$('paidCancel').addEventListener('click', () => {
  $('paidChoice').hidden = true;
  $('payActions').hidden = false;
});
$('paidChoice').addEventListener('click', async (e) => {
  const method = e.target.closest('[data-method]')?.dataset.method;
  if (!method) return;
  const { due } = bill();
  $('paidChoice').hidden = true;
  $('payActions').hidden = false;
  if (due <= 0) return;
  const { y, m } = state;
  try {
    const p = await state.store.addPayment(y, m, due, method);
    if (y === state.y && m === state.m) state.payments.push(p);
    render();
    toast(`Saved: ${rupees(due)} paid for ${MONTHS[m]}.`);
  } catch (err) {
    toast("Couldn't save the payment. " + friendly(err));
  }
});

$('history').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (!id) return;
  if (state.confirmRemove !== id) { state.confirmRemove = id; render(); return; }
  state.confirmRemove = null;
  try {
    await state.store.removePayment(id);
    state.payments = state.payments.filter((p) => p.id !== id);
    render();
  } catch (err) {
    toast("Couldn't remove it. " + friendly(err));
  }
});

function billMessage() {
  const b = bill();
  const h = state.household;
  const month = `${MONTHS[state.m]} ${state.y}`;
  const lines = [`Hi${h.seller_name ? ' ' + h.seller_name : ''}, here is the milk bill for ${month}:`];
  if (b.one.days) lines.push(`1 litre: ${plural(b.one.days, 'day')} = ${rupees(b.one.amount)}`);
  if (b.half.days) lines.push(`½ litre: ${plural(b.half.days, 'day')} = ${rupees(b.half.amount)}`);
  lines.push(`Total: ${rupees(b.total)}`);
  const missed = missedDates();
  if (missed.length) lines.push(`Not delivered on: ${missed.join(', ')} ${MONTHS[state.m].slice(0, 3)}`);
  if (b.paid > 0 && b.due > 0) lines.push(`Already paid: ${rupees(b.paid)}. Balance: ${rupees(b.due)}`);
  else if (b.due === 0) lines.push('Paid in full. Thank you!');
  else lines.push('I will pay by UPI. Thank you!');
  return lines.join('\n');
}

$('shareBtn').addEventListener('click', async () => {
  let text = billMessage();
  if (aiStatus() === 'ready') {
    // A warmer wording from the on-phone AI, used only if every number survived unchanged.
    $('shareBtn').disabled = true;
    try { text = (await friendlierBill(text)) ?? text; } catch { /* keep the plain message */ } finally {
      $('shareBtn').disabled = false;
    }
  }
  try {
    if (native) await Share.share({ text, dialogTitle: 'Send the bill' });
    else if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Bill copied.'); }
  } catch { /* the viewer closed the share sheet */ }
});

// ---------- Settings ----------
function openSettings() {
  const h = state.household;
  $('sellerName').value = h.seller_name || '';
  $('upiId').value = h.upi_id || '';
  $('rateOneInput').value = h.rate_one;
  $('rateHalfInput').value = h.rate_half;
  $('reminderOn').checked = Boolean(h.reminder_on);
  $('reminderTime').value = h.reminder_time || '08:00';
  $('reminderOn').disabled = !native;
  $('reminderTimeField').hidden = !native;
  $('reminderWebNote').hidden = native;
  $('repriceMonthName').textContent = MONTHS[state.m];
  renderAiSettings();
  $('supportEmail').textContent = SUPPORT_EMAIL;
  $('settingsError').hidden = true;
  state.confirmDelete = false;
  renderDelete();
  state.confirmRestore = false;
  renderRestore();
  $('screen-settings').hidden = false;
}
function closeSettings() { $('screen-settings').hidden = true; }

const ML_KIT_NOTE = 'While it’s on, Google’s ML Kit sends Google basic usage statistics: phone model, Android and app version, and speed and error figures. Your records and what you type stay on this phone.';

function renderAiSettings(progress) {
  const s = aiStatus();
  $('aiStatusText').textContent = !native
    ? 'Available in the Android app on phones that have Google’s Gemini Nano.'
    : {
      off: 'Off. Turn it on to type notes in your own words, ask questions about your records and get a warmer bill message, if this phone has Google’s Gemini Nano. ' + ML_KIT_NOTE,
      ready: 'On. Google’s Gemini Nano runs on this phone to understand typed notes, answer questions about your records and word your bill message. ' + ML_KIT_NOTE,
      downloadable: 'This phone can run Google’s Gemini Nano. Set it up to start using it; Android downloads it, preferably over Wi-Fi. ' + ML_KIT_NOTE,
      downloading: `Setting up Gemini Nano${progress ? ` (${progress} MB so far)` : ''}. You can keep using the app.`,
      none: 'This phone doesn’t have Google’s on-phone AI, so it has been turned off. Everything else in the app works the same.',
    }[s];
  const toggle = $('aiToggleBtn');
  toggle.hidden = !native || s === 'none';
  toggle.textContent = s === 'off' ? 'Turn on on-phone AI' : 'Turn off on-phone AI';
  toggle.className = s === 'off' ? 'btn primary' : 'btn';
  $('aiSetupBtn').hidden = s !== 'downloadable';
}

$('aiToggleBtn').addEventListener('click', async () => {
  const turningOn = aiStatus() === 'off';
  $('aiToggleBtn').disabled = true;
  try {
    let s = 'off';
    if (turningOn) s = await checkAi(); else turnOffAi();
    // A phone without Gemini Nano stays off, so ML Kit isn't called again.
    state.household = await state.store.saveHousehold({ ai_on: turningOn && s !== 'none' });
    if (s === 'none') toast('This phone doesn’t have Google’s on-phone AI.');
    else toast(turningOn ? (s === 'ready' ? 'On-phone AI is on.' : 'Set it up to start using it.') : 'On-phone AI is off.');
  } finally {
    $('aiToggleBtn').disabled = false;
  }
  renderAiSettings();
  render();
});

$('aiSetupBtn').addEventListener('click', async () => {
  try {
    await setUpAi((mb) => renderAiSettings(mb));
    toast(aiStatus() === 'ready' ? 'On-phone AI is ready.' : 'Gemini Nano is still setting up. Check back later.');
  } catch {
    toast("Couldn't set up on-phone AI right now. Try again later on Wi-Fi.");
    await checkAi();
  }
  renderAiSettings();
  render();
});
function renderDelete() {
  $('deleteBtn').classList.toggle('armed', state.confirmDelete);
  $('deleteBtn').textContent = state.confirmDelete ? 'Yes, clear everything' : 'Clear all data';
  $('deleteNote').hidden = !state.confirmDelete;
}

function renderRestore() {
  $('restoreBtn').textContent = state.confirmRestore ? 'Choose backup file' : 'Restore from backup';
  $('restoreNote').hidden = !state.confirmRestore;
}

$('openSettings').addEventListener('click', openSettings);
$('setupBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('settingsError');
  const seller_name = $('sellerName').value.trim().slice(0, 60) || null;
  const upi = $('upiId').value.trim();
  const rate_one = Number($('rateOneInput').value);
  const rate_half = Number($('rateHalfInput').value);
  const bad = (r) => !Number.isInteger(r) || r < 1 || r > 10000;
  let problem = '';
  if (upi && !UPI_PATTERN.test(upi)) problem = 'That UPI ID doesn\'t look right. It should look like name@bank, for example raju@okaxis.';
  else if (bad(rate_one) || bad(rate_half)) problem = 'Enter each rate as a whole number of rupees between 1 and 10,000.';
  const reminder_time = $('reminderTime').value || '08:00';
  let reminder_on = native && $('reminderOn').checked;
  if (problem) { err.textContent = problem; err.hidden = false; return; }
  err.hidden = true;

  const prev = state.household;
  $('saveSettings').disabled = true;
  try {
    if (reminder_on && !prev.reminder_on && !(await allowReminders())) {
      reminder_on = false;
      $('reminderOn').checked = false;
      err.textContent = "Notifications are off for Milk Ledger. Turn them on in your phone's Settings → Apps → Milk Ledger → Notifications, then try again.";
      err.hidden = false;
      return;
    }
    state.household = await state.store.saveHousehold({ seller_name, upi_id: upi || null, rate_one, rate_half, reminder_on, reminder_time });
    refreshReminders();
    if ($('repriceMonth').checked) {
      const { y, m } = state;
      if (rate_one !== prev.rate_one) await state.store.repriceMonth(y, m, 'one', rate_one);
      if (rate_half !== prev.rate_half) await state.store.repriceMonth(y, m, 'half', rate_half);
      await loadMonth();
    }
    closeSettings();
    render();
    toast('Settings saved.');
  } catch (ex) {
    err.textContent = "Couldn't save. " + friendly(ex);
    err.hidden = false;
  } finally {
    $('saveSettings').disabled = false;
  }
});

$('backupBtn').addEventListener('click', async () => {
  $('backupBtn').disabled = true;
  try {
    await exportBackup();
  } catch (ex) {
    toast("Couldn't back up your data. " + friendly(ex));
  } finally {
    $('backupBtn').disabled = false;
  }
});

$('restoreBtn').addEventListener('click', () => {
  if (!state.confirmRestore) { state.confirmRestore = true; renderRestore(); return; }
  $('restoreFile').click();
});

$('restoreFile').addEventListener('change', async () => {
  const file = $('restoreFile').files[0];
  $('restoreFile').value = '';
  if (!file) return;
  try {
    await restoreBackup(file);
    toast('Restored. Reopening the ledger…');
    setTimeout(() => location.reload(), 600);
  } catch (ex) {
    toast("Couldn't restore that backup. " + friendly(ex));
    state.confirmRestore = false;
    renderRestore();
  }
});

$('deleteBtn').addEventListener('click', async () => {
  if (!state.confirmDelete) { state.confirmDelete = true; renderDelete(); return; }
  $('deleteBtn').disabled = true;
  try {
    await state.store.deleteAccount();
    state.household = await state.store.household();
    turnOffAi();
    refreshReminders();
    closeSettings();
    await loadMonth();
    toast('All your records were cleared.');
  } catch (ex) {
    toast("Couldn't clear your data. " + friendly(ex));
  } finally {
    $('deleteBtn').disabled = false;
  }
});

// ---------- Links and back button ----------
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-link]');
  if (!a) return;
  e.preventDefault();
  const url = a.dataset.link === 'privacy' ? PRIVACY_URL : TERMS_URL;
  if (native) AppLauncher.openUrl({ url }); else window.open(url, '_blank', 'noopener');
});

if (native) {
  App.addListener('backButton', () => {
    if (!$('screen-settings').hidden) closeSettings();
    else if (!$('paidChoice').hidden) $('paidCancel').click();
    else App.exitApp();
  });
}

// ---------- Start ----------
$('enterBtn').addEventListener('click', () => enterApp(localStore()));
show('signin');
if (native) {
  // A reminder button can be tapped before the ledger is open; open it first.
  initReminders(async (day, status) => {
    if (!state.store) await enterApp(localStore());
    await answerReminder(day, status);
  }).catch(() => {});
}
