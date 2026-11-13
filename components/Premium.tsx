import React, { useEffect, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, shadow } from '../lib/theme';
import { T, Icon, Card, Btn, Field, Header, Pill, toast, confirmDialog, openWhats } from './ui';
import { useStore, useMe, isMember } from '../lib/store';
import { apiPremium, apiPremiumSave, apiPremiumActivate, apiPremiumCancel, PremiumView } from '../lib/api';
import { fmtDate, money } from '../lib/format';

/** The small gold mark for a subscriber's order or account. */
export function ProBadge({ small }: { small?: boolean }) {
  return (
    <View style={{ backgroundColor: C.gold, borderRadius: 7, paddingHorizontal: small ? 6 : 8, paddingVertical: small ? 1 : 2 }}>
      <T w="black" size={small ? 9 : 10.5} color={C.dark}>PRO</T>
    </View>
  );
}

/** The gold bar at the bottom of the home screen for customers who are not subscribers yet (it can be dismissed for the session). */
let barDismissed = false;
export function PremiumBar({ navigation, bottom = 12 }: { navigation: any; bottom?: number }) {
  const { db } = useStore();
  const me = useMe();
  const [, force] = useState(0);
  const pm = db.settings.premium;
  if (!pm || !pm.on || !me || me.role !== 'customer' || me.id === 'guest' || isMember(db, me) || barDismissed) return null;
  return (
    <Pressable
      onPress={() => navigation.navigate('Premium')}
      style={{ position: 'absolute', left: 16, right: 16, bottom, backgroundColor: C.gold, borderRadius: 16, paddingVertical: 11, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, ...shadow }}
    >
      <Icon name="diamond" size={20} color={C.dark} />
      <T w="black" size={13} color={C.dark} style={{ flex: 1 }} numberOfLines={2}>{pm.promo || 'اشترك في أبيس بريميم'}</T>
      <Pressable onPress={() => { barDismissed = true; force((x) => x + 1); }} hitSlop={10}><Icon name="close" size={18} color={C.dark} /></Pressable>
    </Pressable>
  );
}

