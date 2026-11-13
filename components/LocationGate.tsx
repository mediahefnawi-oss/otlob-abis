import React, { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { C } from '../lib/theme';
import { CenterNotice } from './CenterNotice';
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
    <CenterNotice
      visible
      icon="location"
      title="فعّل الموقع"
      message="عشان نحدد مكانك تلقائياً"
      primary={{ label: 'الإعدادات', onPress: openLocationSettings }}
      onClose={() => setHidden(true)}
    />
  );
}
