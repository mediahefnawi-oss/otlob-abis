import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Image, AppState } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { C } from '../lib/theme';
import { T, Card, Btn, Icon, Sheet, Field, Chip, toast, confirmDialog } from './ui';
import { useStore, useMe } from '../lib/store';
import { storage } from '../lib/storage';
import { navigationRef } from '../lib/nav';
import { Appointment } from '../lib/types';
import { RxRow, apiRxList, apiRxPharmacies, apiRxCreate, apiRxPhoto, apiRxStep } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';

const STATUS: Record<string, { label: string; color: string }> = {
  issued: { label: 'بانتظار اختيارك للصيدلية', color: C.goldDeep }, sent: { label: 'وصلت الصيدلية', color: C.goldDeep }, ready: { label: 'جاهزة للاستلام ✅', color: C.green },
  picked_up: { label: 'تم الاستلام', color: C.sub }, delivery: { label: 'طلبت توصيل', color: C.goldDeep }, cancelled: { label: 'ملغية', color: C.red }, expired: { label: 'انتهت صلاحيتها', color: C.red },
};
const left = (r: RxRow) => { const d = Math.ceil((r.expiresAt - Date.now()) / 86400000); return d > 0 ? `باقي ${d} يوم` : ''; };

function usePoll<T2>(f: () => Promise<T2>, on: boolean) {
  const [v, setV] = useState<T2 | null>(null);
  const load = useCallback(() => { f().then(setV).catch(() => {}); }, [f]);
  useEffect(() => { if (!on) return; load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load, on]);
  return [v, load] as const;
}

function RxPhoto({ id }: { id: string }) {
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => { apiRxPhoto(id).then((r) => setImg(r.image)).catch(() => {}); }, [id]);
  return img ? <Image source={{ uri: img }} style={{ width: '100%', height: 190, borderRadius: 14, backgroundColor: C.line }} resizeMode="contain" /> : null;
}

