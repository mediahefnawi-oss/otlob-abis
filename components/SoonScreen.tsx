import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView, Pressable, Linking, Platform, Animated, Easing } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, Icon, Logo, openWhats } from './ui';
import { useStore, useMe, logout } from '../lib/store';
import { adImageUrl } from '../lib/api';
import { SoonCfg, countdown, pad2, whenLabel } from '../lib/soon';

const GOLD = '#F2B51D';
const GOLD_LIGHT = '#FFE08A';

/** Splits the headline into two lines (first white, second gold) so it reads big and clear. */
function twoLines(text: string): [string, string] {
  const w = text.trim().split(/\s+/).filter(Boolean);
  if (w.length < 2) return [text.trim(), ''];
  const cut = Math.ceil(w.length / 2);
  return [w.slice(0, cut).join(' '), w.slice(cut).join(' ')];
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, borderRadius: 16, borderWidth: 1.5, borderColor: 'rgba(242,181,29,0.75)', backgroundColor: 'rgba(255,255,255,0.09)', paddingVertical: 8, alignItems: 'center' }}>
      <T w="black" size={30} color={GOLD_LIGHT} style={{ lineHeight: 36 }}>{value}</T>
      <T size={11} color="#CFE3D4">{label}</T>
    </View>
  );
}

