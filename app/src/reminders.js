import { LocalNotifications } from '@capacitor/local-notifications';

// Daily "Did milk come today?" reminders, scheduled on the phone for the next two weeks and
// refreshed whenever the app is used. Days already marked, and days milk usually doesn't come,
// get no reminder.

const ACTION_TYPE = 'milk-today';
const DAYS_AHEAD = 14;
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export async function initReminders(onAnswer) {
  await LocalNotifications.registerActionTypes({
    types: [{ id: ACTION_TYPE, actions: [{ id: 'y', title: 'Received' }, { id: 'n', title: 'Not received' }] }],
  });
  await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const day = e.notification?.extra?.day;
    if (day && (e.actionId === 'y' || e.actionId === 'n')) onAnswer(day, e.actionId);
  });
}

/** Asks for notification permission if needed. Resolves true when reminders can be shown. */
export async function allowReminders() {
  let p = await LocalNotifications.checkPermissions();
  if (p.display !== 'granted' && p.display !== 'denied') p = await LocalNotifications.requestPermissions();
  return p.display === 'granted';
}

export async function cancelReminders() {
  const { notifications } = await LocalNotifications.getPending();
  if (notifications.length) await LocalNotifications.cancel({ notifications: notifications.map((n) => ({ id: n.id })) });
}

/**
 * Replace the scheduled reminders. `time` is "HH:MM"; `skip(date)` returns true for days that
 * need no reminder (already marked, or a usual no-milk day).
 */
export async function scheduleReminders(time, skip) {
  await cancelReminders();
  const [hh, mm] = time.split(':').map(Number);
  const now = new Date();
  const notifications = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm);
    if (at <= now || skip(at)) continue;
    const day = isoOf(at);
    notifications.push({
      id: Number(day.replace(/-/g, '')),
      title: 'Did milk come today?',
      body: 'Tap Received or Not received, or open Milk Ledger to mark it.',
      schedule: { at },
      // A few minutes late is fine for this, so don't ask for exact-alarm access.
      isExactNotification: false,
      actionTypeId: ACTION_TYPE,
      extra: { day },
    });
  }
  if (notifications.length) await LocalNotifications.schedule({ notifications });
}
