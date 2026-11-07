import React, { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon } from './ui';
import { useMe, useMapOn } from '../lib/store';
import { askLocationAccess, openLocationSettings, LocAccess } from '../lib/location';

/**
 * Customers (phone app): when the map is on, the location permission is asked for as soon as the customer is signed in.
 * If it stays off, a small bar explains why it helps and opens the phone settings; it can be dismissed and does not nag.
 * The customer can always order with a typed address and a pin chosen by hand, and can watch the courier on the map either way.
 */
export function LocationGate() {
  const me = useMe();
  const on = useMapOn();
  const [access, setAccess] = useState<LocAccess>('unsupported');
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!on || me?.role !== 'customer') return;
    let dead = false;
    askLocationAccess().then((a) => { if (!dead) setAccess(a); });
    return () => { dead = true; };
  }, [on, me?.id, me?.role]);
  if (!on || me?.role !== 'customer' || access !== 'denied' || hidden) return null;
  return (
    <Pressable onPress={openLocationSettings} style={{ backgroundColor: C.goldSoft, paddingVertical: 9, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="location" size={18} color={C.goldDeep} />
      <T w="bold" size={12.5} color={C.goldDeep} style={{ flex: 1 }}>فعّل الموقع من الإعدادات لتحديد مكانك تلقائياً (أو اختر مكانك من الخريطة)</T>
      <Pressable onPress={() => setHidden(true)} hitSlop={10}><Icon name="close" size={18} color={C.goldDeep} /></Pressable>
    </Pressable>
  );
}