export function SoonScreen({ cfg, navigation, preview, onClose }: { cfg: SoonCfg; navigation?: any; preview?: boolean; onClose?: () => void }) {
  const { db } = useStore();
  const me = useMe();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!cfg.at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cfg.at]);

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] });

  const cd = useMemo(() => countdown(cfg.at, now), [cfg.at, now]);
  const [l1, l2] = twoLines(cfg.m);
  const scene = cfg.ad ? { uri: adImageUrl({ id: cfg.ad, v: cfg.av }) } : require('../assets/images/soon-scene.webp');
  const phone = db.settings.supportPhone;
  // inside the installed app the visitor already has it: the download button is for the web page only
  const showDownload = !!cfg.u && Platform.OS === 'web';
  const open = () => { if (cfg.u) Linking.openURL(cfg.u).catch(() => {}); };

  return (
    <View style={{ flex: 1, backgroundColor: '#01220C' }}>
      <LinearGradient colors={['#0F5A24', '#073D16', '#01220C']} locations={[0, 0.4, 1]} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', paddingTop: insets.top + 22, paddingBottom: insets.bottom + 20 }} showsVerticalScrollIndicator={false}>
        <View style={{ width: '100%', maxWidth: 460, alignItems: 'center' }}>
          <Logo width={250} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 }}>
            <View style={{ width: 36, height: 1, backgroundColor: 'rgba(242,181,29,0.7)' }} />
            <T w="black" size={13} color={GOLD} style={{ letterSpacing: 6 }}>{cfg.br}</T>
            <View style={{ width: 36, height: 1, backgroundColor: 'rgba(242,181,29,0.7)' }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 10, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(242,181,29,0.7)', backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 14, paddingVertical: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF5A4D' }} />
            <T w="bold" size={12.5} color={GOLD}>{cfg.pl}</T>
          </View>

          <View style={{ width: '100%', aspectRatio: 800 / 548, marginTop: 6 }}>
            <Image source={scene} style={{ width: '100%', height: '100%' }} contentFit="cover" />
            <LinearGradient colors={['#073D16', 'rgba(7,61,22,0)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 30 }} pointerEvents="none" />
            <View style={{ position: 'absolute', left: 0, right: 0, top: 6, alignItems: 'center' }} pointerEvents="none">
              <T w="black" size={31} color="#FFF3D6" align="center" style={{ lineHeight: 42, textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 8 }}>{cfg.wa}</T>
              <T w="bold" size={15} color={GOLD} align="center" style={{ letterSpacing: 4 }}>{cfg.we}</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <View style={{ width: 80, height: 1, backgroundColor: 'rgba(242,181,29,0.7)' }} />
                <Icon name="location" size={16} color={GOLD} />
                <View style={{ width: 80, height: 1, backgroundColor: 'rgba(242,181,29,0.7)' }} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                <View style={{ width: 16, height: 16, backgroundColor: '#E9A30A', transform: [{ rotate: '45deg' }], marginRight: -9, borderRadius: 2 }} />
                <LinearGradient colors={['#FFE08A', '#E9A30A', '#C98A06']} style={{ borderRadius: 8, paddingVertical: 8, paddingHorizontal: 26, borderWidth: 1.5, borderColor: '#FFF1B8' }}>
                  <T w="black" size={18} color="#3A2600" align="center">{cfg.rb}</T>
                </LinearGradient>
                <View style={{ width: 16, height: 16, backgroundColor: '#E9A30A', transform: [{ rotate: '45deg' }], marginLeft: -9, borderRadius: 2 }} />
              </View>
            </View>
            <LinearGradient colors={['rgba(1,34,12,0)', '#01220C']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 }} pointerEvents="none" />
          </View>

          {/* the big call to action */}
          <View style={{ width: '88%', marginTop: -8, borderRadius: 24, borderWidth: 2, borderColor: GOLD, backgroundColor: 'rgba(0,0,0,0.38)', paddingVertical: 16, paddingHorizontal: 14, alignItems: 'center', shadowColor: GOLD, shadowOpacity: 0.45, shadowRadius: 20, shadowOffset: { width: 0, height: 0 }, elevation: 8 }}>
            <T size={30}>📲</T>
            <T w="black" size={31} color="#fff" align="center" style={{ lineHeight: 42, marginTop: 2 }}>{l1}</T>
            {!!l2 && <T w="black" size={31} color={GOLD} align="center" style={{ lineHeight: 42 }}>{l2}</T>}
            {cfg.at > 0 && <T w="bold" size={16} color="#E8F2EA" align="center" style={{ marginTop: 8, lineHeight: 26 }}>{cfg.wl} <T w="black" size={16} color={GOLD}>{whenLabel(cfg.at, now)}</T></T>}
          </View>

          {cfg.at > 0 && (
            <View style={{ width: '88%', marginTop: 16 }}>
              {cd.left > 0 ? (
                <>
                  <T w="bold" size={12.5} color={GOLD} align="center" style={{ marginBottom: 6 }}>{cfg.cl}</T>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {cd.d > 0 && <Tile value={pad2(cd.d)} label="يوم" />}
                    <Tile value={pad2(cd.h)} label="ساعة" />
                    <Tile value={pad2(cd.m)} label="دقيقة" />
                    <Tile value={pad2(cd.s)} label="ثانية" />
                  </View>
                </>
              ) : (
                <View style={{ borderRadius: 16, borderWidth: 1.5, borderColor: GOLD, backgroundColor: 'rgba(242,181,29,0.14)', paddingVertical: 12 }}>
                  <T w="black" size={20} color={GOLD_LIGHT} align="center">{cfg.dn}</T>
                </View>
              )}
            </View>
          )}

          {showDownload && (
            <Animated.View style={{ width: '88%', marginTop: 20, transform: [{ scale }] }}>
              <Pressable onPress={open} accessibilityRole="button">
                <LinearGradient colors={['#FFD65A', '#E9A30A']} style={{ borderRadius: 32, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 2, borderColor: '#FFF1B8', shadowColor: GOLD, shadowOpacity: 0.55, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 8 }}>
                  <Icon name="download" size={24} color="#00211A" />
                  <T w="black" size={20} color="#00211A">{cfg.dl}</T>
                </LinearGradient>
              </Pressable>
            </Animated.View>
          )}

          {cfg.sup && !!phone && (
            <Pressable onPress={() => openWhats(phone)} style={{ marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 }}>
              <Icon name="logo-whatsapp" size={18} color={GOLD} />
              <T w="bold" size={14} color={GOLD}>{cfg.sp}</T>
            </Pressable>
          )}

          {!preview && (
            me ? (
              <Pressable onPress={logout} style={{ marginTop: 10, padding: 8 }}><T size={12} color="rgba(255,255,255,0.4)">تسجيل الخروج</T></Pressable>
            ) : navigation ? (
              <Pressable onPress={() => navigation.navigate('Login')} style={{ marginTop: 10, padding: 8 }}><T size={12} color="rgba(255,255,255,0.4)">دخول الإدارة</T></Pressable>
            ) : null
          )}
        </View>
      </ScrollView>
      {preview && !!onClose && (
        <Pressable onPress={onClose} style={{ position: 'absolute', top: insets.top + 10, left: 14, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: 1, borderColor: GOLD, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={24} color={GOLD} />
        </Pressable>
      )}
    </View>
  );
}
