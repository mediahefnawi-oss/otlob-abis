import React, { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Toggle, Empty, Field, Chip, toast, confirmDialog } from './ui';
import { refresh } from '../lib/store';
import { CoversManager } from './Covers';
import { BlocksManager } from './HomeBlocks';
import { PremiumAdmin } from './Premium';
import { CourierPhotoReview } from './CourierPhoto';
import { ChatReportsList } from './Chat';
import { apiWipePreview, apiWipe, WipeCounts, apiDailyReport, apiFeatures, apiSetFeature, FeatureRow } from '../lib/api';

const HINT: Record<string, string> = {
  menu: 'المنيو بالصورة، ونقل المحل لقسم آخر، وطريقة الطلب لكل محل',
  chat: 'العميل يكلّم المحل قبل الطلب',
  voice: 'العميل يسجّل صوته بدل الكتابة',
  clinicSchedule: 'العيادة هي اللي تحدد يوم وساعة الكشف',
  rx: 'العيادة تحوّل الروشتة لصيدلية برقم',
  offerBadge: 'شارة «خصم %» على كارت المحل في الرئيسية والقوائم',
  todayOffers: 'شريط «عروض اليوم» أعلى الرئيسية مع عدّاد الوقت المتبقي',
  offerPush: 'إشعار للعملاء لما يبدأ عرض جديد (مرة واحدة في اليوم كحد أقصى)',
  regionClose: 'تقفل التوصيل في منطقة بشكل مؤقت (برسالة ووقت رجوع)، والعملاء فيها ما يقدروش يطلبوا لحد ما ترجع. الزرار بيظهر جنب كل منطقة في «المناطق»',
  dataWipe: 'بيفتح في آخر الصفحة كارت «مسح بيانات الطلبات» لتنضيف البيانات التجريبية. بيطلب كلمة مرورك وكلمة تأكيد. وما فيهوش تراجع',
  pool: 'الجيران يشاركوا رسوم التوصيل',
  adTarget: 'الإعلان يفتح محل أو منتج معين',
  courierPhoto: 'صورة المندوب تظهر للعميل بعد موافقتك',
  ordering: 'تثبيت محلات في أول القايمة، والباقي يترتب تلقائيًا (مفتوح ← تقييم ← طلبات)',
  favorites: 'قلب على المحل أو المنتج وقسم «أماكني المفضلة» في الرئيسية',
  addresses: 'العميل يحفظ أكثر من عنوان (البيت والشغل) ويختار وقت الطلب',
  schedule: 'العميل يطلب لوقت لاحق (مثلًا الساعة 8 مساءً)',
  dailyReport: 'إشعار يومي لك بعدد الطلبات والإيرادات وأكتر محل',
  lateAlert: 'تنبيه ليك وللمحل لو طلب اتأخر من غير ما يتحرك',
  winback: 'إشعار للعميل اللي ما طلبش من 14 يوم (مرة كل 30 يوم، بين 5 و9 مساءً)',
  bot: 'المساعد الآلي يرد على الأسئلة الشائعة في الدعم',
  coupons: 'أكواد الخصم في السلة. لو قفلتها العميل مش هيشوف خانة الكود',
  ratings: 'العميل يقيّم المحل والمندوب بعد التسليم',
  support: 'شات العميل والمحل والمندوب مع الدعم الفني',
  covers: 'صورة كافر ثابتة ورا الهيدر في الرئيسية الجديدة، وصورة كافر لكل مقدم خدمة في صفحته (مع «صفحة المقدم الجديدة»). ترفع الصور من كارت «صور الكافر» في آخر الصفحة.',
  premium: 'أبيس بريميم: اشتراك شهري للعميل. بيظهر زر الاشتراك وشارة PRO. المزايا بتفعّلها من المفاتيح اللي تحته، والاشتراك بتفعّله إنت بعد التحويل من كارت «أبيس بريميم» تحت.',
  premiumFreeDelivery: 'توصيل مجاني للمشترك لما طلبه يعدّي حد معين. المندوب بياخد أجره كامل والفرق عليك.',
  premiumDiscount: 'خصم نسبة على مجموع طلب المشترك (بدون ما يتجمع مع كوبون).',
  premiumOffers: 'كوبونات «لمشتركي بريميم فقط» تشتغل للمشتركين بس.',
  premiumPriority: 'طلبات المشتركين بتظهر للمناديب الأول وعليها شارة PRO.',
  homeBlocks: 'قوائم محلات بتختارها بإيدك ولوحات إعلانية بين القوائم في الرئيسية الجديدة. بترتّبهم وتعدّلهم من كارت «ترتيب الرئيسية» في آخر الصفحة.',
  ratingStars: 'التقييم يظهر نجوم (★★★★☆) مع الرقم وعدد العملاء اللي قيّموا، على كارت المحل وفي صفحته. بالضغط على التقييم تظهر آراء العملاء.',
  homeAddress: 'العنوان في الرئيسية القديمة يبقى زرار: العميل يضغط عليه ويغيّر عنوانه ومنطقته (زي الرئيسية الجديدة)',
};
const BASIC = ['coupons', 'ratings', 'support', 'bot'];

