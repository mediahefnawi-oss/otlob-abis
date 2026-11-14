import React, { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { C } from '../lib/theme';
import { CenterNotice } from './CenterNotice';
import { T, Icon } from './ui';
import { useMe, useMapOn, useStore, updateProfile, setCartDest } from '../lib/store';
import { storage } from '../lib/storage';
import { reverseAddress } from '../lib/revgeo';
import { askLocationAccess, openLocationSettings, getPosition, LocAccess } from '../lib/location';

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
  const { db } = useStore();
  const required = db.settings.map?.required !== false; // owner switch "تحديد الموقع إجباري"
  // when the location is required: the first time, the address written on the home page comes from the phone's location (after that it stays as it is)
  useEffect(() => {
    if (!on || !required || me?.role !== 'customer' || access !== 'granted') return;
    const key = `addrAuto_${me.id}`;
    let dead = false;
    (async () => {
      try {
        if (await storage.getItem(key)) return;
        const p = await getPosition();
        if (dead) return;
        setCartDest({ pin: { lat: p.lat, lng: p.lng } });
        const a = await reverseAddress(p.lat, p.lng);
        if (dead || !a) return;
        const r = await updateProfile({ address: a });
        if (r.ok) await storage.setItem(key, '1');
      } catch { /* tried again next time the app opens */ }
    })();
    return () => { dead = true; };
  }, [on, required, me?.id, me?.role, access]);
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
