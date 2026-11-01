import React, { useState } from 'react';
import { View, Image, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { Provider, Product } from '../lib/types';
import { TYPES } from '../lib/format';
import { providerLogoUrl, productImageUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';
import { setProviderLogo } from '../lib/store';
import { T, Icon, EmojiBubble, Btn, toast } from './ui';

/** The provider's logo (a rounded picture) or, when there is none, its emoji. */
export function ProviderLogo({ p, size = 44 }: { p: Pick<Provider, 'id' | 'emoji' | 'type' | 'logoV'>; size?: number }) {
  const [bad, setBad] = useState(false);
  const uri = providerLogoUrl(p);
  if (!uri || bad) return <EmojiBubble emoji={p.emoji || TYPES[p.type].emoji} size={size} bg={TYPES[p.type].soft} />;
  return (
    <Image
      source={{ uri }} onError={() => setBad(true)} resizeMode="cover"
      style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: C.line, borderWidth: 1, borderColor: C.line }}
    />
  );
}

/** A product picture, or its emoji when it has none. */
export function ProductThumb({ p, size = 52, bg, emoji }: { p: Pick<Product, 'id' | 'emoji' | 'imageV'>; size?: number; bg: string; emoji?: string }) {
  const [bad, setBad] = useState(false);
  const uri = productImageUrl(p);
  if (!uri || bad) return <EmojiBubble emoji={emoji || p.emoji} size={size} bg={bg} />;
  return <Image source={{ uri }} onError={() => setBad(true)} resizeMode="cover" style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: C.line }} />;
}

/**
 * Picture field inside the product form. value: undefined = unchanged, a data URL = new picture, null = remove it.
 * `existing` is the product being edited (to show its current picture).
 */
export function ProductPicture({ value, existing, onChange }: { value: string | null | undefined; existing?: Product | null; onChange: (v: string | null | undefined) => void }) {
  if (!canPickImage) return null;
  const shown = value === undefined ? (existing && existing.imageV ? productImageUrl(existing) : '') : value || '';
  const choose = async () => {
    const img = await pickImage(700);
    if (img) onChange(img);
    else toast('تعذّر قراءة الصورة، جرّب صورة أخرى');
  };
  return (
    <View style={{ gap: 6 }}>
      <T w="bold" size={13}>صورة المنتج</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable onPress={choose} style={{ width: 84, height: 84, borderRadius: 18, backgroundColor: C.line, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
          {shown ? <Image source={{ uri: shown }} style={{ width: 84, height: 84 }} resizeMode="cover" /> : <Icon name="image-outline" size={28} color={C.sub} />}
        </Pressable>
        <View style={{ flex: 1, gap: 6 }}>
          <Btn title={shown ? 'تغيير الصورة' : 'إضافة صورة'} variant="soft" icon="camera" onPress={choose} />
          {!!shown && <Btn title="حذف الصورة" variant="ghost" onPress={() => onChange(null)} />}
        </View>
      </View>
    </View>
  );
}

/** Logo field in the service form: uploads (or removes) the logo straight away. */
export function LogoPicker({ p }: { p: Provider }) {
  const [busy, setBusy] = useState(false);
  if (!canPickImage) return null;
  const run = async (img: string | null) => {
    setBusy(true);
    const r = await setProviderLogo(p.id, img);
    setBusy(false);
    toast(r.ok ? (img ? 'تم حفظ اللوجو ✅' : 'تم حذف اللوجو') : r.error || 'تعذّر الحفظ');
  };
  const choose = async () => {
    const img = await pickImage(400);
    if (img) run(img);
    else toast('تعذّر قراءة الصورة، جرّب صورة أخرى');
  };
  return (
    <View style={{ gap: 6 }}>
      <T w="bold" size={13}>لوجو الخدمة</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ProviderLogo p={p} size={72} />
        <View style={{ flex: 1, gap: 6 }}>
          <Btn title={p.logoV ? 'تغيير اللوجو' : 'إضافة لوجو'} variant="soft" icon="camera" onPress={choose} loading={busy} />
          {!!p.logoV && <Btn title="حذف اللوجو" variant="ghost" onPress={() => run(null)} />}
        </View>
      </View>
    </View>
  );
}
