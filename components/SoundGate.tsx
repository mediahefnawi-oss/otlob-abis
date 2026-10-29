import React, { useCallback, useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, toast } from './ui';
import { useMe } from '../lib/store';
import { soundReady, soundSupported, subscribeSound, enableSound, playNewOrderSound } from '../lib/alerts';
import { PushState, pushState, enablePush } from '../lib/push';

/** Shops and couriers: browsers keep the page silent until it is tapped once, and ask permission for notifications. */
export function SoundGate() {
  const me = useMe();
  const [ready, setReady] = useState(soundReady());
  const [push, setPush] = useState<PushState>('unsupported');
  const refresh = useCallback(() => { pushState().then(setPush).catch(() => {}); }, []);
  useEffect(() => subscribeSound(() => setReady(soundReady())), []);
  useEffect(refresh, [refresh, me?.id]);

  if (!me || !['provider', 'courier'].includes(me.role)) return null;
  const needSound = soundSupported() && !ready;
  const needPush = push === 'off';
  if (!needSound && !needPush) return null;
  return (
    <Pressable
      onPress={async () => {
        const ok = await enableSound();
        if (needPush) {
          const r = await enablePush();
          if (!r.ok && r.error) toast(r.error, 'err');
        }
        if (ok) { playNewOrderSound(); toast('تم تفعيل التنبيهات 🔔'); }
        refresh();
      }}
      style={{ backgroundColor: C.gold, paddingVertical: 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}
    >
      <Icon name="notifications" size={18} color={C.dark} />
      <T w="bold" size={13} color={C.dark} style={{ flex: 1 }}>
        اضغط هنا لتفعيل {needSound && needPush ? 'صوت وإشعارات' : needSound ? 'صوت تنبيه' : 'إشعارات'} الطلبات الجديدة
      </T>
    </Pressable>
  );
}