/** Customer: what "أبيس بريميم" gives, the subscription status, and how to pay (a transfer, then the proof on WhatsApp; the owner activates it). */
export function PremiumScreen({ navigation }: any) {
  const { db } = useStore();
  const me = useMe()!;
  const insets = useSafeAreaInsets();
  const pm = db.settings.premium;
  const member = isMember(db, me);
  const left = member ? Math.max(0, Math.ceil(((me.premiumUntil || 0) - Date.now()) / 86400000)) : 0;
  const support = (db.settings.supportPhone || '').trim() || '01004379508';
  const perks: { icon: string; text: string }[] = [];
  if (pm) {
    if (pm.freeAbove != null) perks.push({ icon: 'bicycle', text: pm.freeAbove > 0 ? `توصيل مجاني على أي طلب من محل واحد من ${money(pm.freeAbove)}` : 'توصيل مجاني على كل الطلبات' });
    if (pm.discountPct > 0) perks.push({ icon: 'pricetag', text: `خصم ${pm.discountPct}٪ على المنتجات (من غير كود ولا عرض)` });
    if (pm.offers) perks.push({ icon: 'ticket', text: 'أكواد خصم وعروض حصرية للمشتركين بس' });
    if (pm.priority) perks.push({ icon: 'flash', text: 'أولوية: طلبك يوصل للمناديب الأول' });
    pm.lines.forEach((l) => perks.push({ icon: 'checkmark-circle', text: l }));
  }
  if (!pm || !pm.on) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <Header title="أبيس بريميم" onBack={() => navigation.goBack()} />
        <View style={{ padding: 24, alignItems: 'center', gap: 8 }}><T w="bold" size={15} align="center">الاشتراك غير متاح حالياً</T></View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="أبيس بريميم" subtitle="توصيل مجاني وخصومات للمشتركين" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: insets.bottom + 30 }}>
        <View style={{ backgroundColor: C.dark, borderRadius: 22, padding: 18, gap: 8, borderWidth: 2, borderColor: C.gold }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="diamond" size={26} color={C.gold} />
            <T w="black" size={18} color="#fff" style={{ flex: 1 }}>{member ? 'أنت مشترك في بريميم' : 'اشترك في أبيس بريميم'}</T>
            <ProBadge />
          </View>
          {member ? (
            <>
              <T size={13} color="#C9D8D2">ينتهي يوم {fmtDate(me.premiumUntil!)} (باقي {left} يوم)</T>
              <T size={12} color="#9FB5AC">عشان تمدّد الاشتراك، حوّل نفس المبلغ وابعت صورة التحويل زي الأول، وبنزوّد المدة على اللي باقي لك.</T>
            </>
          ) : (
            <T w="black" size={22} color={C.gold}>{money(pm.price)} <T size={13} color="#C9D8D2">/ {pm.days} يوم</T></T>
          )}
        </View>
        <Card style={{ gap: 12 }}>
          <T w="black" size={15}>المزايا</T>
          {perks.length === 0 && <T size={12.5} color={C.sub}>المزايا بتتحدد من الإدارة.</T>}
          {perks.map((p, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.goldSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={p.icon} size={18} color={C.goldDeep} /></View>
              <T w="bold" size={13.5} style={{ flex: 1 }}>{p.text}</T>
            </View>
          ))}
        </Card>
        <Card style={{ gap: 10 }}>
          <T w="black" size={15}>{member ? 'تمديد الاشتراك' : 'إزاي أشترك؟'}</T>
          <T size={13} color={C.sub}>١) حوّل {money(pm.price)} على الرقم ده{pm.transfer ? '' : ' (الإدارة هتبعتلك الرقم على واتساب)'}:</T>
          {!!pm.transfer && <View style={{ backgroundColor: C.goldSoft, borderRadius: 12, padding: 12, alignItems: 'center' }}><T w="black" size={20} color={C.dark} selectable>{pm.transfer}</T></View>}
          <T size={13} color={C.sub}>٢) ابعت صورة التحويل ورقم موبايلك على واتساب.</T>
          <T size={13} color={C.sub}>٣) بنفعّل حسابك في دقايق، وبيجيلك إشعار.</T>
          <Btn title="ابعت صورة التحويل واتساب" icon="logo-whatsapp" onPress={() => openWhats(support, `مرحباً، اشتركت في أبيس بريميم (${money(pm.price)}). رقم حسابي: ${me.phone}. مرفق صورة التحويل.`)} />
        </Card>
      </ScrollView>
    </View>
  );
}

