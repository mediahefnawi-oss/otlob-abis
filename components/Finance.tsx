import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Image, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Chip, Sheet, Field, Toggle, Segmented, SectionTitle, Stat, Pill, Header, Empty, toast, confirmDialog } from './ui';
import { useStore, publishUpdateNotice, setWelcomeLogo, setLoginImage, setAppIcon, setCatIcon, updateSettings, createService, updateService, reorderServices, deleteService } from '../lib/store';
import { TYPES, DEFAULT_CREDITS, money, fmtDateTime, isoDay, DAYS, typeKeys, serviceDefs, errandDef, TEMPLATE_LABEL } from '../lib/format';
import { ProviderType, ServiceDef, ServiceTemplate } from '../lib/types';
import { apiJson, refreshCounters, useCounters, useMyCommission, ruleSummary, Counters } from '../lib/finance';
import { loginImageUrl, welcomeLogoUrl, appIconUrl, catIconUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';
import { useRC } from '../screens/customer';

const toEn = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫,]/g, '.');

const COUNTER_LABEL: Record<string, string> = { sales: 'المبيعات', orders: 'الطلبات', profit: 'الأرباح' };
const run = async (p: Promise<any>, okMsg: string) => {
  try { await p; toast(okMsg); return true; } catch (e: any) { toast(e?.message || 'تعذر تنفيذ العملية', 'err'); return false; }
};
const Wrap = ({ children }: { children: React.ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
const Label = ({ children }: { children: string }) => <T w="semi" size={13} color={C.dark3}>{children}</T>;

/* ---------- who does it apply to (all / a section / one provider) ---------- */
type Scope = { scope: 'all' | 'type' | 'provider'; providerType: ProviderType; providerId: string };
const newScope = (): Scope => ({ scope: 'all', providerType: 'restaurant', providerId: '' });
function ScopePicker({ value, onChange, allLabel = 'الجميع' }: { value: Scope; onChange: (s: Scope) => void; allLabel?: string }) {
  const { db } = useStore();
  const provs = db.providers.filter((p) => p.status === 'active' || p.status === 'suspended');
  return (
    <View style={{ gap: 8 }}>
      <Wrap>
        <Chip label={allLabel} active={value.scope === 'all'} onPress={() => onChange({ ...value, scope: 'all' })} />
        <Chip label="قسم" active={value.scope === 'type'} onPress={() => onChange({ ...value, scope: 'type' })} />
        <Chip label="مقدم خدمة" active={value.scope === 'provider'} onPress={() => onChange({ ...value, scope: 'provider' })} />
      </Wrap>
      {value.scope === 'type' && <Wrap>{typeKeys().map((k) => <Chip key={k} label={TYPES[k].label} icon={TYPES[k].icon} active={value.providerType === k} onPress={() => onChange({ ...value, providerType: k })} />)}</Wrap>}
      {value.scope === 'provider' && (
        <Wrap>{provs.map((p) => <Chip key={p.id} label={p.name} active={value.providerId === p.id} onPress={() => onChange({ ...value, providerId: p.id })} />)}</Wrap>
      )}
    </View>
  );
}
const scopeBody = (s: Scope) => ({ scope: s.scope, providerType: s.scope === 'type' ? s.providerType : undefined, providerId: s.scope === 'provider' ? s.providerId : undefined });
const scopeText = (x: any, provName: (id: string) => string) =>
  x.scope === 'all' ? 'الجميع' : x.scope === 'type' ? `قسم: ${TYPES[x.providerType as ProviderType]?.label || x.providerType}` : `مقدم الخدمة: ${provName(x.providerId)}`;

/* ============================== rules ============================== */
function RuleSheet({ rule, visible, onClose, onSaved }: { rule?: any; visible: boolean; onClose: () => void; onSaved: () => void }) {
  const { db } = useStore();
  const [target, setTarget] = useState<'provider' | 'courier'>('provider');
  const [sc, setSc] = useState<Scope>(newScope());
  const [courierId, setCourierId] = useState('');
  const [errand, setErrand] = useState(false);
  const [kind, setKind] = useState<'percent' | 'fixed'>('fixed');
  const [value, setValue] = useState('');
  const [min, setMin] = useState('');
  const [from, setFrom] = useState('');
  const [fromDirty, setFromDirty] = useState(false);
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const couriers = db.users.filter((u) => u.role === 'courier');
  useEffect(() => {
    if (!visible) return;
    setTarget(rule?.target || 'provider');
    setSc(rule && rule.target === 'provider' ? { scope: rule.scope, providerType: rule.providerType || 'restaurant', providerId: rule.providerId || '' } : newScope());
    setCourierId(rule?.courierUserId || '');
    setErrand(!!rule && rule.target === 'courier' && rule.scope === 'type' && rule.providerType === 'custom');
    setKind(rule?.kind || 'fixed'); setValue(rule ? String(rule.value) : ''); setMin(rule && rule.minAmount ? String(rule.minAmount) : '');
    setFrom(rule ? isoDay(new Date(rule.effectiveFrom)) : ''); setFromDirty(false); setNote(rule?.note || ''); setActive(rule ? rule.active : true);
  }, [visible, rule?.id]);
  const dayIn = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
  const save = async () => {
    const v = Number(toEn(value));
    if (!Number.isFinite(v) || v < 0 || value.trim() === '') return toast('اكتب قيمة العمولة', 'err');
    const body: any = { kind, value: v, minAmount: Number(toEn(min)) || 0, active, note: note.trim() };
    if (!rule) {
      body.target = target;
      if (target === 'provider') Object.assign(body, scopeBody(sc));
      else if (errand) { body.scope = 'type'; body.providerType = 'custom'; }
      else { body.scope = courierId ? 'courier' : 'all'; if (courierId) body.courierUserId = courierId; }
    } else if (target === 'provider') Object.assign(body, scopeBody(sc));
    else if (errand) { body.scope = 'type'; body.providerType = 'custom'; }
      else { body.scope = courierId ? 'courier' : 'all'; if (courierId) body.courierUserId = courierId; }
    if (fromDirty && from) body.effectiveFrom = from;
    setBusy(true);
    const okk = await run(apiJson(rule ? `/api/admin/commissions/rules/${rule.id}` : '/api/admin/commissions/rules', rule ? 'PATCH' : 'POST', body), rule ? 'تم تعديل القاعدة' : 'تمت إضافة القاعدة');
    setBusy(false);
    if (okk) { onSaved(); onClose(); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={rule ? 'تعديل قاعدة عمولة' : 'قاعدة عمولة جديدة'}>
      {!rule && (
        <View style={{ gap: 6 }}>
          <Label>تُطبّق على</Label>
          <Wrap>
            <Chip label="مقدمو الخدمة" icon="storefront" active={target === 'provider'} onPress={() => setTarget('provider')} />
            <Chip label="المناديب (خصم من مستحقاتهم)" icon="bicycle" active={target === 'courier'} onPress={() => setTarget('courier')} />
          </Wrap>
        </View>
      )}
      <View style={{ gap: 6 }}>
        <Label>النطاق</Label>
        {target === 'provider' ? <ScopePicker value={sc} onChange={setSc} allLabel="كل مقدمي الخدمة" /> : (
          <Wrap>
            <Chip label="كل المناديب" active={!errand && !courierId} onPress={() => { setErrand(false); setCourierId(''); }} />
            <Chip label="خدمة اطلب إيه نجيبهولك" icon="bag-handle" active={errand} onPress={() => { setErrand(true); setCourierId(''); }} />
            {couriers.map((u) => <Chip key={u.id} label={u.name} active={!errand && courierId === u.id} onPress={() => { setErrand(false); setCourierId(u.id); }} />)}
          </Wrap>
        )}
      </View>
      <View style={{ gap: 6 }}>
        <Label>نوع العمولة</Label>
        <Wrap>
          <Chip label="مبلغ ثابت لكل طلب" icon="cash" active={kind === 'fixed'} onPress={() => setKind('fixed')} />
          <Chip label="نسبة مئوية" icon="analytics" active={kind === 'percent'} onPress={() => setKind('percent')} />
        </Wrap>
      </View>
      <Field label={kind === 'percent' ? 'النسبة (%) من قيمة المنتجات' : 'المبلغ (ج.م)'} icon="pricetag" value={value} onChangeText={setValue} keyboardType="numeric" placeholder={kind === 'percent' ? 'مثال: 10' : 'مثال: 15'} />
      <Field label="الحد الأدنى لقيمة الطلب ليكون مؤهلاً (اختياري)" icon="arrow-up" value={min} onChangeText={setMin} keyboardType="numeric" placeholder="0 = كل الطلبات" />
      <View style={{ gap: 6 }}>
        <Label>تاريخ السريان (الطلبات المكتملة بعده فقط)</Label>
        <Wrap>
          <Chip label="من الآن" active={!fromDirty && !rule} onPress={() => { setFrom(''); setFromDirty(false); }} />
          <Chip label="غداً" onPress={() => { setFrom(dayIn(1)); setFromDirty(true); }} />
          <Chip label="بعد أسبوع" onPress={() => { setFrom(dayIn(7)); setFromDirty(true); }} />
          <Chip label="بعد شهر" onPress={() => { setFrom(dayIn(30)); setFromDirty(true); }} />
        </Wrap>
        <Field value={from} onChangeText={(t) => { setFrom(t); setFromDirty(true); }} placeholder="YYYY-MM-DD" icon="calendar" />
        <T size={11.5} color={C.sub}>العمولات المحتسبة سابقاً لا تتغير أبداً بتعديل القاعدة.</T>
      </View>
      <Field label="ملاحظة (اختياري)" icon="create" value={note} onChangeText={setNote} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T w="bold" size={14} style={{ flex: 1 }}>القاعدة مفعّلة</T>
        <Toggle value={active} onValueChange={setActive} />
      </View>
      <Btn title="حفظ القاعدة" icon="checkmark" loading={busy} onPress={save} />
    </Sheet>
  );
}

function RulesTab() {
  const { db } = useStore();
  const [rules, setRules] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { apiJson<{ rules: any[] }>('/api/admin/commissions/rules').then((r) => setRules(r.rules)).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  const provName = (id: string) => db.providers.find((p) => p.id === id)?.name || `#${id}`;
  const courName = (id?: string) => db.users.find((u) => u.id === id)?.name || `#${id}`;
  const now = Date.now();
  const toggle = (r: any, v: boolean) => run(apiJson(`/api/admin/commissions/rules/${r.id}`, 'PATCH', { active: v }), v ? 'تم تفعيل القاعدة' : 'تم إيقاف القاعدة').then(load);
  const del = (r: any) => confirmDialog({ title: 'حذف القاعدة؟', message: 'لن تتأثر العمولات المحتسبة سابقاً. سيُسجَّل الحذف في السجل.', danger: true, confirmText: 'حذف', onConfirm: () => { run(apiJson(`/api/admin/commissions/rules/${r.id}`, 'DELETE'), 'تم حذف القاعدة').then(load); } });
  const group = (target: 'provider' | 'courier') => rules.filter((r) => r.target === target);
  const card = (r: any) => (
    <Card key={r.id} style={{ gap: 8, opacity: r.active ? 1 : 0.6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T w="black" size={14.5}>{r.target === 'courier' ? (r.scope === 'courier' ? `المندوب: ${courName(r.courierUserId)}` : r.scope === 'type' ? 'خدمة اطلب إيه نجيبهولك (على رسوم التوصيل)' : 'كل المناديب') : scopeText(r, provName)}</T>
          <T size={13} color={C.goldDeep} w="bold">{ruleSummary(r.kind, r.value, r.minAmount, r.target)}</T>
        </View>
        <Toggle value={r.active} onValueChange={(v) => toggle(r, v)} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Pill label={r.effectiveFrom > now ? `يسري من ${fmtDateTime(r.effectiveFrom)}` : r.effectiveFrom < Date.parse('2001-01-01') ? 'افتراضية' : `يسري منذ ${fmtDateTime(r.effectiveFrom)}`} color={r.effectiveFrom > now ? C.blue : C.sub} soft={r.effectiveFrom > now ? C.blueSoft : C.line} icon="calendar" />
        {!!r.note && r.note !== 'افتراضي' && <Pill label={r.note} color={C.sub} soft={C.line} />}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small variant="soft" icon="create" title="تعديل" style={{ flex: 1 }} onPress={() => { setEdit(r); setOpen(true); }} />
        <Btn small variant="soft" icon="trash" title="حذف" style={{ flex: 1 }} onPress={() => del(r)} />
      </View>
    </Card>
  );
  return (
    <View style={{ gap: 12 }}>
      <Card style={{ backgroundColor: C.goldSoft, gap: 4 }}>
        <T w="black" size={14} color={C.goldDeep}>كيف تُحتسب العمولة؟</T>
        <T size={12.5} color={C.dark3}>تُسجَّل مرة واحدة عند تسليم الطلب أو إتمام الحجز. الأخص يغلب الأعم: مقدم خدمة محدد ← قسم ← الجميع. اختر القاعدة الأحدث التي بدأ سريانها.</T>
      </Card>
      <SectionTitle title="مقدمو الخدمة" action="+ قاعدة جديدة" onAction={() => { setEdit(null); setOpen(true); }} />
      {group('provider').map(card)}
      <SectionTitle title="خصم المناديب" />
      {group('courier').map(card)}
      {!rules.length && <Empty icon="cash" title="لا توجد قواعد" text="أضف قاعدة عمولة" />}
      <RuleSheet rule={edit} visible={open} onClose={() => setOpen(false)} onSaved={load} />
    </View>
  );
}

/* ============================== reports / dues ============================== */
function ReportsTab() {
  const [period, setPeriod] = useState<'day' | 'month'>('day');
  const [range, setRange] = useState(30);
  const [rows, setRows] = useState<any[]>([]);
  const [ov, setOv] = useState<any>(null);
  const load = useCallback(() => {
    const from = new Date(); from.setDate(from.getDate() - range);
    apiJson<any>(`/api/admin/commissions/report?period=${period}&from=${isoDay(from)}`).then((r) => setRows(r.rows)).catch(() => {});
    apiJson<any>('/api/admin/commissions/overview').then(setOv).catch(() => {});
  }, [period, range]);
  useEffect(() => { load(); }, [load]);
  const byPeriod: Record<string, any[]> = {};
  rows.forEach((r) => { (byPeriod[r.period] = byPeriod[r.period] || []).push(r); });
  const tot = (k: string) => ov?.totals?.find((t: any) => t.kind === k) || { gross: 0, adjustments: 0, net: 0, due: 0, settled: 0 };
  const settle = (b: any) => confirmDialog({
    title: 'تسوية المستحقات؟', message: `سيتم تسجيل سداد ${money(b.due)} من ${b.name} وإقفال هذه المستحقات.`, confirmText: 'تأكيد السداد',
    onConfirm: () => { run(apiJson('/api/admin/commissions/settle', 'POST', b.kind === 'provider' ? { providerId: b.id } : { courierId: b.id }), 'تم تسجيل السداد').then(load); },
  });
  const fmtPeriod = (p: string) => (period === 'month' ? p.slice(0, 7) : `${DAYS[new Date(p + 'T12:00:00').getDay()]} ${p}`);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat icon="cash" label="صافي الشهر الحالي" value={money(ov?.month || 0)} color={C.goldDeep} soft={C.goldSoft} />
        <Stat icon="alert-circle" label="مستحقات غير مسددة" value={money(tot('provider').due + tot('courier').due)} color={C.red} soft={C.redSoft} />
      </View>
      <Card style={{ gap: 8 }}>
        <T w="black" size={14.5}>الإجمالي التراكمي (لا يتأثر بتصفير العدادات)</T>
        {(['provider', 'courier'] as const).map((k) => (
          <View key={k} style={{ gap: 2 }}>
            <T w="bold" size={13}>{k === 'provider' ? 'عمولات مقدمي الخدمة' : 'خصومات المناديب'}</T>
            <T size={12} color={C.sub}>المحتسب {money(tot(k).gross)} • التسويات {money(tot(k).adjustments)} • الصافي {money(tot(k).net)}</T>
            <T size={12} color={C.sub}>مسدد {money(tot(k).settled)} • غير مسدد {money(tot(k).due)}</T>
          </View>
        ))}
      </Card>
      <SectionTitle title="المستحقات حسب الحساب" />
      {(ov?.balances || []).filter((b: any) => b.due !== 0).length === 0 && <T size={12.5} color={C.sub}>لا توجد مستحقات غير مسددة.</T>}
      {(ov?.balances || []).filter((b: any) => b.due !== 0).map((b: any) => (
        <Card key={b.kind + b.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name={b.kind === 'provider' ? 'storefront' : 'bicycle'} size={22} color={C.goldDeep} />
          <View style={{ flex: 1 }}>
            <T w="bold" size={14}>{b.name}</T>
            <T size={11.5} color={C.sub}>{b.kind === 'provider' ? 'عمولة المنصة' : 'خصم من المندوب'} • {b.count} عملية • سُدد سابقاً {money(b.settled)}</T>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <T w="black" size={15} color={b.due > 0 ? C.red : C.green}>{money(b.due)}</T>
            {b.due > 0 && <Btn small title="تسوية" onPress={() => settle(b)} />}
          </View>
        </Card>
      ))}
      <SectionTitle title="التقرير" />
      <Segmented value={period} onChange={(k) => setPeriod(k as any)} options={[{ key: 'day', label: 'يومي' }, { key: 'month', label: 'شهري' }]} />
      <Wrap>{[[7, 'أسبوع'], [30, '30 يوم'], [90, '3 شهور'], [365, 'سنة']].map(([n, l]) => <Chip key={String(n)} label={String(l)} active={range === n} onPress={() => setRange(n as number)} />)}</Wrap>
      {Object.keys(byPeriod).length === 0 && <Empty icon="analytics" title="لا توجد عمولات في هذه الفترة" />}
      {Object.keys(byPeriod).map((p) => (
        <Card key={p} style={{ gap: 6 }}>
          <T w="black" size={14}>{fmtPeriod(p)}</T>
          {byPeriod[p].map((r) => (
            <View key={r.kind} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T size={12.5} style={{ flex: 1 }}>{r.kind === 'provider' ? 'مقدمو الخدمة' : 'المناديب'} • {r.count} عملية{r.adjustments ? ` • تسويات ${money(r.adjustments)}` : ''}</T>
              <T w="black" size={14} color={C.goldDeep}>{money(r.net)}</T>
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}

/* ============================== counters ============================== */
const CounterPick = ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
  <Wrap>{['sales', 'orders', 'profit'].map((k) => (
    <Chip key={k} label={COUNTER_LABEL[k]} icon={value.includes(k) ? 'checkmark-circle' : undefined} active={value.includes(k)} onPress={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])} />
  ))}</Wrap>
);
const FREQ: Record<string, string> = { once: 'مرة واحدة', daily: 'يومياً', weekly: 'أسبوعياً', monthly: 'شهرياً' };

function ScheduleSheet({ visible, onClose, onSaved }: { visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [sc, setSc] = useState<Scope>(newScope());
  const [counters, setCounters] = useState<string[]>(['sales']);
  const [freq, setFreq] = useState<'once' | 'daily' | 'weekly' | 'monthly'>('monthly');
  const [time, setTime] = useState('00:00');
  const [dow, setDow] = useState(5);
  const [dom, setDom] = useState('1');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setSc(newScope()); setCounters(['sales']); setFreq('monthly'); setTime('00:00'); setDom('1'); setDate(''); } }, [visible]);
  const save = async () => {
    const body: any = { ...scopeBody(sc), counters, frequency: freq, time: toEn(time).trim() };
    if (freq === 'weekly') body.dayOfWeek = dow;
    if (freq === 'monthly') body.dayOfMonth = Number(toEn(dom));
    if (freq === 'once') body.date = toEn(date).trim();
    setBusy(true);
    const okk = await run(apiJson('/api/admin/counters/schedules', 'POST', body), 'تمت جدولة التصفير');
    setBusy(false);
    if (okk) { onSaved(); onClose(); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="جدولة تصفير تلقائي">
      <View style={{ gap: 6 }}><Label>ما الذي يُصفَّر؟</Label><ScopePicker value={sc} onChange={setSc} /></View>
      <View style={{ gap: 6 }}><Label>العدادات</Label><CounterPick value={counters} onChange={setCounters} /></View>
      <View style={{ gap: 6 }}>
        <Label>التكرار</Label>
        <Wrap>{Object.keys(FREQ).map((k) => <Chip key={k} label={FREQ[k]} active={freq === k} onPress={() => setFreq(k as any)} />)}</Wrap>
      </View>
      {freq === 'weekly' && <Wrap>{DAYS.map((d, i) => <Chip key={d} label={d} active={dow === i} onPress={() => setDow(i)} />)}</Wrap>}
      {freq === 'monthly' && <Field label="يوم الشهر (1-31)" icon="calendar" value={dom} onChangeText={setDom} keyboardType="numeric" />}
      {freq === 'once' && <Field label="التاريخ" icon="calendar" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />}
      <Field label="الساعة (بتوقيت القاهرة)" icon="time" value={time} onChangeText={setTime} placeholder="00:00" />
      <T size={11.5} color={C.sub}>التصفير يخص العدادات المعروضة فقط، ولا يحذف أي طلب أو فاتورة أو عمولة.</T>
      <Btn title="حفظ الجدولة" icon="checkmark" loading={busy} onPress={save} />
    </Sheet>
  );
}

function CountersTab() {
  const { db } = useStore();
  const data = useCounters('admin', 8000);
  const [sc, setSc] = useState<Scope>(newScope());
  const [counters, setCounters] = useState<string[]>(['sales', 'orders', 'profit']);
  const [note, setNote] = useState('');
  const [hist, setHist] = useState<{ resets: any[]; schedules: any[] }>({ resets: [], schedules: [] });
  const [sheet, setSheet] = useState(false);
  const load = useCallback(() => { apiJson<any>('/api/admin/counters/resets').then(setHist).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  const provName = (id?: string) => db.providers.find((p) => p.id === id)?.name || `#${id}`;
  const tgt = (x: any) => (x.scope === 'all' ? 'الجميع' : x.scope === 'type' ? `قسم ${TYPES[x.providerType as ProviderType]?.label}` : provName(x.providerId));
  const doReset = () => {
    if (!counters.length) return toast('اختر عداداً واحداً على الأقل', 'err');
    if (sc.scope === 'provider' && !sc.providerId) return toast('اختر مقدم الخدمة', 'err');
    confirmDialog({
      title: 'تصفير العدادات؟', danger: true, confirmText: 'تصفير الآن',
      message: `سيتم تصفير (${counters.map((c) => COUNTER_LABEL[c]).join('، ')}) لـ ${sc.scope === 'all' ? 'الجميع' : sc.scope === 'type' ? TYPES[sc.providerType].label : provName(sc.providerId)}. لن يُحذف أي طلب أو فاتورة أو عمولة.`,
      onConfirm: () => { run(apiJson('/api/admin/counters/reset', 'POST', { ...scopeBody(sc), counters, note }), 'تم تصفير العدادات').then(() => { load(); refreshCounters(); }); },
    });
  };
  const t = data?.totals;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat icon="cash" label="المبيعات" value={money(t?.sales || 0)} color={C.goldDeep} soft={C.goldSoft} />
        <Stat icon="receipt" label="الطلبات" value={t?.orders || 0} color={C.blue} soft={C.blueSoft} />
        <Stat icon="trending-up" label="الأرباح" value={money(t?.profit || 0)} />
      </View>
      <Card style={{ gap: 8 }}>
        <T w="black" size={14.5}>حسب القسم</T>
        {typeKeys().map((k) => (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name={TYPES[k].icon} size={16} color={TYPES[k].color} />
            <T size={12.5} style={{ flex: 1 }}>{TYPES[k].label}</T>
            <T size={12} color={C.sub}>{money(data?.types[k]?.sales || 0)} • {data?.types[k]?.orders || 0} طلب • ربح {money(data?.types[k]?.profit || 0)}</T>
          </View>
        ))}
      </Card>
      <Card style={{ gap: 12 }}>
        <T w="black" size={15}>تصفير يدوي</T>
        <T size={12} color={C.sub}>يصفّر الأرقام المعروضة فقط. الطلبات والفواتير والعمولات والمستحقات تبقى كما هي.</T>
        <ScopePicker value={sc} onChange={setSc} />
        <CounterPick value={counters} onChange={setCounters} />
        <Field label="ملاحظة (اختياري)" icon="create" value={note} onChangeText={setNote} />
        <Btn title="تصفير الآن" variant="danger" icon="refresh" onPress={doReset} />
      </Card>
      <SectionTitle title="التصفير التلقائي" action="+ جدولة" onAction={() => setSheet(true)} />
      {hist.schedules.length === 0 && <T size={12.5} color={C.sub}>لا توجد جدولة.</T>}
      {hist.schedules.map((s) => (
        <Card key={s.id} style={{ gap: 6, opacity: s.enabled ? 1 : 0.6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <T w="bold" size={14}>{tgt(s)} • {s.counters.map((c: string) => COUNTER_LABEL[c]).join('، ')}</T>
              <T size={12} color={C.sub}>{FREQ[s.frequency]}{s.frequency === 'weekly' ? ` (${DAYS[s.dayOfWeek]})` : s.frequency === 'monthly' ? ` (يوم ${s.dayOfMonth})` : s.frequency === 'once' ? ` (${s.date})` : ''} الساعة {s.time}</T>
              <T size={11.5} color={C.sub}>{s.nextRunAt ? `التالي: ${fmtDateTime(s.nextRunAt)}` : 'انتهت'}{s.lastRunAt ? ` • آخر تنفيذ: ${fmtDateTime(s.lastRunAt)}` : ''}</T>
            </View>
            <Toggle value={s.enabled} onValueChange={(v) => { run(apiJson(`/api/admin/counters/schedules/${s.id}`, 'PATCH', { enabled: v }), v ? 'تم تشغيل الجدولة' : 'تم إيقاف الجدولة').then(load); }} />
          </View>
          <Btn small variant="soft" icon="trash" title="حذف الجدولة" onPress={() => confirmDialog({ title: 'حذف الجدولة؟', message: tgt(s), danger: true, confirmText: 'حذف', onConfirm: () => { run(apiJson(`/api/admin/counters/schedules/${s.id}`, 'DELETE'), 'تم الحذف').then(load); } })} />
        </Card>
      ))}
      <SectionTitle title="سجل التصفير" />
      {hist.resets.length === 0 && <T size={12.5} color={C.sub}>لم يتم التصفير بعد.</T>}
      {hist.resets.slice(0, 20).map((r) => (
        <Card key={r.id} style={{ gap: 2 }}>
          <T w="bold" size={13.5}>{tgt(r)} • {r.counters.map((c: string) => COUNTER_LABEL[c]).join('، ')}</T>
          <T size={11.5} color={C.sub}>{fmtDateTime(r.at)} • {r.source === 'schedule' ? 'تلقائي' : 'يدوي'}{r.note ? ` • ${r.note}` : ''}</T>
        </Card>
      ))}
      <ScheduleSheet visible={sheet} onClose={() => setSheet(false)} onSaved={load} />
    </View>
  );
}

/* ============================== audit ============================== */
const ACTION: Record<string, string> = {
  'rule.create': 'إضافة قاعدة عمولة', 'rule.update': 'تعديل قاعدة عمولة', 'rule.delete': 'حذف قاعدة عمولة', 'commission.reverse': 'تسوية إلغاء / مرتجع', 'commission.settle': 'تسوية مستحقات',
  'day.close': 'تقفيل يوم محل', 'day.close.undo': 'تراجع عن تقفيل', 'counters.reset.manual': 'تصفير يدوي', 'counters.reset.schedule': 'تصفير تلقائي', 'counters.schedule.create': 'إضافة جدولة', 'counters.schedule.update': 'تعديل جدولة', 'counters.schedule.delete': 'حذف جدولة',
  'order.assign': 'تعيين مندوب لطلب', 'order.transfer': 'تحويل طلب لمتجر آخر', 'welcome-logo.set': 'تغيير لوجو الشاشة الأولى', 'welcome-logo.remove': 'حذف لوجو الشاشة الأولى', 'login-image.set': 'تغيير صورة الدخول', 'login-image.remove': 'حذف صورة الدخول',
};
function AuditTab() {
  const [log, setLog] = useState<any[]>([]);
  useEffect(() => { apiJson<{ log: any[] }>('/api/admin/audit?limit=100').then((r) => setLog(r.log)).catch(() => {}); }, []);
  const brief = (x: any) => {
    const a = x.after || {}; const b = x.before || {};
    if (x.action.startsWith('rule.')) { const r = x.action === 'rule.delete' ? b : a; return `${r.kind === 'percent' ? r.value + '%' : r.value + ' ج.م'}${x.action === 'rule.update' && b.value !== undefined ? ` (كانت ${b.kind === 'percent' ? b.value + '%' : b.value + ' ج.م'}${b.active !== a.active ? `، ${a.active ? 'تفعيل' : 'إيقاف'}` : ''})` : ''}`; }
    if (x.action === 'commission.settle') return `${money(a.amount || 0)} • ${a.entries} عملية`;
    if (x.action.startsWith('counters.reset')) return `${(a.counters || []).map((c: string) => COUNTER_LABEL[c]).join('، ')}`;
    return '';
  };
  return (
    <View style={{ gap: 8 }}>
      {log.length === 0 && <Empty icon="document-text" title="لا يوجد سجل بعد" />}
      {log.map((x) => (
        <Card key={x.id} style={{ gap: 2 }}>
          <T w="bold" size={13.5}>{ACTION[x.action] || x.action}</T>
          {!!brief(x) && <T size={12.5} color={C.dark3}>{brief(x)}</T>}
          <T size={11.5} color={C.sub}>{x.actor} • {fmtDateTime(x.at)}{x.note ? ` • ${x.note}` : ''}</T>
        </Card>
      ))}
    </View>
  );
}

/* ============================== day closing: collect the commission, restart the shop's day ============================== */
type ClosingProv = { id: string; name: string; type: string; since: number | null; sales: number; orders: number; due: number };
type ClosingRow = { id: string; providerId: string; at: number; orders: number; sales: number; due: number; received: number; carried: number; note: string; undone: boolean };
function ClosingTab() {
  const [data, setData] = useState<{ providers: ClosingProv[]; closings: ClosingRow[] } | null>(null);
  const [sel, setSel] = useState<ClosingProv | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiJson<any>('/api/admin/closings').then(setData).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const open = (p: ClosingProv) => { setSel(p); setAmount(String(p.due)); };
  const num = Number(toEn(amount.trim()));
  const submit = async () => {
    if (!sel) return;
    if (sel.due > 0 && (!Number.isFinite(num) || num <= 0)) return toast('اكتب المبلغ المستلم', 'err');
    if (num > sel.due) return toast(`المبلغ أكبر من المستحق (${money(sel.due)})`, 'err');
    setBusy(true);
    const ok = await run(apiJson('/api/admin/closings', 'POST', { providerId: sel.id, received: sel.due > 0 ? num : 0 }), `تم تقفيل ${sel.name}`);
    setBusy(false);
    if (ok) { setSel(null); load(); refreshCounters(); }
  };
  const undo = (c: ClosingRow, name: string) => confirmDialog({
    title: 'التراجع عن التقفيل؟', danger: true, confirmText: 'تراجع',
    message: `سيرجع عداد ${name} وطلباته المقفولة كما كانت. المبلغ المستلم (${money(c.received)}) يفضل مسجلاً ولا يُلغى.`,
    onConfirm: () => { run(apiJson(`/api/admin/closings/${c.id}/undo`, 'POST'), 'تم التراجع عن التقفيل').then(() => { load(); refreshCounters(); }); },
  });
  const name = (id: string) => data?.providers.find((p) => p.id === id)?.name || `#${id}`;
  const latest = new Set<string>();
  (data?.closings || []).forEach((c) => { if (!c.undone && !latest.has(c.providerId)) latest.add(c.id); });
  const list = (data?.providers || []).filter((p) => p.orders > 0 || p.sales > 0 || p.due > 0);
  return (
    <View style={{ gap: 12 }}>
      <SectionTitle title="تقفيل اليوم" />
      <T size={12.5} color={C.sub}>التقفيل يعني أنك استلمت عمولة المنصة من المحل: يُسجَّل السداد، ويبدأ عداد المحل من الصفر، وتنتقل طلباته المنتهية للسجل. لا يُحذف أي طلب.</T>
      {!data && <T size={13} color={C.sub}>جارٍ التحميل…</T>}
      {data && list.length === 0 && <Empty icon="checkmark-done" title="لا يوجد ما يُقفل" text="كل المحلات مقفولة وعدّاداتها صفر" />}
      {list.map((p) => (
        <Card key={p.id} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T w="black" size={14.5}>{p.name}</T>
              <T size={12} color={C.sub}>{TYPES[p.type as ProviderType]?.label || p.type}{p.since ? ` • آخر تقفيل ${fmtDateTime(p.since)}` : ' • لم يُقفل من قبل'}</T>
            </View>
            <Btn title="قفّل" small variant="green" icon="lock-closed" onPress={() => open(p)} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Stat icon="cash" label="المبيعات" value={money(p.sales)} color={C.goldDeep} soft={C.goldSoft} />
            <Stat icon="receipt" label="طلبات منتهية" value={p.orders} color={C.blue} soft={C.blueSoft} />
            <Stat icon="wallet" label="العمولة المستحقة" value={money(p.due)} color={p.due > 0 ? C.red : C.green} soft={p.due > 0 ? C.redSoft : C.greenSoft} />
          </View>
        </Card>
      ))}
      {!!data?.closings.length && <SectionTitle title="سجل التقفيلات" />}
      {(data?.closings || []).map((c) => (
        <Card key={c.id} style={{ gap: 4, opacity: c.undone ? 0.55 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T w="bold" size={13.5}>{name(c.providerId)}{c.undone ? ' (تم التراجع)' : ''}</T>
              <T size={12} color={C.sub}>{fmtDateTime(c.at)} • {c.orders} طلب • مبيعات {money(c.sales)}</T>
              <T size={12} color={C.dark3}>المستحق {money(c.due)} • المستلم {money(c.received)}{c.carried > 0 ? ` • رُحّل ${money(c.carried)}` : ''}</T>
            </View>
            {latest.has(c.id) && <Btn title="تراجع" small variant="outline" onPress={() => undo(c, name(c.providerId))} />}
          </View>
        </Card>
      ))}
      <Sheet visible={!!sel} onClose={() => setSel(null)} title={sel ? `تقفيل ${sel.name}` : 'تقفيل'}>
        {sel && (
          <View style={{ gap: 12 }}>
            <T size={13.5} color={C.dark3}>{sel.orders} طلب منتهي • مبيعات {money(sel.sales)}</T>
            {sel.due > 0 ? (
              <>
                <T w="black" size={15}>استلمت عمولة المنصة من {sel.name}؟</T>
                <Field label={`المبلغ المستلم (المستحق ${money(sel.due)})`} icon="cash" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
                {Number.isFinite(num) && num > 0 && num < sel.due && <T size={12.5} color={C.red}>سيُرحَّل {money(Math.round((sel.due - num) * 100) / 100)} كمتأخرات تظهر في حساب المحل وتُسدَّد في تقفيل لاحق.</T>}
              </>
            ) : <T size={13.5} color={C.dark3}>لا توجد عمولة مستحقة. سيُقفل اليوم فقط.</T>}
            <T size={12} color={C.sub}>الطلبات الشغّالة (جديدة / قيد التنفيذ) تفضل ظاهرة، ويمكنك التراجع بعد التقفيل.</T>
            <Btn title="تأكيد: استلمت العمولة وقفّل" icon="lock-closed" variant="green" full loading={busy} onPress={submit} />
          </View>
        )}
      </Sheet>
    </View>
  );
}

/** A shop sees today's numbers, and opens its day-by-day history (Cairo days) and closings in a sheet. */
export function ProviderDaysCard({ providerId }: { providerId: string }) {
  const [d, setD] = useState<{ today: string; days: { day: string; orders: number; sales: number }[]; closings: ClosingRow[] } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const f = () => apiJson<any>(`/api/my/days?providerId=${providerId}&days=90`).then(setD).catch(() => {});
    f(); const t = setInterval(f, 20000); return () => clearInterval(t);
  }, [providerId]);
  if (!d) return null;
  const today = d.days.find((x) => x.day === d.today);
  const past = d.days.filter((x) => x.day !== d.today);
  const dayName = (iso: string) => { const dt = new Date(iso + 'T12:00:00'); return `${DAYS[dt.getDay()] || ''} ${iso.slice(8)}/${iso.slice(5, 7)}`; };
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>مبيعات الأيام</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Stat icon="cash" label="مبيعات اليوم" value={money(today?.sales || 0)} color={C.goldDeep} soft={C.goldSoft} />
        <Stat icon="receipt" label="طلبات اليوم" value={today?.orders || 0} color={C.blue} soft={C.blueSoft} />
      </View>
      <Btn title={`سجل الأيام${past.length ? ` (${past.length})` : ''}`} icon="calendar" variant="soft" full onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} title="سجل الأيام">
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 4 }}>
          {past.length === 0 && <T size={12.5} color={C.sub}>سجل الأيام السابقة سيظهر هنا.</T>}
          {past.map((x) => (
            <View key={x.day} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <T w="bold" size={13} style={{ flex: 1 }}>{dayName(x.day)}</T>
              <T size={12.5} color={C.blue} style={{ width: 72 }}>{x.orders} طلب</T>
              <T w="black" size={13}>{money(x.sales)}</T>
            </View>
          ))}
          {d.closings.filter((c) => !c.undone).length > 0 && <T w="black" size={14} style={{ marginTop: 10 }}>آخر التقفيلات</T>}
          {d.closings.filter((c) => !c.undone).slice(0, 10).map((c) => (
            <T key={c.id} size={12} color={C.dark3}>{fmtDateTime(c.at)}: استلمت المنصة {money(c.received)}{c.carried > 0 ? ` • متبقي ${money(c.carried)}` : ''}</T>
          ))}
        </ScrollView>
      </Sheet>
    </Card>
  );
}

/* ============================== the owner's screen ============================== */
export function AdminFinanceScreen() {
  const rc = useRC();
  const [seg, setSeg] = useState('rules');
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="العمولات والعدادات" subtitle="كل الإعدادات تُحفظ مركزياً وتسري فوراً">
        <View style={{ marginTop: 12 }}>
          <Segmented value={seg} onChange={setSeg} options={[{ key: 'rules', label: 'القواعد' }, { key: 'reports', label: 'التقارير' }, { key: 'counters', label: 'العدادات' }, { key: 'closing', label: 'التقفيل' }, { key: 'audit', label: 'السجل' }]} />
        </View>
      </Header>
      <ScrollView refreshControl={rc} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        {seg === 'rules' && <RulesTab />}
        {seg === 'reports' && <ReportsTab />}
        {seg === 'counters' && <CountersTab />}
        {seg === 'closing' && <ClosingTab />}
        {seg === 'audit' && <AuditTab />}
      </ScrollView>
    </View>
  );
}

/* ============================== order / booking: trail + return ============================== */
/** Owner only: the commission lines of one order / booking and a documented return / cancellation. */
export function CommissionTrail({ orderId, appointmentId }: { orderId?: string; appointmentId?: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('');
  const [courierToo, setCourierToo] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    apiJson<{ entries: any[] }>(`/api/admin/commissions/entries?${orderId ? `orderId=${orderId}` : `appointmentId=${appointmentId}`}`).then((r) => setRows(r.entries)).catch(() => {});
  }, [orderId, appointmentId]);
  useEffect(() => { load(); }, [load]);
  if (!rows.length) return null;
  const net = rows.reduce((s, r) => s + r.amount, 0);
  const submit = async () => {
    setBusy(true);
    const okk = await run(apiJson('/api/admin/commissions/reverse', 'POST', { orderId, appointmentId, note: reason, refundAmount: refund.trim() ? Number(toEn(refund)) : undefined, reverseCourier: courierToo }), 'تم تسجيل التسوية');
    setBusy(false);
    if (okk) { setOpen(false); setReason(''); setRefund(''); load(); }
  };
  return (
    <Card style={{ gap: 8 }}>
      <T w="black" size={15}>العمولة (للإدارة)</T>
      {rows.map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T size={12.5} style={{ flex: 1 }}>{r.type === 'adjustment' ? `تسوية: ${r.note}` : r.kind === 'provider' ? `عمولة الخدمة (${r.rule?.kind === 'percent' ? r.rule.value + '%' : 'ثابتة'})` : 'خصم المندوب'}</T>
          <T w="bold" size={13} color={r.amount < 0 ? C.red : C.dark}>{money(r.amount)}</T>
          <Pill label={r.status === 'settled' ? 'مسدد' : 'مستحق'} color={r.status === 'settled' ? C.green : C.goldDeep} soft={r.status === 'settled' ? C.greenSoft : C.goldSoft} />
        </View>
      ))}
      <T w="black" size={13.5}>الصافي: {money(net)}</T>
      <Btn small variant="soft" icon="return-down-back" title="تسوية إلغاء / مرتجع" onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} title="تسوية إلغاء / مرتجع">
        <T size={12.5} color={C.sub}>تُسجَّل تسوية بالسالب مقابل العمولة، ولا يُعدَّل أو يُحذف أي سجل سابق.</T>
        <Field label="السبب (مطلوب)" icon="create" value={reason} onChangeText={setReason} />
        <Field label="قيمة المرتجع من المنتجات (اتركه فارغاً لمرتجع كامل)" icon="cash" value={refund} onChangeText={setRefund} keyboardType="numeric" />
        {!!orderId && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={13} style={{ flex: 1 }}>عكس خصم المندوب أيضاً</T>
            <Toggle value={courierToo} onValueChange={setCourierToo} />
          </View>
        )}
        <Btn title="تسجيل التسوية" variant="danger" icon="checkmark" loading={busy} onPress={submit} />
      </Sheet>
    </Card>
  );
}

/* ============================== provider / courier cards ============================== */
/** Provider: counters (reset-aware) + what the platform takes. */
export function ProviderFinanceCard({ providerId }: { providerId: string }) {
  const counters = useCounters('provider');
  const mine = useMyCommission('provider');
  const c = counters?.providers[providerId];
  const rule = mine?.rules.find((r) => r.providerId === providerId) || mine?.rules[0];
  if (!c && !mine) return null;
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>حساباتي</T>
      {c && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Stat icon="cash" label="المبيعات" value={money(c.sales)} color={C.goldDeep} soft={C.goldSoft} />
          <Stat icon="receipt" label="الطلبات" value={c.orders} color={C.blue} soft={C.blueSoft} />
          <Stat icon="trending-up" label="الصافي" value={money(c.net)} />
        </View>
      )}
      {mine && (
        <View style={{ gap: 4 }}>
          {rule && <T size={12.5} color={C.dark3}>عمولة المنصة: {ruleSummary(rule.kind, rule.value, rule.minAmount)}</T>}
          <T size={12.5} color={C.dark3}>مستحق للمنصة: <T w="black" size={13} color={mine.due > 0 ? C.red : C.green}>{money(mine.due)}</T> • هذا الشهر {money(mine.month)}</T>
        </View>
      )}
    </Card>
  );
}
/** Courier: the platform deduction per delivered order and what is owed. */
export function CourierFinanceCard() {
  const mine = useMyCommission('courier');
  if (!mine) return null;
  const rule = mine.rules[0];
  return (
    <Card style={{ gap: 4 }}>
      <T w="black" size={15}>خصم المنصة</T>
      {rule && <T size={12.5} color={C.dark3}>{ruleSummary(rule.kind, rule.value, rule.minAmount, 'courier')}</T>}
      <T size={12.5} color={C.dark3}>إجمالي الخصم غير المسدد: <T w="black" size={13} color={mine.due > 0 ? C.red : C.green}>{money(mine.due)}</T> • هذا الشهر {money(mine.month)}</T>
    </Card>
  );
}

