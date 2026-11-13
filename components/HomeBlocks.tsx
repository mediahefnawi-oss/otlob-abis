import React, { useEffect, useState } from 'react';
import { View, ScrollView, Pressable, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { C, shadow } from '../lib/theme';
import { T, Icon, Card, Chip, Btn, Field, Sheet, SectionTitle, Toggle, toast, confirmDialog } from './ui';
import { ProviderLogo } from './Brand';
import { AreaTag } from './Cards';
import { ShopOfferTag } from './Offers';
import { RatingLine, useRatingStars } from './Stars';
import { openAdLink } from './Ads';
import { useStore, saveHomeBlocks, setBlockImage } from '../lib/store';
import { homeBlockImageUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';
import { HomeBlock } from '../lib/types';

/**
 * The owner's blocks in the new home (switch "homeBlocks"), in the order he arranged them:
 * a list of shops he picked by hand, or a banner (a picture with an optional link to a shop, a product or a web page).
 */
export function HomeBlocksView({ navigation, tw }: { navigation: any; tw: number }) {
  const { db } = useStore();
  const stars = useRatingStars();
  const blocks = (db.settings.homeBlocks || []).filter((b) => b.active);
  return (
    <>
      {blocks.map((b) => {
        if (b.type === 'banner') {
          const uri = homeBlockImageUrl(b);
          return (
            <Pressable key={b.id} disabled={!b.link} onPress={() => openAdLink(b.link, db, navigation)} style={{ marginTop: 14 }}>
              {uri ? (
                <Image source={{ uri }} style={{ width: '100%', aspectRatio: 2.2, borderRadius: 20 }} resizeMode="cover" />
              ) : (
                <LinearGradient colors={['#F8CB4B', '#F2B51D']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 20, minHeight: 84, padding: 16, justifyContent: 'center', ...shadow }}>
                  <T w="black" size={17} color={C.dark}>{b.title}</T>
                </LinearGradient>
              )}
            </Pressable>
          );
        }
        const shops = b.providerIds.map((id) => db.providers.find((p) => p.id === id && p.status === 'active')).filter(Boolean) as typeof db.providers;
        if (!shops.length) return null;
        return (
          <View key={b.id} style={{ marginTop: 14 }}>
            <SectionTitle title={b.title} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 4 }}>
              {shops.map((item) => (
                <Card key={item.id} onPress={() => navigation.navigate('Provider', { id: item.id })} style={{ width: tw, paddingHorizontal: 9, paddingTop: 10, paddingBottom: 8, alignItems: 'center', gap: 4 }}>
                  <ProviderLogo p={item} size={tw - 18} />
                  <T w="bold" size={11.5} align="center" numberOfLines={2}>{item.name}</T>
                  {stars ? <RatingLine p={item} size={10.5} /> : null}
                  <AreaTag p={item} />
                  <ShopOfferTag providerId={item.id} compact />
                </Card>
              ))}
            </ScrollView>
          </View>
        );
      })}
    </>
  );
}

const newId = () => Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

/** Owner: arrange the blocks (add, move up/down, edit, switch off, delete) and save them with one button. */
export function BlocksManager() {
  const { db } = useStore();
  const saved = db.settings.homeBlocks || [];
  const [list, setList] = useState<HomeBlock[]>(saved);
  const [dirty, setDirty] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!dirty) setList(db.settings.homeBlocks || []); }, [db.settings.homeBlocks]);
  const change = (next: HomeBlock[]) => { setList(next); setDirty(true); };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= list.length) return; const n = [...list]; [n[i], n[j]] = [n[j], n[i]]; change(n); };
  const patch = (id: string, p: Partial<HomeBlock>) => change(list.map((b) => (b.id === id ? { ...b, ...p } : b)));
  const add = (type: 'list' | 'banner') => { const b: HomeBlock = { id: newId(), type, title: type === 'list' ? 'قايمة جديدة' : 'لوحة إعلانية', providerIds: [], link: '', active: true, imgV: 0 }; change([...list, b]); setEdit(b.id); };
  const remove = (id: string) => confirmDialog({ title: 'مسح الكتلة؟', message: 'هتتمسح من الرئيسية بعد ما تضغط حفظ.', danger: true, confirmText: 'مسح', onConfirm: () => change(list.filter((b) => b.id !== id)) });
  const save = async () => {
    setBusy(true); const r = await saveHomeBlocks(list); setBusy(false);
    if (r.ok) { setDirty(false); toast('تم حفظ الترتيب ✅'); } else toast(r.error, 'err');
    return r.ok;
  };
  const cur = list.find((b) => b.id === edit) || null;
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>ترتيب الرئيسية (قوائم ولوحات)</T>
      <T size={12} color={C.sub}>بتظهر في الرئيسية الجديدة بالترتيب ده لما تشغّل «قوائم ولوحات إعلانية». بعد أي تعديل اضغط حفظ.</T>
      {list.length === 0 && <T size={12} color={C.sub}>لسه مفيش كتل.</T>}
      {list.map((b, i) => (
        <View key={b.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.2, borderColor: C.line, borderRadius: 14, padding: 8, opacity: b.active ? 1 : 0.55 }}>
          <View style={{ width: 6, alignSelf: 'stretch', borderRadius: 3, backgroundColor: b.type === 'banner' ? C.gold : '#0E5A33' }} />
          <Pressable onPress={() => setEdit(b.id)} style={{ flex: 1, gap: 1 }}>
            <T w="bold" size={13}>{b.type === 'banner' ? 'لوحة' : 'قايمة'}: {b.title || '—'}</T>
            <T size={11} color={C.sub}>{b.type === 'banner' ? (b.imgV ? 'بصورة' : 'بدون صورة') + (b.link ? ' + رابط' : '') : `${b.providerIds.length} محلات`}{b.active ? '' : ' • مقفولة'}</T>
          </Pressable>
          <Pressable onPress={() => move(i, -1)} hitSlop={6}><Icon name="chevron-up" size={20} color={C.goldDeep} /></Pressable>
          <Pressable onPress={() => move(i, 1)} hitSlop={6}><Icon name="chevron-down" size={20} color={C.goldDeep} /></Pressable>
          <Pressable onPress={() => setEdit(b.id)} hitSlop={6}><Icon name="create" size={19} color={C.goldDeep} /></Pressable>
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small variant="soft" icon="add" title="قايمة جديدة" onPress={() => add('list')} style={{ flex: 1 }} />
        <Btn small variant="soft" icon="image" title="لوحة إعلانية" onPress={() => add('banner')} style={{ flex: 1 }} />
      </View>
      {dirty && <Btn title="حفظ الترتيب" icon="checkmark" loading={busy} onPress={save} />}
      <BlockSheet b={cur} onClose={() => setEdit(null)} patch={patch} remove={remove} saveNow={save} />
    </Card>
  );
}