/** Clinic: write the prescription for a confirmed booking and suggest a pharmacy (the patient's own area first). */
export function ClinicRxButton({ a }: { a: Appointment }) {
  const { db } = useStore();
  const [open, setOpen] = useState(false);
  if (!db.settings.features?.rx || a.lab || !['confirmed', 'completed'].includes(a.status)) return null;
  return (
    <>
      <Btn small variant="soft" icon="medkit" title="اكتب روشتة 💊" onPress={() => setOpen(true)} />
      <ClinicRxSheet a={a} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The prescription sheet. The clinic's screen opens it by itself right after "تمت الزيارة" so the doctor never has to look for it. */
export function ClinicRxSheet({ a, visible, onClose }: { a: Appointment; visible: boolean; onClose: () => void }) {
  const [meds, setMeds] = useState('');
  const [img, setImg] = useState<string | null>(null);
  const [phs, setPhs] = useState<{ id: string; name: string; region: string; suggested: boolean }[]>([]);
  const [ph, setPh] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setMeds(''); setImg(null); setPh('');
    apiRxPharmacies(a.id).then((r) => { setPhs(r.pharmacies); const s = r.pharmacies.find((x) => x.suggested); if (s) setPh(s.id); }).catch(() => {});
  }, [visible, a.id]);
  const pick = async () => {
    if (!canPickImage) return toast('رفع الصور متاح حاليًا من نسخة الويب', 'info');
    const x = await pickImage(1100);
    if (x) setImg(x); else toast('تعذر تحميل الصورة', 'err');
  };
  const send = async () => {
    if (!meds.trim() && !img) return toast('اكتب الأدوية أو ارفع صورة الروشتة', 'err');
    setBusy(true);
    try { const r = await apiRxCreate({ appointmentId: a.id, meds, image: img, pharmacyId: ph || undefined }); onClose(); toast(`تم إرسال الروشتة ${r.rx.number} للمريض ✅ وهيوصله إشعار`); }
    catch (e: any) { toast(e?.message || 'تعذر الإرسال', 'err'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Sheet visible={visible} onClose={onClose} title={`روشتة للمريض ${a.patientName || ''}`}>
        <Field label="الأدوية والجرعات" icon="create" value={meds} onChangeText={setMeds} multiline placeholder="مثال: أموكسيسيلين 500 مرتين يوميًا لمدة 5 أيام" />
        {img ? <Image source={{ uri: img }} style={{ width: '100%', height: 140, borderRadius: 14 }} resizeMode="contain" /> : null}
        <Btn variant="soft" icon="camera" title={img ? 'تغيير الصورة' : 'أو ارفع صورة الروشتة'} onPress={pick} />
        {!!phs.length && <T w="bold" size={12.5}>اقترح صيدلية (⭐ الأقرب لمنطقة المريض)</T>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {phs.map((p) => <Chip key={p.id} label={`${p.suggested ? '⭐ ' : ''}${p.name}${p.region ? ` • ${p.region}` : ''}`} active={ph === p.id} onPress={() => setPh(ph === p.id ? '' : p.id)} />)}
        </View>
        <T size={11.5} color={C.sub}>المريض هو اللي يوافق على الصيدلية أو يغيّرها، ومفيش صيدلية بتشوف الروشتة قبل موافقته. صلاحيتها 7 أيام.</T>
        <Btn title="إرسال الروشتة للمريض" icon="send" loading={busy} onPress={send} />
        <Btn variant="soft" title="مفيش روشتة دلوقتي" onPress={onClose} />
      </Sheet>
    </>
  );
}

/** Patient: his prescriptions. Approve / change the pharmacy, collect it or ask for delivery. */
export function MyRxCard() {
  const { db } = useStore();
  const nav: any = useNavigation();
  const on = !!db.settings.features?.rx;
  const [v, load] = usePoll(apiRxList, on);
  const [choice, setChoice] = useState<{ rx: string; ph: string } | null>(null);
  if (!on || !v || !v.list.length) return null;
  const pharmacies = db.providers.filter((p) => p.type === 'pharmacy' && p.status === 'active');
  const act = async (id: string, step: any, body?: any) => {
    try {
      const r = await apiRxStep(id, step, body);
      load();
      if (step === 'delivery' && r.orderText && r.pharmacyId) nav.navigate('RequestOrder', { id: r.pharmacyId, prefill: r.orderText });
      else toast('تم ✅');
    } catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); }
  };
  return (
    <View style={{ gap: 10 }}>
      <T w="black" size={15}>💊 روشتاتي</T>
      {v.list.filter((r) => r.role === 'patient').map((r) => {
        const st = STATUS[r.status] || STATUS.issued;
        return (
          <Card key={r.id} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T w="black" size={15} style={{ flex: 1 }}>{r.number}</T>
              <T w="bold" size={12} color={st.color}>{st.label}</T>
            </View>
            <T size={12} color={C.sub}>من {r.clinicName}{r.pharmacyName ? ` • ${r.pharmacyName}` : ''} {left(r) ? `• ${left(r)}` : ''}</T>
            {!!r.meds && <T size={13}>{r.meds}</T>}
            {r.hasImage && <RxPhoto id={r.id} />}
            {r.status === 'issued' && (
              <View style={{ gap: 8 }}>
                <T w="bold" size={12.5}>اختار الصيدلية اللي تستلم منها</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {pharmacies.map((p) => <Chip key={p.id} label={`${p.id === r.pharmacyId ? '⭐ ' : ''}${p.name}`} active={choice?.rx === r.id && choice.ph === p.id} onPress={() => setChoice({ rx: r.id, ph: p.id })} />)}
                </View>
                <Btn small icon="checkmark" title={r.pharmacyId && choice?.rx !== r.id ? `موافق على ${r.pharmacyName}` : 'تأكيد الصيدلية'} onPress={() => act(r.id, 'choose', { pharmacyId: choice?.rx === r.id ? choice.ph : r.pharmacyId || undefined })} />
              </View>
            )}
            {r.status === 'ready' && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn small variant="green" icon="checkmark-done" title="استلمتها" style={{ flex: 1 }} onPress={() => act(r.id, 'pickup')} />
                <Btn small variant="soft" icon="bicycle" title="وصّلها لي" style={{ flex: 1 }} onPress={() => act(r.id, 'delivery')} />
              </View>
            )}
            {r.status === 'sent' && <Btn small variant="soft" icon="bicycle" title="وصّلها لي" onPress={() => act(r.id, 'delivery')} />}
            {['issued', 'sent'].includes(r.status) && <Btn small variant="danger" icon="close" title="إلغاء الروشتة" onPress={() => confirmDialog({ title: 'إلغاء الروشتة؟', danger: true, confirmText: 'إلغاء', onConfirm: () => act(r.id, 'cancel') })} />}
          </Card>
        );
      })}
    </View>
  );
}