/* ============================== login picture (owner settings) ============================== */
export function LoginImageManager() {
  const { db } = useStore();
  const v = db.settings.loginImageV || 0;
  const [busy, setBusy] = useState(false);
  if (!canPickImage) return null;
  const choose = async () => {
    const img = await pickImage(1280);
    if (!img) return toast('تعذر قراءة الصورة، جرّب صورة أخرى', 'err');
    setBusy(true);
    const r = await setLoginImage(img);
    setBusy(false);
    toast(r.ok ? 'تم تغيير صورة واجهة الدخول' : r.error, r.ok ? 'ok' : 'err');
  };
  const remove = () => confirmDialog({ title: 'حذف الصورة؟', message: 'ستعود الصورة الأصلية للتطبيق.', danger: true, confirmText: 'حذف', onConfirm: async () => { const r = await setLoginImage(null); toast(r.ok ? 'تمت العودة للصورة الأصلية' : r.error, r.ok ? 'ok' : 'err'); } });
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>صورة واجهة تسجيل الدخول</T>
      <T size={12} color={C.sub}>تظهر في الشاشة الأولى للتطبيق عند كل المستخدمين فور حفظها.</T>
      {v > 0 ? <Image source={{ uri: loginImageUrl(v) }} style={{ width: '100%', height: 170, borderRadius: 14, backgroundColor: C.line }} resizeMode="cover" /> : <T size={12.5} color={C.sub}>الصورة الحالية: الصورة الأصلية للتطبيق.</T>}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn variant="soft" icon="camera" title={v > 0 ? 'تغيير الصورة' : 'رفع صورة'} style={{ flex: 1 }} loading={busy} onPress={choose} />
        {v > 0 && <Btn variant="danger" icon="trash" title="حذف" style={{ flex: 0.5 }} onPress={remove} />}
      </View>
    </Card>
  );
}


