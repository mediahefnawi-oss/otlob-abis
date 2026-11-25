import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, ScrollView, Modal } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Sheet, Empty, toast } from './ui';
import { useMe, listStaffCouriers, StaffCourier, bellOrderAction } from '../lib/store';
import { apiBellStart, apiBellStop, apiBellList, apiMyBells, apiBellRespond, BellInfo, MyBell } from '../lib/api';
import { setAlarm } from '../lib/alerts';
import { navigationRef } from '../lib/nav';
import { Order } from '../lib/types';

const errText = (e: any) => String(e?.message || e || 'حصلت مشكلة');
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Owner only: ring a courier / the shop until he answers, and stop the ringing at any moment. */
export function OrderBellPanel({ o }: { o: Order }) {
  const me = useMe();
  const isOwner = me?.role === 'admin';
  const [bells, setBells] = useState<BellInfo[]>([]);
  const [now, setNow] = useState(Date.now());
  const [sheet, setSheet] = useState(false);
  const [couriers, setCouriers] = useState<StaffCourier[] | null>(null);
  const [busy, setBusy] = useState('');
  const canCourier = ['accepted', 'ready'].includes(o.status) && !['picked_up', 'on_the_way', 'arrived', 'delivered'].includes(o.status);
  const canShop = ['pending', 'quoted'].includes(o.status);

  const load = useCallback(() => { apiBellList(o.id).then((r) => setBells(r.bells || [])).catch(() => {}); }, [o.id]);
  useEffect(() => {
    if (!isOwner) return;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [isOwner, load]);
  const ringing = bells.filter((b) => b.status === 'ringing');
  useEffect(() => {
    if (!ringing.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ringing.length]);

  if (!isOwner) return null;
  const last = !ringing.length ? bells.find((b) => b.status !== 'ringing') : undefined;
  const lastText = last ? ({ accepted: '✅ آخر جرس: اتقبل', rejected: '❌ آخر جرس: اترفض', expired: '⏱️ آخر جرس: ما حدّش رد (30 دقيقة)', stopped: '🔕 آخر جرس: اتوقف', closed: '🔕 آخر جرس: الطلب اتغيّر' } as Record<string, string>)[last.status] : '';

  const start = async (role: 'courier' | 'shop', targetId: string | number, who: string) => {
    setBusy(String(targetId));
    try {
      await apiBellStart(o.id, role, targetId);
      setSheet(false);
      toast(`🔔 الجرس شغّال على ${who}`);
      load();
    } catch (e) { toast(errText(e), 'err'); }
    setBusy('');
  };
  const stop = async () => {
    setBusy('stop');
    try { await apiBellStop(o.id); toast('🔕 تم إيقاف الجرس'); } catch (e) { toast(errText(e), 'err'); }
    setBusy('');
    load();
  };
  const openCouriers = async () => {
    setSheet(true);
    setCouriers(null);
    setCouriers(await listStaffCouriers());
  };

  if (!ringing.length && !canCourier && !canShop && !lastText) return null;
  return (
    <View style={{ gap: 10 }}>
      {ringing.map((b) => (
        <View key={b.id} style={{ backgroundColor: '#FDECEC', borderRadius: 16, padding: 12, gap: 8, borderWidth: 1, borderColor: '#F3B8B8' }}>
          <T w="bold" size={14} color="#B42318">🔔 الجرس شغّال على {b.name || (b.role === 'shop' ? 'المحل' : 'المندوب')}</T>
          <T size={12} color={C.sub}>بيرنّ كل 15 ثانية لحد ما يفتح الطلب ويقبل أو يرفض • من {mmss(now - b.startedAt)} (بيقف تلقائي بعد 30 دقيقة)</T>
          <Btn variant="danger" icon="notifications-off" title="🔕 إيقاف الجرس" loading={busy === 'stop'} onPress={stop} />
        </View>
      ))}
      {!ringing.length && !!lastText && <T size={12} color={C.sub}>{lastText}</T>}
      {canCourier && !ringing.length && <Btn variant="outline" icon="notifications" title="🔔 جرس على مندوب" onPress={openCouriers} />}
      {canShop && !ringing.length && <Btn variant="outline" icon="notifications" title={`🔔 جرس على ${o.providerName || 'المحل'}`} loading={!!busy} onPress={() => start('shop', 0, o.providerName || 'المحل')} />}
      <Sheet visible={sheet} onClose={() => setSheet(false)} title="اختر المندوب للجرس 🔔">
        <ScrollView style={{ maxHeight: 380 }}>
          {couriers === null ? <T size={13} color={C.sub}>جاري التحميل...</T> : couriers.length === 0 ? <Empty icon="bicycle" title="لا يوجد مناديب مفعّلون" /> : couriers.map((c) => (
            <Pressable key={c.id} disabled={busy === c.id}
              onPress={() => (c.available ? start('courier', c.id, c.name) : toast('المندوب غير متاح، جرّب مندوب تاني', 'err'))}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderColor: C.line, opacity: c.available ? 1 : 0.45 }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.available ? '#22C55E' : '#A8B3AE' }} />
              <View style={{ flex: 1 }}>
                <T w="bold" size={14}>{c.name}</T>
                <T size={11.5} color={C.sub}>{c.available ? 'متاح الآن' : 'غير متاح'} • {c.busy} طلب جاري{c.vehicle ? ` • ${c.vehicle}` : ''}</T>
              </View>
              <T size={20}>🔔</T>
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
    </View>
  );
}

/** A courier / shop whose phone is being rung: a full screen that keeps ringing until he opens the order and answers. */
export function BellRinger() {
  const me = useMe();
  const on = !!me && me.status === 'active' && (me.role === 'courier' || me.role === 'provider');
  const [bells, setBells] = useState<MyBell[]>([]);
  const [busy, setBusy] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(() => {
    apiMyBells().then((r) => { if (alive.current) setBells(r.bells || []); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!on) { setBells([]); return; }
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [on, load]);

  const cur = on ? bells[0] : undefined;
  useEffect(() => {
    setAlarm(!!cur);
    return () => setAlarm(false);
  }, [!!cur]);
  if (!cur) return null;

  const o = cur.order;
  const open = () => {
    setBells((b) => b.filter((x) => x.id !== cur.id));
    try { navigationRef.isReady() && navigationRef.navigate('OrderDetail', { id: String(o.id) }); } catch {}
  };
  const accept = async () => {
    setBusy('accept');
    try {
      if (cur.role === 'courier') {
        if (o.mine) await apiBellRespond(o.id, 'accept');
        else { const r = await bellOrderAction(String(o.id), 'courier_accept'); if (!r.ok) throw new Error(r.error); }
      } else {
        const r = await bellOrderAction(String(o.id), 'accept'); if (!r.ok) throw new Error(r.error);
      }
      toast('✅ تم القبول');
      setBells((b) => b.filter((x) => x.id !== cur.id));
      try { navigationRef.isReady() && navigationRef.navigate('OrderDetail', { id: String(o.id) }); } catch {}
    } catch (e) { toast(errText(e), 'err'); }
    setBusy('');
    load();
  };
  const reject = async () => {
    setBusy('reject');
    try {
      if (cur.role === 'courier') await apiBellRespond(o.id, 'reject');
      else { const r = await bellOrderAction(String(o.id), 'reject'); if (!r.ok) throw new Error(r.error); }
      toast('تم الرفض');
      setBells((b) => b.filter((x) => x.id !== cur.id));
    } catch (e) { toast(errText(e), 'err'); }
    setBusy('');
    load();
  };
  // a courier can only refuse an order that is not picked up yet; the shop answers from its own order screen too
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
        <View style={{ width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 24, padding: 18, gap: 10 }}>
          <T size={44} align="center">🔔</T>
          <T w="bold" size={19} align="center">{cur.role === 'courier' ? 'الإدارة بترنّ عليك' : 'طلب جديد بيرنّ عليك'}</T>
          <View style={{ backgroundColor: '#F6F7F2', borderRadius: 14, padding: 12, gap: 4 }}>
            <T w="bold" size={15}>طلب #{o.number}</T>
            {!!o.shop && <T size={13.5}>🏪 {o.shop}</T>}
            {!!o.customer && <T size={13.5}>👤 {o.customer}</T>}
            {!!(o.region || o.address) && <T size={13} color={C.sub}>📍 {[o.region, o.address].filter(Boolean).join(' - ')}</T>}
            {o.total > 0 && <T size={13.5}>💰 {o.total} ج</T>}
          </View>
          <T size={12} color={C.sub} align="center">الرنين مش هيقف لحد ما تقبل أو ترفض الطلب</T>
          <Btn variant="green" icon="checkmark-circle" title="قبول الطلب" loading={busy === 'accept'} onPress={accept} />
          <Btn variant="danger" icon="close-circle" title="رفض الطلب" loading={busy === 'reject'} onPress={reject} />
          <Btn variant="soft" icon="open" title="فتح تفاصيل الطلب" onPress={open} />
        </View>
      </View>
    </Modal>
  );
}
