import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const monthStart = (y, m) => isoDay(y, m, 1);
export const monthEnd = (y, m) => isoDay(y, m, new Date(y, m + 1, 0).getDate());

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// Talks to Supabase. Row-level security limits every query to the signed-in household.
export function remoteStore(userId) {
  return {
    async household() {
      const row = check(await supabase.from('households').select('*').maybeSingle());
      if (row) return row;
      return check(await supabase.from('households').insert({ user_id: userId }).select().single());
    },
    async saveHousehold(patch) {
      return check(
        await supabase
          .from('households')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .select()
          .single(),
      );
    },
    async deliveries(y, m) {
      return check(
        await supabase
          .from('deliveries')
          .select('day, kind, status, rate')
          .gte('day', monthStart(y, m))
          .lte('day', monthEnd(y, m)),
      );
    },
    async setDeliveries(rows) {
      const now = new Date().toISOString();
      check(
        await supabase
          .from('deliveries')
          .upsert(rows.map((r) => ({ ...r, user_id: userId, updated_at: now })), { onConflict: 'user_id,day,kind' }),
      );
    },
    async clearDelivery(day, kind) {
      check(await supabase.from('deliveries').delete().eq('day', day).eq('kind', kind));
    },
    async clearMonth(y, m) {
      check(await supabase.from('deliveries').delete().gte('day', monthStart(y, m)).lte('day', monthEnd(y, m)));
    },
    async repriceMonth(y, m, kind, rate) {
      check(
        await supabase
          .from('deliveries')
          .update({ rate })
          .eq('kind', kind)
          .eq('status', 'y')
          .gte('day', monthStart(y, m))
          .lte('day', monthEnd(y, m)),
      );
    },
    async payments(y, m) {
      return check(
        await supabase.from('payments').select('id, amount, method, paid_at').eq('month', monthStart(y, m)).order('paid_at'),
      );
    },
    async addPayment(y, m, amount, method) {
      return check(
        await supabase.from('payments').insert({ user_id: userId, month: monthStart(y, m), amount, method }).select().single(),
      );
    },
    async removePayment(id) {
      check(await supabase.from('payments').delete().eq('id', id));
    },
    async deleteAccount() {
      check(await supabase.rpc('delete_my_account'));
    },
  };
}

// In-memory stand-in for trying the screens in a desktop browser (?demo). Never used in the app build.
export function demoStore() {
  let household = { seller_name: 'Raju', upi_id: 'raju.milk@okaxis', rate_one: 70, rate_half: 35 };
  const rows = new Map();
  const payments = [];
  const key = (day, kind) => `${day}|${kind}`;
  const inMonth = (day, y, m) => day >= monthStart(y, m) && day <= monthEnd(y, m);
  const today = new Date();
  for (let d = 1; d < today.getDate(); d++) {
    const day = isoDay(today.getFullYear(), today.getMonth(), d);
    rows.set(key(day, 'one'), { day, kind: 'one', status: d % 9 === 0 ? 'n' : 'y', rate: 70 });
  }
  return {
    async household() { return { ...household }; },
    async saveHousehold(patch) { household = { ...household, ...patch }; return { ...household }; },
    async deliveries(y, m) { return [...rows.values()].filter((r) => inMonth(r.day, y, m)).map((r) => ({ ...r })); },
    async setDeliveries(list) { list.forEach((r) => rows.set(key(r.day, r.kind), { ...r })); },
    async clearDelivery(day, kind) { rows.delete(key(day, kind)); },
    async clearMonth(y, m) { [...rows.keys()].forEach((k) => inMonth(k.split('|')[0], y, m) && rows.delete(k)); },
    async repriceMonth(y, m, kind, rate) {
      rows.forEach((r) => { if (r.kind === kind && r.status === 'y' && inMonth(r.day, y, m)) r.rate = rate; });
    },
    async payments(y, m) { return payments.filter((p) => p.month === monthStart(y, m)).map((p) => ({ ...p })); },
    async addPayment(y, m, amount, method) {
      const p = { id: crypto.randomUUID(), month: monthStart(y, m), amount, method, paid_at: new Date().toISOString() };
      payments.push(p);
      return { ...p };
    },
    async removePayment(id) { const i = payments.findIndex((p) => p.id === id); if (i >= 0) payments.splice(i, 1); },
    async deleteAccount() {},
  };
}