/** Owner: the logo on the first screen, the support number and the developer lines at the bottom of that screen. */
export function WelcomeScreenManager() {
  const { db } = useStore();
  const s = db.settings;
  const v = s.welcomeLogoV || 0;
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState(s.supportPhone || '');
  const cr = s.credits || DEFAULT_CREDITS;
  const [a, setA] = useState(cr.a);
  const [b, setB] = useState(cr.b);
  const [c, setC] = useState(cr.c);
  const [d, setD] = useState(cr.d);
  const choose = async () => {
    const img = await pickImage(900, true);
    if (!img) return toast('تعذر قراءة الصورة، جرّب صورة أخرى', 'err');
    setBusy(true);
    const r = await setWelcomeLogo(img);
    setBusy(false);
    toast(r.ok ? 'تم تغيير اللوجو ويظهر للجميع الآن' : r.error, r.ok ? 'ok' : 'err');
  };
  const remove = () => confirmDialog({ title: 'حذف اللوجو؟', message: 'سيعود اللوجو الأصلي للتطبيق.', danger: true, confirmText: 'حذف', onConfirm: async () => { const r = await setWelcomeLogo(null); toast(r.ok ? 'عاد اللوجو الأصلي' : r.error, r.ok ? 'ok' : 'err'); } });
  const savePhone = async () => {
    const p = phone.replace(/[^\d+]/g, '');
    if (p.length < 8) return toast('اكتب رقم صحيح', 'err');
    const r = await updateSettings({ supportPhone: p });
    toast(r.ok ? 'تم حفظ رقم الدعم' : r.error, r.ok ? 'ok' : 'err');
  };
  const saveCredits = async () => { const r = await updateSettings({ credits: { a, b, c, d } }); toast(r.ok ? 'تم حفظ البيانات' : r.error, r.ok ? 'ok' : 'err'); };
  const resetCredits = async () => { const r = await updateSettings({ credits: null }); if (r.ok) { setA(DEFAULT_CREDITS.a); setB(DEFAULT_CREDITS.b); setC(DEFAULT_CREDITS.c); setD(DEFAULT_CREDITS.d); } toast(r.ok ? 'عادت البيانات الأصلية' : r.error, r.ok ? 'ok' : 'err'); };
  return (
    <Card style={{ gap: 12 }}>
      <T w="black" size={15}>الشاشة الأولى: اللوجو والدعم والبيانات</T>
      <T size={12} color={C.sub}>اللوجو يفضّل أن يكون PNG بخلفية شفافة. كل تغيير هنا يظهر عند كل المستخدمين فور حفظه.</T>
      <View style={{ backgroundColor: C.dark, borderRadius: 14, padding: 12, alignItems: 'center' }}>
        {v > 0 ? <Image source={{ uri: welcomeLogoUrl(v) }} style={{ width: 220, height: 110 }} resizeMode="contain" /> : <T size={12.5} color="#C9D8D2">اللوجو الحالي: اللوجو الأصلي للتطبيق.</T>}
      </View>
      {canPickImage && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn variant="soft" icon="camera" title={v > 0 ? 'تغيير اللوجو' : 'رفع لوجو جديد'} style={{ flex: 1 }} loading={busy} onPress={choose} />
          {v > 0 && <Btn variant="danger" icon="trash" title="حذف" style={{ flex: 0.5 }} onPress={remove} />}
        </View>
      )}
      <View style={{ height: 1, backgroundColor: C.line }} />
      <Field label="رقم الدعم (واتساب)" icon="logo-whatsapp" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="01xxxxxxxxx" />
      <Btn title="حفظ رقم الدعم" icon="checkmark" onPress={savePhone} />
      <View style={{ height: 1, backgroundColor: C.line }} />
      <T w="bold" size={13}>البيانات أسفل الصفحة</T>
      <Field label="السطر الأول (إنجليزي صغير)" value={a} onChangeText={setA} autoCapitalize="none" />
      <Field label="الاسم (يظهر بالذهبي)" value={b} onChangeText={setB} autoCapitalize="none" />
      <Field label="السطر العربي" value={c} onChangeText={setC} />
      <Field label="سطر الحقوق" value={d} onChangeText={setD} autoCapitalize="none" />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="حفظ البيانات" icon="checkmark" style={{ flex: 1 }} onPress={saveCredits} />
        <Btn title="الأصلية" variant="ghost" style={{ flex: 0.6 }} onPress={resetCredits} />
      </View>
    </Card>
  );
}

