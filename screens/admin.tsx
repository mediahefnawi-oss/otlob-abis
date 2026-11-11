import React, { useMemo, useState } from 'react';
import { View, FlatList, ScrollView, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { C, shadow } from '../lib/theme';
import {
  T, Icon, Toggle, IconBtn, Sheet, Card, Btn, Header, Empty, Segmented, Stat, Appear, Chip, EmojiBubble, IconBubble, Pill, AcctPill, OrderPill, Field,
  toast, confirmDialog, SectionTitle, Row, callPhone, openWhats, FlagPill,
} from '../components/ui';
import { OrderCard, ApptCard } from '../components/Cards';
import { ProviderLogo } from '../components/Brand';
import { useRC } from './customer';
import { ProfileScreen } from './shared';
import { ProviderFormSheet, CatalogEditor } from '../components/OwnerTools';
import {
  useStore, useMe, updateSettings, setProviderStatus, setUserStatus, resetAll, availableCouriers, adminDeleteProvider, adminDeleteCourier, adminDeleteCustomer, adminMoveProvider, adminSetOrderMode, adminResetPassword, setProviderFeatured, setProviderRegion, setCustomerFlag, createSupervisor, updateSupervisor, deleteSupervisor,
} from '../lib/store';
import { TYPES, money, fmtDateTime, fmtDate, DAYS, isoDay, ORDER_STATUS, FLAGS, inStaffQueue, isBooking, hasProducts, typeKeys } from '../lib/format';
import { RegionsManager, RegionPicker, RoutePricesManager } from '../components/Regions';
import { LoginImageManager, WelcomeScreenManager, AppIconManager, UpdateNoticeManager, ServicesManager } from '../components/Finance';
import { useCounters } from '../lib/finance';
import { SupportInbox, useSupportUnread } from '../components/SupportChat';
import { ThemePicker } from '../components/ThemePicker';
import { UiScaleCard } from '../components/UiScaleCard';
import { PrivacyCard } from '../components/PrivacyCard';
import { DeliveryModeCard } from '../components/DeliveryMode';
import { MapModeCard, CustomerLocationCard } from '../components/Location';
import { apiSupervisorSupport } from '../lib/api';
import { AdsManager } from '../components/Ads';
import { MenuManager } from '../components/Menu';
import { HoursSettings } from '../components/HoursSettings';
import { ReplicationCard } from '../components/Replication';
import { ProviderType, AccountStatus, Provider } from '../lib/types';

// Runs a server-backed action and only reports success when the server accepted it.
async function done(action: Promise<{ ok: boolean }>, okMsg: string, okKind: 'ok' | 'info' = 'ok') {
  const r: any = await action;
  if (r.ok) toast(okMsg, okKind);
  else toast(r.error || 'تعذر تنفيذ العملية', 'err');
}

function AppSwitch({ compact }: { compact?: boolean }) {
  const { db } = useStore();
  const on = db.settings.appEnabled;
  const toggle = () =>
    confirmDialog({
      title: on ? 'إيقاف التطبيق؟' : 'تشغيل التطبيق؟',
      message: on ? 'سيظهر للعملاء ومقدمي الخدمات والمناديب شاشة "التطبيق متوقف مؤقتاً" ولن يمكنهم تنفيذ أي عمليات.' : 'سيعود التطبيق للعمل بشكل طبيعي لجميع المستخدمين.',
      danger: on,
      confirmText: on ? 'إيقاف التطبيق' : 'تشغيل التطبيق',
      onConfirm: () => {
        done(updateSettings({ appEnabled: !on }), on ? 'تم إيقاف التطبيق لجميع المستخدمين' : 'تم تشغيل التطبيق لجميع المستخدمين', on ? 'info' : 'ok');
      },
    });
  if (compact) {
    return (
      <Pressable onPress={toggle}>
        <LinearGradient colors={on ? ['#16A163', '#0E7A4F'] : ['#B53A3A', '#8E2A2A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 16, paddingVertical: 9, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="power" size={18} color="#fff" />
          <View style={{ flex: 1 }}>
            <T w="black" size={13.5} color="#fff">{on ? 'التطبيق يعمل' : 'التطبيق متوقف'}</T>
          </View>
          <T size={11} color="rgba(255,255,255,0.85)">{on ? 'اضغط للإيقاف' : 'اضغط للتشغيل'}</T>
          <View style={{ width: 40, height: 23, borderRadius: 12, backgroundColor: on ? C.gold : 'rgba(255,255,255,0.3)', padding: 2.5, alignItems: on ? 'flex-start' : 'flex-end' }}>
            <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff' }} />
          </View>
        </LinearGradient>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={toggle}>
      <LinearGradient colors={on ? ['#16A163', '#0E7A4F'] : ['#B53A3A', '#8E2A2A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 22, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, ...shadow }}>
        <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="power" size={28} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <T w="black" size={17} color="#fff">{on ? 'التطبيق يعمل' : 'التطبيق متوقف'}</T>
          <T size={12} color="rgba(255,255,255,0.85)">{on ? 'اضغط لإيقاف التطبيق لجميع المستخدمين' : 'اضغط لإعادة تشغيل التطبيق'}</T>
        </View>
        <View style={{ width: 52, height: 30, borderRadius: 15, backgroundColor: on ? C.gold : 'rgba(255,255,255,0.3)', padding: 3, alignItems: on ? 'flex-start' : 'flex-end' }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff' }} />
        </View>
      </LinearGradient>
    </Pressable>
  );
}

/* ---------------- Dashboard ---------------- */
export function AdminDashboardScreen({ navigation, go }: any) {
  const rc = useRC();
  const { db } = useStore();
  const me = useMe()!;
  const supUnread = useSupportUnread(true);
  const orders = db.orders;
  const delivered = orders.filter((o) => o.status === 'delivered');
  const active = orders.filter((o) => ['pending', 'quoted', 'accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status));
  const pendingProv = db.providers.filter((p) => p.status === 'pending');
  const pendingCour = db.users.filter((u) => u.role === 'courier' && u.status === 'pending');
  const pendingCust = db.users.filter((u) => u.role === 'customer' && u.status === 'pending');
  const couriers = db.users.filter((u) => u.role === 'courier' && u.status === 'active');
  const avail = availableCouriers(db).length;
  const revenue = delivered.reduce((s, o) => s + o.total, 0);
  const counters = useCounters('admin'); // server-side, honours the owner's counter resets

  const bars = useMemo(() => {
    const arr: { label: string; n: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = isoDay(d);
      arr.push({ label: i === 0 ? 'اليوم' : DAYS[d.getDay()].slice(0, 3), n: orders.filter((o) => isoDay(new Date(o.createdAt)) === key).length });
    }
    return arr;
  }, [orders]);
  const todayKey = isoDay(new Date());
  const todayOrders = orders.filter((o) => isoDay(new Date(o.createdAt)) === todayKey);
  const todayDone = orders.filter((o) => o.status === 'delivered' && isoDay(new Date(o.updatedAt)) === todayKey);
  const todayDead = orders.filter((o) => ['rejected', 'cancelled'].includes(o.status) && isoDay(new Date(o.updatedAt)) === todayKey);
  const todaySales = todayDone.reduce((sum, o) => sum + o.total, 0);
  const stuck = orders.filter((o) => inStaffQueue(o)).length;
  const shortcuts = [
    { label: 'العملاء', route: 'AdminCustomers', icon: 'people', color: C.goldDeep, bg: C.goldSoft, badge: 0 },
    { label: 'المناديب على الخريطة', route: 'CouriersMap', icon: 'map', color: C.orange, bg: C.orangeSoft, badge: 0 },
    { label: 'شات الدعم', route: 'AdminSupport', icon: 'chatbubbles', color: C.goldDeep, bg: C.goldSoft, badge: supUnread },
    { label: 'العروض والخصومات', route: 'AdminOffers', icon: 'pricetags', color: C.red, bg: C.redSoft, badge: 0 },
    { label: 'أكواد الخصم', route: 'AdminCoupons', icon: 'ticket', color: C.green, bg: C.greenSoft, badge: 0 },
    { label: 'تشغيل الميزات', route: 'AdminFeatures', icon: 'options', color: C.green, bg: C.greenSoft, badge: 0 },
    { label: 'التقييمات', route: 'AdminRatings', icon: 'star', color: C.goldDeep, bg: C.goldSoft, badge: 0 },
    { label: 'المشرفون', route: 'AdminSupervisors', icon: 'shield-checkmark', color: C.green, bg: C.greenSoft, badge: 0 },
  ];
  const max = Math.max(1, ...bars.map((b) => b.n));
  const recent = [...orders].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="لوحة الإدارة" subtitle={`مرحباً ${me.name}`} />
      <ScrollView refreshControl={rc} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 30 }}>
        <AppSwitch compact />

        {(pendingProv.length > 0 || pendingCour.length > 0 || pendingCust.length > 0) && (
          <Appear>
            <Card style={{ backgroundColor: C.goldSoft, gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="notifications" size={20} color={C.goldDeep} />
                <T w="black" size={15} color={C.goldDeep}>طلبات انضمام بانتظار المراجعة</T>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {pendingProv.length > 0 && <Btn small title={`مقدمو خدمة (${pendingProv.length})`} icon="storefront" style={{ flex: 1 }} onPress={() => go('providers')} />}
                {pendingCour.length > 0 && <Btn small title={`مناديب (${pendingCour.length})`} icon="bicycle" variant="dark" style={{ flex: 1 }} onPress={() => go('couriers')} />}
                {pendingCust.length > 0 && <Btn small title={`عملاء (${pendingCust.length})`} icon="person" variant="green" style={{ flex: 1 }} onPress={() => navigation.navigate('AdminCustomers')} />}
              </View>
            </Card>
          </Appear>
        )}

        {(supUnread > 0 || stuck > 0) && (
          <Card style={{ backgroundColor: C.goldSoft, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="alert-circle" size={20} color={C.goldDeep} />
              <T w="black" size={15} color={C.goldDeep}>يحتاج انتباهك</T>
            </View>
            {supUnread > 0 && <Pressable onPress={() => navigation.navigate('AdminSupport')}><T w="bold" size={13}>💬 {supUnread} رسائل دعم غير مقروءة ›</T></Pressable>}
            {stuck > 0 && <Pressable onPress={() => go('orders')}><T w="bold" size={13}>⏳ {stuck} طلب متعطل يحتاج تدخل ›</T></Pressable>}
          </Card>
        )}

        <View>
          <T w="black" size={15} style={{ marginBottom: 8 }}>اليوم</T>
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Stat compact icon="receipt" label="طلبات اليوم" value={todayOrders.length} />
              <Stat compact icon="cash" label="مبيعات اليوم" value={money(todaySales)} color={C.goldDeep} soft={C.goldSoft} />
              <Stat compact icon="bicycle" label="قيد التنفيذ" value={active.length} color={C.orange} soft={C.orangeSoft} />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Stat compact icon="checkmark-done" label="مكتملة اليوم" value={todayDone.length} color={C.blue} soft={C.blueSoft} />
              <Stat compact icon="close-circle" label="ملغاة اليوم" value={todayDead.length} color={C.red} soft={C.redSoft} />
              <Stat compact icon="radio" label={`مناديب متاحون / ${couriers.length}`} value={avail} color={C.green} />
            </View>
          </View>
        </View>

        <View>
          <T w="black" size={15} style={{ marginBottom: 8 }}>اختصارات</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {shortcuts.map((x) => (
              <Pressable key={x.label} onPress={() => navigation.navigate(x.route)} style={{ width: '31.3%' }}>
                <Card style={{ alignItems: 'center', gap: 6, paddingVertical: 14, paddingHorizontal: 6 }}>
                  <IconBubble icon={x.icon} color={x.color} bg={x.bg} size={46} />
                  <T w="bold" size={12} align="center" numberOfLines={2}>{x.label}</T>
                  {!!x.badge && <View style={{ position: 'absolute', top: 8, left: 8, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><T w="black" size={10.5} color="#fff" align="center">{x.badge}</T></View>}
                </Card>
              </Pressable>
            ))}
          </View>
        </View>

        <Card style={{ gap: 12 }}>
          <T w="black" size={15}>الطلبات آخر 7 أيام</T>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 130, gap: 8 }}>
            {bars.map((b, i) => (
              <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4, height: '100%' }}>
                <T w="bold" size={11} align="center">{b.n}</T>
                <View style={{ width: '70%', height: Math.max(6, (b.n / max) * 90), borderRadius: 8, backgroundColor: i === 6 ? C.gold : C.green, opacity: i === 6 ? 1 : 0.75 }} />
                <T size={9.5} color={C.sub} align="center" numberOfLines={1}>{b.label}</T>
              </View>
            ))}
          </View>
        </Card>

        <View>
          <SectionTitle title="أحدث الطلبات" action="عرض الكل" onAction={() => go('orders')} />
          <Card style={{ paddingVertical: 4, paddingHorizontal: 0 }}>
            {recent.length === 0 && <Empty title="لا توجد طلبات" />}
            {recent.map((o, i) => (
              <Pressable key={o.id} onPress={() => navigation.navigate('OrderDetail', { id: o.id })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: i ? 1 : 0, borderColor: C.line }}>
                <T w="bold" size={12} color={C.sub} style={{ width: 38 }}>‎#{o.number}</T>
                <View style={{ flex: 1 }}>
                  <T w="semi" size={13} numberOfLines={1}>{o.customerName}</T>
                  <T size={11} color={C.sub} numberOfLines={1}>{o.providerName}</T>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 3 }}>
                  <OrderPill s={o.status} />
                  <T w="bold" size={12}>{money(o.total)}</T>
                </View>
              </Pressable>
            ))}
          </Card>
        </View>

        <View>
          <T w="black" size={15} style={{ marginBottom: 8 }}>الإجمالي (كل الوقت)</T>
          <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stat compact icon="receipt" label="إجمالي الطلبات" value={counters ? counters.totals.orders : orders.length} />
          <Stat compact icon="checkmark-done" label="المكتملة" value={delivered.length} color={C.blue} soft={C.blueSoft} />
          <Stat compact icon="bicycle" label="قيد التنفيذ" value={active.length} color={C.orange} soft={C.orangeSoft} />
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stat compact icon="cash" label="إجمالي المبيعات" value={money(counters ? counters.totals.sales : revenue)} color={C.goldDeep} soft={C.goldSoft} />
          <Stat compact icon="trending-up" label="أرباح المنصة" value={money(counters ? counters.totals.profit : 0)} color={C.green} soft={C.greenSoft} />
          <Stat compact icon="calendar" label="حجوزات العيادات" value={db.appointments.length} color="#8A5CD1" soft="#EFE6FB" />
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stat compact icon="people" label="العملاء" value={db.users.filter((u) => u.role === 'customer').length} />
          <Stat compact icon="storefront" label="مقدمو الخدمة" value={db.providers.filter((p) => p.status === 'active').length} color={C.blue} soft={C.blueSoft} />
          <Stat compact icon="radio" label={`مناديب متاحون / ${couriers.length}`} value={avail} color={C.green} />
        </View>

          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/* ---------------- Providers ---------------- */
export function AdminProvidersScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const [st, setSt] = useState<'all' | AccountStatus>('all');
  const [tp, setTp] = useState<'all' | ProviderType>('all');
  const [adding, setAdding] = useState(false);
  const list = db.providers
    .filter((p) => (st === 'all' || p.status === st) && (tp === 'all' || p.type === tp))
    .sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || b.createdAt - a.createdAt);
  const owner = (id: string) => db.users.find((u) => u.id === id);
  const pending = db.providers.filter((p) => p.status === 'pending').length;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="الخدمات ومقدموها" subtitle={`${db.providers.length} خدمة مسجلة`} right={<IconBtn icon="add" bg={C.gold} color={C.dark} onPress={() => setAdding(true)} />} />
      <ProviderFormSheet visible={adding} onClose={() => setAdding(false)} onCreated={(id) => navigation.navigate('AdminDetail', { kind: 'provider', id })} />
      <View style={{ paddingTop: 12, gap: 8 }}>
        <FlatList horizontal data={[{ k: 'all', l: 'الكل' }, { k: 'pending', l: 'قيد المراجعة' }, { k: 'active', l: 'معتمد' }, { k: 'rejected', l: 'مرفوض' }, { k: 'suspended', l: 'موقوف' }]} keyExtractor={(x) => x.k} showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
          renderItem={({ item }) => <Chip label={item.l} active={st === item.k} count={item.k === 'pending' ? pending : undefined} onPress={() => setSt(item.k as any)} />} />
        <FlatList horizontal data={['all', ...typeKeys()]} keyExtractor={(x) => x} showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
          renderItem={({ item }) => <Chip label={item === 'all' ? 'كل الأنواع' : TYPES[item as ProviderType].label} icon={item === 'all' ? undefined : TYPES[item as ProviderType].icon} active={tp === item} onPress={() => setTp(item as any)} />} />
      </View>
      <FlatList
        data={list}
        keyExtractor={(p) => p.id}
        refreshControl={rc}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={<Empty icon="storefront" title="لا توجد نتائج" />}
        renderItem={({ item, index }) => {
          const n = db.orders.filter((o) => o.providerId === item.id).length;
          const ap = db.appointments.filter((a) => a.providerId === item.id).length;
          const o = owner(item.ownerId);
          return (
            <Appear i={index}>
              <Card onPress={() => navigation.navigate('AdminDetail', { kind: 'provider', id: item.id })} style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <ProviderLogo p={item} size={50} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T w="bold" size={15} numberOfLines={1}>{item.name}</T>
                    <T size={11.5} color={C.sub}>{TYPES[item.type].single} • {o?.name} • {o?.phone}</T>
                  </View>
                  <AcctPill s={item.status} />
                </View>
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  <T size={12} color={C.sub}>{isBooking(item.type) ? `${ap} حجز` : `${n} طلب`}</T>
                  <T size={12} color={C.sub}>سجّل {fmtDate(item.createdAt)}</T>
                </View>
                {item.status === 'pending' && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Btn small variant="green" icon="checkmark" title="قبول" style={{ flex: 1 }} onPress={() => done(setProviderStatus(item.id, 'active'), 'تم قبول مقدم الخدمة ✅')} />
                    <Btn small variant="danger" icon="close" title="رفض" style={{ flex: 1 }} onPress={() => done(setProviderStatus(item.id, 'rejected'), 'تم رفض الطلب', 'info')} />
                  </View>
                )}
              </Card>
            </Appear>
          );
        }}
      />
    </View>
  );
}

/* ---------------- Couriers ---------------- */
export function AdminCouriersScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const list = db.users.filter((u) => u.role === 'courier').sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
  const avail = availableCouriers(db).length;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="المناديب" subtitle={`${avail} متاح الآن من ${list.filter((u) => u.status === 'active').length}`} />
      <FlatList
        data={list}
        keyExtractor={(u) => u.id}
        refreshControl={rc}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={<Empty icon="bicycle" title="لا يوجد مناديب" />}
        renderItem={({ item, index }) => {
          const active = db.orders.filter((o) => o.courierId === item.id && ['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status)).length;
          const done = db.orders.filter((o) => o.courierId === item.id && o.status === 'delivered').length;
          return (
            <Appear i={index}>
              <Card onPress={() => navigation.navigate('AdminDetail', { kind: 'courier', id: item.id })} style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View>
                    <IconBubble icon="bicycle" color={C.orange} bg={C.orangeSoft} size={50} />
                    <View style={{ position: 'absolute', bottom: -2, left: -2, width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#fff', backgroundColor: item.status === 'active' && item.available ? '#22C55E' : '#A8B3AE' }} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T w="bold" size={15}>{item.name}</T>
                    <T size={11.5} color={C.sub}>{item.phone} • {item.vehicle}</T>
                    <T size={11.5} color={item.available ? C.green : C.sub} w="semi">{item.status !== 'active' ? '' : item.available ? 'متاح الآن' : 'غير متاح'}</T>
                  </View>
                  <AcctPill s={item.status} />
                </View>
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  <T size={12} color={C.sub}>{active} جارية</T>
                  <T size={12} color={C.sub}>{done} مكتملة</T>
                </View>
                {item.status === 'pending' && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Btn small variant="green" icon="checkmark" title="قبول المندوب" style={{ flex: 1 }} onPress={() => done(setUserStatus(item.id, 'active'), 'تم قبول المندوب ✅')} />
                    <Btn small variant="danger" icon="close" title="رفض" style={{ flex: 1 }} onPress={() => done(setUserStatus(item.id, 'rejected'), 'تم رفض الطلب', 'info')} />
                  </View>
                )}
              </Card>
            </Appear>
          );
        }}
      />
    </View>
  );
}

/* ---------------- Orders & bookings ---------------- */
export function AdminOrdersScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const [seg, setSeg] = useState('orders');
  const [f, setF] = useState('all');
  const orders = db.orders.filter((o) => f === 'all' || (f === 'active' ? ['pending', 'quoted', 'accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status) : f === 'dead' ? ['rejected', 'cancelled', 'unavailable'].includes(o.status) : o.status === f)).sort((a, b) => b.createdAt - a.createdAt);
  const appts = db.appointments.filter((a) => f === 'all' || a.status === f).sort((a, b) => b.createdAt - a.createdAt);
  const chips = seg === 'orders'
    ? [{ k: 'all', l: 'الكل' }, { k: 'active', l: 'جارية' }, { k: 'pending', l: 'جديدة' }, { k: 'delivered', l: 'مكتملة' }, { k: 'dead', l: 'ملغية' }]
    : [{ k: 'all', l: 'الكل' }, { k: 'pending', l: 'جديدة' }, { k: 'confirmed', l: 'مؤكدة' }, { k: 'completed', l: 'مكتملة' }, { k: 'rejected', l: 'مرفوضة' }];
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="الطلبات والحجوزات" subtitle="متابعة كل العمليات داخل التطبيق" />
      <View style={{ padding: 16, paddingBottom: 6, gap: 10 }}>
        <Segmented value={seg} onChange={(s) => { setSeg(s); setF('all'); }} options={[{ key: 'orders', label: `طلبات التوصيل (${db.orders.length})` }, { key: 'appts', label: `حجوزات العيادات (${db.appointments.length})` }]} />
        <FlatList horizontal data={chips} keyExtractor={(x) => x.k} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} renderItem={({ item }) => <Chip label={item.l} active={f === item.k} onPress={() => setF(item.k)} />} />
      </View>
      {seg === 'orders' ? (
        <FlatList data={orders} keyExtractor={(o) => o.id} refreshControl={rc} contentContainerStyle={{ padding: 16, gap: 12 }} ListEmptyComponent={<Empty icon="receipt" title="لا توجد طلبات" />}
          renderItem={({ item, index }) => <Appear i={index}><OrderCard o={item} perspective="admin" onPress={() => navigation.navigate('OrderDetail', { id: item.id })} /></Appear>} />
      ) : (
        <FlatList data={appts} keyExtractor={(o) => o.id} refreshControl={rc} contentContainerStyle={{ padding: 16, gap: 12 }} ListEmptyComponent={<Empty icon="calendar" title="لا توجد حجوزات" />}
          renderItem={({ item, index }) => <Appear i={index}><ApptCard a={item} perspective="admin" onPress={() => navigation.navigate('ApptDetail', { id: item.id })} /></Appear>} />
      )}
    </View>
  );
}

/* ---------------- Detail (provider / courier) ---------------- */
/** Owner: move the place to another section and choose how it takes orders. */
function ProviderModeCard({ prov }: { prov: Provider }) {
  const { db } = useStore();
  const [busy, setBusy] = useState(false);
  const menuOn = !!db.settings.features?.menu;
  const run = async (f: Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(true);
    const r: any = await f;
    setBusy(false);
    toast(r.ok ? okMsg : r.error, r.ok ? 'ok' : 'err');
  };
  const modes: ['' | 'request', string][] = [['', 'حسب القسم'], ['request', 'طلب مكتوب بدل السلة']];
  return (
    <Card style={{ gap: 12, opacity: busy ? 0.6 : 1 }} pointerEvents={busy ? 'none' : 'auto'}>
      <T w="black" size={15}>القسم وطريقة الطلب</T>
      <T size={12} color={C.sub}>القسم الحالي: {TYPES[prov.type]?.label || prov.type}. الطلبات القديمة تفضل زي ما هي.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {typeKeys().map((k) => <Chip key={k} label={TYPES[k as ProviderType].label} active={prov.type === k} onPress={() => { if (k !== prov.type) confirmDialog({ title: 'نقل لقسم آخر؟', message: `سينتقل "${prov.name}" إلى قسم ${TYPES[k as ProviderType].label}`, confirmText: 'نقل', onConfirm: () => { run(adminMoveProvider(prov.id, k), 'تم النقل ✅'); } }); }} />)}
      </View>
      <T w="bold" size={12.5}>طريقة الطلب</T>
      {menuOn ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {modes.map(([m, l]) => <Chip key={m || 'def'} label={l} active={(prov.orderMode || '') === m} onPress={() => run(adminSetOrderMode(prov.id, m), 'تم الحفظ ✅')} />)}
        </View>
      ) : <T size={12} color={C.sub}>فعّل «المنيو وطرق الطلب» من شاشة «تشغيل الميزات» أولاً (المنيو بالصور بيتضاف فوق طريقة الطلب الحالية).</T>}
    </Card>
  );
}

export function AdminDetailScreen({ navigation, route }: any) {
  const { db } = useStore();
  const { kind, id } = route.params;
  const prov = kind === 'provider' ? db.providers.find((p) => p.id === id) : null;
  const user = kind === 'provider' ? db.users.find((u) => u.id === prov?.ownerId) : db.users.find((u) => u.id === id);
  if (!user) return <View style={{ flex: 1 }}><Header title="التفاصيل" onBack={() => navigation.goBack()} /><Empty title="غير موجود" /></View>;
  const status = prov ? prov.status : user.status;
  const setS = (s: AccountStatus) => (prov ? setProviderStatus(prov.id, s) : setUserStatus(user.id, s));
  const orders = (prov ? db.orders.filter((o) => o.providerId === prov.id) : db.orders.filter((o) => o.courierId === user.id)).sort((a, b) => b.createdAt - a.createdAt);
  const appts = prov ? db.appointments.filter((a) => a.providerId === prov.id).sort((a, b) => b.createdAt - a.createdAt) : [];
  const [editing, setEditing] = useState(false);
  const [pwSheet, setPwSheet] = useState(false);
  const [newPw, setNewPw] = useState('');
  const delivered = orders.filter((o) => o.status === 'delivered');
  const revenue = delivered.reduce((s, o) => s + (prov ? o.subtotal : o.deliveryFee), 0);
  const counters = useCounters('admin');
  const pc = prov && counters ? counters.providers[prov.id] : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={prov ? prov.name : user.name} subtitle={prov ? TYPES[prov.type].single : 'مندوب توصيل'} onBack={() => navigation.goBack()} right={<AcctPill s={status} />} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        <Card style={{ gap: 12 }}>
          <T w="black" size={15}>بيانات الحساب</T>
          <Row icon="person" label="المسؤول" value={user.name} />
          <Row icon="call" label="الهاتف" value={user.phone} />
          <Row icon="location" label="العنوان" value={prov?.address || user.address || '—'} />
          {prov && <Row icon="document-text" label="الوصف" value={prov.desc || '—'} />}
          {prov?.specialty && <Row icon="pulse" label="التخصص" value={prov.specialty} />}
          {!prov && <Row icon="bicycle" label="الوسيلة" value={user.vehicle || '—'} />}
          {!prov && <Row icon="radio" label="الحالة" value={user.available ? 'متاح الآن' : 'غير متاح'} color={user.available ? C.green : C.sub} />}
          <Row icon="calendar" label="تاريخ التسجيل" value={fmtDateTime(user.createdAt)} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small variant="soft" icon="call" title="اتصال" style={{ flex: 1 }} onPress={() => callPhone(user.phone)} />
            <Btn small variant="soft" icon="logo-whatsapp" title="واتساب" style={{ flex: 1 }} onPress={() => openWhats(user.phone)} />
          </View>
        </Card>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stat icon="receipt" label={isBooking(prov?.type) ? 'حجوزات' : 'طلبات'} value={pc ? pc.orders : isBooking(prov?.type) ? appts.length : orders.length} />
          <Stat icon="checkmark-done" label="مكتملة" value={pc ? pc.done : isBooking(prov?.type) ? appts.filter((a) => a.status === 'completed').length : delivered.length} color={C.blue} soft={C.blueSoft} />
          <Stat icon="cash" label={prov ? 'المبيعات' : 'الأرباح'} value={pc ? money(pc.sales) : isBooking(prov?.type) ? money(appts.filter((a) => ['confirmed', 'completed'].includes(a.status)).reduce((s, a) => s + a.fee, 0)) : money(revenue)} color={C.goldDeep} soft={C.goldSoft} />
        </View>
        {pc && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Stat icon="trending-up" label="عمولة المنصة منه" value={money(pc.commission)} color={C.green} soft={C.greenSoft} />
            <Stat icon="bicycle" label="خصم مناديبه" value={money(pc.courierCut)} color={C.orange} soft={C.orangeSoft} />
          </View>
        )}
        <Card style={{ gap: 10 }}>
          <T w="black" size={15}>إجراءات الإدارة</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {status !== 'active' && <Btn small variant="green" icon="checkmark" title="قبول / تفعيل" style={{ flexGrow: 1 }} onPress={() => done(setS('active'), 'تم تفعيل الحساب ✅')} />}
            {status === 'pending' && <Btn small variant="danger" icon="close" title="رفض" style={{ flexGrow: 1 }} onPress={() => done(setS('rejected'), 'تم رفض الطلب', 'info')} />}
            {status === 'active' && <Btn small variant="danger" icon="pause" title="إيقاف الحساب" style={{ flexGrow: 1 }} onPress={() => confirmDialog({ title: 'إيقاف الحساب؟', message: 'لن يتمكن من استقبال أي طلبات', danger: true, confirmText: 'إيقاف', onConfirm: () => done(setS('suspended'), 'تم إيقاف الحساب', 'info') })} />}
          </View>
        </Card>
        <Card style={{ gap: 10 }}>
          <T w="black" size={15}>تحكم المالك</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {prov && <Btn small variant="dark" icon="create" title="تعديل بيانات الخدمة" style={{ flexGrow: 1 }} onPress={() => setEditing(true)} />}
            <Btn small variant="soft" icon="key" title="تعيين كلمة مرور" style={{ flexGrow: 1 }} onPress={() => { setNewPw(''); setPwSheet(true); }} />
            <Btn small variant="danger" icon="trash" title={prov ? 'حذف الخدمة' : 'حذف المندوب'} style={{ flexGrow: 1 }} onPress={() => confirmDialog({
              title: prov ? 'حذف الخدمة نهائياً؟' : 'حذف المندوب نهائياً؟',
              message: prov ? `سيتم حذف "${prov.name}" وجميع منتجاتها وحساب مسؤولها. سجل الطلبات السابقة يبقى محفوظاً.` : `سيتم حذف حساب ${user.name}.`,
              danger: true, confirmText: 'حذف',
              onConfirm: () => { navigation.goBack(); setTimeout(() => { done(prov ? adminDeleteProvider(prov.id) : adminDeleteCourier(user.id), 'تم الحذف'); }, 150); },
            })} />
          </View>
        </Card>
        {prov && <ProviderModeCard prov={prov} />}
        {prov && db.settings.features?.menu && <MenuManager providerId={prov.id} />}
        {prov && (
          <Card style={{ gap: 12 }}>
            <T w="black" size={15}>الظهور للعملاء</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <T w="bold" size={13.5}>يظهر في «الأعلى تقييماً»</T>
                <T size={11.5} color={C.sub}>القائمة اللي بتظهر في الصفحة الرئيسية للعملاء. أنت اللي تحدد مين فيها.</T>
              </View>
              <Toggle value={!!prov.featured} onValueChange={(v) => done(setProviderFeatured(prov.id, v), v ? 'تمت الإضافة للأعلى تقييماً ⭐' : 'تم الحذف من الأعلى تقييماً', v ? 'ok' : 'info')} />
            </View>
            <RegionPicker value={prov.regionId || ''} onChange={(rid) => done(setProviderRegion(prov.id, rid), 'تم تحديد منطقة المكان')} label={`منطقة المكان${prov.regionName ? ` (الحالية: ${prov.regionName})` : ' (غير محددة)'}`} />
          </Card>
        )}
        {prov && hasProducts(prov.type) && <CatalogEditor prov={prov} />}
        {prov && <ProviderFormSheet visible={editing} onClose={() => setEditing(false)} provider={prov} />}
        <Sheet visible={pwSheet} onClose={() => setPwSheet(false)} title="تعيين كلمة مرور جديدة">
          <T size={12.5} color={C.sub}>سيتم تعيين كلمة مرور جديدة للحساب {user.phone}. كلمات المرور مشفّرة ولا يمكن عرضها.</T>
          <Field label="كلمة المرور الجديدة" icon="key" value={newPw} onChangeText={setNewPw} secureTextEntry />
          <Btn title="حفظ" icon="checkmark" onPress={() => { adminResetPassword(user.id, newPw).then((r) => { if (!r.ok) return toast(r.error, 'err'); setPwSheet(false); toast('تم تعيين كلمة المرور'); }); }} />
        </Sheet>
        {isBooking(prov?.type) && appts.length > 0 && (
          <View style={{ gap: 10 }}>
            <SectionTitle title="حجوزات العيادة" />
            {appts.slice(0, 15).map((a) => <ApptCard key={a.id} a={a} perspective="admin" onPress={() => navigation.navigate('ApptDetail', { id: a.id })} />)}
          </View>
        )}
        {!isBooking(prov?.type) && (
          <View style={{ gap: 10 }}>
            <SectionTitle title={prov ? 'الطلبات عند مقدم الخدمة' : 'طلبات المندوب'} />
            {orders.length === 0 && <Empty icon="receipt" title="لا توجد طلبات" />}
            {orders.slice(0, 20).map((o) => <OrderCard key={o.id} o={o} perspective="admin" onPress={() => navigation.navigate('OrderDetail', { id: o.id })} />)}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/** A settings section that opens and closes with a tap, so the settings page stays short and tidy. */
function Section({ icon, title, sub, children }: { icon: string; title: string; sub?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      <Pressable onPress={() => setOpen((v) => !v)}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: open ? C.goldSoft : C.card }}>
          <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: C.goldSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon} size={21} color={C.goldDeep} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T w="black" size={15}>{title}</T>
            {!!sub && <T size={11.5} color={C.sub} numberOfLines={1}>{sub}</T>}
          </View>
          <Icon name={open ? 'chevron-down' : 'chevron-back'} size={20} color={C.sub} />
        </Card>
      </Pressable>
      {open && children}
    </View>
  );
}

/* ---------------- Settings ---------------- */
export function AdminSettingsScreen({ navigation }: any) {
  const { db } = useStore();
  const s = db.settings;
  const [msg, setMsg] = useState(s.maintenanceMessage);
  const [ann, setAnn] = useState(s.announcement);
  const extra = (
    <>
      <Section icon="settings" title="التطبيق" sub="تشغيل وإيقاف، الصيانة، الإعلان، التعيين التلقائي">
        <AppSwitch />
      <Card style={{ gap: 12 }}>
        <T w="black" size={15}>إعدادات التطبيق</T>
        <Field label="رسالة الصيانة (عند إيقاف التطبيق)" value={msg} onChangeText={setMsg} multiline icon="construct" />
        <Field label="إعلان الصفحة الرئيسية" value={ann} onChangeText={setAnn} multiline icon="megaphone" />
        <Btn title="حفظ الإعدادات" icon="checkmark" onPress={() => done(updateSettings({ maintenanceMessage: msg.trim(), announcement: ann.trim() }), 'تم حفظ الإعدادات ويظهر الآن للمستخدمين')} />
        <View style={{ height: 1, backgroundColor: C.line }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <T w="bold" size={14}>التعيين التلقائي للمناديب</T>
            <T size={11.5} color={C.sub}>يُسند الطلب تلقائياً لأقرب مندوب متاح للمتجر (والأقل انشغالاً) ويفتح له فوراً، ولو لم يفتحه خلال دقيقتين ينتقل للمندوب التالي</T>
          </View>
          <Toggle value={s.autoAssign} onValueChange={(v) => done(updateSettings({ autoAssign: v }), v ? 'تم تفعيل التعيين التلقائي' : 'تم إيقاف التعيين التلقائي')} />
        </View>
      </Card>
      <PrivacyCard />
      </Section>
      <Section icon="color-palette" title="المظهر وحجم الواجهة" sub="لون التطبيق • حجم الخط والعناصر للموبايل والكمبيوتر">
        <ThemePicker />
        <UiScaleCard />
      </Section>
      <Section icon="map" title="الخريطة والتوصيل" sub="نوع الخريطة • طريقة حساب التوصيل">
        <MapModeCard />
        <DeliveryModeCard />
      </Section>
      <Section icon="moon" title="مواعيد التشغيل" sub="ساعة الفتح والغلق، الأيام، رسالة الغلق للعميل">
        <HoursSettings />
      </Section>
      <Section icon="server" title="النسخة الاحتياطية" sub="تشغيل أو إيقاف الربط مع القاعدة الاحتياطية">
        <ReplicationCard />
      </Section>
      <Section icon="grid" title="الخدمات" sub={`${(db.services && db.services.length ? db.services.filter((x) => x.template !== 'errand').length : 6)} خدمات • أسماء وترتيب وأحجام`}>
        <ServicesManager />
      </Section>
      <Section icon="location" title="المناطق والتوصيل" sub={`${db.regions.length} منطقة • أسعار التوصيل`}>
        <RegionsManager />
        <RoutePricesManager />
      </Section>
      <Section icon="images" title="الإعلانات والصور" sub={`${(db.ads || []).length} إعلانات • صورة الدخول`}>
        <AdsManager />
        <LoginImageManager />
      </Section>
      <Section icon="color-palette" title="الهوية" sub="الشاشة الأولى • البيانات • أيقونة التطبيق">
        <WelcomeScreenManager />
        <AppIconManager />
        <UpdateNoticeManager />
      </Section>
      <Section icon="server" title="قاعدة البيانات" sub="إحصائيات المستخدمين والأنشطة والطلبات">
      <Card style={{ gap: 10 }}>
        <T w="black" size={15}>قاعدة البيانات</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[['المستخدمون', db.users.length], ['الأنشطة', db.providers.length], ['المنتجات', db.products.length], ['الطلبات', db.orders.length], ['الحجوزات', db.appointments.length], ['الفواتير', db.invoices.length], ['الرسائل', db.messages.length]].map(([l, n]) => (
            <View key={l as string} style={{ backgroundColor: '#F3F4EE', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
              <T size={11} color={C.sub}>{l}</T>
              <T w="black" size={16}>{n}</T>
            </View>
          ))}
        </View>
      </Card>
      </Section>
    </>
  );
  return <ProfileScreen navigation={navigation} extra={extra} title="الإعدادات" />;
}


/* ---------------- Customers: suspend + label ---------------- */
const FLAG_FILTERS = [
  { key: 'all', label: 'الكل' },
  { key: 'pending', label: 'بانتظار القبول' },
  { key: 'trusted', label: 'معتمد' },
  { key: 'watch', label: 'مراقبة' },
  { key: 'fraud', label: 'احتيالي' },
  { key: 'suspended', label: 'موقوف' },
];

export function AdminCustomersScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const [q, setQ] = useState('');
  const [f, setF] = useState('all');
  const regionOf = (id?: string | null) => db.regions.find((x) => x.id === id)?.name || '';
  const all = db.users.filter((u) => u.role === 'customer');
  const list = all
    .filter((u) => (f === 'all' ? true : f === 'suspended' ? u.status === 'suspended' : f === 'pending' ? u.status === 'pending' : u.accountFlag === f))
    .filter((u) => !q.trim() || u.name.includes(q.trim()) || (u.phone || '').includes(q.trim()))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const cnt = (k: string) => (k === 'all' ? all.length : k === 'pending' ? all.filter((u) => u.status === 'pending').length : k === 'suspended' ? all.filter((u) => u.status === 'suspended').length : all.filter((u) => u.accountFlag === k).length);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="إدارة العملاء" subtitle={`${all.length} عميل`} onBack={() => navigation.goBack()} />
      <View style={{ padding: 16, paddingBottom: 4, gap: 10 }}>
        <Field icon="search" placeholder="بحث بالاسم أو رقم الهاتف" value={q} onChangeText={setQ} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {FLAG_FILTERS.map((x) => <Chip key={x.key} label={x.label} active={f === x.key} count={x.key === 'all' ? undefined : cnt(x.key)} onPress={() => setF(x.key)} />)}
        </ScrollView>
      </View>
      <FlatList
        data={list}
        keyExtractor={(u) => u.id}
        refreshControl={rc}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        ListEmptyComponent={<Empty icon="people" title="لا يوجد عملاء" />}
        renderItem={({ item }) => {
          const n = db.orders.filter((o) => o.customerId === item.id).length;
          return (
            <Card onPress={() => navigation.navigate('AdminCustomer', { id: item.id })} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <IconBubble icon="person" color={C.dark3} bg={C.goldSoft} size={44} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T w="bold" size={15}>{item.name}</T>
                  <T size={11.5} color={C.sub}>{item.phone}{regionOf(item.regionId) ? ` • ${regionOf(item.regionId)}` : ''} • {n} طلب</T>
                </View>
                {item.status !== 'active' && <AcctPill s={item.status} />}
              </View>
              {!!item.accountFlag && <FlagPill flag={item.accountFlag} />}
            </Card>
          );
        }}
      />
    </View>
  );
}

export function AdminCustomerScreen({ navigation, route }: any) {
  const { db } = useStore();
  const user = db.users.find((u) => u.id === route.params.id);
  const [flag, setFlag] = useState(user?.accountFlag || '');
  const [note, setNote] = useState(user?.flagNote || '');
  const [busy, setBusy] = useState(false);
  const [pwSheet, setPwSheet] = useState(false);
  const [newPw, setNewPw] = useState('');
  if (!user) return <View style={{ flex: 1 }}><Header title="العميل" onBack={() => navigation.goBack()} /><Empty title="غير موجود" /></View>;
  const orders = db.orders.filter((o) => o.customerId === user.id).sort((a, b) => b.createdAt - a.createdAt);
  const dirty = flag !== (user.accountFlag || '') || (flag && note.trim() !== (user.flagNote || ''));
  const save = async () => {
    setBusy(true);
    await done(setCustomerFlag(user.id, flag, note.trim()), flag ? 'تم حفظ العلامة ✅' : 'تم إزالة العلامة', 'ok');
    setBusy(false);
  };
  const suspended = user.status === 'suspended';
  const savePw = async () => {
    setBusy(true);
    const r = await adminResetPassword(user.id, newPw);
    setBusy(false);
    if (!r.ok) return toast(r.error || 'تعذر تعيين كلمة المرور', 'err');
    setPwSheet(false); setNewPw(''); toast('تم تعيين كلمة المرور الجديدة ✅ أبلغها للعميل');
  };
  const toggleSuspend = () =>
    confirmDialog({
      title: suspended ? 'إعادة تفعيل الحساب؟' : 'إيقاف الحساب؟',
      message: suspended ? 'سيتمكن العميل من استخدام التطبيق مرة أخرى.' : 'لن يتمكن العميل من الدخول أو الطلب حتى تعيد تفعيله.',
      danger: !suspended,
      confirmText: suspended ? 'إعادة التفعيل' : 'إيقاف الحساب',
      onConfirm: () => { done(setUserStatus(user.id, suspended ? 'active' : 'suspended'), suspended ? 'تم تفعيل الحساب ✅' : 'تم إيقاف الحساب', suspended ? 'ok' : 'info'); },
    });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={user.name} subtitle="عميل" onBack={() => navigation.goBack()} right={<AcctPill s={user.status} />} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        <Card style={{ gap: 8 }}>
          <T size={13} color={C.sub}>الهاتف: {user.phone}</T>
          {!!db.regions.find((x) => x.id === user.regionId) && <T size={13} color={C.sub}>المنطقة: {db.regions.find((x) => x.id === user.regionId)!.name}</T>}
          <T size={13} color={C.sub}>عدد الطلبات: {orders.length} • المكتملة: {orders.filter((o) => o.status === 'delivered').length}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small variant="green" icon="call" title="اتصال" style={{ flex: 1 }} onPress={() => callPhone(user.phone)} />
            <Btn small variant="green" icon="logo-whatsapp" title="واتساب" style={{ flex: 1 }} onPress={() => openWhats(user.phone)} />
          </View>
        </Card>

        <CustomerLocationCard lat={user.homeLat} lng={user.homeLng} />

        <Card style={{ gap: 12 }}>
          <T w="bold" size={15}>علامة الحساب</T>
          <T size={12} color={C.sub}>تظهر لمقدمي الخدمات والمناديب على طلبات هذا العميل (ولا يراها العميل).</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {Object.keys(FLAGS).map((k) => <Chip key={k} label={FLAGS[k].label} icon={FLAGS[k].icon} active={flag === k} onPress={() => setFlag(k)} />)}
            <Chip label="بدون علامة" active={flag === ''} onPress={() => setFlag('')} />
          </View>
          {!!flag && <Field label="ملاحظة تظهر لهم (اختياري)" placeholder="مثال: رفض الاستلام مرتين" value={note} onChangeText={setNote} multiline maxLength={200} />}
          <Btn title="حفظ العلامة" icon="checkmark" disabled={busy || !dirty} onPress={save} />
        </Card>

        <Btn variant="outline" icon="key" title="تعيين كلمة مرور جديدة للعميل" onPress={() => setPwSheet(true)} />
        <Sheet visible={pwSheet} onClose={() => setPwSheet(false)} title="كلمة مرور جديدة">
          <T size={12.5} color={C.sub}>كلمات المرور مشفّرة ولا يمكن لأحد (حتى الإدارة) معرفة القديمة. اكتب كلمة جديدة (8 أحرف على الأقل) وأبلغها للعميل على {user.phone}.</T>
          <Field label="كلمة المرور الجديدة" icon="key" value={newPw} onChangeText={setNewPw} secureTextEntry autoCapitalize="none" />
          <Btn title="حفظ" icon="checkmark" disabled={busy || newPw.length < 8} onPress={savePw} />
        </Sheet>
        {user.status === 'pending' && (
          <Card style={{ gap: 10, backgroundColor: C.goldSoft }}>
            <T w="black" size={15} color={C.goldDeep}>رقم سبق حذفه يطلب العودة</T>
            <T size={12.5} color={C.sub}>هذا الرقم كان محذوفاً من قبل وسجّل من جديد. لن يدخل التطبيق إلا بعد قبولك.</T>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn small variant="green" icon="checkmark" title="قبول العميل" style={{ flex: 1 }} onPress={() => done(setUserStatus(user.id, 'active'), 'تم قبول العميل ✅')} />
              <Btn small variant="danger" icon="close" title="رفض" style={{ flex: 1 }} onPress={() => done(setUserStatus(user.id, 'rejected'), 'تم رفض الطلب', 'info')} />
            </View>
          </Card>
        )}
        <Btn variant={suspended ? 'green' : 'danger'} icon={suspended ? 'play' : 'ban'} title={suspended ? 'إعادة تفعيل الحساب' : 'إيقاف الحساب'} onPress={toggleSuspend} />
        <Btn variant="danger" icon="trash" title="حذف العميل نهائياً" onPress={() => confirmDialog({
          title: 'حذف العميل نهائياً؟',
          message: `سيتم حذف "${user.name}" وجميع طلباته وحجوزاته وفواتيره ومحادثاته. ولو سجّل بنفس الرقم مرة أخرى فلن يدخل إلا بموافقتك. لا يمكن التراجع.`,
          danger: true, confirmText: 'حذف نهائي',
          onConfirm: () => { navigation.goBack(); setTimeout(() => { done(adminDeleteCustomer(user.id), 'تم حذف العميل'); }, 150); },
        })} />

        <SectionTitle title="طلبات العميل" />
        {orders.length === 0 ? <T size={13} color={C.sub}>لا توجد طلبات.</T> : orders.slice(0, 15).map((o) => (
          <OrderCard key={o.id} o={o} perspective="admin" onPress={() => navigation.navigate('OrderDetail', { id: o.id })} />
        ))}
      </ScrollView>
    </View>
  );
}


/* ---------------- Supervisors: staff accounts that run the orders of their own areas ---------------- */
function RegionChecks({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { db } = useStore();
  const list = db.regions.filter((r) => r.active);
  return (
    <View style={{ gap: 6 }}>
      <T w="semi" size={13} color={C.dark3}>المناطق التي يديرها</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {list.map((r) => <Chip key={r.id} label={r.name} active={value.includes(r.id)} onPress={() => onChange(value.includes(r.id) ? value.filter((x) => x !== r.id) : [...value, r.id])} />)}
      </View>
      {list.length === 0 && <T size={12} color={C.sub}>أضف مناطق أولاً من الإعدادات.</T>}
    </View>
  );
}

export function AdminSupportScreen({ navigation }: any) {
  return <SupportInbox onBack={() => navigation.goBack()} />;
}

export function AdminSupervisorsScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const list = db.users.filter((u) => u.role === 'supervisor');
  const [sheet, setSheet] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pw, setPw] = useState('');
  const [regions, setRegions] = useState<string[]>([]);
  const [newPw, setNewPw] = useState('');
  const [busy, setBusy] = useState(false);
  const editing = editId ? list.find((u) => u.id === editId) : undefined;
  const [supOn, setSupOn] = useState<Record<string, boolean>>({});
  const chatOn = editing ? (editing.id in supOn ? supOn[editing.id] : !!editing.supportChat) : false;
  const setChat = async (v: boolean) => {
    if (!editing) return;
    setSupOn((p) => ({ ...p, [editing.id]: v }));
    try { await apiSupervisorSupport(editing.id, v); toast(v ? 'تم السماح بشات الدعم' : 'تم إلغاء شات الدعم عن المشرف'); } catch (e: any) { setSupOn((p) => ({ ...p, [editing.id]: !v })); toast(e?.message || 'تعذر الحفظ', 'err'); }
  };
  const openNew = () => { setEditId(null); setName(''); setPhone(''); setPw(''); setRegions([]); setSheet(true); };
  const openEdit = (u: typeof list[number]) => { setEditId(u.id); setName(u.name); setRegions(u.supRegions || []); setNewPw(''); setSheet(true); };
  const regionNames = (ids?: string[]) => (ids || []).map((id) => db.regions.find((r) => r.id === id)?.name).filter(Boolean).join('، ');
  const save = async () => {
    setBusy(true);
    const r = editing ? await updateSupervisor(editing.id, { name: name.trim(), regionIds: regions }) : await createSupervisor({ name: name.trim(), phone: phone.trim(), password: pw, regionIds: regions });
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    setSheet(false);
    toast(editing ? 'تم حفظ التعديل' : 'تم إضافة المشرف ✅');
  };
  const savePw = async () => {
    if (!editing) return;
    setBusy(true);
    const r = await adminResetPassword(editing.id, newPw);
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    setNewPw('');
    toast('تم تعيين كلمة المرور');
  };
  const toggle = async () => {
    if (!editing) return;
    await done(setUserStatus(editing.id, editing.status === 'suspended' ? 'active' : 'suspended'), editing.status === 'suspended' ? 'تم تفعيل الحساب' : 'تم إيقاف الحساب');
  };
  const remove = () => editing && confirmDialog({ title: 'حذف المشرف؟', message: 'سيتم إيقاف الحساب نهائياً ولن يستطيع الدخول.', danger: true, confirmText: 'حذف', onConfirm: async () => { const r = await deleteSupervisor(editing.id); if (!r.ok) return toast(r.error, 'err'); setSheet(false); toast('تم حذف المشرف'); } });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="المشرفون" subtitle={`${list.length} حساب`} onBack={() => navigation.goBack()} />
      <FlatList
        data={list}
        keyExtractor={(u) => u.id}
        refreshControl={rc}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListHeaderComponent={<Btn title="إضافة مشرف جديد" icon="person-add" onPress={openNew} />}
        ListEmptyComponent={<Empty icon="shield-checkmark" title="لا يوجد مشرفون" text="أضف مشرفاً ليدير الطلبات في مناطق تحددها له" />}
        renderItem={({ item, index }) => (
          <Appear i={index}>
            <Card onPress={() => openEdit(item)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconBubble icon="shield-checkmark" color={C.green} bg={C.greenSoft} size={46} />
              <View style={{ flex: 1, gap: 2 }}>
                <T w="bold" size={15}>{item.name}</T>
                <T size={11.5} color={C.sub}>{item.phone}</T>
                <T size={11.5} color={C.dark3}>{regionNames(item.supRegions) || 'لم تُحدد مناطق (لا يرى طلبات)'}</T>
              </View>
              <AcctPill s={item.status} />
            </Card>
          </Appear>
        )}
      />
      <Sheet visible={sheet} onClose={() => setSheet(false)} title={editing ? 'تعديل مشرف' : 'مشرف جديد'}>
        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 12 }}>
          <Field label="الاسم" icon="person" value={name} onChangeText={setName} />
          {!editing && <Field label="رقم الموبايل (للدخول)" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />}
          {!editing && <Field label="كلمة المرور (8 أحرف على الأقل)" icon="key" value={pw} onChangeText={setPw} secureTextEntry autoCapitalize="none" />}
          {editing && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.goldSoft, borderRadius: 14, padding: 12 }}>
              <View style={{ flex: 1 }}>
                <T w="bold" size={13.5}>شات الدعم</T>
                <T size={11.5} color={C.dark3}>{chatOn ? 'يرى رسائل الدعم ويرد عليها' : 'مغلق: لا يظهر له شات الدعم'}</T>
              </View>
              <Toggle value={chatOn} onValueChange={setChat} />
            </View>
          )}
          <RegionChecks value={regions} onChange={setRegions} />
          <Btn title="حفظ" icon="checkmark" loading={busy} disabled={name.trim().length < 3 || (!editing && (!/^01[0-9]{9}$/.test(phone.trim()) || pw.length < 8))} onPress={save} />
          {editing && (
            <>
              <View style={{ height: 1, backgroundColor: C.line }} />
              <Field label="كلمة مرور جديدة" icon="key" value={newPw} onChangeText={setNewPw} secureTextEntry autoCapitalize="none" />
              <Btn variant="outline" title="تعيين كلمة المرور" disabled={busy || newPw.length < 8} onPress={savePw} />
              <Btn variant={editing.status === 'suspended' ? 'green' : 'danger'} icon={editing.status === 'suspended' ? 'play' : 'ban'} title={editing.status === 'suspended' ? 'إعادة تفعيل' : 'إيقاف الحساب'} onPress={toggle} />
              <Btn variant="ghost" icon="trash" title="حذف المشرف" onPress={remove} />
            </>
          )}
        </ScrollView>
      </Sheet>
    </View>
  );
}