/** Owner: the settings of "أبيس بريميم", turning a customer's subscription on / off by phone, the subscribers and what the benefits cost. */
export function PremiumAdmin() {
  const [v, setV] = useState<PremiumView | null>(null);
  const [price, setPrice] = useState(''); const [days, setDays] = useState(''); const [pct, setPct] = useState(''); const [free, setFree] = useState('');
  const [transfer, setTransfer] = useState(''); const [promo, setPromo] = useState(''); const [lines, setLines] = useState('');
  const [phone, setPhone] = useState(''); const [d, setD] = useState('30');
  const [busy, setBusy] = useState(false);
  const fill = (x: PremiumView) => { setV(x); setPrice(String(x.cfg.price)); setDays(String(x.cfg.days)); setPct(String(x.cfg.discountPct)); setFree(String(x.cfg.freeAbove)); setTransfer(x.cfg.transfer); setPromo(x.cfg.promo); setLines(x.cfg.lines.join('\n')); };
  useEffect(() => { apiPremium().then(fill).catch((e) => toast(e?.message || 'تعذر تحميل البريميم', 'err')); }, []);
  const run = async (f: () => Promise<PremiumView>, ok: string | ((x: PremiumView) => string)) => {
    setBusy(true);
    try { const x = await f(); setV(x); if (!x.activated) fill(x); toast(typeof ok === 'function' ? ok(x) : ok); return true; }
    catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); return false; }
    finally { setBusy(false); }
  };
  const save = () => run(() => apiPremiumSave({ price: Number(price), days: Number(days), discountPct: Number(pct), freeAbove: Number(free), transfer: transfer.trim(), promo: promo.trim(), lines: lines.split('\n').map((x) => x.trim()).filter(Boolean) }), 'تم حفظ إعدادات البريميم ✅');
  const activate = async () => { if (await run(() => apiPremiumActivate(phone.trim(), Number(d)), (x) => `تم التفعيل لـ ${x.activated?.name || 'العميل'} لحد ${fmtDate(x.activated?.until || 0)} ✅`)) setPhone(''); };
  const cancel = (s: { name: string; phone: string }) => confirmDialog({ title: 'إلغاء الاشتراك؟', message: `اشتراك «${s.name}» هيتلغي فوراً.`, danger: true, confirmText: 'إلغاء الاشتراك', onConfirm: () => { run(() => apiPremiumCancel(s.phone), 'تم إلغاء الاشتراك'); } });
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>أبيس بريميم (الاشتراك)</T>
      <T size={12} color={C.sub}>شغّل «حسابات أبيس بريميم» ومعاه المزايا اللي عايزها من المفاتيح فوق. العميل يحوّل ويبعتلك الصورة، وإنت تفعّله من هنا.</T>
      <Field label="سعر الاشتراك (ج.م)" icon="cash" value={price} onChangeText={setPrice} keyboardType="numeric" />
      <Field label="مدة الاشتراك (أيام)" icon="calendar" value={days} onChangeText={setDays} keyboardType="numeric" />
      <Field label="نسبة الخصم على المنتجات (٪)" icon="pricetag" value={pct} onChangeText={setPct} keyboardType="numeric" />
      <Field label="التوصيل المجاني من (ج.م) — صفر = كل الطلبات" icon="bicycle" value={free} onChangeText={setFree} keyboardType="numeric" />
      <Field label="رقم التحويل (فودافون كاش مثلاً)" icon="call" value={transfer} onChangeText={setTransfer} keyboardType="phone-pad" />
      <Field label="الجملة اللي في الشريط الذهبي" icon="megaphone" value={promo} onChangeText={setPromo} />
      <Field label="مزايا إضافية (سطر لكل ميزة)" icon="list" value={lines} onChangeText={setLines} multiline />
      <Btn title="حفظ الإعدادات" icon="checkmark" loading={busy} onPress={save} />
      <View style={{ height: 1, backgroundColor: C.line, marginVertical: 4 }} />
      <T w="black" size={14}>تفعيل اشتراك لعميل</T>
      <Field label="رقم موبايل العميل" icon="person" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="01xxxxxxxxx" />
      <Field label="عدد الأيام" icon="time" value={d} onChangeText={setD} keyboardType="numeric" />
      <Btn title="تفعيل / تمديد الاشتراك" icon="diamond" loading={busy} disabled={!phone.trim() || !d} onPress={activate} />
      {v && (
        <>
          <View style={{ height: 1, backgroundColor: C.line, marginVertical: 4 }} />
          <T w="black" size={14}>المشتركين ({v.activeCount} شغّال)</T>
          <T size={11.5} color={C.sub}>تكلفة المزايا آخر ٣٠ يوم (طلبات اتسلّمت): توصيل مجاني {money(v.cost30.freeDelivery)} + خصم {money(v.cost30.discount)} في {v.cost30.orders} طلب. المندوب بياخد رسوم توصيله كاملة والفرق عليك.</T>
          {v.subscribers.length === 0 && <T size={12} color={C.sub}>لسه مفيش مشتركين.</T>}
          {v.subscribers.slice(0, 50).map((s) => (
            <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <T w="bold" size={13}>{s.name}</T>
                <T size={11} color={C.sub}>{s.phone} • {s.active ? `ينتهي ${fmtDate(s.until)} (باقي ${s.daysLeft})` : `انتهى ${fmtDate(s.until)}`}</T>
              </View>
              <Pill label={s.active ? 'شغّال' : 'منتهي'} color={s.active ? C.green : C.sub} soft={s.active ? C.greenSoft : '#EEE'} />
              {s.active && <Btn small variant="danger" title="إلغاء" onPress={() => cancel(s)} />}
            </View>
          ))}
        </>
      )}
    </Card>
  );
}
