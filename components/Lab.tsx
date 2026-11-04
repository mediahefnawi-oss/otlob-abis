import React, { useEffect, useMemo, useState } from 'react';
import { View, Pressable, Linking, Platform, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Pill, Field, Chip, Row, Header, Empty, toast, confirmDialog, callPhone } from './ui';
import { useStore, useMe, labAction, fetchLabFile, LabFile } from '../lib/store';
import { apiLabLink } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';
import { Appointment, LabInfo } from '../lib/types';
import { money, fmtDateTime, prettyIso, isoDay, dayName } from '../lib/format';

/** "09:30" -> "9:30 صباحاً" */
export const fmt12 = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  if (!m) return t || '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'صباحاً' : 'مساءً'}`;
};

type Stage = LabInfo['stage'];
const STAGE: Record<Stage, { label: string; color: string; soft: string }> = {
  new: { label: 'بانتظار تسعير المعمل', color: C.orange, soft: C.orangeSoft },
  quoted: { label: 'بانتظار تأكيد العميل', color: C.blue, soft: C.blueSoft },
  confirmed: { label: 'الحجز مؤكد', color: C.green, soft: C.greenSoft },
  visited: { label: 'بانتظار التقرير', color: C.goldDeep, soft: C.goldSoft },
  done: { label: 'تم رفع التقرير', color: C.green, soft: C.greenSoft },
  rejected: { label: 'اعتذر المعمل', color: C.red, soft: C.redSoft },
  cancelled: { label: 'ملغي', color: C.red, soft: C.redSoft },
};
export const LabPill = ({ stage }: { stage: Stage }) => <Pill label={(STAGE[stage] || STAGE.new).label} color={(STAGE[stage] || STAGE.new).color} soft={(STAGE[stage] || STAGE.new).soft} />;

const STEPS: Array<[Stage, string]> = [['new', 'تم إرسال الطلب'], ['quoted', 'المعمل حدد الموعد والسعر'], ['confirmed', 'تأكيد الحجز وفاتورة الحجز'], ['visited', 'الكشف'], ['done', 'رفع التقرير']];
const ORDER: Stage[] = ['new', 'quoted', 'confirmed', 'visited', 'done'];

function Timeline({ stage }: { stage: Stage }) {
  const at = ORDER.indexOf(stage);
  return (
    <Card style={{ gap: 8 }}>
      {STEPS.map(([s, label], i) => {
        const done = at >= i;
        return (
          <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: done ? C.green : C.line }} />
            <T size={13} w={done ? 'bold' : 'regular'} color={done ? C.text : C.sub}>{label}</T>
          </View>
        );
      })}
    </Card>
  );
}

/** a prescription picture or a report: pictures are shown here, a PDF (or any file) opens in the phone's viewer through a short-lived link */
export function LabFileView({ id, kind, title }: { id: string; kind: 'rx' | 'report'; title: string }) {
  const [file, setFile] = useState<LabFile | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; fetchLabFile(id, kind).then((f) => { if (on) setFile(f); }); return () => { on = false; }; }, [id, kind]);
  const open = async () => {
    setBusy(true);
    try { const { url } = await apiLabLink(id, kind); await Linking.openURL(url); }
    catch { toast('تعذر فتح الملف، حاول مرة أخرى', 'err'); }
    setBusy(false);
  };
  if (file === undefined) return <T size={12} color={C.sub}>جاري تحميل {title}...</T>;
  if (!file) return null;
  return (
    <View style={{ gap: 8 }}>
      <T w="bold" size={13}>{title}</T>
      {file.mime !== 'pdf' ? <Image source={{ uri: file.data }} style={{ width: '100%', height: 280, borderRadius: 14, backgroundColor: C.line }} contentFit="contain" /> : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.goldSoft, borderRadius: 14, padding: 12 }}>
          <Icon name="document-text" size={28} color={C.goldDeep} /><T w="bold" size={13} style={{ flex: 1 }} numberOfLines={1}>{file.name || 'ملف PDF'}</T>
        </View>
      )}
      <Btn small variant="soft" icon="open" title={file.mime === 'pdf' ? 'فتح ملف PDF' : 'فتح الصورة بحجم كامل'} loading={busy} onPress={open} />
    </View>
  );
}

