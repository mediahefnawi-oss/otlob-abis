import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Image, Pressable, ScrollView, Modal, useWindowDimensions } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Icon, toast, confirmDialog } from './ui';
import { PhotoViewer } from './Quote';
import { apiMenuList, apiMenuAdd, apiMenuDelete, menuImageUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';

/** The shop's picture menu: a banner as wide as the ads board, swipe left / right between pages, tap to read a page full screen. */
export function MenuGallery({ providerId, count }: { providerId: string; count?: number }) {
  const [ids, setIds] = useState<string[]>([]);
  const [w, setW] = useState(0);
  const [i, setI] = useState(0);
  const [full, setFull] = useState<number | null>(null);
  useEffect(() => { apiMenuList(providerId).then((r) => setIds(r.images)).catch(() => {}); }, [providerId, count]);
  if (!ids.length) return null;
  const h = Math.max(120, Math.round(w * 0.42));
  return (
    <View style={{ marginHorizontal: 16, marginTop: 14 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <T w="black" size={15} style={{ marginBottom: 8 }}>📄 المنيو</T>
      {w > 0 && (
        <View style={{ height: h, borderRadius: 20, overflow: 'hidden', backgroundColor: C.line }}>
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={(e) => setI(Math.round(Math.abs(e.nativeEvent.contentOffset.x) / w))}>
            {ids.map((id, k) => (
              <Pressable key={id} onPress={() => setFull(k)} style={{ width: w, height: h }}>
                <Image source={{ uri: menuImageUrl(id) }} style={{ width: w, height: h }} resizeMode="cover" />
              </Pressable>
            ))}
          </ScrollView>
          <View pointerEvents="none" style={{ position: 'absolute', top: 10, left: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 2 }}>
            <T size={11} color="#fff">{Math.min(i, ids.length - 1) + 1} / {ids.length}</T>
          </View>
          <View pointerEvents="none" style={{ position: 'absolute', bottom: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 2 }}>
            <T size={10.5} color="#fff">🔍 اضغط لعرض الصفحة كاملة</T>
          </View>
        </View>
      )}
      {ids.length > 1 && (
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 8 }}>
          {ids.map((id, k) => <View key={id} style={{ width: k === i ? 18 : 7, height: 7, borderRadius: 4, backgroundColor: k === i ? C.gold : C.line }} />)}
        </View>
      )}
      <T size={11.5} color={C.sub} align="center" style={{ marginTop: 6 }}>اسحب يمين أو شمال لباقي الصفحات، واضغط على الصفحة لعرضها كاملة</T>
      <MenuViewer ids={ids} start={full ?? 0} visible={full !== null} onClose={() => setFull(null)} />
    </View>
  );
}

/** Full-screen pages: swipe between them; "تكبير" opens the zoomable viewer for the page on screen. */
function MenuViewer({ ids, start, visible, onClose }: { ids: string[]; start: number; visible: boolean; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const [cur, setCur] = useState(start);
  const [zoom, setZoom] = useState('');
  const ref = useRef<ScrollView>(null);
  useEffect(() => { if (visible) { setCur(start); setTimeout(() => ref.current?.scrollTo({ x: start * width, animated: false }), 30); } }, [visible, start, width]);
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <ScrollView ref={ref} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={(e) => setCur(Math.round(Math.abs(e.nativeEvent.contentOffset.x) / width))} style={{ flex: 1 }}>
          {ids.map((id) => (
            <View key={id} style={{ width, height, justifyContent: 'center' }}>
              <Image source={{ uri: menuImageUrl(id) }} style={{ width, height: height - 140 }} resizeMode="contain" />
            </View>
          ))}
        </ScrollView>
        <View style={{ position: 'absolute', top: 44, left: 0, right: 0, alignItems: 'center' }} pointerEvents="none"><T size={13} color="#fff">{cur + 1} / {ids.length}</T></View>
        <Pressable onPress={onClose} hitSlop={12} style={{ position: 'absolute', top: 38, right: 18, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={22} color="#fff" /></Pressable>
        <View style={{ position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center', gap: 8 }}>
          <T size={12} color="#ffffffcc">اسحب يمين أو شمال للصفحة اللي بعدها</T>
          <Pressable onPress={() => setZoom(ids[cur])} style={{ backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 18, paddingHorizontal: 18, paddingVertical: 8 }}><T w="bold" size={13} color="#fff">🔍 تكبير الصفحة</T></Pressable>
        </View>
        <PhotoViewer uri={zoom ? menuImageUrl(zoom) : ''} visible={!!zoom} onClose={() => setZoom('')} />
      </View>
    </Modal>
  );
}

/** The shop (or the owner) adds and removes menu pages. */
export function MenuManager({ providerId }: { providerId: string }) {
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiMenuList(providerId).then((r) => setIds(r.images)).catch(() => {}); }, [providerId]);
  useEffect(load, [load]);
  const add = async () => {
    if (!canPickImage) return toast('رفع الصور غير متاح هنا', 'info');
    const img = await pickImage(1400);
    if (!img) return toast('تعذر تحميل الصورة، جرّب صورة أخرى', 'err');
    setBusy(true);
    try { await apiMenuAdd(providerId, img); load(); toast('تمت إضافة الصفحة ✅'); }
    catch (e: any) { toast(e?.message || 'تعذر الرفع', 'err'); }
    finally { setBusy(false); }
  };
  const del = (id: string) => confirmDialog({ title: 'حذف الصفحة؟', message: 'ستختفي من المنيو', danger: true, confirmText: 'حذف', onConfirm: async () => {
    try { await apiMenuDelete(id); load(); } catch (e: any) { toast(e?.message || 'تعذر الحذف', 'err'); }
  } });
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>📄 صور المنيو ({ids.length}/8)</T>
      <T size={12} color={C.sub}>ارفع صور المنيو أو قايمة الأسعار بوضوح. العميل يشوفها ويكتب طلبه.</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
        {ids.map((id) => (
          <View key={id}>
            <Image source={{ uri: menuImageUrl(id) }} style={{ width: 110, height: 150, borderRadius: 12, backgroundColor: C.line }} resizeMode="cover" />
            <Pressable onPress={() => del(id)} style={{ position: 'absolute', top: 4, left: 4, backgroundColor: '#000a', borderRadius: 12, padding: 5 }}><Icon name="trash" size={14} color="#fff" /></Pressable>
          </View>
        ))}
      </ScrollView>
      {ids.length < 8 && <Btn small variant="soft" icon="camera" title="إضافة صفحة" loading={busy} onPress={add} />}
    </Card>
  );
}
