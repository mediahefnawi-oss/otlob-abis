import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Btn, Sheet, Empty, toast, confirmDialog } from './ui';
import { useStore, useMe, assignCourier, transferOrder, staffOrderAction, listStaffCouriers, StaffCourier } from '../lib/store';
import { TYPES, needsStaff, acceptsRequests } from '../lib/format';
import { Order } from '../lib/types';

/** Owner / supervisor tools on an order: link it to a chosen courier, or send an unpriced written request to another shop. */
export function OrderStaffTools({ o }: { o: Order }) {
  const { db } = useStore();
  const me = useMe();
  // the owner may always act; a supervisor only when the shop left the order stuck (or he already took it over)
  const open = me?.role === 'admin' || needsStaff(o);
  const [sheet, setSheet] = useState<'' | 'courier' | 'transfer' | 'cancel'>('');
  const [why, setWhy] = useState('المحل رافض الطلب');
  const [couriers, setCouriers] = useState<StaffCourier[] | null>(null);
  const [busy, setBusy] = useState('');
  const [gift, setGift] = useState(false);
  const [gv, setGv] = useState<'10' | '20' | '50' | '10%'>('20');
  const [gd, setGd] = useState(7);
  const canAssign = open && ['accepted', 'ready'].includes(o.status);
  // a written request can move to another shop while it is still waiting or after the shop refused it; never after it was accepted
  const byShop = o.status === 'cancelled' && o.cancelledBy === 'provider';
  const movable = o.providerType !== 'custom' && (!!o.request || o.items.length > 0);
  const canTransfer = open && movable && (['pending', 'rejected'].includes(o.status) || byShop);
  // a problem with the courier who carries the order (vehicle, accident, phone...): the owner or the area's supervisor hands it to another courier, even after pickup
  const canBreakdown = !!o.courierId && ['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status);
  const [breakdown, setBreakdown] = useState(false);
  const showBreakdown = canBreakdown && ['picked_up', 'on_the_way', 'arrived'].includes(o.status);
  // a refused order can also be ended for good, or just marked handled so it leaves the needs-attention list
  const canEnd = open && o.status === 'rejected';
  if (!canAssign && !canTransfer && !showBreakdown && !canEnd) return null;

  const openCouriers = async (asBreakdown = false) => {
    setBreakdown(asBreakdown);
    setSheet('courier');
    setCouriers(null);
    setCouriers(await listStaffCouriers());
  };
  const doAssign = async (c: StaffCourier) => {
    setBusy(c.id);
    const r = await assignCourier(o.id, c.id, breakdown);
    setBusy('');
    if (!r.ok) return toast(r.error, 'err');
    setSheet('');
    toast(breakdown ? `تم تحويل الطلب إلى ${c.name}` : `تم تعيين ${c.name} لهذا الطلب`);
  };
  const pickCourier = (c: StaffCourier) => {
    if (!breakdown) return doAssign(c);
    confirmDialog({
      title: 'تحويل الطلب لمندوب آخر؟',
      message: `${c.name} هيستلم الطلب من المندوب الحالي ويكمل التوصيل. المندوب الحالي والعميل والمتجر هيتم إخطارهم.`,
      confirmText: 'تحويل', danger: true, onConfirm: () => { doAssign(c); },
    });
  };
  const shops = db.providers
    .filter((p) => p.status === 'active' && p.id !== o.providerId && (o.request ? acceptsRequests(p.type) : p.type === o.providerType))
    .sort((a, b) => (a.type === o.providerType ? -1 : 0) - (b.type === o.providerType ? -1 : 0));
  const pickShop = async (id: string, name: string) => {
    setBusy(id);
    const r = await transferOrder(o.id, id);
    setBusy('');
    if (!r.ok) return toast(r.error, 'err');
    setSheet('');
    toast(`تم تحويل الطلب إلى ${name}`);
  };
  const doCancel = async () => {
    setBusy('cancel');
    const r = await staffOrderAction(o.id, 'cancel', why, me?.role === 'admin' && gift ? { kind: gv.endsWith('%') ? 'percent' : 'amount', value: parseInt(gv, 10), days: gd } : undefined);
    setBusy('');
    if (!r.ok) return toast(r.error, 'err');
    setSheet('');
    toast('تم إلغاء الطلب وإشعار العميل');
  };
  const doDismiss = async () => {
    setBusy('dismiss');
    const r = await staffOrderAction(o.id, 'dismiss');
    setBusy('');
    toast(r.ok ? 'تم التعامل مع الطلب' : r.error, r.ok ? 'ok' : 'err');
  };
  const Row = ({ title, sub, on, onPress, loading }: { title: string; sub?: string; on?: boolean; onPress: () => void; loading?: boolean }) => (
    <Pressable onPress={onPress} disabled={loading} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderColor: C.line, opacity: loading ? 0.5 : 1 }}>
      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: on ? '#22C55E' : '#A8B3AE' }} />
      <View style={{ flex: 1 }}>
        <T w="bold" size={14}>{title}</T>
        {!!sub && <T size={11.5} color={C.sub}>{sub}</T>}
      </View>
      <Icon name="chevron-back" size={16} color={C.sub} />
    </Pressable>
  );
  return (
    <View style={{ gap: 10 }}>
      {canAssign && <Btn variant="dark" icon="bicycle" title={o.courierId ? 'تغيير المندوب' : 'تعيين مندوب لهذا الطلب'} onPress={() => openCouriers(false)} />}
      {showBreakdown && <Btn variant="danger" icon="warning" title="عطل عند المندوب: حوّل الطلب لمندوب آخر" onPress={() => openCouriers(true)} />}
      {canTransfer && <Btn variant="outline" icon="swap-horizontal" title={o.status === 'rejected' ? 'رفضه المتجر: تحويل الطلب لمتجر آخر' : byShop ? 'ألغاه المتجر: تحويل الطلب لمتجر آخر' : 'تحويل الطلب لمتجر آخر'} onPress={() => setSheet('transfer')} />}
      {canEnd && <Btn variant="danger" icon="close-circle" title="إلغاء الطلب نهائياً" onPress={() => setSheet('cancel')} />}
      {canEnd && !o.staffDismissed && <Btn variant="soft" icon="checkmark" title="تم التعامل (إخفاء من يحتاج انتباهك)" loading={busy === 'dismiss'} onPress={doDismiss} />}
      <Sheet visible={sheet === 'courier'} onClose={() => setSheet('')} title={breakdown ? 'اختر المندوب البديل' : 'اختر المندوب'}>
        <ScrollView style={{ maxHeight: 380 }}>
          {couriers === null ? <T size={13} color={C.sub}>جاري التحميل...</T> : couriers.length === 0 ? <Empty icon="bicycle" title="لا يوجد مناديب مفعّلون" /> : couriers.map((c) => (
            <Row key={c.id} title={c.name} on={c.available} loading={busy === c.id}
              sub={`${c.available ? 'متاح الآن' : 'غير متاح'} • ${c.busy} طلب جاري${c.vehicle ? ` • ${c.vehicle}` : ''}${c.id === o.courierId ? ' • المندوب الحالي' : ''}`}
              onPress={() => pickCourier(c)} />
          ))}
        </ScrollView>
      </Sheet>
      <Sheet visible={sheet === 'cancel'} onClose={() => setSheet('')} title={`إلغاء الطلب #${o.number}`}>
        <View style={{ gap: 10 }}>
          <T size={12.5} color={C.sub}>سبب الإلغاء (يصل للعميل في الإشعار)</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
            {['المحل رافض الطلب', 'المنتج غير متاح', 'العميل غير متاح', 'خارج منطقة التوصيل'].map((r) => (
              <Pressable key={r} onPress={() => setWhy(r)} style={{ paddingVertical: 8, paddingHorizontal: 13, borderRadius: 14, backgroundColor: why === r ? C.dark : '#F3F4EE' }}>
                <T w="bold" size={12.5} color={why === r ? C.gold : C.dark3}>{r}</T>
              </Pressable>
            ))}
          </View>
          {me?.role === 'admin' && (
            <View style={{ gap: 8, backgroundColor: C.goldSoft, borderRadius: 14, padding: 12 }}>
              <Pressable onPress={() => setGift((g) => !g)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T size={18}>{gift ? '☑️' : '⬜'}</T>
                <T w="bold" size={13.5} style={{ flex: 1 }}>🎁 إهداء العميل كود خصم لمرة واحدة</T>
              </Pressable>
              {gift && (
                <>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                    {(['10', '20', '50', '10%'] as const).map((v) => (
                      <Pressable key={v} onPress={() => setGv(v)} style={{ paddingVertical: 7, paddingHorizontal: 13, borderRadius: 14, backgroundColor: gv === v ? C.dark : '#fff' }}>
                        <T w="bold" size={12.5} color={gv === v ? C.gold : C.dark3}>{v.endsWith('%') ? v : `${v} ج`}</T>
                      </Pressable>
                    ))}
                  </View>
                  <T size={11.5} color={C.sub}>صلاحية الكود</T>
                  <View style={{ flexDirection: 'row', gap: 7 }}>
                    {[3, 7, 30].map((d) => (
                      <Pressable key={d} onPress={() => setGd(d)} style={{ paddingVertical: 7, paddingHorizontal: 13, borderRadius: 14, backgroundColor: gd === d ? C.dark : '#fff' }}>
                        <T w="bold" size={12.5} color={gd === d ? C.gold : C.dark3}>{d} يوم</T>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}
            </View>
          )}
          <Btn variant="danger" icon="close-circle" title="تأكيد الإلغاء وإشعار العميل" loading={busy === 'cancel'} onPress={doCancel} />
        </View>
      </Sheet>
      <Sheet visible={sheet === 'transfer'} onClose={() => setSheet('')} title="حوّل الطلب إلى">
        <ScrollView style={{ maxHeight: 380 }}>
          {shops.length === 0 ? <Empty icon="storefront" title="لا توجد متاجر مناسبة" /> : shops.map((p) => (
            <Row key={p.id} title={p.name} on={p.open} loading={busy === p.id} sub={`${TYPES[p.type].single}${p.open ? '' : ' • مغلق الآن'}`} onPress={() => pickShop(p.id, p.name)} />
          ))}
        </ScrollView>
      </Sheet>
    </View>
  );
}
