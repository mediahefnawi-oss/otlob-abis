import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Toggle, confirmDialog, toast } from './ui';
import { apiJson } from '../lib/finance';

type Status = { configured: boolean; found?: boolean; enabled?: boolean; slotActive?: boolean; lagBytes?: number; subscription?: string };
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(0, Math.round(n / 1024))} كيلوبايت` : `${(n / 1024 / 1024).toFixed(1)} ميجابايت`);

/** Owner: pause / resume the live copy of the database (paused = the main database can sleep when nobody is ordering). */
export function ReplicationCard() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await apiJson<Status>('/api/admin/replication')); setErr(''); }
    catch (e: any) { setErr(e?.message || 'تعذر قراءة الحالة'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const set = (enabled: boolean) => confirmDialog({
    title: enabled ? 'تشغيل الربط مع القاعدة الاحتياطية؟' : 'إيقاف الربط؟',
    message: enabled
      ? 'ستلحق القاعدة الاحتياطية بكل ما فاتها. الأفضل تشغيله وقت الهدوء، والقاعدة الرئيسية لن تنام طالما الربط شغال.'
      : 'ستستريح القاعدة الرئيسية عند عدم وجود طلبات، لكن النسخة الاحتياطية لن تتحدث حتى تعيد التشغيل.',
    confirmText: enabled ? 'تشغيل' : 'إيقاف',
    onConfirm: async () => {
      setBusy(true);
      try { setSt(await apiJson<Status>('/api/admin/replication', 'POST', { enabled })); setErr(''); toast(enabled ? 'تم تشغيل الربط' : 'تم إيقاف الربط', 'ok'); }
      catch (e: any) { toast(e?.message || 'تعذر التغيير', 'err'); }
      setBusy(false);
    },
  });
  return (
    <Card style={{ gap: 12 }}>
      {!st && !err ? <T size={12.5} color={C.sub}>جاري قراءة الحالة...</T> : null}
      {err ? <T size={12.5} color={C.red}>{err}</T> : null}
      {st && !st.configured ? <T size={12.5} color={C.sub}>القاعدة الاحتياطية غير مربوطة بالسيرفر.</T> : null}
      {st && st.configured && st.found === false ? <T size={12.5} color={C.sub}>لا يوجد ربط على القاعدة الاحتياطية.</T> : null}
      {st && st.configured && st.found ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <T w="black" size={15}>الربط مع القاعدة الاحتياطية</T>
              <T size={11.5} color={C.sub}>{st.enabled ? 'شغال: النسخة الاحتياطية تتحدث أولاً بأول، والقاعدة الرئيسية لا تنام' : 'موقوف: القاعدة الرئيسية تستريح عند عدم وجود طلبات'}</T>
            </View>
            <Toggle value={!!st.enabled} onValueChange={(v) => !busy && set(v)} />
          </View>
          {typeof st.lagBytes === 'number' ? (
            <T size={12} color={st.lagBytes > 50 * 1024 * 1024 ? C.red : C.sub}>
              {st.lagBytes < 64 * 1024 ? 'النسختان متطابقتان تقريباً' : `النسخة الاحتياطية متأخرة حوالي ${kb(st.lagBytes)}`}
            </T>
          ) : null}
          <Btn small variant="soft" icon="refresh" title="تحديث الحالة" onPress={load} />
        </>
      ) : null}
    </Card>
  );
}
