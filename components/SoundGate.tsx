import React, { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, toast } from './ui';
import { useMe } from '../lib/store';
import { soundReady, soundSupported, subscribeSound, enableSound, playNewOrderSound } from '../lib/alerts';

/** Shops and couriers: browsers keep the page silent until it is tapped once. This bar asks for that tap. */
export function SoundGate() {
  const me = useMe();
  const [ready, setReady] = useState(soundReady());
  useEffect(() => subscribeSound(() => setReady(soundReady())), []);
  if (!me || !['provider', 'courier'].includes(me.role) || !soundSupported() || ready) return null;
  return (
    <Pressable
      onPress={async () => {
        const ok = await enableSound();
        if (ok) { playNewOrderSound(); toast('تم تفعيل صوت تنبيه الطلبات 🔔'); }
      }}
      style={{ backgroundColor: C.gold, paddingVertical: 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}
    >
      <Icon name="notifications" size={18} color={C.dark} />
      <T w="bold" size={13} color={C.dark} style={{ flex: 1 }}>اضغط هنا لتفعيل صوت تنبيه الطلبات الجديدة</T>
    </Pressable>
  );
}
