import React, { useCallback, useEffect, useState } from 'react';
import { View, Platform } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, toast } from './ui';
import { useMe } from '../lib/store';
import { getPosition, startCourierTracking, locationPermission, openLocationSettings } from '../lib/location';
import { lastPingAt, subscribePing, LocPerm } from '../lib/locState';
import { fmtTime } from '../lib/format';

/** Courier home: is my position visible to customers, and a button to switch the location on (the phone / browser asks only when it is pressed). */
export function CourierLocationCard({ working }: { working: boolean }) {
  const me = useMe();
  const [perm, setPerm] = useState<LocPerm>('prompt');
  const [last, setLast] = useState(lastPingAt());
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => { locationPermission().then(setPerm).catch(() => {}); }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => subscribePing(() => setLast(lastPingAt())), []);
  if (!me || me.role !== 'courier') return null;
  const granted = perm === 'granted';
  const visible = granted && working && last > 0 && Date.now() - last < 120000;
  const enable = async () => {
    setBusy(true);
    try {
      await getPosition();               // this is the user's tap: the browser / phone shows its question now
      await startCourierTracking();
      toast('تم تفعيل الموقع 📍');
    } catch (e: any) {
      toast(e && e.message ? e.message : 'تعذر تفعيل الموقع', 'err');
    } finally { setBusy(false); refresh(); }
  };
  const status = !granted ? 'موقعك مش ظاهر للعملاء' : !working ? 'الموقع مفعّل — بيظهر لما تكون متاح أو معاك طلب' : visible ? `موقعك ظاهر للعملاء • آخر تحديث ${fmtTime(last)}` : 'الموقع مفعّل — بنستنى أول تحديث';
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Icon name="location" size={26} color={visible ? C.green : C.goldDeep} />
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>موقعي</T>
          <T size={12.5} color={visible ? C.green : C.sub}>{status}</T>
        </View>
      </View>
      {!granted && <Btn title={perm === 'denied' && Platform.OS !== 'web' ? 'فتح إعدادات الموقع' : 'تفعيل الموقع'} icon="location" loading={busy} onPress={perm === 'denied' && Platform.OS !== 'web' ? openLocationSettings : enable} />}
      {perm === 'denied' && Platform.OS === 'web' && <T size={11.5} color={C.sub}>الموقع مقفول: اضغط على أيقونة القفل 🔒 جنب عنوان الموقع ← الأذونات ← الموقع ← سماح، وبعدها حدّث الصفحة.</T>}
      <T size={11} color={C.sub}>موقعك بيظهر للعميل صاحب الطلب ولإدارة التطبيق وأنت متاح أو معاك طلب فقط.</T>
    </Card>
  );
}
