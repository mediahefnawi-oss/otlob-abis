import React, { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Toggle, Empty, toast } from './ui';
import { CourierPhotoReview } from './CourierPhoto';
import { ChatReportsList } from './Chat';
import { apiDailyReport, apiFeatures, apiSetFeature, FeatureRow } from '../lib/api';

const HINT: Record<string, string> = {
  menu: 'المنيو بالصورة، ونقل المحل لقسم آخر، وطريقة الطلب لكل محل',
  chat: 'العميل يكلّم المحل قبل الطلب',
  voice: 'العميل يسجّل صوته بدل الكتابة',
  clinicSchedule: 'العيادة هي اللي تحدد يوم وساعة الكشف',
  rx: 'العيادة تحوّل الروشتة لصيدلية برقم',
  pool: 'الجيران يشاركوا رسوم التوصيل',
  adTarget: 'الإعلان يفتح محل أو منتج معين',
  courierPhoto: 'صورة المندوب تظهر للعميل بعد موافقتك',
  ordering: 'تثبيت محلات في أول القايمة، والباقي يترتب تلقائيًا (مفتوح ← تقييم ← طلبات)',
  favorites: 'قلب على المحل أو المنتج وقسم «أماكني المفضلة» في الرئيسية',
  addresses: 'العميل يحفظ أكثر من عنوان (البيت والشغل) ويختار وقت الطلب',
  schedule: 'العميل يطلب لوقت لاحق (مثلًا الساعة 8 مساءً)',
  dailyReport: 'إشعار يومي لك بعدد الطلبات والإيرادات وأكتر محل',
  lateAlert: 'تنبيه ليك وللمحل لو طلب اتأخر من غير ما يتحرك',
  bot: 'المساعد الآلي يرد على الأسئلة الشائعة في الدعم',
};

/** Owner only: every new feature is a switch. Closing one hides it at once; whatever already started finishes normally. */
export function AdminFeaturesScreen({ navigation }: any) {
  const [rows, setRows] = useState<FeatureRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState('');
  useEffect(() => { apiFeatures().then((r) => setRows(r.features)).catch((e) => { setRows([]); toast(e?.message || 'تعذر التحميل', 'err'); }); }, []);
  const flip = async (k: string, on: boolean) => {
    setBusy(k);
    try { const r = await apiSetFeature(k, on); setRows(r.features); toast(on ? 'تم التشغيل ✅' : 'تم الإيقاف'); }
    catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); }
    finally { setBusy(''); }
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="تشغيل الميزات" subtitle="افتح الميزة بعد ما تجربها بنفسك" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}>
        {rows && !rows.length && <Empty icon="toggle" title="تعذر تحميل الميزات" />}
        {(rows || []).map((f) => (
          <Card key={f.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T w="black" size={14.5}>{f.label}</T>
              <T size={12} color={C.sub}>{HINT[f.key] || ''}</T>
            </View>
            <View style={{ opacity: busy === f.key ? 0.5 : 1 }} pointerEvents={busy ? 'none' : 'auto'}>
              <Toggle value={f.on} onValueChange={(v) => flip(f.key, v)} />
            </View>
          </Card>
        ))}
        {(rows || []).some((f) => f.key === 'dailyReport' && f.on) && (
          <Card style={{ gap: 8 }}>
            <T w="black" size={14.5}>تقرير النهارده</T>
            {!!report && <T size={13}>{report}</T>}
            <Btn small variant="soft" icon="stats-chart" title="اعرض أرقام النهارده دلوقتي" onPress={() => apiDailyReport().then((r) => setReport(r.text)).catch((e) => toast(e?.message || 'تعذر التحميل', 'err'))} />
            <T size={11.5} color={C.sub}>بيوصلك التقرير كإشعار كل يوم الساعة 10 مساءً بتوقيت القاهرة.</T>
          </Card>
        )}
        {(rows || []).some((f) => f.key === 'chat' && f.on) && <ChatReportsList />}
        {(rows || []).some((f) => f.key === 'courierPhoto' && f.on) && <CourierPhotoReview />}
      </ScrollView>
    </View>
  );
}
