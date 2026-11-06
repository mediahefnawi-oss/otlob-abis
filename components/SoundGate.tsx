import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Platform } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, toast } from './ui';
import { useMe } from '../lib/store';
import { soundReady, soundSupported, subscribeSound, enableSound, playNewOrderSound } from '../lib/alerts';
import { PushState, pushState, enablePush, autoEnablePush, openPushSettings } from '../lib/push';

/** Shops and couriers: browsers keep the page silent until it is tapped once, and ask permission for notifications. */
export function SoundGate() {
  const me = useMe();
  const [ready, setReady] = useState(soundReady());
  const [push, setPush] = useState<PushState>('unsupported');
  const refresh = useCallback(() => { pushState().then(setPush).catch(() => {}); }, []);
  useEffect(() => subscribeSound(() => setReady(soundReady())), []);
  useEffect(refresh, [refresh, me?.id]);
  const native = Platform.OS !== 'web';
  // phone app: ask for the permission as soon as the app opens and keep registering by itself until it works
  useEffect(() => {
    if (!native || !me?.id) return;
    let dead = false;
    const run = async () => { await autoEnablePush(); if (!dead) refresh(); };
    run();
    const t = setInterval(run, 20000);
    return () => { dead = true; clearInterval(t); };
  }, [native, me?.id, refresh]);

  if (!me) return null;
  if (!native && !['provider', 'courier'].includes(me.role)) return null;
  const needSound = soundSupported() && !ready;
  const needPush = push === 'off' || (native && push === 'denied');
  if (!needSound && !needPush) return null;
  return (
    <Pressable
      onPress={async () => {
        if (native && push === 'denied') { await openPushSettings(); return; }
        const ok = await enableSound();
        if (needPush) {
          const r = await enablePush();
          if (!r.ok && r.error) toast(r.error, 'err'); else if (r.ok && !soundSupported()) toast('تم تفعيل الإشعارات 🔔');
        }
        if (ok) { playNewOrderSound(); toast('تم تفعيل التنبيهات 🔔'); }
        refresh();
      }}
      style={{ backgroundColor: C.gold, paddingVertical: 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}
    >
      <Icon name="notifications" size={18} color={C.dark} />
      <T w="bold" size={13} color={C.dark} style={{ flex: 1 }}>
        {native && push === 'denied' ? 'الإشعارات مقفولة: اضغط لفتح الإعدادات وفعّلها' : `اضغط هنا لتفعيل $${needSound && needPush ? 'صوت وإشعارات' : needSound ? 'صوت تنبيه' : 'إشعارات'} الطلبات الجديدة`}
      </T>
    </Pressable>
  );
}
