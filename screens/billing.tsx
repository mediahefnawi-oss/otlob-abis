import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, ScrollView as RNScroll } from 'react-native';
import { ScrollView } from '../components/KScroll';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Header, Field, Chip, Sheet, Toggle, SectionTitle, Empty, toast, confirmDialog } from '../components/ui';
import { useMe } from '../lib/store';
import { InvoiceView, BUILTIN, KIND_TITLE, paperMm, paperName, stampSource } from '../components/InvoiceView';
import { captureView, shareImage, printImage, openWhatsAppChat } from '../lib/shareImage';
import { pickImage, canPickImage } from '../lib/pickImage';
import {
  apiBillingConfig, apiBillingDesign, apiBillingStampAdd, apiBillingStampDelete, apiBillingParties, apiBillingCommission, apiBillingInvoices, apiBillingInvoice,
  apiBillingCreate, apiBillingVoid, InvDesign, InvStamp, InvStampPlace, InvKind, InvParty, InvListRow, Invoice,
} from '../lib/api';

const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');
const num = (s: string) => { const n = Number(String(s).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isOwnerAcct = (me: any) => !!me && me.role === 'admin' && !me.manager;

/* ---------------- home: new invoice / my invoices ---------------- */
export function BillingHomeScreen({ navigation }: any) {
  const me = useMe();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<InvListRow[] | null>(null);
  const load = useCallback(() => { apiBillingInvoices(q.trim()).then((r) => setRows(r.invoices)).catch((e) => { setRows([]); toast(errText(e), 'err'); }); }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => navigation.addListener('focus', load), [navigation, load]);
  const kinds: { k: InvKind; l: string; icon: string; s: string }[] = [
    { k: 'customer', l: 'فاتورة عميل', icon: 'person', s: 'أصناف وأسعار + خدمة التوصيل' },
    { k: 'provider', l: 'فاتورة مقدم خدمة', icon: 'storefront', s: 'أصناف وأسعار لمحل أو مقدم خدمة' },
    { k: 'courier', l: 'فاتورة مندوب', icon: 'bicycle', s: 'أصناف وأسعار لمندوب' },
    { k: 'commission', l: 'فاتورة عمولة', icon: 'cash', s: 'عمولة مقدم خدمة أو مندوب (تلقائي أو بإيدك)' },
  ];
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="عمل فاتورة" subtitle="اكتب فاتورة وابعتها واتساب أو اطبعها" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {kinds.map((k) => (
          <Card key={k.k} onPress={() => navigation.navigate('InvoiceForm', { kind: k.k })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name={k.icon} size={26} color={C.goldDeep} />
            <View style={{ flex: 1 }}><T w="black" size={15}>{k.l}</T><T size={12} color={C.sub}>{k.s}</T></View>
            <Icon name="chevron-back" size={18} color={C.sub} />
          </Card>
        ))}
        {isOwnerAcct(me) && <Btn variant="soft" icon="color-palette" title="تصميم الفاتورة وإدارة الأختام" onPress={() => navigation.navigate('InvoiceDesign')} />}
        <SectionTitle title="فواتيري" />
        <Field value={q} onChangeText={setQ} placeholder="ابحث بالاسم أو الموبايل أو رقم الفاتورة" icon="search" />
        {rows && rows.length === 0 && <Empty icon="document-text" title="لا توجد فواتير" />}
        {(rows || []).map((r) => (
          <Card key={r.id} onPress={() => navigation.navigate('InvoiceDetail', { id: r.id })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: r.voided ? 0.5 : 1 }}>
            <View style={{ flex: 1 }}>
              <T w="bold" size={14} style={r.voided ? { textDecorationLine: 'line-through' } : undefined}>#{r.number} • {r.partyName}</T>
              <T size={11.5} color={C.sub}>{KIND_TITLE[r.kind]} • {new Date(r.createdAt).toLocaleDateString('ar-EG')}{r.voided ? ' • ملغاة' : ''}</T>
            </View>
            <T w="black" size={15} color={C.goldDeep}>{r.total} ج.م</T>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

/* ---------------- pick a registered customer / shop / courier ---------------- */
function PartyPicker({ visible, kind, onClose, onPick }: { visible: boolean; kind: 'customer' | 'provider' | 'courier'; onClose: () => void; onPick: (p: InvParty) => void }) {
  const [q, setQ] = useState(''); const [list, setList] = useState<InvParty[]>([]);
  useEffect(() => {
    if (!visible || q.trim().length < 2) { setList([]); return; }
    let dead = false;
    const t = setTimeout(() => { apiBillingParties(kind, q.trim()).then((r) => { if (!dead) setList(r.parties); }).catch(() => {}); }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [q, kind, visible]);
  return (
    <Sheet visible={visible} onClose={onClose} title="اختيار من المسجلين">
      <Field value={q} onChangeText={setQ} placeholder="اكتب حرفين من الاسم أو الموبايل" icon="search" autoFocus />
      <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
        {list.map((p) => (
          <Pressable key={`${p.userId}-${p.providerId}`} onPress={() => { onPick(p); onClose(); setQ(''); }} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <T w="bold" size={14}>{p.name}</T><T size={12} color={C.sub}>{p.phone}</T>
          </Pressable>
        ))}
        {q.trim().length >= 2 && list.length === 0 && <T size={12.5} color={C.sub}>لا توجد نتائج</T>}
      </ScrollView>
    </Sheet>
  );
}

/* ---------------- create ---------------- */
type L = { name: string; qty: string; price: string };
export function InvoiceFormScreen({ navigation, route }: any) {
  const kind: InvKind = route.params?.kind || 'customer';
  const [partyKind, setPartyKind] = useState<'customer' | 'provider' | 'courier'>(kind === 'commission' ? 'provider' : kind);
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [uid, setUid] = useState<number | null>(null); const [pid, setPid] = useState<number | null>(null);
  const [pick, setPick] = useState(false);
  const [lines, setLines] = useState<L[]>([{ name: '', qty: '1', price: '' }]);
  const [delivery, setDelivery] = useState(''); const [discount, setDiscount] = useState('');
  const [extras, setExtras] = useState<{ label: string; value: string }[]>([]);
  const [number, setNumber] = useState('');
  const [cfg, setCfg] = useState<{ design: InvDesign; stamps: InvStamp[]; nextNumber: number } | null>(null);
  const [stamps, setStamps] = useState<InvStampPlace[]>([]);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1))); const [to, setTo] = useState(iso(now));
  const [cBase, setCBase] = useState(''); const [cComm, setCComm] = useState(''); const [cSet, setCSet] = useState(''); const [cOrders, setCOrders] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<any>(null);

  useEffect(() => {
    apiBillingConfig().then((c) => {
      setCfg(c); setNumber(String(c.nextNumber));
      setStamps(c.design.defaultStamps.slice(0, 4).map((r, i, a) => ({ ref: r, x: a.length === 1 ? 0.75 : 0.25 + (0.5 * i) / Math.max(1, a.length - 1), y: 0.9, size: 0.3 })));
    }).catch((e) => toast(errText(e), 'err'));
  }, []);

  const partyId = partyKind === 'provider' ? pid : uid;
  const fetchAuto = useCallback(async () => {
    if (kind !== 'commission' || mode !== 'auto' || !partyId || partyKind === 'customer') return;
    try {
      const r = (await apiBillingCommission(partyKind, partyId, from, to)).figures;
      setCBase(String(r.base)); setCComm(String(r.commission)); setCSet(String(r.settled)); setCOrders(String(r.orders));
    } catch (e) { toast(errText(e), 'err'); }
  }, [kind, mode, partyId, partyKind, from, to]);
  useEffect(() => { fetchAuto(); }, [fetchAuto]);

  const cleanLines = lines.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), qty: num(l.qty) || 1, price: num(l.price) }));
  const sub = cleanLines.reduce((s, l) => s + l.qty * l.price, 0);
  const total = kind === 'commission' ? Math.max(0, num(cComm) - num(cSet)) : Math.max(0, sub + (kind === 'customer' ? num(delivery) : 0) - num(discount));
  const design = cfg?.design;
  const commission = kind === 'commission' ? { mode, from, to, orders: num(cOrders), base: num(cBase), commission: num(cComm), settled: num(cSet), percent: num(cBase) > 0 ? Math.round((num(cComm) / num(cBase)) * 1000) / 10 : null } : null;
  const preview: any = design && {
    number: num(number) || 0, kind, partyName: name.trim() || 'اسم العميل', partyPhone: phone.trim(), lines: cleanLines, extras: extras.filter((x) => x.label || x.value),
    delivery: kind === 'customer' ? num(delivery) : 0, discount: num(discount), total, commission, design, stamps, createdAt: Date.now(),
  };
  const setLine = (i: number, p: Partial<L>) => setLines((a) => a.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const move = (i: number, p: Partial<InvStampPlace>) => setStamps((a) => a.map((s, j) => (j === i ? { ...s, ...p, x: Math.min(1, Math.max(0, p.x ?? s.x)), y: Math.min(1, Math.max(0, p.y ?? s.y)), size: Math.min(0.7, Math.max(0.08, p.size ?? s.size)) } : s)));
  const label = (r: string) => (r.startsWith('b:') ? BUILTIN[r.slice(2)]?.label : cfg?.stamps.find((s) => 'u:' + s.id === r)?.name) || 'ختم';

  const save = async () => {
    if (name.trim().length < 2) return toast('اكتب الاسم', 'err');
    if (phone.trim() && !/^01[0-9]{9}$/.test(phone.replace(/\s+/g, ''))) return toast('رقم الموبايل لازم 11 رقم يبدأ بـ 01 (أو سيبه فاضي)', 'err');
    if (kind !== 'commission' && cleanLines.length === 0) return toast('أضف صنف واحد على الأقل', 'err');
    if (kind === 'commission' && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))) return toast('اكتب الفترة بشكل 2026-11-01', 'err');
    setBusy(true);
    try {
      const body: any = { kind, partyKind, partyName: name.trim(), partyPhone: phone.replace(/\s+/g, ''), partyUserId: uid || undefined, partyProviderId: pid || undefined, extras: preview.extras, stamps, number: number ? num(number) : undefined };
      if (kind === 'commission') body.commission = commission; else { body.lines = cleanLines; body.delivery = preview.delivery; body.discount = num(discount); }
      const r = await apiBillingCreate(body);
      toast('تم إنشاء الفاتورة ✅');
      navigation.replace('InvoiceDetail', { id: r.invoice.id });
    } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };

  const title = KIND_TITLE[kind];
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={title} subtitle="املأ البيانات وشوف الفاتورة قبل الحفظ" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {kind === 'commission' && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="مقدم خدمة" active={partyKind === 'provider'} onPress={() => { setPartyKind('provider'); setUid(null); setPid(null); }} />
            <Chip label="مندوب" active={partyKind === 'courier'} onPress={() => { setPartyKind('courier'); setUid(null); setPid(null); }} />
          </View>
        )}
        <Card style={{ gap: 10 }}>
          <T w="black" size={14}>بيانات {partyKind === 'customer' ? 'العميل' : partyKind === 'provider' ? 'مقدم الخدمة' : 'المندوب'}</T>
          <Field label="الاسم" value={name} onChangeText={(v) => { setName(v); setUid(null); setPid(null); }} placeholder="الاسم بالكامل" />
          <Field label="رقم الموبايل" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="01xxxxxxxxx" />
          <Btn small variant="soft" icon="search" title="اختيار من المسجلين" onPress={() => setPick(true)} />
        </Card>
        <PartyPicker visible={pick} kind={partyKind} onClose={() => setPick(false)} onPick={(p) => { setName(p.name); setPhone(p.phone); setUid(p.userId); setPid(p.providerId); }} />

        {kind !== 'commission' ? (
          <Card style={{ gap: 10 }}>
            <T w="black" size={14}>الأصناف</T>
            {lines.map((l, i) => (
              <View key={i} style={{ gap: 6, borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 10 }}>
                <Field value={l.name} onChangeText={(v) => setLine(i, { name: v })} placeholder="اسم الصنف" />
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <View style={{ flex: 1 }}><Field label="الكمية" value={l.qty} onChangeText={(v) => setLine(i, { qty: v })} keyboardType="decimal-pad" /></View>
                  <View style={{ flex: 1 }}><Field label="السعر" value={l.price} onChangeText={(v) => setLine(i, { price: v })} keyboardType="decimal-pad" /></View>
                  {lines.length > 1 && <Pressable onPress={() => setLines((a) => a.filter((_, j) => j !== i))} hitSlop={10} style={{ paddingTop: 20 }}><Icon name="trash" size={20} color={C.red} /></Pressable>}
                </View>
              </View>
            ))}
            <Btn small variant="soft" icon="add" title="＋ إضافة صنف" onPress={() => setLines((a) => [...a, { name: '', qty: '1', price: '' }])} />
            {kind === 'customer' && <Field label="خدمة التوصيل (ج.م)" value={delivery} onChangeText={setDelivery} keyboardType="decimal-pad" placeholder="0" />}
            <Field label="الخصم (ج.م)" value={discount} onChangeText={setDiscount} keyboardType="decimal-pad" placeholder="0" />
          </Card>
        ) : (
          <Card style={{ gap: 10 }}>
            <T w="black" size={14}>العمولة</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Toggle value={mode === 'auto'} onValueChange={(v) => setMode(v ? 'auto' : 'manual')} />
              <T size={13} style={{ flex: 1 }}>{mode === 'auto' ? 'تلقائي من الطلبات (تقدر تعدّل أي رقم)' : 'هكتبها بنفسي'}</T>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}><Field label="من" value={from} onChangeText={setFrom} placeholder="2026-11-01" /></View>
              <View style={{ flex: 1 }}><Field label="إلى" value={to} onChangeText={setTo} placeholder="2026-11-30" /></View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Chip label="الشهر ده" onPress={() => { const d = new Date(); setFrom(iso(new Date(d.getFullYear(), d.getMonth(), 1))); setTo(iso(d)); }} />
              <Chip label="الشهر اللي فات" onPress={() => { const d = new Date(); setFrom(iso(new Date(d.getFullYear(), d.getMonth() - 1, 1))); setTo(iso(new Date(d.getFullYear(), d.getMonth(), 0))); }} />
            </View>
            {mode === 'auto' && !partyId && <T size={12} color={C.orange}>اختار الطرف من «اختيار من المسجلين» عشان الأرقام تتحسب تلقائي</T>}
            <Field label="عدد الطلبات" value={cOrders} onChangeText={setCOrders} keyboardType="number-pad" />
            <Field label="إجمالي المبيعات" value={cBase} onChangeText={setCBase} keyboardType="decimal-pad" />
            <Field label="العمولة المستحقة" value={cComm} onChangeText={setCComm} keyboardType="decimal-pad" />
            <Field label="مدفوع سابقاً" value={cSet} onChangeText={setCSet} keyboardType="decimal-pad" />
          </Card>
        )}

        <Card style={{ gap: 10 }}>
          <T w="black" size={14}>بيانات إضافية (اختياري)</T>
          {extras.map((x, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><Field value={x.label} onChangeText={(v) => setExtras((a) => a.map((e, j) => (j === i ? { ...e, label: v } : e)))} placeholder="العنوان" /></View>
              <View style={{ flex: 1.3 }}><Field value={x.value} onChangeText={(v) => setExtras((a) => a.map((e, j) => (j === i ? { ...e, value: v } : e)))} placeholder="القيمة" /></View>
              <Pressable onPress={() => setExtras((a) => a.filter((_, j) => j !== i))} hitSlop={10}><Icon name="close" size={20} color={C.red} /></Pressable>
            </View>
          ))}
          {extras.length < 10 && <Btn small variant="soft" icon="add" title="＋ إضافة بيان" onPress={() => setExtras((a) => [...a, { label: '', value: '' }])} />}
          <Field label="رقم الفاتورة" value={number} onChangeText={setNumber} keyboardType="number-pad" />
        </Card>

        <Card style={{ gap: 10 }}>
          <T w="black" size={14}>الأختام (اختياري)</T>
          <T size={12} color={C.sub}>اضغط على ختم لإضافته، وتقدر تحركه وتكبّره أو تشيله. ممكن فاتورة من غير أي ختم.</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[...Object.keys(BUILTIN).map((k) => 'b:' + k), ...(cfg?.stamps || []).map((s) => 'u:' + s.id)].map((r) => (
              <Chip key={r} icon="add" label={label(r)} onPress={() => stamps.length < 6 ? setStamps((a) => [...a, { ref: r, x: 0.5 + (a.length % 3 - 1) * 0.2, y: 0.9, size: 0.3 }]) : toast('حد أقصى 6 أختام', 'err')} />
            ))}
          </View>
          {stamps.map((s, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', backgroundColor: C.bg, borderRadius: 12, padding: 8 }}>
              <T w="bold" size={12.5} style={{ flex: 1, minWidth: 90 }}>{label(s.ref)}</T>
              {[['arrow-forward', { x: s.x + 0.04 }], ['arrow-back', { x: s.x - 0.04 }], ['arrow-up', { y: s.y - 0.03 }], ['arrow-down', { y: s.y + 0.03 }], ['add-circle', { size: s.size + 0.04 }], ['remove-circle', { size: s.size - 0.04 }]].map(([ic, p]: any) => (
                <Pressable key={ic} onPress={() => move(i, p)} hitSlop={6}><Icon name={ic} size={24} color={C.dark} /></Pressable>
              ))}
              <Pressable onPress={() => setStamps((a) => a.filter((_, j) => j !== i))} hitSlop={8}><Icon name="close-circle" size={24} color={C.red} /></Pressable>
            </View>
          ))}
        </Card>

        <T w="black" size={14}>معاينة الفاتورة</T>
        {preview && cfg && (
          <RNScroll horizontal contentContainerStyle={{ paddingBottom: 4 }}>
            <View style={{ borderWidth: 1, borderColor: C.line }}><InvoiceView ref={ref} inv={preview} stamps={cfg.stamps} /></View>
          </RNScroll>
        )}
        <Btn title="حفظ الفاتورة" icon="checkmark-circle" loading={busy} onPress={save} />
      </ScrollView>
    </View>
  );
}

