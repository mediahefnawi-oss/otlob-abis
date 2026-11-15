import React, { useMemo, useState } from 'react';
import { View, ScrollView, Pressable, Modal, Platform } from 'react-native';
import { Image } from 'expo-image';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Field, Toggle, toast, confirmDialog } from './ui';
import { useStore, updateSettings } from '../lib/store';
import { adImageUrl } from '../lib/api';
import { SoonScreen } from './SoonScreen';
import { SoonCfg, DEFAULT_SOON_MSG, buildSoon, parseSoon, parseWhen, dateText, clockText, whenLabel } from '../lib/soon';

const DEFAULT_URL = 'https://otlob-abis-app.vercel.app/download.html?v=2';

function tomorrowAt15() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(15, 0, 0, 0);
  return d.getTime();
}

/** Owner: the "coming soon" opening screen (locks the app for everybody except the owner, with a countdown and a download button). */
export function SoonAdminCard() {
  const { db } = useStore();
  const s = db.settings;
  const saved = useMemo(() => parseSoon(s.maintenanceMessage), [s.maintenanceMessage]);
  const startAt = saved && saved.at ? saved.at : tomorrowAt15();
  const [msg, setMsg] = useState(saved?.m || DEFAULT_SOON_MSG);
  const [date, setDate] = useState(dateText(startAt));
  const [time, setTime] = useState(clockText(startAt));
  const [url, setUrl] = useState(saved?.u || s.apkUrl || DEFAULT_URL);
  const [sup, setSup] = useState(saved ? saved.sup : true);
  const [ad, setAd] = useState(saved?.ad || '');
  const [av, setAv] = useState(saved?.av || 0);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const ads = db.ads || [];
  const locked = !s.appEnabled;
  const lockedSoon = locked && !!saved;

  const at = parseWhen(date, time);
  const build = (): SoonCfg | null => {
    if (!msg.trim()) { toast('اكتب الرسالة الأساسية', 'err'); return null; }
    if (Number.isNaN(at)) { toast('اكتب اليوم بالشكل 2026-11-16 والساعة بالشكل 15:00', 'err'); return null; }
    if (url.trim() && !/^https:\/\/[^\s]+$/i.test(url.trim())) { toast('رابط التحميل لازم يبدأ بـ https://', 'err'); return null; }
    return { m: msg.trim(), at, u: url.trim(), sup, ad, av };
  };
  const previewCfg = (): SoonCfg => ({ m: msg.trim() || DEFAULT_SOON_MSG, at: Number.isNaN(at) ? 0 : at, u: url.trim() || DEFAULT_URL, sup, ad, av });

  const save = () => {
    const cfg = build();
    if (!cfg) return;
    const text = buildSoon(cfg);
    if (text.length > 480) { toast('الرسالة طويلة، اختصرها شوية', 'err'); return; }
    confirmDialog({
      title: 'قفل التطبيق بشاشة «قريبًا»؟',
      message: `العملاء والمحلات والمناديب هيشوفوا الشاشة بدل التطبيق (وإنت بتدخل عادي). الافتتاح المكتوب: ${whenLabel(cfg.at)}. في الموعد اضغط «افتح التطبيق للناس الآن».`,
      confirmText: 'احفظ وقفل',
      danger: true,
      onConfirm: async () => {
        setBusy(true);
        const r: any = await updateSettings({ appEnabled: false, maintenanceMessage: text });
        setBusy(false);
        toast(r.ok ? 'تم الحفظ وقفل التطبيق بشاشة قريبًا' : r.error || 'تعذر الحفظ', r.ok ? 'ok' : 'err');
      },
    });
  };
  const openNow = () => confirmDialog({
    title: 'فتح التطبيق للناس؟',
    message: 'الشاشة هتختفي والتطبيق هيشتغل عادي للكل.',
    confirmText: 'افتح الآن',
    onConfirm: async () => {
      setBusy(true);
      const r: any = await updateSettings({ appEnabled: true });
      setBusy(false);
      toast(r.ok ? 'تم فتح التطبيق للجميع 🎉' : r.error || 'تعذر الفتح', r.ok ? 'ok' : 'err');
    },
  });

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>شاشة الافتتاح «قريبًا»</T>
          <T size={11.5} color={C.sub}>تقفل التطبيق والموقع على الناس بشاشة فيها عدّاد تنازلي وزر تحميل</T>
        </View>
        <View style={{ borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: lockedSoon ? '#FDECEA' : locked ? '#FFF3CF' : '#E7F6EE' }}>
          <T w="bold" size={11.5} color={lockedSoon ? '#B42318' : locked ? '#8A6100' : '#0A7A4B'}>{lockedSoon ? '🔒 مقفول بشاشة قريبًا' : locked ? '⏸ متوقف للصيانة' : '🟢 مفتوح للناس'}</T>
        </View>
      </View>

      <Field label="الرسالة الأساسية (الكبيرة)" value={msg} onChangeText={setMsg} icon="megaphone" maxLength={120} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="الساعة (مثال 15:00)" value={time} onChangeText={setTime} icon="time" keyboardType="numbers-and-punctuation" /></View>
        <View style={{ flex: 1.3 }}><Field label="يوم الافتتاح (مثال 2026-11-16)" value={date} onChangeText={setDate} icon="calendar" keyboardType="numbers-and-punctuation" /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="النهاردة" small variant="soft" onPress={() => setDate(dateText(Date.now()))} />
        <Btn title="بكرا" small variant="soft" onPress={() => setDate(dateText(Date.now() + 86400000))} />
        {!Number.isNaN(at) && <View style={{ flex: 1, justifyContent: 'center' }}><T size={12} color={C.sub}>هتظهر: {whenLabel(at)}</T></View>}
      </View>
      <Field label="رابط زر التحميل (الموقع بس)" value={url} onChangeText={setUrl} icon="link" autoCapitalize="none" keyboardType="url" style={{ writingDirection: 'ltr', textAlign: 'left' } as any} />

      <T w="semi" size={13} color={C.dark3}>الصورة (المنظر في النص)</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
        <Pressable onPress={() => { setAd(''); setAv(0); }} style={{ width: 96, alignItems: 'center', gap: 4 }}>
          <View style={{ width: 96, height: 66, borderRadius: 12, backgroundColor: '#0A4A1D', borderWidth: 2.5, borderColor: !ad ? C.gold : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
            <Image source={require('../assets/images/soon-scene.webp')} style={{ width: '100%', height: '100%', borderRadius: 10 }} contentFit="cover" />
          </View>
          <T size={11} color={!ad ? C.dark : C.sub} w={!ad ? 'bold' : 'regular'}>الافتراضية</T>
        </Pressable>
        {ads.map((a) => (
          <Pressable key={a.id} onPress={() => { setAd(a.id); setAv(a.v); }} style={{ width: 96, alignItems: 'center', gap: 4 }}>
            <View style={{ width: 96, height: 66, borderRadius: 12, overflow: 'hidden', borderWidth: 2.5, borderColor: ad === a.id ? C.gold : 'transparent', backgroundColor: '#E6EBE7' }}>
              <Image source={{ uri: adImageUrl(a) }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
            </View>
            <T size={11} numberOfLines={1} color={ad === a.id ? C.dark : C.sub} w={ad === a.id ? 'bold' : 'regular'}>{a.title || 'بانر'}</T>
          </Pressable>
        ))}
      </ScrollView>
      <T size={11} color={C.sub}>الصور المتاحة هي البانرات اللي رفعتها قبل كده (من «البانرات الإعلانية»). عشان تضيف صورة جديدة ارفعها هناك الأول.</T>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}><T w="bold" size={14}>زر «تواصل معنا» (واتساب الدعم)</T></View>
        <Toggle value={sup} onValueChange={setSup} />
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Btn title="معاينة" icon="eye" variant="outline" onPress={() => setPreview(true)} /></View>
        <View style={{ flex: 1.5 }}><Btn title="حفظ وقفل التطبيق" icon="lock-closed" loading={busy} onPress={save} /></View>
      </View>
      {locked && <Btn title="افتح التطبيق للناس الآن" icon="lock-open" variant="green" loading={busy} onPress={openNow} />}
      <T size={11.5} color={C.sub}>الافتتاح بإيدك: في الموعد اضغط «افتح التطبيق للناس الآن». العدّاد بيكتب «بنفتح حالًا» لما الوقت يخلص. حسابك (المالك) بيدخل عادي وقت القفل.</T>

      <Modal visible={preview} animationType="slide" onRequestClose={() => setPreview(false)}>
        <SoonScreen cfg={previewCfg()} preview onClose={() => setPreview(false)} />
      </Modal>
    </Card>
  );
}