/** Pharmacy: prescriptions the patients chose to send here. */
export function PharmacyRxInbox({ compact }: { compact?: boolean } = {}) {
  const { db } = useStore();
  const on = !!db.settings.features?.rx;
  const [v, load] = usePoll(apiRxList, on);
  if (!on) return null;
  const mine = (v?.list || []).filter((r) => r.role === 'pharmacy' && (!compact || ['sent', 'ready', 'delivery'].includes(r.status)));
  if (compact && !mine.length) return null;
  const act = async (id: string, step: any) => { try { await apiRxStep(id, step); load(); toast('تم ✅'); } catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); } };
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>💊 {compact ? `روشتات للتجهيز (${mine.length})` : 'الروشتات'}</T>
      {!mine.length && !compact && <T size={12.5} color={C.sub}>لا توجد روشتات بعد.</T>}
      {mine.map((r) => {
        const st = STATUS[r.status] || STATUS.sent;
        return (
          <View key={r.id} style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T w="black" size={14.5} style={{ flex: 1 }}>{r.number} • {r.patientName}</T>
              <T w="bold" size={12} color={st.color}>{st.label}</T>
            </View>
            {!!r.meds && <T size={13}>{r.meds}</T>}
            {r.hasImage && <RxPhoto id={r.id} />}
            {r.status === 'sent' && <Btn small variant="green" icon="checkmark" title="جاهزة للاستلام" onPress={() => act(r.id, 'ready')} />}
            {['sent', 'ready', 'delivery'].includes(r.status) && <Btn small variant="soft" icon="checkmark-done" title="تم التسليم" onPress={() => act(r.id, 'pickup')} />}
          </View>
        );
      })}
    </Card>
  );
}

/**
 * Opens the prescription by itself for whoever has to act now, while the app is open: the patient (confirm the pharmacy, then "collect it or deliver
 * it?") and the pharmacy (a new prescription to prepare). Each step is shown once (remembered on the phone); the sound notification brings people
 * to the app, and this sheet is the first thing they see.
 */