/** Owner: the icon of the Android app (used the next time the app is built) + its download link. */
export function AppIconManager() {
  const { db } = useStore();
  const v = db.settings.appIconV || 0;
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(db.settings.apkUrl || '');
  const choose = async () => {
    const img = await pickImage(1024);
    if (!img) return toast('تعذر قراءة الصورة، جرّب صورة أخرى', 'err');
    setBusy(true);
    const r = await setAppIcon(img);
    setBusy(false);
    toast(r.ok ? 'تم حفظ أيقونة التطبيق. ستظهر في النسخة القادمة من الأندرويد' : r.error, r.ok ? 'ok' : 'err');
  };
  const remove = () => confirmDialog({ title: 'حذف الأيقونة؟', message: 'ستعود الأيقونة الأصلية في النسخة القادمة.', danger: true, confirmText: 'حذف', onConfirm: async () => { const r = await setAppIcon(null); toast(r.ok ? 'تمت العودة للأيقونة الأصلية' : r.error, r.ok ? 'ok' : 'err'); } });
  const saveUrl = async () => { const r = await updateSettings({ apkUrl: url.trim() }); toast(r.ok ? 'تم حفظ رابط التحميل' : r.error, r.ok ? 'ok' : 'err'); };
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>تطبيق الأندرويد</T>
      <T size={12} color={C.sub}>الأيقونة بتتثبت وقت بناء التطبيق: بعد ما ترفعها شغّل بناء الأندرويد (build-apk) من جديد عشان تظهر على الموبايلات.</T>
      {v > 0 ? <Image source={{ uri: appIconUrl(v) }} style={{ width: 96, height: 96, borderRadius: 22, backgroundColor: C.line, alignSelf: 'flex-start' }} resizeMode="cover" /> : <T size={12.5} color={C.sub}>الأيقونة الحالية: الأيقونة الأصلية.</T>}
      {canPickImage && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn variant="soft" icon="camera" title={v > 0 ? 'تغيير الأيقونة (صورة مربعة)' : 'رفع أيقونة (صورة مربعة)'} style={{ flex: 1 }} loading={busy} onPress={choose} />
          {v > 0 && <Btn variant="danger" icon="trash" title="حذف" style={{ flex: 0.5 }} onPress={remove} />}
        </View>
      )}
      <Field label="رابط تحميل التطبيق (يظهر للعملاء)" icon="download" value={url} onChangeText={setUrl} placeholder="https://..." autoCapitalize="none" />
      <Btn title="حفظ الرابط" icon="checkmark" onPress={saveUrl} />
    </Card>
  );
}

