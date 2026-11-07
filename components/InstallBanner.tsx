import React, { useEffect, useState } from 'react';
import { Pressable, View, Platform, Linking } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { C } from '../lib/theme';
import { T, Icon } from './ui';
import { useMe } from '../lib/store';
import { storage } from '../lib/storage';

const KEY = 'otlob_abis_install_banner_dismissed_v1';
const INSTALL_PAGE = '/install.html';

/** Website opened in a phone browser: a thin bar that offers the Android app. Never shown inside the installed app. */
export function InstallBanner() {
  const me = useMe();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    storage.getItem(KEY).then((v) => setDismissed(!!v)).catch(() => setDismissed(false));
  }, []);
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || dismissed !== false || !me) return null;
  const ua = String((navigator as any).userAgent || '');
  if (!/Android|iPhone|iPad|iPod/i.test(ua)) return null; // phones only
  try { if ((window as any).matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone) return null; } catch {} // already on the home screen
  const close = () => { setDismissed(true); storage.setItem(KEY, '1').catch(() => {}); };
  const open = () => { try { (window as any).open(INSTALL_PAGE, '_blank'); } catch { Linking.openURL(INSTALL_PAGE).catch(() => {}); } };
  return (
    <LinearGradient colors={['#00211A', '#0B3A2E']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ paddingVertical: 9, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: 'rgba(242,181,29,0.35)' }}>
      <View style={{ width: 40, height: 40 }}>
        <Image source={require('../assets/icon.png')} contentFit="cover" style={{ width: 40, height: 40, borderRadius: 11, borderWidth: 1.5, borderColor: C.gold }} />
        <View style={{ position: 'absolute', bottom: -4, left: -4, width: 17, height: 17, borderRadius: 9, backgroundColor: C.gold, borderWidth: 1.5, borderColor: C.dark, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="arrow-down" size={10} color={C.dark} />
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <T w="black" size={13.5} color="#fff">حمّل تطبيق أطلب أبيس</T>
        <T size={11} color="#BFD3CA">أسرع وإشعارات فورية بطلباتك</T>
      </View>
      <Pressable onPress={open} hitSlop={8} style={{ backgroundColor: C.gold, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8 }}><T w="black" size={12.5} color={C.dark}>تحميل</T></Pressable>
      <Pressable onPress={close} hitSlop={12} accessibilityLabel="إخفاء" style={{ padding: 2 }}><Icon name="close" size={18} color="#9FB8AD" /></Pressable>
    </LinearGradient>
  );
}
