import React from 'react';
import { Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon } from './ui';
import { useStore, refresh } from '../lib/store';

/** Shown only when the app could not refresh from the server (so a stale screen is never mistaken for live data). */
export function SyncBanner() {
  const { syncError, userId } = useStore();
  if (!syncError || !userId) return null;
  return (
    <Pressable onPress={() => { refresh(); }} style={{ backgroundColor: C.red, paddingVertical: 8, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="cloud-offline" size={16} color="#fff" />
      <T size={12} w="bold" color="#fff" style={{ flex: 1 }}>تعذر تحديث البيانات: {syncError} — اضغط لإعادة المحاولة</T>
    </Pressable>
  );
}