/** the lab picks the report: a picture (from the gallery) or, from the web version, a PDF */
function pickPdfWeb(): Promise<{ data: string; name: string } | null> {
  return new Promise((resolve) => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return resolve(null);
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/pdf';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onerror = () => resolve(null);
      r.onload = () => resolve({ data: String(r.result), name: f.name });
      r.readAsDataURL(f);
    };
    input.click();
  });
}

function QuoteForm({ a, onDone }: { a: Appointment; onDone: () => void }) {
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return isoDay(d); }), []);
  const [date, setDate] = useState(a.lab?.stage === 'quoted' ? a.date : days[0]);
  const [time, setTime] = useState(a.lab?.stage === 'quoted' ? a.time : '10:00');
  const [fee, setFee] = useState(a.lab?.stage === 'quoted' ? String(a.fee) : '');
  const [note, setNote] = useState(a.lab?.note || '');
  const [busy, setBusy] = useState(false);
  const step = (d: number) => { const [h, m] = time.split(':').map(Number); const t = (((h * 60 + m + d) % 1440) + 1440) % 1440; setTime(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`); };
  const StepBtn = ({ icon, d }: { icon: string; d: number }) => (
    <Pressable onPress={() => step(d)} style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: C.goldSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={20} color={C.goldDeep} /></Pressable>
  );
  const send = async () => {
    const f = Number(fee);
    if (!fee.trim() || !Number.isFinite(f) || f < 0) return toast('اكتب سعر الكشف', 'err');
    setBusy(true);
    const r = await labAction(a.id, { action: 'quote', date, time, fee: f, note: note.trim() });
    setBusy(false);
    if (!r.ok) return toast(r.error || 'تعذر الإرسال', 'err');
    toast('تم إرسال الموعد والسعر للعميل ✅'); onDone();
  };
  return (
    <Card style={{ gap: 12 }}>
      <T w="black" size={15}>{a.lab?.stage === 'quoted' ? 'تعديل الموعد والسعر' : 'حدد موعد الكشف والسعر'}</T>
      <T w="semi" size={13} color={C.dark3}>يوم الكشف</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {days.map((d, i) => <Chip key={d} label={i === 0 ? 'اليوم' : `${dayName(d)} ${Number(d.slice(8))}/${Number(d.slice(5, 7))}`} active={date === d} onPress={() => setDate(d)} />)}
      </View>
      <T w="semi" size={13} color={C.dark3}>ساعة الكشف</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <StepBtn icon="remove" d={-30} />
        <View style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.card }}><T w="black" size={16}>{fmt12(time)}</T></View>
        <StepBtn icon="add" d={30} />
      </View>
      <Field label="سعر الكشف (ج.م)" icon="cash" value={fee} onChangeText={setFee} keyboardType="numeric" />
      <Field label="ملاحظة للعميل (اختياري)" icon="create" value={note} onChangeText={setNote} placeholder="مثال: صيام 8 ساعات قبل التحليل" multiline maxLength={300} />
      <Btn title={a.lab?.stage === 'quoted' ? 'إرسال التعديل للعميل' : 'إرسال الموعد والسعر للعميل'} icon="send" loading={busy} onPress={send} />
    </Card>
  );
}

function ReportForm({ a }: { a: Appointment }) {
  const [file, setFile] = useState<{ data: string; name: string; image: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const pickPic = async () => {
    if (!canPickImage) return toast('رفع الصور غير متاح هنا', 'info');
    const img = await pickImage(1600);
    if (img) setFile({ data: img, name: 'تقرير.jpg', image: true }); else toast('تعذر تحميل الصورة، جرّب صورة أخرى', 'err');
  };
  const pickPdf = async () => {
    const f = await pickPdfWeb();
    if (!f) return;
    if (f.data.length > 1800000) return toast('ملف الـPDF كبير (الحد حوالي 1.3 ميجا)', 'err');
    setFile({ ...f, image: false });
  };
  const send = async () => {
    if (!file) return;
    setBusy(true);
    const r = await labAction(a.id, { action: 'report', file: file.data, name: file.name });
    setBusy(false);
    if (!r.ok) return toast(r.error || 'تعذر رفع التقرير', 'err');
    toast('تم رفع التقرير وإنهاء الطلب ✅');
  };
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>رفع التقرير أو نتيجة التحليل</T>
      <T size={12} color={C.sub}>صورة، أو ملف PDF من نسخة الويب. بعد الرفع يصل إشعار للعميل ويُقفل الطلب.</T>
      {file?.image ? <Image source={{ uri: file.data }} style={{ width: '100%', height: 220, borderRadius: 14, backgroundColor: C.line }} contentFit="contain" /> : null}
      {file && !file.image ? <T w="bold" size={13}>📄 {file.name}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn variant="soft" icon="camera" title={file ? 'تغيير' : 'ارفع صورة'} style={{ flex: 1 }} onPress={pickPic} />
        {Platform.OS === 'web' ? <Btn variant="soft" icon="document-text" title="ارفع PDF" style={{ flex: 1 }} onPress={pickPdf} /> : null}
      </View>
      {file ? <Btn title="رفع التقرير وإنهاء الطلب" icon="cloud-upload" variant="green" loading={busy} onPress={send} /> : null}
    </Card>
  );
}

/** buttons under a lab case in the lists (provider / customer / owner) */
export function LabCardActions({ a, navigation, role }: { a: Appointment; navigation: any; role: string }) {
  const lab = a.lab!;
  const go = () => navigation.navigate('ApptDetail', { id: a.id });
  if (role === 'provider') {
    if (lab.stage === 'new') return <Btn small icon="create" title="حدد الموعد والسعر" onPress={go} />;
    if (lab.stage === 'quoted') return <T size={12} color={C.sub}>بانتظار تأكيد العميل للموعد والسعر</T>;
    if (lab.stage === 'confirmed') return (
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small variant="soft" icon="document-text" title="الفاتورة" style={{ flex: 1 }} onPress={() => a.invoiceId && navigation.navigate('Invoice', { id: a.invoiceId })} />
        <Btn small variant="dark" icon="checkmark-done" title="تمت الزيارة" style={{ flex: 1 }} onPress={async () => { const r = await labAction(a.id, { action: 'visit' }); toast(r.ok ? 'تم تسجيل الزيارة، ارفع التقرير لاحقاً' : r.error || 'تعذر التنفيذ', r.ok ? 'ok' : 'err'); }} />
      </View>
    );
    if (lab.stage === 'visited') return <Btn small variant="green" icon="cloud-upload" title="ارفع التقرير" onPress={go} />;
    return null;
  }
  if (role === 'customer') {
    if (lab.stage === 'quoted') return <Btn small variant="green" icon="checkmark" title="عرض الموعد والسعر وتأكيده" onPress={go} />;
    if (lab.stage === 'done') return <Btn small variant="green" icon="document-text" title="عرض التقرير" onPress={go} />;
  }
  return null;
}

export function LabDetail({ navigation, a }: { navigation: any; a: Appointment }) {
  const { db } = useStore();
  const me = useMe()!;
  const lab = a.lab!;
  const isProv = me.role === 'admin' || (me.role === 'provider' && a.clinicOwnerId === me.id);
  const isCust = me.role === 'admin' || me.id === a.customerId;
  const prov = db.providers.find((p) => p.id === a.providerId);
  const hasQuote = ['quoted', 'confirmed', 'visited', 'done'].includes(lab.stage);
  const cancel = () => confirmDialog({ title: 'إلغاء الطلب؟', danger: true, confirmText: 'إلغاء الطلب', onConfirm: async () => { const r = await labAction(a.id, { action: 'cancel' }); toast(r.ok ? 'تم إلغاء الطلب' : r.error || 'تعذر الإلغاء', r.ok ? 'info' : 'err'); } });
  const run = async (action: 'confirm' | 'reject' | 'visit', ok: string) => { const r = await labAction(a.id, { action }); toast(r.ok ? ok : r.error || 'تعذر التنفيذ', r.ok ? 'ok' : 'err'); };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={`طلب تحليل #${a.number}`} subtitle={fmtDateTime(a.createdAt)} onBack={() => navigation.goBack()} right={<LabPill stage={lab.stage} />} />
      <View style={{ flex: 1 }}>
        <Scroll>
          <Card style={{ gap: 12 }}>
            <T w="black" size={15}>بيانات الطلب</T>
            <Row icon="flask" label="المعمل" value={a.clinicName} />
            <Row icon="person" label="المريض" value={a.patientName} />
            <Row icon="call" label="الهاتف" value={a.phone} />
            {!!a.clinicAddress && <Row icon="location" label="العنوان" value={a.clinicAddress} />}
          </Card>
          <Card style={{ gap: 10 }}>
            <T w="black" size={15}>سبب الكشف</T>
            {lab.reason ? <T size={13.5}>{lab.reason}</T> : <T size={12.5} color={C.sub}>لم يكتب العميل سبباً، راجع الروشتة المرفقة.</T>}
            {lab.hasRx ? <LabFileView id={a.id} kind="rx" title="صورة الروشتة" /> : null}
          </Card>
          {hasQuote && (
            <Card style={{ gap: 10, backgroundColor: C.goldSoft }}>
              <T w="black" size={15} color={C.goldDeep}>موعد الكشف والسعر</T>
              <Row icon="calendar" label="اليوم" value={prettyIso(a.date)} />
              <Row icon="time" label="الساعة" value={fmt12(a.time)} />
              <Row icon="cash" label="سعر الكشف" value={money(a.fee)} color={C.goldDeep} />
              {!!lab.note && <Row icon="create" label="ملاحظة المعمل" value={lab.note} />}
            </Card>
          )}
          {lab.stage !== 'rejected' && lab.stage !== 'cancelled' && <Timeline stage={lab.stage} />}
          {lab.stage === 'new' && isCust && !isProv && <T size={12.5} color={C.sub} align="center">بانتظار المعمل ليحدد موعد الكشف والسعر، وسيصلك إشعار.</T>}
          {lab.stage === 'quoted' && isProv && !isCust && <T size={12.5} color={C.sub} align="center">أرسلت الموعد والسعر، بانتظار تأكيد العميل.</T>}
          {isProv && ['new', 'quoted'].includes(lab.stage) && <QuoteForm key={lab.stage + a.updatedAt} a={a} onDone={() => {}} />}
          {isCust && lab.stage === 'quoted' && (
            <Card style={{ gap: 10 }}>
              <T size={12.5} color={C.sub}>لو وافقت على الموعد والسعر اضغط تأكيد، وتصلك فاتورة الحجز وتروح المعمل في نفس الميعاد.</T>
              <Btn title="تأكيد الحجز" icon="checkmark" variant="green" onPress={() => run('confirm', 'تم تأكيد الحجز ✅ وصلتك فاتورة الحجز')} />
            </Card>
          )}
          {isProv && lab.stage === 'confirmed' && <Btn title="تمت الزيارة" icon="checkmark-done" variant="dark" onPress={() => run('visit', 'تم تسجيل الزيارة، ارفع التقرير عند جاهزيته')} />}
          {isProv && ['confirmed', 'visited'].includes(lab.stage) && <ReportForm a={a} />}
          {lab.stage === 'visited' && isCust && !isProv && <T size={12.5} color={C.sub} align="center">تم الكشف. سيرفع المعمل التقرير في هذا الطلب فور جاهزيته، وسيصلك إشعار.</T>}
          {lab.stage === 'done' && lab.hasReport && (
            <Card style={{ gap: 10 }}><LabFileView id={a.id} kind="report" title={`التقرير: ${lab.reportName || ''}`} /></Card>
          )}
          <View style={{ gap: 10 }}>
            {a.invoiceId && <Btn title="عرض فاتورة الحجز" icon="document-text" variant="dark" onPress={() => navigation.navigate('Invoice', { id: a.invoiceId })} />}
            {isProv && ['new', 'quoted'].includes(lab.stage) && <Btn title="اعتذار عن الطلب" icon="close" variant="danger" onPress={() => confirmDialog({ title: 'الاعتذار عن الطلب؟', danger: true, confirmText: 'اعتذار', onConfirm: () => run('reject', 'تم الاعتذار عن الطلب') })} />}
            {(isCust || isProv) && ['new', 'quoted', 'confirmed'].includes(lab.stage) && <Btn title="إلغاء الطلب" icon="close-circle" variant="outline" onPress={cancel} />}
            {me.role !== 'provider' && <Btn title="اتصال بالمعمل" icon="call" variant="soft" onPress={() => callPhone(prov?.phone || '')} />}
            {isProv && <Btn title="اتصال بالمريض" icon="call" variant="soft" onPress={() => callPhone(a.phone)} />}
          </View>
        </Scroll>
      </View>
    </View>
  );
}

function Scroll({ children }: { children: React.ReactNode }) {
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>{children}</ScrollView>;
}
