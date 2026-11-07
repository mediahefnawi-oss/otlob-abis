import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ScrollView, Pressable, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { C, FONT } from '../lib/theme';
import { T, Icon, Card, Header, Empty, toast, callPhone } from './ui';
import { useMe } from '../lib/store';
import {
  SupportMsg, SupportThread, apiSupportMine, apiSupportSend, apiSupportUnread, apiSupportThreads, apiSupportThread, apiSupportReply, apiSupportStatus,
} from '../lib/api';

const ROLE_AR: Record<string, string> = { customer: 'عميل', provider: 'مقدم خدمة', courier: 'مندوب', admin: 'الإدارة', supervisor: 'مشرف' };
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
      {msgs.map((m) => (
        <View key={m.id} style={{ alignSelf: mine(m) ? 'flex-start' : 'flex-end', maxWidth: '85%', backgroundColor: mine(m) ? C.goldSoft : '#F3F4EE', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 }}>
          {!mine(m) && <T w="bold" size={10.5} color={C.goldDeep}>{m.senderName} • {ROLE_AR[m.senderRole] || ''}</T>}
          <T size={13.5}>{m.text}</T>
          <T size={9.5} color={C.sub}>{timeOf(m.at)}</T>
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

/** Customer / shop / courier: a card at the top of the support screen. Last messages + a box to write. */
export function SupportChatCard() {
  const me = useMe();
  const [msgs, setMsgs] = useState<SupportMsg[]>([]);
  const [full, setFull] = useState(false);
  const last = useRef(0);
  const load = useCallback(async () => {
    const r = await apiSupportMine(last.current);
    if (r.messages.length) { last.current = Number(r.messages[r.messages.length - 1].id); setMsgs((p) => [...p, ...r.messages.filter((m) => !p.some((x) => x.id === m.id))]); }
  }, []);
  usePolling(load, 5000);
  if (!me) return null;
  const shown = full ? msgs : msgs.slice(-4);
  const mine = (m: SupportMsg) => m.senderId === me.id;
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="chatbubbles" size={20} color={C.dark3} />
        <T w="black" size={15} style={{ flex: 1 }}>محادثة مع الدعم داخل التطبيق</T>
        {msgs.length > 4 && <Pressable onPress={() => setFull(!full)}><T w="bold" size={12} color={C.green}>{full ? 'عرض الأحدث' : 'عرض الكل'}</T></Pressable>}
      </View>
      {msgs.length === 0 && <T size={12.5} color={C.sub}>اكتب مشكلتك أو سؤالك وسيرد عليك فريق الدعم هنا.</T>}
      {shown.map((m) => (
        <View key={m.id} style={{ alignSelf: mine(m) ? 'flex-start' : 'flex-end', maxWidth: '85%', backgroundColor: mine(m) ? C.goldSoft : '#F3F4EE', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 }}>
          {!mine(m) && <T w="bold" size={10.5} color={C.goldDeep}>{m.senderName}</T>}
          <T size={13}>{m.text}</T>
        </View>
      ))}
      <Composer placeholder="اكتب رسالتك للدعم..." onSend={async (t) => { const r = await apiSupportSend(t); last.current = Math.max(last.current, Number(r.message.id)); setMsgs((p) => (p.some((x) => x.id === r.message.id) ? p : [...p, r.message])); }} />
    </Card>
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
export function SupportInbox({ onBack, title = 'شات الدعم' }: { onBack?: () => void; title?: string }) {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [list, setList] = useState<SupportThread[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
      </View>
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