/** Owner: announce a new app version; every user sees an update banner until the installed version reaches it. */
export function UpdateNoticeManager() {
  const { db } = useStore();
  const cur = db.settings.update;
  const [version, setVersion] = useState(cur?.version || '');
  const [message, setMessage] = useState(cur?.message || '');
  const [required, setRequired] = useState(!!cur?.required);
  const [busy, setBusy] = useState(false);
  const publish = () => {
    const v = toEn(version.trim());
    if (!/^\d+(\.\d+){0,3}$/.test(v)) return toast('اكتب رقم النسخة مثل 1.1.0', 'err');
    confirmDialog({
      title: 'نشر إشعار التحديث؟', confirmText: 'نشر',
      message: `كل من يستخدم نسخة أقدم من ${v} سيرى إشعار التحديث${required ? ' ولن يستطيع إخفاءه' : ''}.`,
      onConfirm: async () => { setBusy(true); const r = await publishUpdateNotice({ version: v, message: message.trim(), required }); setBusy(false); toast(r.ok ? 'تم نشر إشعار التحديث' : r.error, r.ok ? 'ok' : 'err'); },
    });
  };
  const clear = async () => { setBusy(true); const r = await publishUpdateNotice({ clear: true }); setBusy(false); if (r.ok) { setVersion(''); setMessage(''); setRequired(false); } toast(r.ok ? 'تم إلغاء الإشعار' : r.error, r.ok ? 'ok' : 'err'); };
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>إشعار تحديث التطبيق</T>
      <T size={12} color={C.sub}>بعد ما تبني نسخة جديدة وتنزّلها، اكتب رقمها هنا (نفس رقم الإصدار في app.json). كل مستخدم نسخته أقدم يظهر له إشعار التحديث.</T>
      <T size={12} color={C.dark3}>الإشعار الحالي: {cur?.version ? `${cur.version}${cur.required ? ' (إجباري)' : ''}` : 'لا يوجد'}</T>
      <Field label="رقم النسخة الجديدة" icon="pricetag" value={version} onChangeText={setVersion} placeholder="1.1.0" autoCapitalize="none" keyboardType="numbers-and-punctuation" />
      <Field label="الرسالة (اختياري)" icon="chatbox" value={message} onChangeText={setMessage} placeholder="تحسينات وإصلاحات" />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={13} style={{ flex: 1 }}>تحديث إجباري (لا يمكن إخفاؤه)</T>
        <Toggle value={required} onValueChange={setRequired} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="نشر الإشعار" icon="megaphone" style={{ flex: 2 }} loading={busy} onPress={publish} />
        {!!cur?.version && <Btn title="إلغاء" variant="outline" style={{ flex: 1 }} onPress={clear} />}
      </View>
    </Card>
  );
}

