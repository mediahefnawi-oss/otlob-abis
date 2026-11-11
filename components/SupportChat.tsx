import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ScrollView, Pressable, TextInput, KeyboardAvoidingView, Platform, Modal } from 'react-native';
import { C, FONT } from '../lib/theme';
import { T, Icon, Card, Header, Empty, toast, callPhone, Sheet, Field, Btn } from './ui';
import { useMe, useStore } from '../lib/store';
import {
  SupportMsg, SupportThread, apiSupportMine, apiSupportSend, apiSupportUnread, apiSupportThreads, apiSupportThread, apiSupportReply, apiSupportStatus, apiSupportStart,
} from '../lib/api';

const ROLE_AR: Record<string, string> = { customer: 'عميل', provider: 'مقدم خدمة', courier: 'مندوب', admin: 'الإدارة', supervisor: 'مشرف', bot: 'رد آلي' };
const QUICK = ['إزاي أطلب؟', 'رسوم التوصيل', 'أكواد الخصم', 'الدفع', 'إلغاء طلب', 'فين طلبي؟', '👤 كلم الدعم'];
const timeOf = (t: number) => { try { return new Date(t).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

/** polls a loader every `ms` while mounted; a failed poll is ignored (the next one retries) */
function usePolling(fn: () => Promise<void>, ms: number, deps: unknown[] = []) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    let dead = false; let busy = false;
    const run = async () => { if (busy || dead) return; busy = true; try { await ref.current(); } catch {} busy = false; };
    run(); const t = setInterval(run, ms);
    return () => { dead = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** unread badge number: replies waiting for a user, conversations waiting for the staff */
export function useSupportUnread(enabled = true) {
  const [n, setN] = useState(0);
  usePolling(async () => { if (enabled) setN((await apiSupportUnread()).unread); else setN(0); }, 15000, [enabled]);
  return n;
}

function Bubbles({ msgs, mine }: { msgs: SupportMsg[]; mine: (m: SupportMsg) => boolean }) {
  const sc = useRef<ScrollView>(null);
  return (
    <ScrollView ref={sc} onContentSizeChange={() => sc.current?.scrollToEnd({ animated: false })} contentContainerStyle={{ padding: 14, gap: 8, flexGrow: 1 }}>
      {msgs.map((m) => mine(m) ? (
        <View key={m.id} style={{ alignSelf: 'flex-start', maxWidth: '85%', backgroundColor: C.goldSoft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 }}>
          <T size={13.5}>{m.text}</T>
          <T size={9.5} color={C.sub}>{timeOf(m.at)}</T>
        </View>
      ) : (
        // a reply from the support / assistant: its own white bubble with a border and an icon, so it never blends into the screen
        <View key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '88%', flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <View style={{ flexShrink: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 2 }}>
            <T w="bold" size={10.5} color={C.goldDeep}>{m.senderName} • {ROLE_AR[m.senderRole] || ''}</T>
            <T size={13.5}>{m.text}</T>
            <T size={9.5} color={C.sub}>{timeOf(m.at)}</T>
          </View>
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: m.senderRole === 'bot' ? C.goldSoft : C.green, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={m.senderRole === 'bot' ? 'sparkles' : 'headset'} size={15} color={m.senderRole === 'bot' ? C.goldDeep : '#fff'} />
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function Composer({ onSend, placeholder }: { onSend: (t: string) => Promise<void>; placeholder: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true);
    try { await onSend(t); setText(''); } catch (e: any) { toast(e?.message || 'تعذر الإرسال', 'err'); }
    setBusy(false);
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TextInput maxFontSizeMultiplier={1.1} value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor="#9AA8A2" onSubmitEditing={send} returnKeyType="send" maxLength={2000}
        style={{ flex: 1, backgroundColor: '#F3F4EE', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, fontFamily: FONT.regular, fontSize: 13, textAlign: 'right' }} />
      <Pressable onPress={send} style={{ backgroundColor: busy ? C.sub : C.green, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' }}><Icon name="send" size={16} color="#fff" /></Pressable>
    </View>
  );
}

/** The whole conversation of a customer / shop / courier with the support, in its own full screen (a modal on top of the app). */
function SupportChatFull({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const [msgs, setMsgs] = useState<SupportMsg[]>([]);
  const last = useRef(0);
  const load = useCallback(async () => {
    const r = await apiSupportMine(last.current);
    if (r.messages.length) { last.current = Number(r.messages[r.messages.length - 1].id); setMsgs((p) => [...p, ...r.messages.filter((m) => !p.some((x) => x.id === m.id))]); }
  }, []);
  usePolling(load, 4000);
  const send = async (t: string) => {
    const r = await apiSupportSend(t);
    const add = [r.message, ...(r.reply ? [r.reply] : [])];
    last.current = Math.max(last.current, ...add.map((x) => Number(x.id)));
    setMsgs((p) => [...p, ...add.filter((m) => !p.some((x) => x.id === m.id))]);
  };
  const quick = async (t: string) => { try { await send(t); } catch (e: any) { toast(e?.message || 'تعذر الإرسال', 'err'); } };
  if (!me) return null;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="محادثة مع الدعم" subtitle="فريق الدعم يرد عليك هنا" onBack={onClose} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}>
        <View style={{ flex: 1 }}>
          {msgs.length === 0 ? <Empty icon="chatbubbles" title="أهلاً بيك 👋" text="اسأل عن أي حاجة في التطبيق وهيرد عليك المساعد فوراً، ولو محتاج حد من الدعم اضغط «كلم الدعم»" /> : <Bubbles msgs={msgs} mine={(m) => m.senderRole !== 'bot' && m.senderId === me.id} />}
        </View>
        <View style={{ padding: 10, backgroundColor: '#fff', gap: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }} keyboardShouldPersistTaps="handled">
            {QUICK.map((q) => (
              <Pressable key={q} onPress={() => quick(q)} style={{ backgroundColor: q.startsWith('👤') ? C.dark : C.goldSoft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 }}>
                <T w="bold" size={12} color={q.startsWith('👤') ? C.gold : C.goldDeep}>{q}</T>
              </Pressable>
            ))}
          </ScrollView>
          <Composer placeholder="اكتب رسالتك للدعم..." onSend={send} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Customer / shop / courier: one card on the support screen; tapping it opens the full chat screen. */
export function SupportChatCard() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [lastText, setLastText] = useState('');
  const [n, setN] = useState(0);
  usePolling(async () => {
    if (open) { setN(0); return; }
    const r = await apiSupportUnread(); setN(r.unread);
  }, 8000, [open]);
  useEffect(() => { apiSupportMine(0).then((r) => { const m = r.messages[r.messages.length - 1]; setLastText(m ? m.text : ''); }).catch(() => {}); }, [open]);
  if (!me) return null;
  return (
    <>
      <Card onPress={() => setOpen(true)} style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="chatbubbles" size={20} color={C.dark3} />
          <T w="black" size={15} style={{ flex: 1 }}>محادثة مع الدعم داخل التطبيق</T>
          {n > 0 && <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}><T w="black" size={11} color="#fff">{n}</T></View>}
          <Icon name="chevron-back" size={17} color={C.sub} />
        </View>
        <T size={12.5} color={C.sub} numberOfLines={1}>{lastText || 'اضغط لفتح المحادثة وكتابة مشكلتك أو سؤالك'}</T>
      </Card>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SupportChatFull onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}

/** One conversation, for the owner or an allowed supervisor. */
function ThreadView({ id, onBack }: { id: string; onBack: () => void }) {
  const me = useMe();
  const [th, setTh] = useState<SupportThread | null>(null);
  const [msgs, setMsgs] = useState<SupportMsg[]>([]);
  const last = useRef(0);
  const [denied, setDenied] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await apiSupportThread(id, last.current);
      setTh(r.thread);
      if (r.messages.length) { last.current = Number(r.messages[r.messages.length - 1].id); setMsgs((p) => [...p, ...r.messages.filter((m) => !p.some((x) => x.id === m.id))]); }
    } catch (e: any) { if (/غير مسموح|forbidden/.test(String(e?.message))) setDenied(true); else throw e; }
  }, [id]);
  usePolling(load, 4000, [id]);
  useEffect(() => { if (denied) onBack(); }, [denied, onBack]);
  const toggle = async () => {
    if (!th) return;
    const next = th.status === 'open' ? 'closed' : 'open';
    try { await apiSupportStatus(id, next); setTh({ ...th, status: next }); toast(next === 'closed' ? 'تم إغلاق المحادثة' : 'تمت إعادة فتح المحادثة'); } catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); }
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={th?.userName || 'محادثة'} subtitle={th ? `${ROLE_AR[th.userRole] || ''} • ${th.userPhone}` : ''} onBack={onBack}
        right={th ? <Pressable onPress={() => callPhone(th.userPhone)} style={{ padding: 8 }}><Icon name="call" size={20} color={C.green} /></Pressable> : undefined} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View style={{ flex: 1 }}><Bubbles msgs={msgs} mine={(m) => m.senderId === me?.id} /></View>
        <View style={{ padding: 10, gap: 8, backgroundColor: '#fff' }}>
          <Composer placeholder="اكتب الرد..." onSend={async (t) => { const r = await apiSupportReply(id, t); last.current = Math.max(last.current, Number(r.message.id)); setMsgs((p) => (p.some((x) => x.id === r.message.id) ? p : [...p, r.message])); if (th && th.status === 'closed') setTh({ ...th, status: 'open' }); }} />
          {th && <Pressable onPress={toggle} style={{ alignSelf: 'center', padding: 4 }}><T w="bold" size={12} color={th.status === 'open' ? C.red : C.green}>{th.status === 'open' ? 'إغلاق المحادثة' : 'إعادة فتح المحادثة'}</T></Pressable>}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Inbox of every support conversation (owner always, supervisor only while the owner allows it). */

/** The owner starts a conversation with any customer / shop / courier; the user gets a push notification. */
function NewMessageSheet({ visible, onClose, onSent }: { visible: boolean; onClose: () => void; onSent: (threadId: string) => void }) {
  const { db } = useStore();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'customer' | 'provider' | 'courier'>('all');
  const [pick, setPick] = useState<{ id: string; name: string; role: string; phone: string } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!visible) { setQ(''); setKind('all'); setPick(null); setText(''); } }, [visible]);
  const people = db.users.filter((u) => ['customer', 'provider', 'courier'].includes(u.role) && (kind === 'all' || u.role === kind)
    && (!q.trim() || (u.name || '').includes(q.trim()) || (u.phone || '').includes(q.trim()))).slice(0, 30);
  const send = async () => {
    if (!pick || !text.trim() || busy) return;
    setBusy(true);
    try { const r = await apiSupportStart(pick.id, text.trim()); toast('تم إرسال الرسالة وإشعار المستخدم'); onSent(r.thread.id); } catch (e: any) { toast(e?.message || 'تعذر الإرسال', 'err'); }
    setBusy(false);
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={pick ? `إلى: ${pick.name}` : 'رسالة جديدة'}>
      {!pick ? (
        <View style={{ gap: 10 }}>
          <Field label="بحث بالاسم أو رقم الهاتف" icon="search" value={q} onChangeText={setQ} />
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {([['all', 'الكل'], ['customer', 'عملاء'], ['provider', 'محلات'], ['courier', 'مناديب']] as const).map(([k, l]) => (
              <Pressable key={k} onPress={() => setKind(k)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: kind === k ? C.dark : '#F3F4EE' }}><T w="bold" size={12} color={kind === k ? '#fff' : C.dark3}>{l}</T></Pressable>
            ))}
          </View>
          <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
            {people.length === 0 && <T size={12.5} color={C.sub} align="center">لا توجد نتائج</T>}
            {people.map((u) => (
              <Pressable key={u.id} onPress={() => setPick({ id: u.id, name: u.name, role: u.role, phone: u.phone || '' })} style={{ paddingVertical: 10, borderBottomWidth: 1, borderColor: C.line }}>
                <T w="bold" size={14}>{u.name}</T>
                <T size={11.5} color={C.sub}>{ROLE_AR[u.role] || ''} • {u.phone}</T>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <T size={12} color={C.sub}>{ROLE_AR[pick.role] || ''} • {pick.phone}</T>
          <Field label="رسالتك" icon="chatbubble" value={text} onChangeText={setText} multiline />
          <Btn title="إرسال وإشعار المستخدم" icon="send" loading={busy} onPress={send} />
          <Pressable onPress={() => setPick(null)} style={{ alignSelf: 'center', padding: 4 }}><T w="bold" size={12} color={C.sub}>اختيار مستخدم آخر</T></Pressable>
        </View>
      )}
    </Sheet>
  );
}

export function SupportInbox({ onBack, title = 'شات الدعم' }: { onBack?: () => void; title?: string }) {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [list, setList] = useState<SupportThread[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [compose, setCompose] = useState(false);
  usePolling(async () => {
    try { setList((await apiSupportThreads(tab)).threads); setDenied(false); } catch (e: any) { if (/غير مسموح|forbidden/.test(String(e?.message))) setDenied(true); else throw e; }
    setLoaded(true);
  }, 6000, [tab, open]);
  if (open) return <ThreadView id={open} onBack={() => setOpen(null)} />;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={title} subtitle="محادثات الدعم من العملاء ومقدمي الخدمة والمناديب" onBack={onBack} />
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>
        {(['open', 'closed'] as const).map((k) => (
          <Pressable key={k} onPress={() => { setTab(k); setLoaded(false); }} style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16, backgroundColor: tab === k ? C.dark : '#fff' }}>
            <T w="bold" size={13} color={tab === k ? '#fff' : C.dark3}>{k === 'open' ? 'مفتوحة' : 'مغلقة'}</T>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => setCompose(true)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: C.gold }}>
          <T w="black" size={13} color={C.dark}>＋ رسالة جديدة</T>
        </Pressable>
      </View>
      <NewMessageSheet visible={compose} onClose={() => setCompose(false)} onSent={(tid) => { setCompose(false); setOpen(tid); }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}>
        {denied ? <Empty icon="lock-closed" title="غير مفعّل لك" text="لم يسمح لك المالك بشات الدعم" />
          : loaded && list.length === 0 ? <Empty icon="chatbubbles" title="لا توجد محادثات" text={tab === 'open' ? 'لا توجد رسائل دعم مفتوحة' : 'لا توجد محادثات مغلقة'} />
          : list.map((t) => (
            <Card key={t.id} onPress={() => setOpen(t.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <T w="bold" size={14.5}>{t.userName} <T size={11} color={C.sub}>• {ROLE_AR[t.userRole] || ''}</T></T>
                <T size={12.5} color={C.dark3} numberOfLines={1}>{t.lastMessage}</T>
                <T size={10.5} color={C.sub}>{timeOf(t.lastAt)}</T>
              </View>
              {t.unread > 0 && <View style={{ minWidth: 24, height: 24, borderRadius: 12, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}><T w="black" size={11} color="#fff">{t.unread}</T></View>}
              <Icon name="chevron-back" size={17} color={C.sub} />
            </Card>
          ))}
      </ScrollView>
    </View>
  );
}
