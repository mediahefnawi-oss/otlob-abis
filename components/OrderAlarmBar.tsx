import React from 'react';
import { Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon } from './ui';
import { useStore, useMe, unopenedOrders } from '../lib/store';
import { navigationRef } from '../lib/nav';

/** Shops: stays on screen (and the alarm keeps ringing) until every new order has been opened. */
export function OrderAlarmBar() {
  const { db } = useStore();
  const me = useMe();
  const list = unopenedOrders(db, me);
  if (!list.length) return null;
  const first = [...list].sort((a, b) => b.createdAt - a.createdAt)[0];
  return (
    <Pressable
      onPress={() => { if (navigationRef.isReady()) navigationRef.navigate('OrderDetail', { id: first.id }); }}
      style={{ backgroundColor: C.red, paddingVertical: 11, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <Icon name="notifications" size={20} color="#fff" />
      <T w="black" size={13.5} color="#fff" style={{ flex: 1 }}>
        {list.length > 1 ? `لديك ${list.length} طلبات جديدة لم تفتحها` : 'لديك طلب جديد'} — اضغط لفتحه وإيقاف الصوت
      </T>
    </Pressable>
  );
}