/** Owner: a logo / visual identity for each service icon on the customers' home screen. */
export function CatIconsManager() {
  const { db } = useStore();
  const [busy, setBusy] = useState('');
  const vs = db.settings.catIconV || {};
  const choose = async (t: ProviderType) => {
    const img = await pickImage(512);
    if (!img) return toast('تعذر قراءة الصورة، جرّب صورة أخرى', 'err');
    setBusy(t);
    const r = await setCatIcon(t, img);
    setBusy('');
    toast(r.ok ? 'تم حفظ الأيقونة وتظهر للعملاء الآن' : r.error, r.ok ? 'ok' : 'err');
  };
  const remove = (t: ProviderType) => confirmDialog({ title: 'حذف الصورة؟', message: 'ستعود الأيقونة الأصلية.', danger: true, confirmText: 'حذف', onConfirm: async () => { const r = await setCatIcon(t, null); toast(r.ok ? 'تمت العودة للأيقونة الأصلية' : r.error, r.ok ? 'ok' : 'err'); } });
  return (
    <Card style={{ gap: 12 }}>
      <T w="black" size={15}>أيقونات الأقسام (الهوية البصرية)</T>
      <T size={12} color={C.sub}>ارفع لوجو أو صورة مربعة لكل قسم، وتظهر بدل الأيقونة في الصفحة الرئيسية للعملاء.</T>
      {[...typeKeys(), errandDef().key as ProviderType].map((t) => {
        const v = vs[t] || 0;
        const isE = t === errandDef().key;
        return (
          <View key={t} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: C.dark, borderWidth: 2, borderColor: C.gold, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {v > 0 ? <Image source={{ uri: catIconUrl(t, v) }} style={{ width: 54, height: 54 }} resizeMode="cover" /> : isE ? <T size={24}>{errandDef().emoji}</T> : <Icon name={TYPES[t].icon} size={24} color={C.gold} />}
            </View>
            <T w="bold" size={13.5} style={{ flex: 1 }}>{isE ? errandDef().label : TYPES[t].label}</T>
            {canPickImage && <Btn small variant="soft" icon="image" title={v > 0 ? 'تغيير' : 'رفع صورة'} loading={busy === t} onPress={() => choose(t)} />}
            {v > 0 && <Btn small variant="danger" icon="trash" title="" onPress={() => remove(t)} />}
          </View>
        );
      })}
    </Card>
  );
}


