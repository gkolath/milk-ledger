import { LocalNotifications } from '@capacitor/local-notifications';

// Daily "Did milk come today?" reminders. Today gets an always-current notification the moment
// it needs marking — no waiting for a scheduled time, so it works like a home-screen quick
// action. Tomorrow onward is scheduled for the next two weeks at the household's chosen time.
// Days already marked, and days milk usually doesn't come, get no reminder.

const ACTION_TYPE = 'milk-today';
const DAYS_AHEAD = 14;
const TODAY_ID = 1; // fixed id for the always-current "today" notification; scheduled days use date-based ids
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
  await LocalNotifications.cancelAll();
  await LocalNotifications.removeAllDeliveredNotifications();
}

/**
 * Replace the scheduled reminders for tomorrow onward. `time` is "HH:MM"; `skip(date)` returns
 * true for days that need no reminder (already marked, or a usual no-milk day). Today is handled
 * separately by `ensureTodayNotification`, so it isn't scheduled here.
 */
export async function scheduleReminders(time, skip) {
  const { notifications: pending } = await LocalNotifications.getPending();
  if (pending.length) await LocalNotifications.cancel({ notifications: pending.map((n) => ({ id: n.id })) });
  const [hh, mm] = time.split(':').map(Number);
  const now = new Date();
  const notifications = [];
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm);
    if (skip(at)) continue;
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

/**
 * Keep a single always-current "today" notification in the shade whenever today needs marking —
 * no scheduled time, so it works as a quick action from the notification shade or lock screen
 * without opening the app. Removed as soon as today is marked (from here, the app, or the
 * notification's own buttons).
 */
export async function ensureTodayNotification(needsMarking) {
  if (!needsMarking) {
    await LocalNotifications.removeDeliveredNotificationsById({ ids: [TODAY_ID] });
    return;
  }
  const { notifications } = await LocalNotifications.getDeliveredNotifications();
  if (notifications.some((n) => n.id === TODAY_ID)) return; // already showing; don't re-alert
  await LocalNotifications.schedule({
    notifications: [{
      id: TODAY_ID,
      title: 'Did milk come today?',
      body: 'Tap Received or Not received, or open Milk Ledger to mark it.',
      actionTypeId: ACTION_TYPE,
      ongoing: true,
      autoCancel: false,
      extra: { day: isoOf(new Date()) },
    }],
  });
}
