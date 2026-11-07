import React from 'react';
import { View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Toggle, toast } from './ui';
import { useStore, setPrivacy } from '../lib/store';

const MINS: [number, string][] = [[1, 'دقيقة'], [5, '5 دقائق'], [30, '30 دقيقة'], [60, 'ساعة']];

/** Owner only: shops and couriers stop seeing the customer's data (name, phone, address, notes, chat) some time after delivery. */
export function PrivacyCard() {
  const { db } = useStore();
  const pv = db.settings.privacy || { on: true, minutes: 1 };
  const save = async (b: { on?: boolean; minutes?: number }, ok: string) => {
    const r = await setPrivacy(b);
    toast(r.ok ? ok : r.error, r.ok ? 'ok' : 'err');
  };
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>إخفاء بيانات العميل بعد التسليم</T>
          <T size={12} color={C.sub}>بعد التسليم لا يرى مقدم الخدمة ولا المندوب اسم العميل وهاتفه وعنوانه وملاحظاته ورسائل الطلب. أنت والمشرفون ترون كل شيء دائماً.</T>
        </View>
        <Toggle value={pv.on} onValueChange={(v) => save({ on: v }, v ? 'تم تفعيل إخفاء بيانات العميل' : 'تم إيقاف إخفاء بيانات العميل')} />
      </View>
      {pv.on && (
        <View style={{ gap: 8 }}>
          <T w="bold" size={12.5}>يبدأ الإخفاء بعد</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
            {MINS.map(([m, l]) => {
              const on = pv.minutes === m;
              return (
                <Pressable key={m} onPress={() => save({ minutes: m }, 'تم تغيير المدة')} style={{ paddingVertical: 8, paddingHorizontal: 13, borderRadius: 14, borderWidth: 1.5, borderColor: on ? C.dark : C.line, backgroundColor: on ? C.dark : '#F3F4EE' }}>
                  <T w="bold" size={12.5} color={on ? C.gold : C.text}>{l}</T>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </Card>
  );
}
