import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Btn, Sheet, Empty, toast, confirmDialog } from './ui';
import { useStore, useMe, assignCourier, transferOrder, listStaffCouriers, StaffCourier } from '../lib/store';
import { TYPES, needsStaff, acceptsRequests } from '../lib/format';
import { Order } from '../lib/types';

/** Owner / supervisor tools on an order: link it to a chosen courier, or send an unpriced written request to another shop. */
export function OrderStaffTools({ o }: { o: Order }) {
  const { db } = useStore();
  const me = useMe();
  // the owner may always act; a supervisor only when the shop left the order stuck (or he already took it over)
  const open = me?.role === 'admin' || needsStaff(o);
  const [sheet, setSheet] = useState<'' | 'courier' | 'transfer'>('');
  const [couriers, setCouriers] = useState<StaffCourier[] | null>(null);
  const [busy, setBusy] = useState('');
  const canAssign = open && ['accepted', 'ready'].includes(o.status);
  // a written request can move to another shop while it is still waiting or after the shop refused it; never after it was accepted
  const byShop = o.status === 'cancelled' && o.cancelledBy === 'provider';
  const movable = o.providerType !== 'custom' && (!!o.request || o.items.length > 0);
  const canTransfer = open && movable && (['pending', 'rejected'].includes(o.status) || byShop);
  // a problem with the courier who carries the order (vehicle, accident, phone...): the owner or the area's supervisor hands it to another courier, even after pickup
  const canBreakdown = !!o.courierId && ['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status);
  const [breakdown, setBreakdown] = useState(false);
  const showBreakdown = canBreakdown && ['picked_up', 'on_the_way', 'arrived'].includes(o.status);
  if (!canAssign && !canTransfer && !showBreakdown) return null;

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
      <Sheet visible={sheet === 'courier'} onClose={() => setSheet('')} title={breakdown ? 'اختر المندوب البديل' : 'اختر المندوب'}>
        <ScrollView style={{ maxHeight: 380 }}>
          {couriers === null ? <T size={13} color={C.sub}>جاري التحميل...</T> : couriers.length === 0 ? <Empty icon="bicycle" title="لا يوجد مناديب مفعّلون" /> : couriers.map((c) => (
            <Row key={c.id} title={c.name} on={c.available} loading={busy === c.id}
              sub={`${c.available ? 'متاح الآن' : 'غير متاح'} • ${c.busy} طلب جاري${c.vehicle ? ` • ${c.vehicle}` : ''}${c.id === o.courierId ? ' • المندوب الحالي' : ''}`}
              onPress={() => pickCourier(c)} />
          ))}
        </ScrollView>
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
