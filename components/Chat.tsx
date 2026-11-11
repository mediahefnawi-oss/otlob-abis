import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Icon, Sheet, Field, toast, confirmDialog } from './ui';
import { useStore } from '../lib/store';
import { ChatMsg, apiShopChat, apiShopChatSend, apiChatThreads, apiChatThread, apiChatThreadSend, apiChatReport, apiChatReports } from '../lib/api';

/** Messages + a box to write. `load` / `send` decide which side (customer or shop) is talking; it refreshes every few seconds while open. */
function Conversation({ load, send, hint }: { load: () => Promise<ChatMsg[] | null>; send: (t: string) => Promise<ChatMsg>; hint?: string }) {
  const [msgs, setMsgs] = useState<ChatMsg[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const refresh = useCallback(() => { load().then((m) => { if (m) setMsgs(m); }).catch(() => {}); }, [load]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [refresh]);
  const go = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try { const m = await send(t); setMsgs((x) => [...(x || []), m]); setText(''); setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50); }
    catch (e: any) { toast(e?.message || 'تعذر الإرسال', 'err'); }
    finally { setBusy(false); }
  };
  const report = (m: ChatMsg) => confirmDialog({ title: 'الإبلاغ عن الرسالة؟', message: 'هتوصل لمالك التطبيق ليراجعها', confirmText: 'إبلاغ', danger: true, onConfirm: () => { apiChatReport(m.id).then(() => toast('تم الإبلاغ، شكرًا لك')).catch((e) => toast(e?.message || 'تعذر الإبلاغ', 'err')); } });
  return (
    <View style={{ gap: 10 }}>
      <ScrollView ref={scroll} style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 8 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        {msgs && !msgs.length && <T size={12.5} color={C.sub} align="center">{hint || 'ابدأ المحادثة'}</T>}
        {(msgs || []).map((m) => (
          <Pressable key={m.id} onLongPress={() => { if (!m.mine) report(m); }} style={{ alignSelf: m.mine ? 'flex-start' : 'flex-end', maxWidth: '82%' }}>
            <View style={{ backgroundColor: m.mine ? C.goldSoft : '#EEF1EC', padding: 10, borderRadius: 14 }}>
              <T size={13.5}>{m.text}</T>
            </View>
          </Pressable>
        ))}
      </ScrollView>
      <Field label="رسالتك" icon="chatbubble" value={text} onChangeText={setText} multiline maxLength={500} />
      <T size={11} color={C.sub}>أرقام التليفون بتتخفي تلقائيًا. اضغط مطولًا على رسالة الطرف التاني للإبلاغ عنها.</T>
      <Btn title="إرسال" icon="send" loading={busy} onPress={go} />
    </View>
  );
}

/** Customer: "ask the shop" on the shop's page. Hidden unless the owner switched chat on (and did not close it for this shop). */
export function ShopChatButton({ providerId, chatOff, bottom = 22 }: { providerId: string; chatOff?: boolean; bottom?: number }) {
  const { db } = useStore();
  const [open, setOpen] = useState(false);
  if (!db.settings.features?.chat || chatOff) return null;
  const load = () => apiShopChat(providerId).then((r) => (r.enabled ? r.messages : null));
  return (
    <>
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom, alignItems: 'center', zIndex: 20 }}>
        <Pressable onPress={() => setOpen(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.gold, borderRadius: 30, paddingHorizontal: 22, paddingVertical: 12, shadowColor: C.gold, shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 8 }}>
          <Icon name="chatbubbles" size={20} color={C.dark} />
          <T w="black" size={14} color={C.dark}>اسأل المحل قبل ما تطلب</T>
        </Pressable>
      </View>
      <Sheet visible={open} onClose={() => setOpen(false)} title="محادثة مع المحل">
        {open && <Conversation load={load} send={(t) => apiShopChatSend(providerId, t).then((r) => r.message)} hint="اكتب سؤالك للمحل" />}
        <Btn variant="soft" icon="cart" title="اطلب دلوقتي" onPress={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

/** Shop: conversations with customers. */
export function ShopChatInbox() {
  const { db } = useStore();
  const [threads, setThreads] = useState<{ id: string; name: string; last: string; at: number; unread: number }[]>([]);
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const load = useCallback(() => { apiChatThreads().then((r) => setThreads(r.enabled ? r.threads : [])).catch(() => {}); }, []);
  useEffect(() => { if (!db.settings.features?.chat) return; load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load, db.settings.features?.chat]);
  if (!db.settings.features?.chat) return null;
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>رسائل العملاء</T>
      {!threads.length && <T size={12.5} color={C.sub}>لا توجد رسائل بعد.</T>}
      {threads.map((t) => (
        <Pressable key={t.id} onPress={() => setOpen({ id: t.id, name: t.name })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line }}>
          <View style={{ flex: 1 }}><T w="bold" size={13.5}>{t.name}</T><T size={12} color={C.sub} numberOfLines={1}>{t.last}</T></View>
          {t.unread > 0 && <View style={{ backgroundColor: C.red, borderRadius: 10, minWidth: 20, paddingHorizontal: 6, alignItems: 'center' }}><T w="bold" size={11} color="#fff">{t.unread}</T></View>}
        </Pressable>
      ))}
      <Sheet visible={!!open} onClose={() => { setOpen(null); load(); }} title={open ? `محادثة مع ${open.name}` : ''}>
        {open && <Conversation load={() => apiChatThread(open.id).then((r) => r.messages)} send={(t) => apiChatThreadSend(open.id, t).then((r) => r.message)} />}
      </Sheet>
    </Card>
  );
}

/** Owner: reported messages. */
export function ChatReportsList() {
  const [rows, setRows] = useState<{ id: string; text: string; from: string; reporter: string; providerName: string }[]>([]);
  useEffect(() => { apiChatReports().then((r) => setRows(r.reports)).catch(() => {}); }, []);
  if (!rows.length) return <Card><T size={12.5} color={C.sub}>لا توجد بلاغات على رسائل المحادثة.</T></Card>;
  return (
    <View style={{ gap: 8 }}>
      <T w="black" size={15}>بلاغات المحادثة ({rows.length})</T>
      {rows.map((x) => (
        <Card key={x.id} style={{ gap: 4 }}>
          <T size={12} color={C.sub}>{x.from} • بلاغ من {x.reporter} • {x.providerName}</T>
          <T size={13.5}>{x.text}</T>
        </Card>
      ))}
      <T size={11.5} color={C.sub}>لو محل بيسيء استخدام المحادثة، اقفلها له من تفاصيله.</T>
    </View>
  );
}