/* ---------------- one invoice: send / print / cancel ---------------- */
export function InvoiceDetailScreen({ navigation, route }: any) {
  const id = Number(route.params?.id);
  const [d, setD] = useState<{ invoice: Invoice; stamps: InvStamp[] } | null>(null);
  const [busy, setBusy] = useState('');
  const ref = useRef<any>(null);
  const load = useCallback(() => { apiBillingInvoice(id).then(setD).catch((e) => toast(errText(e), 'err')); }, [id]);
  useEffect(load, [load]);
  if (!d) return <View style={{ flex: 1, backgroundColor: C.bg }}><Header title="فاتورة" onBack={() => navigation.goBack()} /></View>;
  const inv = d.invoice;
  const text = `فاتورة رقم ${inv.number} من أطلب أبيس`;
  const run = async (what: string, fn: (uri: string) => Promise<any>) => {
    setBusy(what);
    try { const uri = await captureView(ref.current); await fn(uri); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(''); }
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={`فاتورة #${inv.number}`} subtitle={inv.voided ? 'ملغاة' : KIND_TITLE[inv.kind]} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        <RNScroll horizontal><View style={{ borderWidth: 1, borderColor: C.line }}><InvoiceView ref={ref} inv={inv} stamps={d.stamps} /></View></RNScroll>
        <Btn title="إرسال الفاتورة (واتساب)" icon="logo-whatsapp" variant="green" loading={busy === 'wa'} onPress={() => run('wa', async (uri) => { const r = await shareImage(uri, `فاتورة-${inv.number}`, text); if (r === 'downloaded') toast('تم تنزيل صورة الفاتورة، ابعتها من واتساب'); })} />
        {!!inv.partyPhone && <Btn title={`فتح محادثة ${inv.partyName} على واتساب`} icon="chatbubble-ellipses" variant="soft" onPress={() => openWhatsAppChat(inv.partyPhone, text)} />}
        <T size={11.5} color={C.sub}>واتساب مش بيسمح لأي تطبيق يبعت صورة لرقم معين لوحده: اضغط «إرسال» واختار المحادثة، أو افتح المحادثة الأول وابعت الصورة.</T>
        <Btn title={`طباعة (ورق ${inv.design.width === 'wa' ? 80 : paperName(inv.design.width)} مم)`} icon="print" variant="dark" loading={busy === 'pr'} onPress={() => run('pr', (uri) => printImage(uri, paperMm(inv.design.width)))} />
        {!inv.voided && <Btn title="إلغاء الفاتورة" icon="close-circle" variant="danger" onPress={() => confirmDialog({ title: 'إلغاء الفاتورة؟', message: 'هتفضل ظاهرة في القائمة بعلامة «ملغاة» ومش بتتمسح.', danger: true, confirmText: 'إلغاء الفاتورة', onConfirm: async () => { try { await apiBillingVoid(inv.id); toast('تم إلغاء الفاتورة'); load(); } catch (e) { toast(errText(e), 'err'); } } })} />}
      </ScrollView>
    </View>
  );
}

