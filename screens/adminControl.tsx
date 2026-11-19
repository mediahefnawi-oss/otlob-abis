import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { ScrollView } from '../components/KScroll';
import { C } from '../lib/theme';
import { useStore, saveHomeLayout, listStaffCouriers, StaffCourier, dispatchOrders } from '../lib/store';
import { BlocksManager } from '../components/HomeBlocks';
import { serviceDefs, TYPES, isMakerTpl, typeKeys } from '../lib/format';
import type { HomeShape } from '../lib/api';
import { T, Icon, Card, Btn, Empty, Header, Field, Chip, toast } from '../components/ui';
import { GateRow, apiAdminGates, apiAdminGateSave } from '../lib/api';

const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');
const fmtUntil = (ms: number) => new Date(ms).toLocaleString('ar-EG', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
/** "reopen after": null = by hand */
const UNTIL: { label: string; at: () => string | null }[] = [
  { label: 'أفتحه بنفسي', at: () => null },
  { label: 'بعد ساعة', at: () => new Date(Date.now() + 3600e3).toISOString() },
  { label: 'بعد 3 ساعات', at: () => new Date(Date.now() + 3 * 3600e3).toISOString() },
  { label: 'الصبح 8', at: () => { const d = new Date(); d.setHours(8, 0, 0, 0); if (d.getTime() <= Date.now() + 600e3) d.setDate(d.getDate() + 1); return d.toISOString(); } },
  { label: 'بكرة الظهر', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.toISOString(); } },
];

