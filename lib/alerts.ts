import { Platform } from 'react-native';

/**
 * New-order alerts for shops and couriers (web): a ding-dong sound, vibration, a flashing tab title and,
 * where the browser allows it, a system notification. Works while the app is open (foreground or background tab).
 * Browsers only allow sound after the user has tapped the page once, so the app shows a banner until then.
 */
const isWeb = Platform.OS === 'web' && typeof window !== 'undefined';
const listeners = new Set<() => void>();
let ctx: any = null;

function getCtx(): any {
  if (!isWeb) return null;
  if (!ctx) {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    ctx.onstatechange = () => { listeners.forEach((l) => l()); syncAlarm(); };
  }
  return ctx;
}

export const soundSupported = () => isWeb && !!((window as any).AudioContext || (window as any).webkitAudioContext);
export const soundReady = () => !!ctx && ctx.state === 'running';
export function subscribeSound(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export async function enableSound(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  try { await c.resume(); } catch {}
  listeners.forEach((l) => l());
  try {
    if ('Notification' in window && (window as any).Notification.permission === 'default') (window as any).Notification.requestPermission().catch(() => {});
  } catch {}
  return c.state === 'running';
}

// the first tap/click anywhere unlocks the sound
if (isWeb) {
  const unlock = () => {
    const c = getCtx();
    if (!c) return;
    Promise.resolve(c.resume()).then(() => {
      listeners.forEach((l) => l());
      if (c.state === 'running') ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => window.removeEventListener(ev, unlock));
    }).catch(() => {});
  };
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));
}

function tone(c: any, freq: number, start: number, dur: number, vol = 0.4, dest?: any) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g);
  g.connect(dest || c.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

/** "ding-dong" three times (about 2.5 seconds). */
export function playNewOrderSound(): boolean {
  const c = getCtx();
  if (!c || c.state !== 'running') return false;
  const t = c.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    tone(c, 988, t + i * 0.9, 0.35);
    tone(c, 784, t + i * 0.9 + 0.3, 0.55);
  }
  return true;
}

let titleTimer: any = null;
const BASE_TITLE = 'أطلب أبيس';
function flashTitle(text: string) {
  if (!isWeb || typeof document === 'undefined') return;
  document.title = `🔔 ${text}`;
  if (titleTimer) return;
  const reset = () => {
    if (document.hidden) return;
    document.title = BASE_TITLE;
    document.removeEventListener('visibilitychange', reset);
    window.removeEventListener('focus', reset);
    titleTimer = null;
  };
  titleTimer = true;
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('focus', reset);
  if (!document.hidden) setTimeout(reset, 6000);
}

export function alertNewOrder(title: string, body: string) {
  if (!isWeb) {
    // phone app: strong vibration + a notification with sound (the phone's loudest "orders" channel) while the app is open
    try { require('react-native').Vibration.vibrate([0, 500, 150, 500, 150, 500]); } catch {}
    nativeNotify('order-new', title, body);
    return;
  }
  playNewOrderSound();
  try { (navigator as any).vibrate?.([250, 120, 250, 120, 250]); } catch {}
  flashTitle(title);
  try {
    const N = (window as any).Notification;
    if (N && N.permission === 'granted') new N(title, { body, tag: 'otlob-order' });
  } catch {}
}

/* ---------- phone app: notification with sound through expo-notifications (installed in the APK build only) ---------- */
function nativeNotify(id: string, title: string, body: string) {
  if (isWeb) return;
  try {
    const n = require('expo-notifications');
    // same identifier = the previous one is replaced, so repeating never piles notifications up
    n.scheduleNotificationAsync({ identifier: id, content: { title, body, sound: 'default', priority: 'max' }, trigger: { channelId: 'orders' } }).catch(() => {});
  } catch {}
}
function nativeClear(id: string) {
  if (isWeb) return;
  try {
    const n = require('expo-notifications');
    n.dismissNotificationAsync(id).catch(() => {});
    n.cancelScheduledNotificationAsync(id).catch(() => {});
  } catch {}
}
let nativeAlarmTimer: any = null;
function nativeAlarm(on: boolean) {
  if (on && !nativeAlarmTimer) {
    const ring = () => {
      try { require('react-native').Vibration.vibrate([0, 600, 200, 600, 200, 600]); } catch {}
      nativeNotify('order-alarm', '🔔 لديك طلب جديد لم تفتحه', 'افتح الطلب لإيقاف التنبيه');
    };
    ring();
    nativeAlarmTimer = setInterval(ring, 6000);
  } else if (!on && nativeAlarmTimer) {
    clearInterval(nativeAlarmTimer);
    nativeAlarmTimer = null;
    try { require('react-native').Vibration.cancel(); } catch {}
    nativeClear('order-alarm');
  }
}

/* ---------- continuous alarm (shops): rings until every new order has been opened ---------- */
let wantAlarm = false;
let alarmTimer: any = null;
let alarmGain: any = null;
let alarmUntil = 0;

function scheduleAlarm(c: any) {
  if (!alarmGain) return;
  // keep ~90 s of ding-dong queued on the audio clock: it keeps ringing even if the browser slows timers in a background tab
  const horizon = c.currentTime + 90;
  let t = Math.max(alarmUntil, c.currentTime + 0.05);
  while (t < horizon) {
    tone(c, 988, t, 0.35, 0.55, alarmGain);
    tone(c, 784, t + 0.3, 0.55, 0.55, alarmGain);
    t += 3.3;
  }
  alarmUntil = t;
}
function startAlarm(c: any) {
  alarmGain = c.createGain();
  alarmGain.connect(c.destination);
  alarmUntil = 0;
  scheduleAlarm(c);
  alarmTimer = setInterval(() => {
    scheduleAlarm(c);
    try { (navigator as any).vibrate?.([300, 150, 300]); } catch {}
  }, 3300);
  if (typeof document !== 'undefined') document.title = '🔔 طلب جديد — أطلب أبيس';
}
function stopAlarm() {
  if (alarmTimer) clearInterval(alarmTimer);
  alarmTimer = null;
  try { alarmGain?.disconnect(); } catch {} // everything already queued goes silent at once
  alarmGain = null;
  if (typeof document !== 'undefined') document.title = BASE_TITLE;
}
function syncAlarm() {
  if (!isWeb) return;
  const c = ctx;
  if (wantAlarm && !alarmTimer && c && c.state === 'running') startAlarm(c);
  else if (!wantAlarm && alarmTimer) stopAlarm();
}
/** on = ring until setAlarm(false). If the browser has not allowed sound yet it starts as soon as it does. */
export function setAlarm(on: boolean) {
  wantAlarm = on;
  if (!isWeb) { nativeAlarm(on); return; }
  if (on) getCtx();
  syncAlarm();
}
export const alarmActive = () => !!alarmTimer;
