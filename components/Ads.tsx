import React, { useEffect, useRef, useState } from 'react';
import { View, Image, Pressable, Linking } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Sheet, Field, SectionTitle, Toggle, toast, confirmDialog } from './ui';
import { useStore, addAd, updateAd, deleteAd } from '../lib/store';
import { adImageUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';

/** A banner that moves by itself every few seconds (tap a dot or swipe to change it, tap the picture to open its link). */
export function AdsCarousel() {
  const { db } = useStore();
  const ads = (db.ads || []).filter((a) => a.active);
  const [i, setI] = useState(0);
  const [w, setW] = useState(0);
  const touchX = useRef<number | null>(null);
  const swiped = useRef(false);

  useEffect(() => {
    if (ads.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % ads.length), 4200);
    return () => clearInterval(t);
  }, [ads.length]);
  useEffect(() => { if (i >= ads.length) setI(0); }, [ads.length, i]);

  if (!ads.length) return null;
  const ad = ads[Math.min(i, ads.length - 1)];
  const h = Math.max(110, Math.round(w * 0.42));
  const go = (d: number) => setI((x) => (x + d + ads.length) % ads.length);

  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      onTouchStart={(e) => { touchX.current = e.nativeEvent.pageX; swiped.current = false; }}
      onTouchEnd={(e) => {
        if (touchX.current === null) return;
        const dx = e.nativeEvent.pageX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 40 && ads.length > 1) { swiped.current = true; go(dx < 0 ? 1 : -1); }
      }}
      style={{ marginHorizontal: 16, marginTop: 14 }}
    >
      <Pressable
        onPress={() => { if (!swiped.current && ad.link) Linking.openURL(ad.link).catch(() => {}); }}
        style={{ height: h, borderRadius: 20, overflow: 'hidden', backgroundColor: C.line }}
      >
        <Animated.View key={ad.id} entering={FadeIn.duration(450)} style={{ flex: 1 }}>
          <Image source={{ uri: adImageUrl(ad) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        </Animated.View>
        {ads.length > 1 && (
          <View style={{ position: 'absolute', bottom: 8, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 }}>
            {ads.map((a, k) => (
              <Pressable key={a.id} onPress={() => setI(k)} hitSlop={6}>
                <View style={{ width: k === i ? 18 : 7, height: 7, borderRadius: 4, backgroundColor: k === i ? C.gold : 'rgba(255,255,255,0.7)' }} />
              </Pressable>
            ))}
          </View>
        )}
      </Pressable>
    </View>
  );
}

/** Owner only: add a picture, pause / resume it, delete it. */
export function AdsManager() {
  const { db } = useStore();
  const ads = db.ads || [];
  const [sheet, setSheet] = useState(false);
  const [title, setTitle] = useState('');
  const [link, setLink] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = () => { setTitle(''); setLink(''); setImage(null); setSheet(true); };
  const choose = async () => {
    if (!canPickImage) return toast('رفع الصور متاح من نسخة الويب', 'info');
    const img = await pickImage();
    if (img) setImage(img);
    else toast('تعذر تحميل الصورة، جرّب صورة أخرى', 'err');
  };
  const save = async () => {
    if (!image) return toast('اختر صورة الإعلان', 'err');
    setBusy(true);
    const r = await addAd(title, link, image);
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    setSheet(false);
    toast('تمت إضافة الإعلان ويظهر الآن لكل المستخدمين');
  };

  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle title={`لوحة الإعلانات (${ads.length})`} action="إضافة" onAction={open} />
      <T size={11.5} color={C.sub}>تظهر الإعلانات المفعّلة كشريط صور متحرك أعلى الصفحة الرئيسية للعملاء. المقاس المناسب: 1200×500 تقريبًا.</T>
      {ads.length === 0 && <T size={12.5} color={C.sub}>لا توجد إعلانات بعد.</T>}
      {ads.map((a) => (
        <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line }}>
          <Image source={{ uri: adImageUrl(a) }} style={{ width: 84, height: 48, borderRadius: 10, backgroundColor: C.line }} resizeMode="cover" />
          <View style={{ flex: 1 }}>
            <T w="bold" size={13.5} color={a.active ? C.text : C.sub} numberOfLines={1}>{a.title || 'إعلان بدون عنوان'}</T>
            <T size={11.5} color={a.active ? C.green : C.sub}>{a.active ? 'ظاهر للمستخدمين' : 'موقوف'}</T>
          </View>
          <Toggle value={a.active} onValueChange={async (v) => { const r = await updateAd(a.id, { active: v }); if (!r.ok) toast(r.error, 'err'); }} />
          <Pressable
            hitSlop={8}
            onPress={() => confirmDialog({
              title: 'حذف الإعلان؟', message: 'سيختفي نهائيًا. لو تريد إخفاءه مؤقتًا استخدم زر الإيقاف.', danger: true, confirmText: 'حذف',
              onConfirm: async () => { const r = await deleteAd(a.id); if (!r.ok) toast(r.error, 'err'); else toast('تم حذف الإعلان'); },
            })}
          >
            <Icon name="trash" size={19} color={C.red} />
          </Pressable>
        </View>
      ))}
      <Sheet visible={sheet} onClose={() => setSheet(false)} title="إضافة إعلان">
        <Field label="عنوان الإعلان (اختياري)" icon="create" value={title} onChangeText={setTitle} placeholder="مثال: عرض الجمعة" />
        <Field label="رابط عند الضغط (اختياري)" icon="link" value={link} onChangeText={setLink} placeholder="https://..." />
        {image ? <Image source={{ uri: image }} style={{ width: '100%', height: 150, borderRadius: 14, backgroundColor: C.line }} resizeMode="cover" /> : null}
        <Btn variant="soft" icon="image" title={image ? 'تغيير الصورة' : 'اختر صورة الإعلان'} onPress={choose} />
        <Btn title="نشر الإعلان" icon="megaphone" loading={busy} onPress={save} />
      </Sheet>
    </Card>
  );
}