/* ============================== services (names, order, sizes, on/off, new services) ============================== */
/** The stored sizes keep their old names so nothing in the database changes: small = 3 icons in a row (the biggest option, as before), medium = 4, large = 5. */
const SIZE_LABEL = { small: 'كبير', medium: 'متوسط', large: 'صغير' } as const;
const EMOJIS = ['🍔', '🛒', '💊', '🩺', '🏬', '🧵', '💧', '🔧', '🧹', '🥖', '🌸', '📦', '🚗', '✂️', '🐾', '🎁'];

function ServiceSheet({ visible, def, onClose }: { visible: boolean; def: ServiceDef | null; onClose: () => void }) {
  const isNew = !def;
  const [label, setLabel] = useState('');
  const [single, setSingle] = useState('');
  const [tagline, setTagline] = useState('');
  const [emoji, setEmoji] = useState('🛍️');
  const [template, setTemplate] = useState<ServiceTemplate>('cart');
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('small');
  const [canProducts, setCanProducts] = useState(true);
  const [showHome, setShowHome] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setLabel(def?.label || ''); setSingle(def?.single || ''); setTagline(def?.tagline || ''); setEmoji(def?.emoji || '🛍️');
    setTemplate((def && def.template !== 'errand' ? def.template : 'cart') as ServiceTemplate);
    setSize(def?.size || 'small'); setCanProducts(def ? def.canProducts : true); setShowHome(def ? def.showHome : true);
  }, [visible, def?.key]);
  const errand = def?.template === 'errand';
  const save = async () => {
    if (label.trim().length < 2) return toast('اكتب اسم الخدمة', 'err');
    setBusy(true);
    const r = isNew
      ? await createService({ label: label.trim(), single: single.trim() || label.trim(), emoji, template, size, canProducts, showHome })
      : await updateService(def!.key, { label: label.trim(), ...(errand ? {} : { single: single.trim() || label.trim() }), emoji, tagline: tagline.trim(), ...(errand || def!.template === 'request' ? {} : { canProducts }) });
    setBusy(false);
    if (r.ok) { toast(isNew ? 'تمت إضافة الخدمة' : 'تم الحفظ'); onClose(); } else toast(r.error || 'تعذر الحفظ', 'err');
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={isNew ? 'خدمة جديدة' : 'تعديل الخدمة'}>
      <Field label="اسم الخدمة (يظهر في الرئيسية)" icon="pricetag" value={label} onChangeText={setLabel} placeholder="مثال: توصيل مياه" />
      {!errand && <Field label="الاسم المفرد (مثال: مطعم، صيدلية)" icon="storefront" value={single} onChangeText={setSingle} placeholder="مثال: مورّد مياه" />}
      {!isNew && <Field label="الوصف (يظهر في صفحة الخدمة وكارت الرئيسية)" icon="create" value={tagline} onChangeText={setTagline} placeholder="منتجات يدوية من أهل أبيس.." multiline />}
      <View style={{ gap: 6 }}>
        <Label>الأيقونة</Label>
        <Wrap>{EMOJIS.map((e) => <Chip key={e} label={e} active={emoji === e} onPress={() => setEmoji(e)} />)}</Wrap>
      </View>
      {isNew && (
        <View style={{ gap: 6 }}>
          <Label>طريقة الشغل</Label>
          <Wrap>{(Object.keys(TEMPLATE_LABEL) as ServiceTemplate[]).map((k) => <Chip key={k} label={TEMPLATE_LABEL[k]} active={template === k} onPress={() => setTemplate(k)} />)}</Wrap>
          <T size={11.5} color={C.sub}>{template === 'cart' ? 'مقدم الخدمة يضيف منتجات والعميل يطلب من سلة.' : template === 'request' ? 'العميل يكتب طلبه والمقدم يحدد السعر، بدون منتجات.' : template === 'booking' ? 'العميل يحجز موعداً عند مقدم الخدمة.' : template === 'lab' ? 'العميل يكتب السبب أو يرفع الروشتة، والمعمل يحدد موعد الكشف والسعر، والعميل يؤكد، وبعد الكشف يرفع المعمل التقرير.' : 'منتجات، ويقدر العميل يطلب طلباً خاصاً والمقدم يحدد السعر وموعد التسليم.'}</T>
        </View>
      )}
      {isNew && (
        <View style={{ gap: 6 }}>
          <Label>حجم الأيقونة في الرئيسية</Label>
          <Wrap>{(['small', 'medium', 'large'] as const).map((k) => <Chip key={k} label={SIZE_LABEL[k]} active={size === k} onPress={() => setSize(k)} />)}</Wrap>
        </View>
      )}
      {(isNew ? template !== 'request' : (!errand && def!.template !== 'request')) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><T w="semi" size={13.5} style={{ flex: 1 }}>مقدم الخدمة يضيف ويعدّل المنتجات</T><Toggle value={canProducts} onValueChange={setCanProducts} /></View>
      )}
      {isNew && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><T w="semi" size={13.5} style={{ flex: 1 }}>تظهر في الصفحة الرئيسية</T><Toggle value={showHome} onValueChange={setShowHome} /></View>}
      <Btn title={isNew ? 'إضافة الخدمة' : 'حفظ'} icon="checkmark" onPress={save} loading={busy} />
    </Sheet>
  );
}

