import React, { useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { ScrollView } from './KScroll';
import { C } from '../lib/theme';
import { T, Card, Header, toast } from './ui';
import { apiAdminTripsSettings, apiAdminTripsSettingsSave } from '../lib/api';

/** Owner only: the most persons one customer can book in an intercity trip (4 to 7). */
export function AdminTripsLimitScreen({ navigation }: any) {
  const [n, setN] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { apiAdminTripsSettings().then((r) => setN(r.maxPersons)).catch(() => setN(7)); }, []);
  const save = async (v: number) => {
    if (busy) return; setBusy(true);
    try { const r = await apiAdminTripsSettingsSave(v); setN(r.maxPersons); toast('تم الحفظ ✅'); } catch (e: any) { toast(e?.message || 'تعذر الحفظ', 'err'); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="حد الأفراد في رحلات المحافظات" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Card style={{ gap: 10 }}>
          <T w="black">أقصى عدد أفراد للعميل في الحجز الواحد</T>
          <T size={13} color={C.sub}>العميل يشوف الأرقام لحد الحد ده، ولو عايز أكتر يكلمكم على واتساب. الحجوزات الحالية مش بتتأثر.</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[4, 5, 6, 7].map((v) => (
              <Pressable key={v} onPress={() => save(v)} style={{ flex: 1, height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: n === v ? C.green : C.greenSoft }}>
                <T w="black" size={18} color={n === v ? '#fff' : C.green}>{v}</T>
              </Pressable>
            ))}
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}
