import React, { useEffect, useState } from 'react';
import { Pressable, View, Linking, Platform } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon } from './ui';
import { useStore } from '../lib/store';
import { storage } from '../lib/storage';
import { APP_VERSION, cmpVersion } from '../lib/version';

const KEY = 'otlob_abis_update_dismissed_v1';

/** The owner announced a newer version: everyone (customers, shops, couriers, staff) sees this until they update. */
export function UpdateBanner() {
  const { db } = useStore();
  const u = db.settings.update;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => { storage.getItem(KEY).then((v) => setDismissed(v || '')).catch(() => setDismissed('')); }, []);
  if (!u || !u.version || cmpVersion(u.version, APP_VERSION) <= 0) return null;
  if (dismissed === null) return null;
  if (!u.required && dismissed === u.version) return null;
  const apk = db.settings.apkUrl || '';
  const update = () => {
    if (Platform.OS === 'web') { try { (window as any).location.reload(); } catch {} return; }
    if (apk) Linking.openURL(apk).catch(() => {});
  };
  const later = () => { setDismissed(u.version); storage.setItem(KEY, u.version).catch(() => {}); };
  const canUpdate = Platform.OS === 'web' || !!apk;
  return (
    <View style={{ backgroundColor: u.required ? C.red : C.dark, paddingVertical: 10, paddingHorizontal: 14, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="cloud-download" size={20} color={C.gold} />
        <View style={{ flex: 1 }}>
          <T w="black" size={13.5} color="#fff">{u.required ? 'تحديث مطلوب للتطبيق' : 'تحديث جديد متاح'} ({u.version})</T>
          {!!u.message && <T size={12} color="#E6EEE9">{u.message}</T>}
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {canUpdate && <Pressable onPress={update} hitSlop={10} style={{ backgroundColor: C.gold, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 }}><T w="black" size={12.5} color={C.dark}>{Platform.OS === 'web' ? 'تحديث الصفحة' : 'تحديث الآن'}</T></Pressable>}
        {!u.required && <Pressable onPress={later} hitSlop={10} style={{ paddingHorizontal: 12, paddingVertical: 8 }}><T size={12.5} color="#C9D8D2">لاحقاً</T></Pressable>}
      </View>
    </View>
  );
}
