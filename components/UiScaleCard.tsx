import React from 'react';
import { View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Icon, toast } from './ui';
import { useStore, setUiSize } from '../lib/store';
import { PHONE_SCALE, DESKTOP_SCALE } from '../lib/scale';

const PRESETS = [0.85, 0.9, 0.95, 1, 1.05, 1.1];
const pct = (n: number) => `${Math.round(n * 100)}٪`;

function Row({ icon, title, sub, cur, onPick }: { icon: string; title: string; sub: string; cur: number; onPick: (n: number) => void }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: C.goldSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={18} color={C.goldDeep} /></View>
        <View style={{ flex: 1 }}>
          <T w="bold" size={13.5}>{title}</T>
          <T size={11.5} color={C.sub}>{sub}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {PRESETS.map((n) => {
          const on = Math.abs(n - cur) < 0.005;
          return (
            <Pressable key={n} onPress={() => onPick(n)} style={{ paddingVertical: 8, paddingHorizontal: 13, borderRadius: 14, borderWidth: 1.5, borderColor: on ? C.dark : C.line, backgroundColor: on ? C.dark : '#F3F4EE' }}>
              <T w="bold" size={12.5} color={on ? C.gold : C.text}>{pct(n)}</T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Owner only: how big the interface is, separately for phones (app + narrow web) and computers (wide web). */
export function UiScaleCard() {
  const { db } = useStore();
  const phone = db.settings.ui?.phone ?? PHONE_SCALE;
  const desktop = db.settings.ui?.desktop ?? DESKTOP_SCALE;
  const save = async (b: { phone?: number; desktop?: number }, ok: string) => {
    const r = await setUiSize(b);
    toast(r.ok ? ok : r.error, r.ok ? 'ok' : 'err');
  };
  return (
    <Card style={{ gap: 14 }}>
      <View>
        <T w="black" size={15}>حجم الواجهة</T>
        <T size={12} color={C.sub}>يتغير عند كل المستخدمين فوراً. 100% هو الحجم الأصلي. قد تحتاج لفتح شاشة أخرى ليظهر على كل الشاشات.</T>
      </View>
      <Row icon="phone-portrait" title="على الموبايل (تطبيق وويب)" sub="الشاشات الصغيرة" cur={phone} onPick={(n) => save({ phone: n }, 'تم تغيير حجم الموبايل')} />
      <Row icon="desktop" title="على الكمبيوتر" sub="الشاشات العريضة فقط (الموقع)" cur={desktop} onPick={(n) => save({ desktop: n }, 'تم تغيير حجم الكمبيوتر')} />
      <Btn title="رجوع للإعدادات الافتراضية" variant="soft" small onPress={() => save({ phone: PHONE_SCALE, desktop: DESKTOP_SCALE }, 'تم الرجوع للحجم الافتراضي')} />
    </Card>
  );
}