function GateCard({ g, onSaved }: { g: GateRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(g.message || '');
  const [u, setU] = useState(0);
  const [busy, setBusy] = useState(false);
  const save = async (closed: boolean) => {
    setBusy(true);
    try { await apiAdminGateSave(g.key, closed ? { closed: true, message: msg.trim(), until: UNTIL[u].at() } : { closed: false }); toast(closed ? 'تم قفل استقبال الطلبات' : 'تم الفتح ✅'); setOpen(false); onSaved(); }
    catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const whole = g.key === '*';
  return (
    <Card style={{ gap: 8, borderWidth: g.closed ? 2 : 0, borderColor: C.red }}>
      <Pressable onPress={() => setOpen((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T w="black" size={whole ? 17 : 15}>{g.label}</T>
          {g.closed ? <T size={12} color={C.red}>مقفول{g.until ? ` — يفتح ${fmtUntil(g.until)}` : ''}{g.message ? ` • «${g.message}»` : ''}</T> : <T size={12} color={C.green}>{g.rawClosed ? 'اتفتح تلقائياً' : 'مفتوح'}</T>}
        </View>
        <View style={{ backgroundColor: g.closed ? C.redSoft : C.greenSoft, borderRadius: 10, paddingVertical: 5, paddingHorizontal: 12 }}><T w="black" size={12.5} color={g.closed ? C.red : C.green}>{g.closed ? 'مقفول' : 'مفتوح'}</T></View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={C.sub} />
      </Pressable>
      {open && (
        <View style={{ gap: 8 }}>
          {!g.closed && (
            <>
              {whole && <T size={12} color={C.red}>قفل التطبيق كله بيمنع أي طلب جديد من كل الخدمات. الأوردرات الشغالة مش بتتأثر والعميل يقدر يتصفح.</T>}
              <Field label="رسالة للعميل (اختياري)" value={msg} onChangeText={setMsg} placeholder="مثال: بنستقبل الطلبات من 9 الصبح" />
              <T size={12.5} w="bold">يفتح تاني:</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{UNTIL.map((x, i) => <Chip key={i} label={x.label} active={u === i} onPress={() => setU(i)} />)}</ScrollView>
              <Btn title={`قفل ${g.label}`} icon="lock-closed" onPress={() => save(true)} loading={busy} />
            </>
          )}
          {g.closed && <Btn title={`افتح ${g.label} دلوقتي`} icon="lock-open" onPress={() => save(false)} loading={busy} />}
        </View>
      )}
    </Card>
  );
}

/** Owner / manager: stop or resume NEW orders — the whole app or one service — with a message and an automatic re-open time. */
export function AdminGatesScreen({ navigation }: any) {
  const [rows, setRows] = useState<GateRow[] | null>(null);
  const load = useCallback(async () => { try { setRows((await apiAdminGates()).gates); } catch (e) { toast(errText(e), 'err'); setRows((r) => r || []); } }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="فتح وقفل الطلبات" subtitle="وقف الطلبات الجديدة كلها أو لخدمة واحدة" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 30 }}>
        {rows === null ? <Empty title="جاري التحميل..." /> : rows.map((g) => <GateCard key={`${g.key}-${g.closed}-${g.message}`} g={g} onSaved={load} />)}
      </ScrollView>
    </View>
  );
}

const SECTION_LABEL: Record<string, string> = {
  ads: 'الإعلانات الرئيسية (فوق)', today: 'عروض النهاردة', favorites: 'المفضلة', announce: 'الإعلان النصي', services: 'أيقونات الخدمات',
  marketOffers: 'عروض ماركت', makers: 'صنايعية (كارت عريض)', market: 'طلبات ماركت (كارت)', rides: 'توصيلة (كارت)', trips: 'رحلات المحافظات (كارت)',
  active: 'طلباتك الجارية', errand: 'اطلب أي حاجة (مشوار)', nearby: 'بالقرب منك', top: 'الأعلى تقييماً',
};
const SHAPES: { k: HomeShape; label: string }[] = [{ k: 'tile', label: 'مربع' }, { k: 'rect', label: 'مستطيل' }, { k: 'wide', label: 'عريض' }, { k: 'round', label: 'دايرة' }, { k: 'text', label: 'كلمة فقط' }];
const DEFAULT_ORDER = ['ads', 'today', 'favorites', 'announce', 'services', 'marketOffers', 'makers', 'market', 'rides', 'active', 'errand', 'nearby', 'top', 'trips'];

/** Owner: design the customer home — order of the sections, hide / show, icon shapes, grid or one swipeable row, banners anywhere. */
export function AdminHomeLayoutScreen({ navigation }: any) {
  const { db } = useStore();
  const layout = (db.settings.homeLayout || {}) as { order?: string[]; hidden?: string[]; mode?: 'grid' | 'row'; svc?: Record<string, { shape: HomeShape }> };
  const blocks = (db.settings.homeBlocks || []).filter((b) => b.active);
  const blockIds = blocks.map((b) => `ban:${b.id}`);
  const initOrder = () => { const o = (layout.order || []).filter((id) => DEFAULT_ORDER.includes(id) || blockIds.includes(id)); return [...o, ...DEFAULT_ORDER.filter((id) => !o.includes(id)), ...blockIds.filter((id) => !o.includes(id))]; };
  const [order, setOrder] = useState<string[]>(initOrder);
  const [hidden, setHidden] = useState<string[]>(layout.hidden ?? ['trips']);
  const [mode, setMode] = useState<'grid' | 'row'>(layout.mode || 'grid');
  const [svc, setSvc] = useState<Record<string, HomeShape>>(() => Object.fromEntries(Object.entries(layout.svc || {}).map(([k, v]) => [k, v.shape])));
  const [busy, setBusy] = useState(false);
  // a banner added later (in the card below) joins the list
  useEffect(() => { setOrder((o) => [...o.filter((id) => DEFAULT_ORDER.includes(id) || blockIds.includes(id)), ...blockIds.filter((id) => !o.includes(id))]); }, [blockIds.join(',')]);
  const move = (i: number, d: number) => setOrder((o) => { const j = i + d; if (j < 0 || j >= o.length) return o; const n = [...o]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const toggle = (id: string) => setHidden((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));
  const label = (id: string) => (id.startsWith('ban:') ? `${blocks.find((b) => `ban:${b.id}` === id)?.type === 'banner' ? 'لوحة إعلانية' : 'قايمة محلات'}: ${blocks.find((b) => `ban:${b.id}` === id)?.title || ''}` : SECTION_LABEL[id] || id);
  const cats = typeKeys().filter((k) => { const d = serviceDefs().find((x) => x.key === k); return (!d || (d.active && d.showHome)) && !isMakerTpl(k); });
  const save = async () => {
    setBusy(true);
    const r = await saveHomeLayout({ order, hidden, mode, svc: Object.fromEntries(Object.entries(svc).filter(([k]) => cats.includes(k as any)).map(([k, shape]) => [k, { shape }])) });
    setBusy(false);
    if (r.ok) toast('تم حفظ شكل الرئيسية ✅'); else toast(r.error, 'err');
  };
  const reset = async () => { setBusy(true); const r = await saveHomeLayout({}); setBusy(false); if (r.ok) { setOrder([...DEFAULT_ORDER]); setHidden(['trips']); setMode('grid'); setSvc({}); toast('رجعت الرئيسية للشكل الأصلي'); } else toast(r.error, 'err'); };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="شكل الشاشة الرئيسية" subtitle="رتّب وغيّر الأيقونات وحط إعلانات" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        <Card style={{ gap: 8 }}>
          <T w="black">ترتيب الأقسام</T>
          <T size={12} color={C.sub}>الأسهم بتحرّك القسم لفوق/تحت، والعين بتخفيه أو تظهره. الإعلانات واللوحات بتحطها في أي مكان (نص الصفحة أو آخرها).</T>
          {order.map((id, i) => {
            const off = hidden.includes(id);
            return (
              <View key={id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.2, borderColor: C.line, borderRadius: 14, padding: 8, opacity: off ? 0.5 : 1 }}>
                <T w="black" color={C.sub} size={12}>{i + 1}</T>
                <T w="bold" size={13} style={{ flex: 1 }}>{label(id)}</T>
                <Pressable onPress={() => move(i, -1)} hitSlop={8}><Icon name="chevron-up" size={22} color={C.goldDeep} /></Pressable>
                <Pressable onPress={() => move(i, 1)} hitSlop={8}><Icon name="chevron-down" size={22} color={C.goldDeep} /></Pressable>
                <Pressable onPress={() => toggle(id)} hitSlop={8}><Icon name={off ? 'eye-off' : 'eye'} size={22} color={off ? C.sub : C.green} /></Pressable>
              </View>
            );
          })}
        </Card>
        <Card style={{ gap: 8 }}>
          <T w="black">طريقة عرض الأيقونات</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="شبكة (صفوف)" active={mode === 'grid'} onPress={() => setMode('grid')} />
            <Chip label="صف واحد بالسحب لجنب" active={mode === 'row'} onPress={() => setMode('row')} />
          </View>
          <T w="black" size={13} style={{ marginTop: 6 }}>شكل أيقونة كل خدمة</T>
          {cats.map((k) => (
            <View key={k} style={{ gap: 6 }}>
              <T w="bold" size={13}>{TYPES[k].emoji} {TYPES[k].label}</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{SHAPES.map((x) => <Chip key={x.k} label={x.label} active={(svc[k] || 'tile') === x.k} onPress={() => setSvc((s) => ({ ...s, [k]: x.k }))} />)}</ScrollView>
            </View>
          ))}
        </Card>
        <Btn title="حفظ شكل الرئيسية" icon="checkmark" onPress={save} loading={busy} />
        <Btn title="رجّع الشكل الأصلي" variant="soft" small onPress={reset} />
        <BlocksManager />
      </ScrollView>
    </View>
  );
}

/** Owner / supervisor: pick 1-3 accepted orders of ONE area and link them to one courier. */
export function DispatchScreen({ navigation }: any) {
  const { db } = useStore();
  const [sel, setSel] = useState<string[]>([]);
  const [couriers, setCouriers] = useState<StaffCourier[] | null>(null);
  const [cid, setCid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadC = useCallback(async () => { setCouriers(await listStaffCouriers()); }, []);
  useEffect(() => { loadC(); }, [loadC]);
  const orders = db.orders.filter((o) => ['accepted', 'ready'].includes(o.status)).sort((a, b) => b.createdAt - a.createdAt);
  const picked = orders.filter((o) => sel.includes(o.id));
  const area = picked[0]?.regionId || null;
  const toggle = (o: typeof orders[number]) => {
    if (sel.includes(o.id)) return setSel((x) => x.filter((i) => i !== o.id));
    if (sel.length >= 3) return toast('أقصى عدد 3 أوردرات للطيار الواحد', 'err');
    if (area && (o.regionId || '') !== area) return toast('الأوردرات لازم تكون من نفس المنطقة', 'err');
    setSel((x) => [...x, o.id]);
  };
  const list = (couriers || []).filter((c) => !area || !c.regionId || c.regionId === area).sort((a, b) => Number(b.available) - Number(a.available) || a.busy - b.busy);
  const chosen = (couriers || []).find((c) => c.id === cid);
  const go = async () => {
    if (!sel.length || !cid) return;
    setBusy(true);
    const r = await dispatchOrders(sel, cid);
    setBusy(false);
    if (!r.ok) return toast(r.error || 'تعذر الربط', 'err');
    toast(`تم ربط ${sel.length} أوردر بالطيار ${chosen?.name || ''} ✅`); setSel([]); setCid(null); loadC();
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="ربط أوردرات بطيار" subtitle="اختار 1 إلى 3 أوردرات من نفس المنطقة" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}>
        <T w="black">1) الأوردرات المقبولة ({orders.length})</T>
        {orders.length === 0 && <Empty title="مفيش أوردرات مقبولة دلوقتي" />}
        {orders.map((o) => {
          const on = sel.includes(o.id);
          return (
            <Pressable key={o.id} onPress={() => toggle(o)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: on ? C.greenSoft : '#fff', borderWidth: on ? 2 : 1, borderColor: on ? C.green : C.line, borderRadius: 16, padding: 12 }}>
              <Icon name={on ? 'checkbox' : 'square-outline'} size={24} color={C.green} />
              <View style={{ flex: 1, gap: 1 }}>
                <T w="black" size={14}>#{o.number} • {o.providerName}</T>
                <T size={12} color={C.sub} numberOfLines={1}>{o.customerName} • {o.address}</T>
                <T size={11.5} color={C.goldDeep}>{o.regionName || 'بدون منطقة'}{o.courierName ? ` • طيار حالي: ${o.courierName}` : ''}</T>
              </View>
            </Pressable>
          );
        })}
        <T w="black" style={{ marginTop: 8 }}>2) الطيار</T>
        {couriers === null ? <T color={C.sub}>جاري التحميل...</T> : list.length === 0 ? <T color={C.sub}>مفيش طيارين متاحين في المنطقة دي.</T> : list.map((c) => {
          const on = cid === c.id, full = c.busy + sel.length > 3;
          return (
            <Pressable key={c.id} onPress={() => setCid(c.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: on ? C.greenSoft : '#fff', borderWidth: on ? 2 : 1, borderColor: on ? C.green : C.line, borderRadius: 16, padding: 12, opacity: full ? 0.5 : 1 }}>
              <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={C.green} />
              <View style={{ flex: 1 }}>
                <T w="black" size={14}>{c.name}</T>
                <T size={12} color={C.sub}>{c.vehicle || 'مندوب'} • {c.available ? 'متاح' : 'مش متاح'} • معاه {c.busy} أوردر</T>
              </View>
            </Pressable>
          );
        })}
        <Btn title={sel.length && chosen ? `اربط ${sel.length} أوردر بـ ${chosen.name}` : 'اختار الأوردرات والطيار'} icon="link" disabled={!sel.length || !cid || busy} loading={busy} onPress={go} />
      </ScrollView>
    </View>
  );
}
