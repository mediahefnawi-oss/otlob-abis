import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { C } from '../lib/theme';
import { T, Icon, toast } from './ui';
import { ProviderLogo } from './Brand';
import { useStore, useMe } from '../lib/store';
import { apiFavorites, apiFavoriteSet } from '../lib/api';

type Fav = { providers: string[]; products: string[] };
let cache: Fav | null = null;
let cacheUser = '';
const subs = new Set<(f: Fav | null) => void>();
const publish = (f: Fav | null) => { cache = f; subs.forEach((s) => s(f)); };
let loading = false;
async function ensure(user: string) {
  if (cacheUser !== user) { cacheUser = user; cache = null; subs.forEach((x) => x(null)); }
  if (cache || loading) return;
  loading = true;
  try { const r = await apiFavorites(); publish(r.enabled ? { providers: r.providers, products: r.products } : { providers: [], products: [] }); } catch { /* try again next time */ } finally { loading = false; }
}
/** The customer's hearts; null until loaded or when the switch is off. */
function useFav(): Fav | null {
  const { db } = useStore();
  const me = useMe();
  const on = !!db.settings.features?.favorites && me?.role === 'customer';
  const [f, setF] = useState<Fav | null>(cache);
  useEffect(() => { if (!on || !me) return; subs.add(setF); ensure(me.id); return () => { subs.delete(setF); }; }, [on, me?.id]);
  return on ? f : null;
}

/** A heart on a shop or product. Hidden unless the owner switched favorites on. */
export function HeartButton({ kind, id, light }: { kind: 'provider' | 'product'; id: string; light?: boolean }) {
  const f = useFav();
  if (!f) return null;
  const list = kind === 'provider' ? f.providers : f.products;
  const on = list.includes(id);
  const flip = async () => {
    const next = !on;
    const upd = (arr: string[]) => (next ? [id, ...arr] : arr.filter((x) => x !== id));
    publish({ providers: kind === 'provider' ? upd(f.providers) : f.providers, products: kind === 'product' ? upd(f.products) : f.products });
    try { await apiFavoriteSet(kind, id, next); }
    catch (e: any) { publish(f); toast(e?.message || 'تعذر الحفظ', 'err'); }
  };
  return (
    <Pressable onPress={flip} hitSlop={10} style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: light ? 'rgba(255,255,255,0.14)' : C.line }}>
      <Icon name={on ? 'heart' : 'heart-outline'} size={21} color={on ? C.red : light ? '#fff' : C.sub} />
    </Pressable>
  );
}

/** "أماكني المفضلة": a row of the shops the customer hearted, on the home screen. */
export function FavoritesRow() {
  const f = useFav();
  const { db } = useStore();
  const nav: any = useNavigation();
  const shops = (f?.providers || []).map((id) => db.providers.find((p) => p.id === id)).filter((p) => p && p.status === 'active') as any[];
  if (!shops.length) return null;
  return (
    <View style={{ gap: 8, marginBottom: 12 }}>
      <T w="black" size={15}>❤️ أماكني المفضلة</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
        {shops.map((p) => (
          <Pressable key={p.id} onPress={() => nav.navigate('Provider', { id: p.id })} style={{ alignItems: 'center', gap: 4, width: 74 }}>
            <ProviderLogo p={p} size={58} />
            <T size={11.5} numberOfLines={1} align="center">{p.name}</T>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