/* ---------------- Supervisor: the orders of his areas ---------------- */
export function SupervisorOrdersScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const me = useMe()!;
  const [f, setF] = useState('stuck');
  const ACTIVE = ['pending', 'quoted', 'accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'];
  // orders run by themselves; these are the ones a shop left unanswered or refused (or he already took over)
  const stuck = (o: typeof db.orders[number]) => inStaffQueue(o);
  const chips = [
    { k: 'stuck', l: 'تحتاج تدخل', n: db.orders.filter(stuck).length },
    { k: 'active', l: 'جارية', n: db.orders.filter((o) => ACTIVE.includes(o.status)).length },
    { k: 'delivered', l: 'مكتملة', n: 0 },
    { k: 'dead', l: 'ملغية', n: 0 },
  ];
  const orders = db.orders.filter((o) => (f === 'stuck' ? stuck(o) : f === 'active' ? ACTIVE.includes(o.status) : f === 'dead' ? ['rejected', 'cancelled', 'unavailable'].includes(o.status) : o.status === 'delivered')).sort((a, b) => b.createdAt - a.createdAt);
  const areas = (me.supRegions || []).map((id) => db.regions.find((r) => r.id === id)?.name).filter(Boolean).join('، ');
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="طلبات مناطقي" subtitle={areas || 'لم يتم تحديد مناطق لك بعد'} />
      <View style={{ padding: 16, paddingBottom: 6 }}>
        <FlatList horizontal data={chips} keyExtractor={(x) => x.k} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} renderItem={({ item }) => <Chip label={item.n ? `${item.l} (${item.n})` : item.l} active={f === item.k} onPress={() => setF(item.k)} />} />
      </View>
      <FlatList data={orders} keyExtractor={(o) => o.id} refreshControl={rc} contentContainerStyle={{ padding: 16, gap: 12 }} ListEmptyComponent={<Empty icon="receipt" title="لا توجد طلبات" text={areas ? undefined : 'تواصل مع المالك ليحدد لك المناطق'} />}
        renderItem={({ item, index }) => <Appear i={index}><OrderCard o={item} perspective="admin" onPress={() => navigation.navigate('OrderDetail', { id: item.id })} /></Appear>} />
    </View>
  );
}
