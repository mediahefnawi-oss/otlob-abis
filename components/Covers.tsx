import React, { useState } from 'react';
import { View, Image } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, toast, confirmDialog } from './ui';
import { useStore, setHomeCover, setProviderCover } from '../lib/store';
import { homeCoverUrl, providerCoverUrl } from '../lib/api';
import { pickImage, canPickImage } from '../lib/pickImage';

/**
 * Owner: the cover pictures (switch "covers"). One fixed picture behind the home header (the same for everybody),
 * and one picture for each provider's page. The picture is chosen from the owner's computer (web); a wide picture (2:1) looks best.
 */
export function CoversManager() {
  const { db } = useStore();
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const v = db.settings.homeCoverV || 0;
  const provs = db.providers.filter((p) => p.status === 'active' && (!q.trim() || p.name.includes(q.trim())));
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(key);
    const r: any = await fn();
    setBusy('');
    toast(r.ok ? okMsg : r.error, r.ok ? 'ok' : 'err');
  };
  const choose = async (key: string, save: (img: string) => Promise<any>) => {
    const img = await pickImage(1400);
    if (!img) return toast('تعذر قراءة الصورة، جرّب صورة أخرى', 'err');
    run(key, () => save(img), 'تم حفظ الصورة');
  };
  const ask = (title: string, fn: () => Promise<any>) => confirmDialog({ title, message: 'هترجع الخلفية الخضراء الأصلية.', danger: true, confirmText: 'حذف', onConfirm: () => { fn().then((r: any) => toast(r.ok ? 'تم الحذف' : r.error, r.ok ? 'ok' : 'err')); } });
  return (
    <Card style={{ gap: 12 }}>
      <T w="black" size={15}>صور الكافر</T>
      <T size={12} color={C.sub}>الصور بتظهر لما تشغّل «صور الكافر» من فوق. الأفضل صورة عريضة (عرضها ضعف طولها تقريباً).</T>
      {!canPickImage && <T size={12} color={C.red}>رفع الصور بيتم من نسخة الويب (otlobabis.com) بس.</T>}
      <T w="bold" size={13.5}>كافر الرئيسية (واحد ثابت للجميع)</T>
      <View style={{ height: 96, borderRadius: 14, backgroundColor: C.dark, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
        {v > 0 ? <Image source={{ uri: homeCoverUrl(v) }} style={{ width: '100%', height: 96 }} resizeMode="cover" /> : <T size={12} color="#9FB5AC">بدون صورة</T>}
      </View>
      {canPickImage && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn small variant="soft" icon="image" title={v > 0 ? 'تغيير الصورة' : 'رفع صورة'} loading={busy === 'home'} onPress={() => choose('home', (i) => setHomeCover(i))} style={{ flex: 1 }} />
          {v > 0 && <Btn small variant="danger" icon="trash" title="حذف" onPress={() => ask('حذف كافر الرئيسية؟', () => setHomeCover(null))} />}
        </View>
      )}
      <T w="bold" size={13.5} style={{ marginTop: 6 }}>كافر كل مقدم خدمة</T>
      {provs.length === 0 && <T size={12} color={C.sub}>لا يوجد مقدمين.</T>}
      {provs.slice(0, 60).map((p) => {
        const has = (p.coverV || 0) > 0;
        return (
          <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 64, height: 36, borderRadius: 8, backgroundColor: C.dark, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
              {has ? <Image source={{ uri: providerCoverUrl(p) }} style={{ width: 64, height: 36 }} resizeMode="cover" /> : null}
            </View>
            <T w="bold" size={13} numberOfLines={1} style={{ flex: 1 }}>{p.name}</T>
            {canPickImage && <Btn small variant="soft" icon="image" title={has ? 'تغيير' : 'رفع'} loading={busy === p.id} onPress={() => choose(p.id, (i) => setProviderCover(p.id, i))} />}
            {has && <Btn small variant="danger" icon="trash" title="" onPress={() => ask('حذف كافر المقدم؟', () => setProviderCover(p.id, null))} />}
          </View>
        );
      })}
      {db.providers.length > 60 && <T size={11.5} color={C.sub}>بيظهر أول ٦٠ مقدم. اكتب جزء من الاسم للبحث.</T>}
    </Card>
  );
}
