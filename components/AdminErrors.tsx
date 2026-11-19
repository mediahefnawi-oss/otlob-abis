import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Empty, toast, confirmDialog } from './ui';
import { apiAdminClientErrors, apiAdminClientErrorsClear, ClientErrorRow } from '../lib/api';

const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'دلوقتي';
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return new Date(t).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

/** Owner only: the errors the phones reported silently (customers never see them). The same error is one line with a counter. */
export function AdminErrorsScreen({ navigation }: any) {
  const [rows, setRows] = useState<ClientErrorRow[] | null>(null);
  const [open, setOpen] = useState('');
  const load = useCallback(() => { apiAdminClientErrors().then((r) => setRows(r.errors)).catch(() => setRows([])); }, []);
  useEffect(() => { load(); }, [load]);
  const clear = () => confirmDialog({
    title: 'مسح كل الأخطاء؟', message: 'هتتمسح القائمة دي بس، ومفيش حاجة تانية بتتأثر', confirmText: 'مسح',
    onConfirm: async () => { try { await apiAdminClientErrorsClear(); toast('تم المسح ✅'); load(); } catch { toast('تعذر المسح', 'err'); } },
  });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="أخطاء التطبيق" subtitle="اللي بيحصل عند العملاء من غير ما يشوفوه" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}>
        {rows && !rows.length && <Empty icon="checkmark-circle" title="مفيش أخطاء مسجلة" text="لو حصل أي خطأ عند حد هيظهر هنا" />}
        {!!rows?.length && <Btn small variant="soft" icon="trash" title="مسح القائمة" onPress={clear} />}
        {(rows || []).map((e) => (
          <Card key={e.id} style={{ gap: 6 }} onPress={() => setOpen(open === e.id ? '' : e.id)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T w="black" size={13} style={{ flex: 1, textAlign: 'left' }} numberOfLines={open === e.id ? undefined : 2}>{e.message}</T>
              <T w="black" size={12} color={C.red}>×{e.count}</T>
            </View>
            <T size={11.5} color={C.sub}>{e.where} • {e.platform || '—'} {e.version}{e.userId ? ` • مستخدم ${e.userId}` : ''} • {ago(e.last)}</T>
            {open === e.id && !!e.stack && <T size={10.5} color={C.sub} style={{ textAlign: 'left' }}>{e.stack}</T>}
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