/** Owner: rename / stop / order / resize the services and add new ones. «اطلب إيه؟ نجيبهولك» is the last row. Each row opens with a tap. */
export function ServicesManager() {
  const { db } = useStore();
  const [busy, setBusy] = useState('');
  const [openKey, setOpenKey] = useState('');
  const [edit, setEdit] = useState<ServiceDef | null>(null);
  const [open, setOpen] = useState(false);
  const vs = db.settings.catIconV || {};
  const defs = (db.services && db.services.length ? db.services : serviceDefs());
  const list = defs.filter((d) => d.template !== 'errand').slice().sort((a, b) => a.order - b.order);
  const errand = defs.find((d) => d.template === 'errand') || errandDef();
  const count = (k: string) => db.providers.filter((p) => p.type === k).length;
  const act = async (key: string, p: Promise<{ ok: boolean; error?: string }>, okMsg?: string) => {
    setBusy(key); const r = await p; setBusy('');
    if (!r.ok) toast(r.error || 'تعذر التنفيذ', 'err'); else if (okMsg) toast(okMsg);
  };
  const move = (i: number, d: -1 | 1) => {
    const keys = list.map((x) => x.key); const j = i + d;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    act(keys[j], reorderServices(keys));
  };
  const choose = async (t: ProviderType) => {
    const img = await pickImage(512);
    if (!img) return toast('تعذر قراءة الصورة، جرّب صورة أخرى', 'err');
    act(t, setCatIcon(t, img), 'تم حفظ الصورة وتظهر للعملاء الآن');
  };
  const remove = (t: ProviderType) => confirmDialog({ title: 'حذف الصورة؟', message: 'ستعود الأيقونة الأصلية.', danger: true, confirmText: 'حذف', onConfirm: () => { act(t, setCatIcon(t, null)); } });
  const del = (d: ServiceDef) => confirmDialog({ title: `حذف خدمة «${d.label}»؟`, message: 'تُحذف الخدمة نهائياً. لو فيها مقدمو خدمة سيرفض النظام الحذف، وأوقفها بدلاً منه.', danger: true, confirmText: 'حذف', onConfirm: () => { act(d.key, deleteService(d.key), 'تم حذف الخدمة'); } });
  const Head = ({ d, i, isErrand }: { d: ServiceDef; i: number; isErrand?: boolean }) => {
    const v = vs[d.key] || 0;
    const isOpen = openKey === d.key;
    return (
      <Pressable onPress={() => setOpenKey(isOpen ? '' : d.key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}>
        <View style={{ width: 44, height: 44, borderRadius: isErrand ? 14 : 22, backgroundColor: isErrand ? C.goldSoft : C.dark, borderWidth: 2, borderColor: C.gold, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {v > 0 ? <Image source={{ uri: catIconUrl(d.key, v) }} style={{ width: 44, height: 44 }} resizeMode="cover" /> : <T size={20}>{d.emoji}</T>}
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <T w="black" size={14} numberOfLines={1}>{d.label}</T>
          <T size={11} color={C.sub} numberOfLines={1}>{isErrand ? 'خدمة خاصة' : `${TEMPLATE_LABEL[d.template as ServiceTemplate]} • ${count(d.key)} مقدم خدمة`}</T>
        </View>
        <Toggle value={d.active} onValueChange={(x) => act(d.key, updateService(d.key, { active: x }), x ? 'تم تشغيل الخدمة' : 'تم إيقاف الخدمة')} />
        <Icon name={isOpen ? 'chevron-down' : 'chevron-back'} size={18} color={C.sub} />
      </Pressable>
    );
  };
  return (
    <>
      <Card style={{ gap: 4 }}>
        <T size={12} color={C.sub} style={{ marginBottom: 6 }}>اضغط على أي خدمة لتغيير حجمها أو ترتيبها أو اسمها أو صورتها. زرار التشغيل يوقفها: تختفي عن العملاء ولا يُطلب منها.</T>
        {list.map((d, i) => {
          const v = vs[d.key] || 0;
          return (
            <View key={d.key} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: C.line, opacity: d.active ? 1 : 0.6 }}>
              <Head d={d} i={i} />
              {openKey === d.key && (
                <View style={{ gap: 10, paddingBottom: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <T size={12} color={C.sub}>حجم الأيقونة</T>
                    {(['small', 'medium', 'large'] as const).map((k) => <Chip key={k} label={SIZE_LABEL[k]} active={d.size === k} onPress={() => act(d.key, updateService(d.key, { size: k }))} />)}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T size={12} color={C.sub}>الترتيب</T>
                    <Btn small variant="soft" icon="arrow-up" title="" disabled={i === 0 || !!busy} onPress={() => move(i, -1)} />
                    <Btn small variant="soft" icon="arrow-down" title="" disabled={i === list.length - 1 || !!busy} onPress={() => move(i, 1)} />
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <T w="semi" size={13} style={{ flex: 1 }}>تظهر في الرئيسية</T><Toggle value={d.showHome} onValueChange={(x) => act(d.key, updateService(d.key, { showHome: x }))} />
                  </View>
                  <Wrap>
                    <Btn small variant="soft" icon="create" title="الاسم والتفاصيل" onPress={() => { setEdit(d); setOpen(true); }} />
                    {canPickImage && <Btn small variant="soft" icon="image" title={v > 0 ? 'تغيير الصورة' : 'رفع صورة'} loading={busy === d.key} onPress={() => choose(d.key)} />}
                    {v > 0 && <Btn small variant="danger" icon="trash" title="حذف الصورة" onPress={() => remove(d.key)} />}
                    {!d.builtin && <Btn small variant="danger" icon="close-circle" title="حذف الخدمة" onPress={() => del(d)} />}
                  </Wrap>
                </View>
              )}
            </View>
          );
        })}
        <View style={{ borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.goldSoft, borderRadius: 14, paddingHorizontal: 8, marginTop: 6, opacity: errand.active ? 1 : 0.6 }}>
          <Head d={errand} i={list.length} isErrand />
          {openKey === errand.key && (
            <View style={{ gap: 10, paddingBottom: 12 }}>
              <T size={11.5} color={C.sub}>المندوب يحدد سعر التوصيل والمشتريات.</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T w="semi" size={13} style={{ flex: 1 }}>تظهر في الرئيسية</T><Toggle value={errand.showHome} onValueChange={(x) => act('errand', updateService('errand', { showHome: x }))} />
              </View>
              <Btn small variant="soft" icon="create" title="الاسم والأيقونة" onPress={() => { setEdit(errand); setOpen(true); }} />
            </View>
          )}
        </View>
        <View style={{ marginTop: 8 }}><Btn title="خدمة جديدة" icon="add" onPress={() => { setEdit(null); setOpen(true); }} /></View>
      </Card>
      <ServiceSheet visible={open} def={edit} onClose={() => setOpen(false)} />
    </>
  );
}
