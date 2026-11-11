import React, { useCallback, useEffect, useState } from 'react';
import { View, Image } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Icon, toast } from './ui';
import { useStore } from '../lib/store';
import { apiCourierPhoto, apiCourierPhotoUpload, apiPendingCourierPhotos, apiReviewCourierPhoto, courierPhotoUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';

/** Round picture of the courier on an order (hidden when the switch is off or he has no approved picture). */
export function CourierAvatar({ courierId, size = 30 }: { courierId?: string; size?: number }) {
  const { db } = useStore();
  const [bad, setBad] = useState(false);
  if (!courierId || bad || !db.settings.features?.courierPhoto) return null;
  return <Image source={{ uri: courierPhotoUrl(courierId, Math.floor(Date.now() / 300000)) }} onError={() => setBad(true)} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.line }} />;
}

/** Courier: upload a picture of yourself. The owner approves it before customers see it. */
export function CourierPhotoCard() {
  const { db } = useStore();
  const [st, setSt] = useState<{ status: string; approved: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiCourierPhoto().then(setSt).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  if (!db.settings.features?.courierPhoto) return null;
  const add = async () => {
    if (!canPickImage) return toast('رفع الصور متاح حاليًا من نسخة الويب', 'info');
    const img = await pickImage(500);
    if (!img) return toast('تعذر تحميل الصورة، جرّب صورة أخرى', 'err');
    setBusy(true);
    try { await apiCourierPhotoUpload(img); toast('تم إرسال صورتك للمراجعة ✅'); load(); }
    catch (e: any) { toast(e?.message || 'تعذر الرفع', 'err'); }
    finally { setBusy(false); }
  };
  const label = !st || st.status === 'none' ? 'لم ترفع صورة بعد' : st.status === 'pending' ? 'صورتك بانتظار موافقة المالك' : st.status === 'rejected' ? (st.approved ? 'الصورة الجديدة اترفضت، والقديمة لسه ظاهرة' : 'الصورة اترفضت، ارفع صورة أوضح لوجهك') : 'صورتك ظاهرة للعملاء ✅';
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>صورتك للعملاء</T>
      <T size={12} color={C.sub}>{label}</T>
      <Btn variant="soft" icon="camera" title={st && st.status !== 'none' ? 'تغيير الصورة' : 'ارفع صورتك'} loading={busy} onPress={add} />
    </Card>
  );
}

/** Owner: approve or reject the pictures that are waiting. */
export function CourierPhotoReview() {
  const [rows, setRows] = useState<{ userId: string; name: string; image: string }[]>([]);
  const load = useCallback(() => { apiPendingCourierPhotos().then((r) => setRows(r.photos)).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (id: string, approve: boolean) => {
    try { await apiReviewCourierPhoto(id, approve); toast(approve ? 'تمت الموافقة ✅' : 'تم الرفض', approve ? 'ok' : 'info'); load(); }
    catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); }
  };
  if (!rows.length) return <Card><T size={12.5} color={C.sub}>لا توجد صور مناديب بانتظار المراجعة.</T></Card>;
  return (
    <View style={{ gap: 10 }}>
      <T w="black" size={15}>صور مناديب بانتظار موافقتك ({rows.length})</T>
      {rows.map((x) => (
        <Card key={x.userId} style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Image source={{ uri: x.image }} style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: C.line }} />
            <View style={{ flex: 1 }}><T w="bold" size={14}>{x.name}</T><T size={11.5} color={C.sub}>اتأكد إن الوجه واضح والصورة مناسبة</T></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small icon="checkmark" title="موافقة" style={{ flex: 1 }} onPress={() => act(x.userId, true)} />
            <Btn small variant="danger" icon="close" title="رفض" style={{ flex: 1 }} onPress={() => act(x.userId, false)} />
          </View>
        </Card>
      ))}
    </View>
  );
}
