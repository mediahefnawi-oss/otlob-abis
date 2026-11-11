import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Toggle } from './ui';
import { useStore } from '../lib/store';
import { apiPoolSuggest } from '../lib/api';
import { money } from '../lib/format';

/** "شير اللقمة": share one delivery trip with neighbours who order from the same shop. Shown only for a single-shop cart with a delivery fee. */
export function PoolCard({ providerId, fee, disabled, value, onChange }: { providerId: string; fee: number; disabled?: boolean; value: boolean; onChange: (v: boolean) => void }) {
  const { db } = useStore();
  const on = !!db.settings.features?.pool;
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!on || !providerId) return;
    let live = true;
    apiPoolSuggest(providerId).then((r) => { if (live) setWaiting(r.waiting || 0); }).catch(() => {});
    return () => { live = false; };
  }, [on, providerId]);
  if (!on || disabled || fee <= 0) return null;
  const share = Math.ceil(fee / (waiting + 1));
  return (
    <Card style={{ gap: 10, borderWidth: value ? 2 : 0, borderColor: C.gold }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={26}>🤝</T>
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>شير اللقمة</T>
          {value && waiting > 0
            ? <T size={12} w="bold" color={C.green}>فيه جار مستني من نفس المحل ✅</T>
            : <T size={12} color={C.sub}>{value ? 'لو جارك طلب من نفس المحل خلال 10 دقايق هتتخفض رسومك وهنبلغك' : 'اشترك مع جيرانك في نفس التوصيلة ووفّر في الرسوم'}</T>}
        </View>
        <Toggle value={value} onValueChange={onChange} />
      </View>
      {value && waiting > 0 && (
        <View style={{ backgroundColor: C.goldSoft, borderRadius: 12, padding: 10, gap: 2 }}>
          <T size={13}>رسوم توصيلك هتبقى <T w="black" size={13}>{money(share)}</T> بدل {money(fee)} 🎉</T>
          <T size={11} color={C.sub}>بنستنى لحد 10 دقايق، وأقصى حاجة 3 طلبات. مش هنظهر اسمك لحد.</T>
        </View>
      )}
    </Card>
  );
}
