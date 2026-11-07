import React from 'react';
import { View, Pressable } from 'react-native';
import { C, THEMES } from '../lib/theme';
import { T, Card, Icon, toast } from './ui';
import { useStore, setTheme } from '../lib/store';

/** Owner only: pick the colour theme of the whole app. Everyone sees it on their next sync. */
export function ThemePicker() {
  const { db } = useStore();
  const cur = db.settings.theme || 'default';
  const pick = async (id: string) => {
    if (id === cur) return;
    const r = await setTheme(id);
    toast(r.ok ? 'تم تغيير ألوان التطبيق لكل المستخدمين 🎨' : r.error, r.ok ? 'ok' : 'err');
  };
  return (
    <Card style={{ gap: 12 }}>
      <View>
        <T w="black" size={15}>ألوان التطبيق</T>
        <T size={12} color={C.sub}>اختر لوناً ويتغير عند كل المستخدمين (العملاء والمحلات والمناديب)</T>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {THEMES.map((t) => {
          const on = t.id === cur;
          return (
            <Pressable key={t.id} onPress={() => pick(t.id)} style={{ width: '47%', borderRadius: 16, borderWidth: 2, borderColor: on ? t.gold : C.line, padding: 8, gap: 6, backgroundColor: '#fff' }}>
              <View style={{ height: 44, borderRadius: 12, backgroundColor: t.dark, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 }}>
                <View style={{ width: 26, height: 8, borderRadius: 4, backgroundColor: t.gold }} />
                <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: t.dark3 }} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <T size={12} w={on ? 'black' : 'semi'} style={{ flex: 1 }}>{t.name}</T>
                {on && <Icon name="checkmark-circle" size={18} color={C.green} />}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}
