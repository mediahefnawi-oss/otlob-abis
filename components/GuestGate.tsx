import React, { useEffect, useRef, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../lib/theme';
import { T, Btn, Field, Sheet, Icon, Card, Header, openWhats, toast } from './ui';
import { login, cartAdd, onGuestPrompt, requireLogin, GuestPending, useStore } from '../lib/store';
import { navigationRef } from '../lib/nav';
import { DEFAULT_CREDITS } from '../lib/format';

/**
 * Guest browsing (switch "guestBrowse"): a visitor can look at every shop and price without an account.
 * The sign-in sheet opens from inside the app the moment he tries to add to the cart or order, and what he wanted is done right after he signs in.
 */
export function GuestLoginSheet() {
  const [open, setOpen] = useState(false);
  const pending = useRef<GuestPending>(null);
  const [phone, setPhone] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    onGuestPrompt((p) => { pending.current = p; setErr(''); setOpen(true); });
    return () => onGuestPrompt(null);
  }, []);
  const submit = async () => {
    if (!phone.trim() || !pass) return;
    setBusy(true); setErr('');
    const r = await login(phone, pass);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setOpen(false); setPass('');
    const pd = pending.current; pending.current = null;
    toast(`أهلاً ${r.user.name} 👋`);
    if (pd && r.user.role === 'customer') setTimeout(() => cartAdd(pd.productId, pd.delta), 400);
  };
  const toRegister = () => { setOpen(false); if (navigationRef.isReady()) (navigationRef as any).navigate('Register', { role: 'customer' }); };
  return (
    <Sheet visible={open} onClose={() => setOpen(false)} title="سجّل دخولك عشان تكمل">
      <T size={12.5} color={C.sub} align="center">عشان نحفظ طلبك ونوصّلهولك</T>
      <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="01xxxxxxxxx" returnKeyType="next" />
      <Field label="كلمة المرور" icon="lock-closed" value={pass} onChangeText={setPass} secureTextEntry placeholder="••••••" returnKeyType="done" onSubmitEditing={submit} />
      {!!err && (
        <View style={{ flexDirection: 'row', gap: 8, backgroundColor: C.redSoft, padding: 10, borderRadius: 12, alignItems: 'center' }}>
          <Icon name="alert-circle" size={18} color={C.red} /><T size={12.5} color={C.red} style={{ flex: 1 }}>{err}</T>
        </View>
      )}
      <Btn title="دخول" loading={busy} disabled={!phone.trim() || !pass} onPress={submit} />
      <Pressable onPress={toRegister} style={{ alignItems: 'center', paddingVertical: 4 }}>
        <T w="bold" size={13} color={C.goldDeep}>معندكش حساب؟ أنشئ حساب جديد</T>
      </Pressable>
    </Sheet>
  );
}

/** The tabs a guest cannot use (my orders, support, my account) show this instead: a welcome card with a sign-in button and the usual links. */
export function GuestAccountScreen({ navigation, title = 'حسابي' }: { navigation: any; title?: string }) {
  const { db } = useStore();
  const insets = useSafeAreaInsets();
  const supportRaw = (db.settings.supportPhone || '').trim() || '01004379508';
  const cr = db.settings.credits || DEFAULT_CREDITS;
  const go = (name: string, params?: any) => navigation.navigate(name, params);
  const Row = ({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) => (
    <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Icon name={icon} size={20} color={C.goldDeep} /><T w="bold" size={14} style={{ flex: 1 }}>{label}</T><Icon name="chevron-back" size={16} color={C.sub} />
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={title} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: insets.bottom + 90 }}>
        <Card style={{ gap: 10 }}>
          <T w="black" size={18}>أهلاً بيك في أطلب أبيس!</T>
          <T size={13} color={C.sub}>سجّل دخولك أو أنشئ حساب عشان تطلب وتتابع طلباتك.</T>
          <Btn title="تسجيل الدخول" icon="log-in" onPress={() => go('Login')} />
          <Btn title="إنشاء حساب جديد" variant="ghost" onPress={() => go('Register', { role: 'customer' })} />
        </Card>
        <Card style={{ paddingVertical: 2 }}>
          <Row icon="headset" label="المساعدة والدعم" onPress={() => openWhats(supportRaw, 'مرحباً، أحتاج مساعدة في تطبيق أطلب أبيس')} />
          <Row icon="storefront" label="سجّل كمقدم خدمة" onPress={() => go('Register', { role: 'provider' })} />
          <Row icon="bicycle" label="انضم كمندوب" onPress={() => go('Register', { role: 'courier' })} />
        </Card>
        <View style={{ alignItems: 'center', paddingTop: 6 }}>
          <T size={7.5} color="#8FA89F" align="center" style={{ letterSpacing: 1.2 }}>{cr.a}</T>
          <T w="black" size={10} color={C.goldDeep} align="center" style={{ letterSpacing: 0.8 }}>{cr.b}</T>
          <T size={9} color={C.sub} align="center">{cr.c}</T>
          <T size={7.5} color="#8FA89F" align="center">{cr.d}</T>
        </View>
      </ScrollView>
    </View>
  );
}

/** Screens that only make sense with an account (a written request, a booking, a lab request, a custom errand): a guest who opens one goes back and the sign-in sheet opens. */
export function GuestBlockScreen({ navigation }: any) {
  useEffect(() => {
    if (navigation.canGoBack()) navigation.goBack(); else navigation.navigate('Main');
    // not cleared on unmount: going back unmounts this screen at once, and the sheet must still open
    setTimeout(() => requireLogin(), 250);
  }, []);
  return <View style={{ flex: 1, backgroundColor: C.bg }} />;
}