const WIPE_PARTS = [{ k: 'orders', t: 'الطلبات' }, { k: 'bookings', t: 'الحجوزات' }, { k: 'rx', t: 'الروشتات' }];

/** Owner: clean the trial data. Everything is deleted in one go, the customers, shops, products and settings are never touched, and there is no undo. */
function DataWipeCard() {
  const [c, setC] = useState<WipeCounts | null>(null);
  const [parts, setParts] = useState<string[]>([]);
  const [renum, setRenum] = useState(true);
  const [pass, setPass] = useState('');
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => apiWipePreview().then((r) => setC(r.counts)).catch(() => {});
  useEffect(() => { load(); }, []);
  const flip = (k: string) => setParts((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const run = async () => {
    if (!parts.length) return toast('اختر اللي عايز تمسحه', 'err');
    if (word.trim() !== 'مسح') return toast('اكتب كلمة «مسح» للتأكيد', 'err');
    if (!pass) return toast('اكتب كلمة مرورك', 'err');
    confirmDialog({
      title: 'مسح نهائي؟', danger: true, confirmText: 'امسح',
      message: `هيتمسح: ${WIPE_PARTS.filter((x) => parts.includes(x.k)).map((x) => x.t).join('، ')}. مفيش تراجع.${c && c.openOrders > 0 && parts.includes('orders') ? ` ⚠️ فيه ${c.openOrders} طلب لسه شغال هيتمسح معاهم.` : ''}`,
      onConfirm: async () => {
        setBusy(true);
        try { const r = await apiWipe({ password: pass, confirm: word.trim(), what: parts, renumber: renum }); setC(r.after); setPass(''); setWord(''); setParts([]); toast('تم المسح ✅'); refresh().catch(() => {}); }
        catch (e: any) { toast(e?.message || 'تعذر المسح', 'err'); }
        finally { setBusy(false); }
      },
    });
  };
  return (
    <Card style={{ gap: 10, borderWidth: 1.5, borderColor: C_RED }}>
      <T w="black" size={14.5} color={C_RED}>⚠️ مسح بيانات الطلبات (نهائي)</T>
      <T size={12} color={C.sub}>عشان تنضّف الطلبات التجريبية قبل الإطلاق. العملاء والمحلات والمنتجات والمناطق والإعدادات ما بتتمسحش أبدًا.</T>
      {c && <T size={12.5}>الموجود دلوقتي: {c.orders} طلب (منهم {c.openOrders} شغال) • {c.bookings} حجز • {c.rx} روشتة • {c.invoices} فاتورة • {c.messages} رسالة</T>}
      <T w="bold" size={12.5}>اختر اللي يتمسح</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {WIPE_PARTS.map((x) => <Chip key={x.k} label={x.t} active={parts.includes(x.k)} onPress={() => flip(x.k)} />)}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={13} style={{ flex: 1 }}>الترقيم يبدأ من 1 بعد المسح</T>
        <Toggle value={renum} onValueChange={setRenum} />
      </View>
      <Field label="كلمة مرورك" icon="lock-closed" value={pass} onChangeText={setPass} secureTextEntry placeholder="••••••" />
      <Field label="اكتب كلمة: مسح" icon="create" value={word} onChangeText={setWord} placeholder="مسح" />
      <Btn variant="danger" icon="trash" title="امسح نهائيًا" loading={busy} onPress={run} />
      <T size={11.5} color={C.sub}>مفيش تراجع من التطبيق. لو عايز نسخة تحميها قبل المسح، شغّل النسخة الاحتياطية من السيرفر الأول (backup.sh).</T>
    </Card>
  );
}
const C_RED = '#C0392B';

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
        {(rows || []).some((f) => BASIC.includes(f.key)) && <T w="black" size={13} color={C.sub}>ميزات أساسية (شغّالة من الأول، تقدر تقفلها)</T>}
        {(rows || []).filter((f) => BASIC.includes(f.key)).map((f) => (
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
        <T w="black" size={13} color={C.sub}>ميزات جديدة (مقفولة لحد ما تفتحها)</T>
        {(rows || []).filter((f) => !BASIC.includes(f.key)).map((f) => (
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
        <PremiumAdmin />
        <BlocksManager />
        <CoversManager />
        {(rows || []).some((f) => f.key === 'dataWipe' && f.on) && <DataWipeCard />}
        {(rows || []).some((f) => f.key === 'chat' && f.on) && <ChatReportsList />}
        {(rows || []).some((f) => f.key === 'courierPhoto' && f.on) && <CourierPhotoReview />}
      </ScrollView>
    </View>
  );
}
