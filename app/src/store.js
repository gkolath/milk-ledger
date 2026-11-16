const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const monthStart = (y, m) => isoDay(y, m, 1);
export const monthEnd = (y, m) => isoDay(y, m, new Date(y, m + 1, 0).getDate());

const LOCAL_KEY = 'milkledger.v1';

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt or unavailable storage: start fresh */ }
  return null;
}

// Persists entirely on this device, via localStorage. No account, no sync.
export function localStore() {
  const saved = loadLocal();
  let household = saved?.household ?? { seller_name: null, upi_id: null, rate_one: 70, rate_half: 35 };
  const rows = new Map(saved?.deliveries ?? []);
  let payments = saved?.payments ?? [];
  const key = (day, kind) => `${day}|${kind}`;
  const inMonth = (day, y, m) => day >= monthStart(y, m) && day <= monthEnd(y, m);
  const persist = () => localStorage.setItem(LOCAL_KEY, JSON.stringify({ household, deliveries: [...rows], payments }));
  return {
    async household() { return { ...household }; },
    async saveHousehold(patch) { household = { ...household, ...patch }; persist(); return { ...household }; },
    async deliveries(y, m) { return [...rows.values()].filter((r) => inMonth(r.day, y, m)).map((r) => ({ ...r })); },
    async allDeliveries() { return [...rows.values()].map((r) => ({ ...r })); },
    async setDeliveries(list) { list.forEach((r) => rows.set(key(r.day, r.kind), { ...r })); persist(); },
    async clearDelivery(day, kind) { rows.delete(key(day, kind)); persist(); },
    async clearMonth(y, m) { [...rows.keys()].forEach((k) => inMonth(k.split('|')[0], y, m) && rows.delete(k)); persist(); },
    async repriceMonth(y, m, kind, rate) {
      rows.forEach((r) => { if (r.kind === kind && r.status === 'y' && inMonth(r.day, y, m)) r.rate = rate; });
      persist();
    },
    async payments(y, m) { return payments.filter((p) => p.month === monthStart(y, m)).map((p) => ({ ...p })); },
    async addPayment(y, m, amount, method) {
      const p = { id: crypto.randomUUID(), month: monthStart(y, m), amount, method, paid_at: new Date().toISOString() };
      payments.push(p);
      persist();
      return { ...p };
    },
    async removePayment(id) { payments = payments.filter((p) => p.id !== id); persist(); },
    async deleteAccount() {
      household = { seller_name: null, upi_id: null, rate_one: 70, rate_half: 35 };
      rows.clear();
      payments = [];
      persist();
    },
  };
}
