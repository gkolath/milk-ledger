import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { AppLauncher } from '@capacitor/app-launcher';
import { Share } from '@capacitor/share';
import { SocialLogin } from '@capgo/capacitor-social-login';
import { supabase, remoteStore, demoStore, isoDay } from './store.js';
import { GOOGLE_WEB_CLIENT_ID, PRIVACY_URL, TERMS_URL, SUPPORT_EMAIL, UPI_PATTERN } from './config.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LITRES = { one: 1, half: 0.5 };
const native = Capacitor.isNativePlatform();
const demo = !native && new URLSearchParams(location.search).has('demo');

const $ = (id) => document.getElementById(id);
const rupees = (n) => '₹' + n.toLocaleString('en-IN');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const today = new Date();

const state = {
  store: null,
  email: '',
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
  confirmRemove: null,
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

// ---------- Sign in ----------
let socialReady = null;
function initSocial() {
  socialReady ??= SocialLogin.initialize({ google: { webClientId: GOOGLE_WEB_CLIENT_ID } });
  return socialReady;
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function signIn() {
  const err = $('signinError');
  err.hidden = true;
  $('googleBtn').disabled = true;
  try {
    await initSocial();
    // Google gets the hashed nonce; Supabase gets the raw one and checks they match.
    const rawNonce = randomNonce();
    const res = await SocialLogin.login({ provider: 'google', options: { nonce: await sha256Hex(rawNonce) } });
    const idToken = res?.result?.idToken;
    if (!idToken) throw new Error('Google did not return a sign-in token. Try again.');
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken, nonce: rawNonce });
    if (error) throw error;
  } catch (e) {
    if (e?.code === 'USER_CANCELLED') return;
    err.textContent = /no credentials/i.test(String(e?.message))
      ? 'No Google account found on this phone. Add one in your phone\'s Settings → Passwords & accounts, then try again.'
      : 'Sign-in failed. ' + friendly(e);
    err.hidden = false;
  } finally {
    $('googleBtn').disabled = false;
  }
}

async function signOut() {
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  if (native) await initSocial().then(() => SocialLogin.logout({ provider: 'google' })).catch(() => {});
}

// ---------- Data ----------
async function enterApp(email, store) {
  state.email = email;
  state.store = store;
  show('loading');
  try {
    state.household = await store.household();
  } catch (e) {
    show('signin');
    $('signinError').textContent = friendly(e);
    $('signinError').hidden = false;
    return;
  }
  show('main');
  render();
  await loadMonth();
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
  return writeChain;
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

// A date is "not delivered" only when no milk came at all that day.
function missedDates() {
  const days = new Set([...Object.keys(state.marks.one), ...Object.keys(state.marks.half)].map(Number));
  return [...days]
    .filter((d) => state.marks.one[d] !== 'y' && state.marks.half[d] !== 'y')
    .filter((d) => state.marks.one[d] === 'n' || state.marks.half[d] === 'n')
    .sort((a, b) => a - b);
}

// ---------- Render ----------
function render() {
  const { y, m, kind } = state;
  const h = state.household;
  const marks = state.marks[kind];
  const n = daysIn(y, m);

  $('setupCard').hidden = Boolean(h.upi_id);
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
  $('fillBtn').disabled = blank === 0;
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

function goMonth(delta) {
  const d = new Date(state.y, state.m + delta, 1);
  state.y = d.getFullYear();
  state.m = d.getMonth();
  state.marks = { one: {}, half: {} };
  state.rates = { one: {}, half: {} };
  state.payments = [];
  state.confirmClear = false;
  render();
  loadMonth();
}
$('prevMonth').addEventListener('click', () => goMonth(-1));
$('nextMonth').addEventListener('click', () => goMonth(1));

$('fillBtn').addEventListener('click', () => {
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
  const text = billMessage();
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
  $('repriceMonthName').textContent = MONTHS[state.m];
  $('accountEmail').textContent = state.email;
  $('supportEmail').textContent = SUPPORT_EMAIL;
  $('settingsError').hidden = true;
  state.confirmDelete = false;
  renderDelete();
  $('screen-settings').hidden = false;
}
function closeSettings() { $('screen-settings').hidden = true; }
function renderDelete() {
  $('deleteBtn').classList.toggle('armed', state.confirmDelete);
  $('deleteBtn').textContent = state.confirmDelete ? 'Yes, delete everything' : 'Delete my account';
  $('deleteNote').hidden = !state.confirmDelete;
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
  if (problem) { err.textContent = problem; err.hidden = false; return; }
  err.hidden = true;

  const prev = state.household;
  $('saveSettings').disabled = true;
  try {
    state.household = await state.store.saveHousehold({ seller_name, upi_id: upi || null, rate_one, rate_half });
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

$('signOutBtn').addEventListener('click', async () => {
  closeSettings();
  await signOut();
  if (demo) location.reload();
});

$('deleteBtn').addEventListener('click', async () => {
  if (!state.confirmDelete) { state.confirmDelete = true; renderDelete(); return; }
  $('deleteBtn').disabled = true;
  try {
    await state.store.deleteAccount();
    closeSettings();
    await signOut();
    toast('Your account and all its records were deleted.');
    if (demo) location.reload();
  } catch (ex) {
    toast("Couldn't delete the account. " + friendly(ex));
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
$('googleBtn').addEventListener('click', signIn);

if (demo) {
  enterApp('demo@example.com', demoStore());
} else {
  let currentId; // undefined until the first auth event, so a signed-out start still shows sign-in
  supabase.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;
    if (currentId !== undefined && (user?.id ?? null) === currentId) return;
    currentId = user?.id ?? null;
    // Supabase asks that no other Supabase calls run inside this callback.
    setTimeout(() => {
      if (user) enterApp(user.email || '', remoteStore(user.id));
      else { state.store = null; show('signin'); }
    }, 0);
  });
  if (native) initSocial().catch(() => {});
}
