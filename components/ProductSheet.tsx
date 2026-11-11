import React, { useEffect, useState } from 'react';
import { View, Image, ScrollView, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Sheet, Icon } from './ui';
import { OfferBadge } from './Offers';
import { HeartButton } from './Favorites';
import { productImageUrl } from '../lib/api';
import { cartAdd } from '../lib/store';
import { money } from '../lib/format';
import type { Product } from '../lib/types';

/** Full product view: big picture, the whole description, a quantity and one "add to cart" button. */
export function ProductSheet({ p, inCart, canOrder, bg, onClose }: { p: Product | null; inCart: number; canOrder: boolean; bg: string; onClose: () => void }) {
  const [n, setN] = useState(1);
  useEffect(() => { setN(1); }, [p?.id]);
  if (!p) return null;
  const uri = productImageUrl(p);
  return (
    <Sheet visible={!!p} onClose={onClose} title={p.name}>
      <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ gap: 12 }}>
        <View style={{ height: 220, borderRadius: 18, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {uri ? <Image source={{ uri }} style={{ width: '100%', height: 220 }} resizeMode="cover" /> : <T size={90}>{p.emoji}</T>}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T w="black" size={20} color={p.oldPrice ? C.red : C.goldDeep}>{money(p.price)}</T>
          {!!p.oldPrice && <T size={13} color={C.sub} style={{ textDecorationLine: 'line-through' }}>{money(p.oldPrice)}</T>}
          <View style={{ flex: 1 }} /><HeartButton kind="product" id={p.id} />
        </View>
        <OfferBadge p={p} />
        {!!p.desc && <T size={14} color={C.dark3} style={{ lineHeight: 24 }}>{p.desc}</T>}
        {inCart > 0 && <T size={12} color={C.sub}>في سلتك الآن: {inCart}</T>}
      </ScrollView>
      {canOrder && p.available ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.greenSoft, borderRadius: 16, padding: 4 }}>
            <Pressable onPress={() => setN((x) => Math.min(99, x + 1))} style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={20} color="#fff" /></Pressable>
            <T w="black" size={17} style={{ minWidth: 24 }} align="center">{n}</T>
            <Pressable onPress={() => setN((x) => Math.max(1, x - 1))} style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}><Icon name="remove" size={20} color={C.green} /></Pressable>
          </View>
          <Btn style={{ flex: 1 }} icon="cart" title={`أضف للسلة • ${money(p.price * n)}`} onPress={() => { cartAdd(p.id, n); onClose(); }} />
        </View>
      ) : (
        <T size={13} color={C.red} w="bold" align="center" style={{ marginTop: 12 }}>{p.available ? 'الطلب غير متاح حالياً' : 'غير متوفر'}</T>
      )}
    </Sheet>
  );
}
