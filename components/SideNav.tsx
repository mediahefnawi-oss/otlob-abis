import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Logo } from './ui';
import { useStore, useMe, logout } from '../lib/store';
import { useNav } from '../lib/wide';
import { navigationRef } from '../lib/nav';

const ROLE: Record<string, string> = { admin: 'المالك', supervisor: 'مشرف', provider: 'مقدم خدمة', courier: 'مندوب', customer: 'عميل' };

/** Computer view: side menu replacing the bottom tab bar (shown only on wide web windows). */
export function SideNav() {
  useStore(); // re-render when the theme changes
  const me = useMe();
  const nav = useNav();
  if (!nav || !me) return null;

  const open = (k: string) => {
    if (navigationRef.isReady() && navigationRef.getCurrentRoute()?.name !== 'Main') navigationRef.navigate('Main');
    nav.go(k);
  };

  return (
    <View style={{ width: 250, backgroundColor: C.dark, paddingTop: 22, paddingBottom: 16, paddingHorizontal: 14 }}>
      <View style={{ alignItems: 'center', marginBottom: 22 }}><Logo width={150} /></View>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {nav.items.map((t) => {
          const a = t.key === nav.active;
          return (
            <Pressable
              key={t.key}
              onPress={() => open(t.key)}
              style={({ hovered }: any) => ({
                flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, marginBottom: 4,
                backgroundColor: a ? 'rgba(255,255,255,0.10)' : hovered ? 'rgba(255,255,255,0.05)' : 'transparent',
                borderRightWidth: 4, borderRightColor: a ? C.gold : 'transparent',
              })}
            >
              <Icon name={a ? t.icon : t.icon + '-outline'} size={20} color={a ? C.gold : '#BFD3CA'} />
              <T w={a ? 'bold' : 'semi'} size={14} color={a ? C.gold : '#BFD3CA'} style={{ flex: 1 }}>{t.label}</T>
              {!!t.badge && (
                <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
                  <T w="black" size={11} color={C.dark} align="center">{t.badge}</T>
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)', paddingTop: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.dark3, borderWidth: 2, borderColor: C.gold, alignItems: 'center', justifyContent: 'center' }}>
          <T w="black" size={16} color={C.gold} align="center">{(me.name || '؟').trim().charAt(0)}</T>
        </View>
        <View style={{ flex: 1 }}>
          <T w="bold" size={13} color="#fff" numberOfLines={1}>{me.name}</T>
          <T size={11} color="#BFD3CA">{ROLE[me.role] || ''}</T>
        </View>
        <Pressable onPress={() => logout()} accessibilityLabel="تسجيل الخروج" style={{ padding: 8 }}>
          <Icon name="log-out-outline" size={20} color="#BFD3CA" />
        </Pressable>
      </View>
    </View>
  );
}
