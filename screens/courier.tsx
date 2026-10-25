import React, { useEffect, useState } from 'react';
import { View, FlatList, ScrollView, Pressable } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { C, shadow } from '../lib/theme';
import { T, Icon, Card, Btn, Header, Empty, Segmented, Appear, Stat, confirmDialog, toast, SectionTitle } from '../components/ui';
import { OrderCard } from '../components/Cards';
import { useRC } from './customer';
import { ProfileScreen } from './shared';
import { useStore, useMe, setAvailable, orderAction, updateProfile } from '../lib/store';
import { Order } from '../lib/types';
import { RegionPicker } from '../components/Regions';
import { money, isToday, fmtTime } from '../lib/format';

/** Lets the home screen open the orders page on a chosen list (offers / mine / done). */
const segBus = {
  seg: 'offers' as 'offers' | 'mine' | 'done',
  listeners: new Set<(s: 'offers' | 'mine' | 'done') => void>(),
  set(s: 'offers' | 'mine' | 'done') { this.seg = s; this.listeners.forEach((l) => l(s)); },
};
const LIVE = ['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'];
const PAGE = 15;

function useCourierLists() {
  const { db } = useStore();
  const me = useMe()!;
  const offers = db.orders.filter((o) => !o.courierId && ['pending', 'accepted', 'ready'].includes(o.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const mine = db.orders.filter((o) => o.courierId === me.id && LIVE.includes(o.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const done = db.orders.filter((o) => o.courierId === me.id && o.status === 'delivered').sort((a, b) => b.updatedAt - a.updatedAt);
  return { me, offers, mine, done };
}

/** Home: availability, today's numbers, current area, and shortcuts to the orders page. */
export function CourierWorkScreen({ go }: any) {
  const { me, offers, mine, done } = useCourierLists();
  const doneToday = done.filter((o) => isToday(o.updatedAt));
  const earn = doneToday.reduce((s, o) => s + o.deliveryFee, 0);
  const on = !!me.available;

  const toggle = () => {
    if (on && mine.length > 0) return toast('أكمل طلباتك الحالية قبل إيقاف الاستقبال', 'err');
    setAvailable(me.id, !on);
    toast(!on ? 'أنت الآن متاح لاستقبال الطلبات 🟢' : 'تم إيقاف استقبال الطلبات');
  };
  const open = (seg: 'offers' | 'mine') => { segBus.set(seg); go?.('orders'); };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ paddingBottom: 24 }}>
      <Header title="لوحة المندوب" subtitle={`أهلاً ${me.name}`}>
        <Pressable onPress={toggle} style={{ marginTop: 14 }}>
          <LinearGradient colors={on ? ['#16A163', '#0E7A4F'] : ['#3A4C46', '#2A3A35']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 22, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="power" size={28} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <T w="black" size={18} color="#fff">{on ? 'أنت متاح للعمل' : 'أنت غير متاح'}</T>
              <T size={12} color="rgba(255,255,255,0.8)">{on ? `منذ ${fmtTime(me.availableSince || Date.now())} • اضغط للإيقاف` : 'اضغط لتفعيل استقبال الطلبات'}</T>
            </View>
            <View style={{ width: 52, height: 30, borderRadius: 15, backgroundColor: on ? C.gold : 'rgba(255,255,255,0.25)', padding: 3, alignItems: on ? 'flex-start' : 'flex-end' }}>
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff' }} />
            </View>
          </LinearGradient>
        </Pressable>
      </Header>
      <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 12 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stat icon="cash" label="أرباح اليوم" value={money(earn)} color={C.goldDeep} soft={C.goldSoft} />
          <Stat icon="checkmark-done" label="تم تسليمها اليوم" value={doneToday.length} />
          <Stat icon="bicycle" label="جارية الآن" value={mine.length} color={C.orange} soft={C.orangeSoft} />
        </View>
        <Card style={{ gap: 8 }}>
          <RegionPicker value={me.regionId} onChange={async (id) => { const r = await updateProfile({ regionId: id }); if (!r.ok) toast(r.error, 'err'); else toast('تم تحديد منطقتك'); }} label="أنا الآن في منطقة" />
        </Card>
        <Pressable onPress={() => open('offers')}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name="radio" size={26} color={C.goldDeep} />
            <View style={{ flex: 1 }}>
              <T w="black" size={15}>طلبات متاحة الآن</T>
              <T size={12} color={C.sub}>{on ? 'اضغط لعرض الطلبات وقبولها' : 'فعّل حالتك أولاً لاستقبال الطلبات'}</T>
            </View>
            <T w="black" size={24} color={C.goldDeep}>{on ? offers.length : 0}</T>
            <Icon name="chevron-back" size={18} color={C.sub} />
          </Card>
        </Pressable>
        <Pressable onPress={() => open('mine')}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name="bicycle" size={26} color={C.orange} />
            <View style={{ flex: 1 }}>
              <T w="black" size={15}>طلباتي الحالية</T>
              <T size={12} color={C.sub}>استلام، في الطريق، وصلت، تم التسليم</T>
            </View>
            <T w="black" size={24} color={C.orange}>{mine.length}</T>
            <Icon name="chevron-back" size={18} color={C.sub} />
          </Card>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/** A full-height page for the orders: available / mine / completed, loaded 15 at a time. */
export function CourierOrdersScreen({ navigation }: any) {
  const rc = useRC();
  const { me, offers, mine, done } = useCourierLists();
  const [seg, setSeg] = useState<'offers' | 'mine' | 'done'>(segBus.seg);
  const [limit, setLimit] = useState(PAGE);
  const on = !!me.available;
  const total = done.reduce((s, o) => s + o.deliveryFee, 0);

  useEffect(() => {
    const l = (s: 'offers' | 'mine' | 'done') => { setSeg(s); setLimit(PAGE); };
    segBus.listeners.add(l);
    return () => { segBus.listeners.delete(l); };
  }, []);

  const list = seg === 'offers' ? (on ? offers : []) : seg === 'mine' ? mine : done;
  const shown = list.slice(0, limit);

  const take = (id: string) => {
    const r = orderAction(id, 'courier_accept', me);
    if (!r.ok) return toast(r.error, 'err');
    toast('تم قبول الطلب ✅');
    segBus.set('mine');
  };
  const deliver = (item: Order) => confirmDialog({
    title: 'تأكيد التسليم', message: `هل استلمت ${money(item.total)} كاش من العميل؟`, confirmText: 'تم التسليم',
    onConfirm: () => { orderAction(item.id, 'deliver', me); toast('اكتمل الطلب 💚'); },
  });

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="الطلبات" subtitle={on ? 'أنت متاح لاستقبال الطلبات' : 'أنت غير متاح حالياً'}>
        <View style={{ marginTop: 12 }}>
          <Segmented
            value={seg}
            onChange={(k: any) => { setSeg(k); setLimit(PAGE); }}
            options={[
              { key: 'offers', label: 'متاحة', count: on ? offers.length : 0 },
              { key: 'mine', label: 'طلباتي', count: mine.length },
              { key: 'done', label: 'المكتملة', count: done.length },
            ]}
          />
        </View>
      </Header>
      <FlatList
        data={shown}
        keyExtractor={(o) => o.id}
        refreshControl={rc}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        onEndReachedThreshold={0.4}
        onEndReached={() => { if (list.length > limit) setLimit((l) => l + PAGE); }}
        ListHeaderComponent={seg === 'done' && done.length > 0 ? (
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name="cash" size={24} color={C.goldDeep} />
            <View style={{ flex: 1 }}><T size={12} color={C.sub}>إجمالي أرباحك من الطلبات المكتملة</T></View>
            <T w="black" size={20} color={C.goldDeep}>{money(total)}</T>
          </Card>
        ) : null}
        ListEmptyComponent={
          seg === 'offers'
            ? (on ? <Empty icon="radio" title="لا توجد طلبات الآن" text="سيظهر هنا أي طلب جديد فور وصوله مع تنبيه صوتي، ابقَ متاحاً" /> : <Empty icon="power" title="فعّل حالتك للعمل" text="من صفحة العمل اضغط على زر التشغيل لاستقبال الطلبات" />)
            : seg === 'mine'
              ? <Empty icon="bicycle" title="لا توجد طلبات حالية" text="الطلبات التي تقبلها ستظهر هنا مع أزرار التحديث" />
              : <Empty icon="time" title="لا يوجد سجل بعد" text="ستظهر هنا الطلبات التي أتممت توصيلها" />
        }
        ListFooterComponent={list.length > limit ? <Btn variant="soft" title={`عرض المزيد (${list.length - limit})`} onPress={() => setLimit((l) => l + PAGE)} /> : null}
        renderItem={({ item, index }) => {
          const isCustom = item.providerType === 'custom';
          return (
            <Appear i={Math.min(index, 6)}>
              <OrderCard o={item} perspective="courier" onPress={() => navigation.navigate('OrderDetail', { id: item.id })}>
                {seg === 'offers' && (item.status === 'pending'
                  ? <Btn variant="soft" icon="hourglass" title="بانتظار قبول المتجر" disabled />
                  : <Btn icon="bicycle" title="قبول الطلب" onPress={() => take(item.id)} />)}
                {seg === 'mine' && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Btn small variant="dark" icon="chatbubbles" title="شات العميل" style={{ flex: 1 }} onPress={() => navigation.navigate('Chat', { orderId: item.id })} />
                    {['accepted', 'ready'].includes(item.status) && <Btn small icon="bag-handle" title={isCustom ? 'تم الشراء' : 'استلمت الطلب'} style={{ flex: 1.3 }} onPress={() => { orderAction(item.id, 'pickup', me); toast('تم تسجيل الاستلام ✅'); }} />}
                    {item.status === 'picked_up' && <Btn small icon="bicycle" title="أنا في الطريق" style={{ flex: 1.3 }} onPress={() => { orderAction(item.id, 'go', me); toast('العميل عرف إنك في الطريق 🚀'); }} />}
                    {item.status === 'on_the_way' && <Btn small variant="dark" icon="location" title="وصلت المكان" style={{ flex: 1.3 }} onPress={() => { orderAction(item.id, 'arrive', me); toast('تم إبلاغ العميل بوصولك 📍'); }} />}
                    {item.status === 'arrived' && <Btn small variant="green" icon="checkmark-done" title="تم التسليم" style={{ flex: 1.3 }} onPress={() => deliver(item)} />}
                  </View>
                )}
              </OrderCard>
            </Appear>
          );
        }}
      />
    </View>
  );
}

export function CourierHistoryScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const me = useMe()!;
  const done = db.orders.filter((o) => o.courierId === me.id && o.status === 'delivered').sort((a, b) => b.updatedAt - a.updatedAt);
  const total = done.reduce((s, o) => s + o.deliveryFee, 0);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="سجل التوصيل" subtitle="طلباتك المكتملة وأرباحك">
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 16, padding: 12 }}>
            <T size={11} color="#C9D8D2">إجمالي الأرباح</T>
            <T w="black" size={20} color={C.gold}>{money(total)}</T>
          </View>
          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 16, padding: 12 }}>
            <T size={11} color="#C9D8D2">طلبات مكتملة</T>
            <T w="black" size={20} color="#fff">{done.length}</T>
          </View>
        </View>
      </Header>
      <FlatList
        data={done}
        keyExtractor={(o) => o.id}
        refreshControl={rc}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={<Empty icon="time" title="لا يوجد سجل بعد" text="ستظهر هنا الطلبات التي أتممت توصيلها" />}
        renderItem={({ item, index }) => (
          <Appear i={index}><OrderCard o={item} perspective="courier" onPress={() => navigation.navigate('OrderDetail', { id: item.id })} /></Appear>
        )}
      />
    </View>
  );
}

export function CourierProfileScreen({ navigation }: any) {
  const me = useMe()!;
  const extra = (
    <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Icon name="bicycle" size={26} color={C.goldDeep} />
      <View style={{ flex: 1 }}>
        <T w="bold" size={14}>وسيلة التوصيل: {me.vehicle}</T>
        <T size={12} color={C.sub}>الحالة: {me.available ? 'متاح للعمل' : 'غير متاح'}</T>
      </View>
    </Card>
  );
  return <ProfileScreen navigation={navigation} extra={extra} />;
}
