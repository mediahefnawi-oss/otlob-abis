import React, { useMemo, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Chip, Field, Card } from './ui';
import { useStore } from '../lib/store';
import { isoDay, dayName } from '../lib/format';

/** Epoch ms from a day ('2026-11-12') and a time ('20:30'), or 0 when the time is not valid. */
export function scheduleMs(day: string, time: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) return 0;
  const d = new Date(`${day}T${m[1].padStart(2, '0')}:${m[2]}:00`);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}
export const schedLabel = (t: number) => new Date(t).toLocaleString('ar-EG', { weekday: 'long', hour: 'numeric', minute: '2-digit' });

/** "Now" or "later": the customer picks a delivery time 30 minutes to 2 days ahead. `onChange` gets 0 for now, otherwise the time in ms. */
export function SchedulePicker({ onChange }: { onChange: (ms: number) => void }) {
  const { db } = useStore();
  const days = useMemo(() => Array.from({ length: 3 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return isoDay(d); }), []);
  const [later, setLater] = useState(false);
  const [day, setDay] = useState(days[0]);
  const [time, setTime] = useState('20:00');
  if (!db.settings.features?.schedule) return null;
  const push = (l: boolean, d: string, t: string) => onChange(l ? scheduleMs(d, t) : 0);
  const ms = later ? scheduleMs(day, time) : 0;
  const bad = later && (ms < Date.now() + 30 * 60000 || ms > Date.now() + 48 * 3600000);
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>وقت التوصيل</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="دلوقتي" active={!later} onPress={() => { setLater(false); push(false, day, time); }} />
        <Chip label="⏰ في وقت لاحق" active={later} onPress={() => { setLater(true); push(true, day, time); }} />
      </View>
      {later && (
        <View style={{ gap: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {days.map((d, i) => <Chip key={d} label={i === 0 ? 'النهارده' : i === 1 ? 'بكرة' : dayName(d)} active={d === day} onPress={() => { setDay(d); push(true, d, time); }} />)}
          </ScrollView>
          <Field label="الساعة (مثال 20:30)" icon="time" value={time} onChangeText={(t) => { setTime(t); push(true, day, t); }} keyboardType="numbers-and-punctuation" />
          {bad || !ms
            ? <T size={12} color={C.red}>اختر وقتًا بعد نصف ساعة على الأقل ولحد يومين قدام.</T>
            : <T size={12} color={C.green}>هيوصلك: {schedLabel(ms)}. المحل بيشوف الميعاد ده مع الطلب.</T>}
        </View>
      )}
    </Card>
  );
}
