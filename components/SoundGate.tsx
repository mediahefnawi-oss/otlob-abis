import React, { useCallback, useEffect, useState } from 'react';
import { Platform, View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { toast, T, Icon } from './ui';
import { useMe, isGuestId } from '../lib/store';
import { soundReady, soundSupported, subscribeSound, enableSound, playNewOrderSound } from '../lib/alerts';
import { PushState, pushState, enablePush, autoEnablePush, openPushSettings } from '../lib/push';

/** Shops and couriers: browsers keep the page silent until it is tapped once, and ask permission for notifications. */
export function SoundGate() {
  const me = useMe();
  const [ready, setReady] = useState(soundReady());
  const [push, setPush] = useState<PushState>('unsupported');
  const [hide, setHide] = useState(false); // must stay above every early return: hooks have to run in the same order each render
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

  if (!me || isGuestId(me.id)) return null; // a visitor has no account to attach this phone to: ask after he signs in, never show an error before
  const staff = ['provider', 'courier'].includes(me.role);
  const needSound = staff && soundSupported() && !ready;
  const needPush = push === 'off' || (native && push === 'denied');
  if (!needSound && !needPush) return null;
  const act = async () => {
    if (native && push === 'denied') { await openPushSettings(); return; }
    const ok = staff ? await enableSound() : true;
    if (needPush) {
      const r = await enablePush();
      if (!r.ok && r.error) toast(r.error, 'err'); else if (r.ok && !soundSupported()) toast('تم تفعيل الإشعارات 🔔');
    }
    if (ok && staff) { playNewOrderSound(); toast('تم تفعيل التنبيهات 🔔'); }
    refresh();
  };
  const denied = native && push === 'denied';
  if (hide) return null;
  // a slim bar in the page flow (not a popup in the middle): it does not cover anything and the person can close it
  return (
    <View style={{ backgroundColor: '#FFF4CC', borderBottomWidth: 1, borderBottomColor: '#F2D98A', paddingVertical: 7, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon name="notifications" size={18} color={C.goldDeep} />
      <T w="bold" size={12.5} color={C.text} style={{ flex: 1 }}>{denied ? 'الإشعارات مقفولة — فعّلها من إعدادات الجهاز' : staff ? 'فعّل التنبيهات عشان توصلك الطلبات فوراً' : 'فعّل التنبيهات عشان توصلك العروض وأخبار طلبك'}</T>
      <Pressable onPress={act} style={{ backgroundColor: C.gold, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 14 }}>
        <T w="black" size={12.5} color={C.dark}>{denied ? 'فتح الإعدادات' : 'تفعيل'}</T>
      </Pressable>
      <Pressable onPress={() => setHide(true)} hitSlop={10}><Icon name="close" size={18} color={C.sub} /></Pressable>
    </View>
  );
}