function BlockSheet({ b, onClose, patch, remove, saveNow }: { b: HomeBlock | null; onClose: () => void; patch: (id: string, p: Partial<HomeBlock>) => void; remove: (id: string) => void; saveNow: () => Promise<boolean | undefined> }) {
  const { db } = useStore();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  if (!b) return null;
  const shops = db.providers.filter((p) => p.status === 'active' && (!q.trim() || p.name.includes(q.trim())));
  const flip = (id: string) => patch(b.id, { providerIds: b.providerIds.includes(id) ? b.providerIds.filter((x) => x !== id) : [...b.providerIds, id].slice(0, 20) });
  const uploadImg = async () => {
    const img = await pickImage(1400);
    if (!img) return toast('تعذر قراءة الصورة، جرّب صورة أخرى', 'err');
    setBusy(true);
    const ok = await saveNow(); // the picture belongs to a saved block
    const r = ok ? await setBlockImage(b.id, img) : { ok: false, error: 'احفظ الترتيب الأول' };
    setBusy(false);
    toast(r.ok ? 'تم حفظ الصورة' : (r as any).error, r.ok ? 'ok' : 'err');
  };
  return (
    <Sheet visible onClose={onClose} title={b.type === 'banner' ? 'تعديل لوحة إعلانية' : 'تعديل قايمة'}>
      <Field label="الاسم" icon="text" value={b.title} onChangeText={(v) => patch(b.id, { title: v })} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T w="bold" size={13} style={{ flex: 1 }}>ظاهرة في الرئيسية</T>
        <Toggle value={b.active} onValueChange={(v) => patch(b.id, { active: v })} />
      </View>
      {b.type === 'list' ? (
        <View style={{ gap: 8 }}>
          <T w="bold" size={13}>المحلات ({b.providerIds.length}/20) — اضغط للاختيار</T>
          <Field label="بحث بالاسم" icon="search" value={q} onChangeText={setQ} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {shops.slice(0, 80).map((p) => <Chip key={p.id} label={p.name} active={b.providerIds.includes(p.id)} onPress={() => flip(p.id)} />)}
          </View>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {b.imgV > 0 && <Image source={{ uri: homeBlockImageUrl(b) }} style={{ width: '100%', aspectRatio: 2.2, borderRadius: 14 }} resizeMode="cover" />}
          {canPickImage ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn small variant="soft" icon="image" title={b.imgV > 0 ? 'تغيير الصورة' : 'رفع صورة'} loading={busy} onPress={uploadImg} style={{ flex: 1 }} />
              {b.imgV > 0 && <Btn small variant="danger" icon="trash" title="" onPress={async () => { const r = await setBlockImage(b.id, null); toast(r.ok ? 'تم حذف الصورة' : (r as any).error, r.ok ? 'ok' : 'err'); }} />}
            </View>
          ) : <T size={12} color={C.red}>رفع الصور بيتم من الموقع otlobabis.com.</T>}
          <T size={11.5} color={C.sub}>الصورة الأفضل عريضة (نسبة ٢٫٢ : ١). لو من غير صورة بتظهر لوحة صفراء بالاسم.</T>
          <Field label="رابط عند الضغط (اختياري)" icon="link" value={b.link.startsWith('app:') ? '' : b.link} onChangeText={(v) => patch(b.id, { link: v })} placeholder="https://..." />
          <T w="bold" size={12.5}>أو يفتح محل:</T>
          <Field label="بحث بالاسم" icon="search" value={q} onChangeText={setQ} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {shops.slice(0, 40).map((p) => <Chip key={p.id} label={p.name} active={b.link === `app:provider:${p.id}`} onPress={() => patch(b.id, { link: b.link === `app:provider:${p.id}` ? '' : `app:provider:${p.id}` })} />)}
          </View>
          {b.link.startsWith('app:') && <T size={11.5} color={C.green}>اللوحة هتفتح المحل المختار (محتاجة ميزة «ربط الإعلان بمحل» شغّالة).</T>}
        </View>
      )}
      <Btn title="تم" onPress={onClose} />
      <Btn title="مسح الكتلة" variant="danger" icon="trash" onPress={() => { onClose(); remove(b.id); }} />
    </Sheet>
  );
}
