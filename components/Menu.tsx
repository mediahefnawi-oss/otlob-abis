import React, { useCallback, useEffect, useState } from 'react';
import { View, Image, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Icon, toast, confirmDialog } from './ui';
import { PhotoViewer } from './Quote';
import { apiMenuList, apiMenuAdd, apiMenuDelete, menuImageUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';

/** The shop's picture menu as the customer sees it: tap a page to read it big. */
export function MenuGallery({ providerId, count }: { providerId: string; count?: number }) {
  const [ids, setIds] = useState<string[]>([]);
  const [open, setOpen] = useState('');
  useEffect(() => { apiMenuList(providerId).then((r) => setIds(r.images)).catch(() => {}); }, [providerId, count]);
  if (!ids.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <T w="black" size={15}>📄 المنيو</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
        {ids.map((id) => (
          <Pressable key={id} onPress={() => setOpen(id)}>
            <Image source={{ uri: menuImageUrl(id) }} style={{ width: 210, height: 280, borderRadius: 16, backgroundColor: C.line }} resizeMode="cover" />
          </Pressable>
        ))}
      </ScrollView>
      <T size={11.5} color={C.sub}>اضغط على الصفحة لتكبيرها، ثم اكتب طلبك في الأسفل</T>
      <PhotoViewer uri={open ? menuImageUrl(open) : ''} visible={!!open} onClose={() => setOpen('')} />
    </View>
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
