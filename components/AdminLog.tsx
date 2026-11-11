import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Empty, toast, confirmDialog } from './ui';
import { apiAdminLog, apiUndoLog, LogEntry } from '../lib/api';

const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'دلوقتي';
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return new Date(t).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

/** Owner only: everything changed from the owner panel, newest first. Feature switches and the basic settings can be undone from here. */
export function AdminLogScreen({ navigation }: any) {
  const [rows, setRows] = useState<LogEntry[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => { apiAdminLog().then((r) => setRows(r.entries)).catch((e) => { setRows([]); toast(e?.message || 'تعذر التحميل', 'err'); }); }, []);
  useEffect(() => { load(); }, [load]);
  const undo = (e: LogEntry) => confirmDialog({
    title: 'تراجع عن التغيير؟', message: e.summary, confirmText: 'تراجع',
    onConfirm: async () => {
      setBusy(e.id);
      try { await apiUndoLog(e.id); toast('تم التراجع ✅'); load(); }
      catch (x: any) { toast(x?.message || 'تعذر التراجع', 'err'); }
      finally { setBusy(''); }
    },
  });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="سجل التغييرات" subtitle="كل حاجة غيّرتها من لوحة المالك، وتقدر ترجّع" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}>
        {rows && !rows.length && <Empty icon="time" title="مفيش تغييرات لسه" text="أي تعديل تعمله من اللوحة هيظهر هنا" />}
        {(rows || []).map((e) => (
          <Card key={e.id} style={{ gap: 6, opacity: e.undone ? 0.6 : 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T w="black" size={14} style={{ flex: 1 }}>{e.summary}</T>
              <T size={11} color={C.sub}>{ago(e.at)}</T>
            </View>
            <T size={12} color={C.sub}>{e.label}{e.admin ? ` • ${e.admin}` : ''}</T>
            {!!e.details && !e.canUndo && !e.undone && <T size={11.5} color={C.sub} numberOfLines={2}>{e.details}</T>}
            {e.undone && <T w="bold" size={12} color={C.green}>✔ تم التراجع</T>}
            {e.canUndo && <Btn small variant="soft" icon="arrow-undo" title="تراجع" loading={busy === e.id} onPress={() => undo(e)} />}
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