export function RxAutoOpen() {
  const { db } = useStore();
  const me = useMe();
  const on = !!db.settings.features?.rx && !!me && me.status === 'active' && (me.role === 'customer' || me.role === 'provider');
  const role = me?.role === 'customer' ? 'patient' : 'pharmacy';
  const [cur, setCur] = useState<RxRow | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const curRef = useRef<RxRow | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const seenReady = useRef<Promise<void> | null>(null);
  const key = (r: RxRow) => `${r.id}:${r.status}`;
  if (!seenReady.current) {
    seenReady.current = storage.getItem('rx_seen').then((v) => { try { (JSON.parse(v || '[]') as string[]).forEach((k) => seen.current.add(k)); } catch { /* ignore */ } }).catch(() => {});
  }
  const check = useCallback(async () => {
    if (!on || curRef.current) return;
    try {
      await seenReady.current;
      const v = await apiRxList();
      const next = v.list.find((x) => x.needsAction && x.role === role && !seen.current.has(key(x)));
      if (next && !curRef.current) { curRef.current = next; setChoice(next.pharmacyId || ''); setCur(next); }
    } catch { /* the next poll tries again */ }
  }, [on, role]);
  useEffect(() => {
    if (!on) return;
    check();
    const t = setInterval(check, 15000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [on, check]);
  const close = (r: RxRow) => {
    seen.current.add(key(r));
    storage.setItem('rx_seen', JSON.stringify([...seen.current].slice(-100))).catch(() => {});
    curRef.current = null; setCur(null);
    setTimeout(check, 400);
  };
  const act = async (r: RxRow, step: any, body?: any, done?: string) => {
    setBusy(true);
    try {
      const x = await apiRxStep(r.id, step, body);
      close(r);
      if (step === 'delivery' && x.orderText && x.pharmacyId && navigationRef.isReady()) (navigationRef as any).navigate('RequestOrder', { id: x.pharmacyId, prefill: x.orderText });
      else if (done) toast(done);
    } catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); }
    finally { setBusy(false); }
  };
  if (!on || !cur) return null;
  const pharmacies = db.providers.filter((p) => p.type === 'pharmacy' && p.status === 'active');
  const r = cur;
  return (
    <Sheet visible onClose={() => close(r)} title={r.role === 'patient' ? (r.status === 'ready' ? `💊 روشتتك جاهزة في ${r.pharmacyName}` : `💊 روشتة جديدة من ${r.clinicName}`) : '💊 روشتة جديدة للتجهيز'}>
      <T size={12.5} color={C.sub}>{r.number}{r.role === 'pharmacy' ? ` • ${r.patientName}` : ''} {left(r) ? `• ${left(r)}` : ''}</T>
      {!!r.meds && <Card style={{ padding: 12 }}><T size={14}>{r.meds}</T></Card>}
      {r.hasImage && <RxPhoto id={r.id} />}
      {r.role === 'patient' && r.status === 'issued' && (
        <View style={{ gap: 10 }}>
          <T w="bold" size={13}>{r.pharmacyId ? `العيادة رشّحت لك ${r.pharmacyName}` : 'اختار الصيدلية اللي تستلم منها'}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {pharmacies.map((p) => <Chip key={p.id} label={`${p.id === r.pharmacyId ? '⭐ ' : ''}${p.name}`} active={choice === p.id} onPress={() => setChoice(p.id)} />)}
          </View>
          <Btn icon="checkmark" title={choice && choice === r.pharmacyId ? `موافق على ${r.pharmacyName}` : 'تأكيد الصيدلية'} loading={busy} onPress={() => (choice ? act(r, 'choose', { pharmacyId: choice }, 'اتبعتت للصيدلية، هيوصلك إشعار لما تجهز ✅') : toast('اختار صيدلية', 'err'))} />
          <Btn variant="soft" title="لاحقًا" onPress={() => close(r)} />
        </View>
      )}
      {r.role === 'patient' && r.status === 'ready' && (
        <View style={{ gap: 10 }}>
          <T w="bold" size={13}>تحب تستلمها بنفسك ولا نوصّلهالك؟</T>
          <Btn variant="green" icon="walk" title="هعدّي أستلمها" loading={busy} onPress={() => { close(r); toast('تمام، الصيدلية مستنياك ✅'); }} />
          <Btn icon="bicycle" title="وصّلها لي" loading={busy} onPress={() => act(r, 'delivery')} />
          <Btn variant="soft" title="لاحقًا" onPress={() => close(r)} />
        </View>
      )}
      {r.role === 'pharmacy' && (
        <View style={{ gap: 10 }}>
          <Btn variant="green" icon="checkmark" title="جاهزة للاستلام (هنبلّغ العميل)" loading={busy} onPress={() => act(r, 'ready', {}, 'اتبلّغ العميل ✅')} />
          <Btn variant="soft" title="لاحقًا" onPress={() => close(r)} />
        </View>
      )}
    </Sheet>
  );
}