/* ---------------- owner only: the look of the invoice and the stamps ---------------- */
export function InvoiceDesignScreen({ navigation }: any) {
  const me = useMe();
  const [cfg, setCfg] = useState<{ design: InvDesign; stamps: InvStamp[]; nextNumber: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiBillingConfig().then(setCfg).catch((e) => toast(errText(e), 'err')); }, []);
  useEffect(load, [load]);
  if (!isOwnerAcct(me)) return <View style={{ flex: 1, backgroundColor: C.bg }}><Header title="تصميم الفاتورة" onBack={() => navigation.goBack()} /><Empty icon="lock-closed" title="للمالك فقط" /></View>;
  if (!cfg) return <View style={{ flex: 1, backgroundColor: C.bg }}><Header title="تصميم الفاتورة" onBack={() => navigation.goBack()} /></View>;
  const d = cfg.design;
  const set = (p: Partial<InvDesign>) => setCfg({ ...cfg, design: { ...d, ...p } });
  const save = async () => { setBusy(true); try { const r = await apiBillingDesign(d); setCfg({ ...cfg, design: r.design }); toast('تم حفظ التصميم ✅'); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); } };
  const sw = (k: keyof InvDesign, l: string) => (
    <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Toggle value={!!d[k]} onValueChange={(v) => set({ [k]: v } as any)} /><T size={13.5} style={{ flex: 1 }}>{l}</T></View>
  );
  const addStamp = async () => {
    const img = await pickImage(500, true);
    if (!img) return;
    try { await apiBillingStampAdd('ختم جديد', img); toast('تم رفع الختم ✅'); load(); } catch (e) { toast(errText(e), 'err'); }
  };
  const defs = (r: string) => d.defaultStamps.includes(r);
  const togDef = (r: string) => set({ defaultStamps: defs(r) ? d.defaultStamps.filter((x) => x !== r) : [...d.defaultStamps, r].slice(0, 4) });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="تصميم الفاتورة والأختام" subtitle="التغييرات بتنطبق على الفواتير الجديدة فقط" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 12 }}>
          <T w="black" size={14}>إيه اللي يظهر في الفاتورة</T>
          {sw('showLogo', 'الشعار')}{sw('showSupport', 'رقم الدعم والموقع')}{sw('showParty', 'اسم وموبايل الطرف')}{sw('showPayment', 'طريقة الدفع')}{sw('showThanks', 'جملة الشكر')}
        </Card>
        <Card style={{ gap: 10 }}>
          <T w="black" size={14}>الألوان وعرض الورق</T>
          <View style={{ flexDirection: 'row', gap: 8 }}><Chip label="ملوّنة" active={d.theme === 'color'} onPress={() => set({ theme: 'color' })} /><Chip label="أبيض وأسود (للطابعة)" active={d.theme === 'bw'} onPress={() => set({ theme: 'bw' })} /></View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Chip label="صورة واتساب" active={d.width === 'wa'} onPress={() => set({ width: 'wa' })} />
            <Chip label="ورق 80 مم" active={d.width === '80'} onPress={() => set({ width: '80' })} />
            <Chip label="ورق 58 مم" active={d.width === '58'} onPress={() => set({ width: '58' })} />
          </View>
        </Card>
        <Card style={{ gap: 10 }}>
          <T w="black" size={14}>النصوص</T>
          <Field label="الشعار اللفظي" value={d.tagline} onChangeText={(v) => set({ tagline: v })} />
          <Field label="رقم الدعم" value={d.supportPhone} onChangeText={(v) => set({ supportPhone: v })} keyboardType="phone-pad" />
          <Field label="الموقع" value={d.website} onChangeText={(v) => set({ website: v })} autoCapitalize="none" />
          <Field label="جملة الشكر" value={d.thanks} onChangeText={(v) => set({ thanks: v })} />
          <Field label="طريقة الدفع" value={d.payment} onChangeText={(v) => set({ payment: v })} />
        </Card>
        <Card style={{ gap: 10 }}>
          <T w="black" size={14}>بيانات ثابتة تظهر في كل فاتورة</T>
          {d.fixed.map((x, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><Field value={x.label} onChangeText={(v) => set({ fixed: d.fixed.map((e, j) => (j === i ? { ...e, label: v } : e)) })} placeholder="العنوان" /></View>
              <View style={{ flex: 1.3 }}><Field value={x.value} onChangeText={(v) => set({ fixed: d.fixed.map((e, j) => (j === i ? { ...e, value: v } : e)) })} placeholder="القيمة" /></View>
              <Pressable onPress={() => set({ fixed: d.fixed.filter((_, j) => j !== i) })} hitSlop={10}><Icon name="close" size={20} color={C.red} /></Pressable>
            </View>
          ))}
          {d.fixed.length < 8 && <Btn small variant="soft" icon="add" title="＋ إضافة بيان ثابت" onPress={() => set({ fixed: [...d.fixed, { label: '', value: '' }] })} />}
        </Card>
        <Card style={{ gap: 10 }}>
          <T w="black" size={14}>الأختام الافتراضية</T>
          <T size={12} color={C.sub}>الأختام المختارة هنا بتتحط تلقائي في الفاتورة الجديدة (وتقدر تشيلها). سيبها فاضية لو مش عايز أي ختم.</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[...Object.keys(BUILTIN).map((k) => 'b:' + k), ...cfg.stamps.map((s) => 'u:' + s.id)].map((r) => {
              const src = stampSource(r, false, cfg.stamps);
              const nm = r.startsWith('b:') ? BUILTIN[r.slice(2)].label : cfg.stamps.find((s) => 'u:' + s.id === r)?.name || 'ختم';
              return (
                <View key={r} style={{ alignItems: 'center', gap: 4 }}>
                  <Pressable onPress={() => togDef(r)} style={{ borderWidth: 2, borderColor: defs(r) ? C.gold : C.line, borderRadius: 12, padding: 4, backgroundColor: '#fff' }}>
                    {!!src && <View style={{ width: 70, height: 70 }}><StampImg src={src} /></View>}
                  </Pressable>
                  <T size={11} color={C.sub}>{nm}</T>
                  {r.startsWith('u:') && <Pressable onPress={() => confirmDialog({ title: 'حذف الختم؟', message: 'مش هيتأثر شكل الفواتير القديمة.', danger: true, confirmText: 'حذف', onConfirm: async () => { try { await apiBillingStampDelete(Number(r.slice(2))); load(); } catch (e) { toast(errText(e), 'err'); } } })}><T size={11} color={C.red}>حذف</T></Pressable>}
                </View>
              );
            })}
          </View>
          {canPickImage && <Btn small variant="soft" icon="cloud-upload" title="رفع ختم من عندي (صورة PNG)" onPress={addStamp} />}
        </Card>
        <Btn title="حفظ التصميم" icon="save" loading={busy} onPress={save} />
      </ScrollView>
    </View>
  );
}
function StampImg({ src }: { src: any }) {
  const { Image } = require('react-native');
  return <Image source={src} style={{ width: 70, height: 70 }} resizeMode="contain" />;
}
