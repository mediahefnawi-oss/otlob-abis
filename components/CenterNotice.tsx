import React from 'react';
import { View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon } from './ui';

/** A small dark message in the middle of the screen. It does not dim or block the app behind it. */
export function CenterNotice({ visible, icon, title, message, primary, onClose }: {
  visible: boolean; icon: string; tone?: 'red' | 'gold'; title: string; message?: string;
  primary: { label: string; onPress: () => void }; secondary?: { label: string; onPress: () => void }; onClose: () => void;
}) {
  if (!visible) return null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, zIndex: 999, elevation: 999 }}>
      <View style={{ backgroundColor: C.dark, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%', maxWidth: 340, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 12 }}>
        <Icon name={icon as any} size={22} color={C.gold} />
        <View style={{ flex: 1 }}>
          <T w="bold" size={14} color="#fff">{title}</T>
          {!!message && <T size={12} color="#B8CFC6">{message}</T>}
        </View>
        <Pressable onPress={primary.onPress} style={{ backgroundColor: C.gold, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12 }}>
          <T w="black" size={13} color={C.dark}>{primary.label}</T>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={10}>
          <Icon name="close" size={18} color="#8FB0A4" />
        </Pressable>
      </View>
    </View>
  );
}
