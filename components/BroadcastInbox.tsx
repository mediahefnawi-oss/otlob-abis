import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Modal, View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn } from './ui';
import { useMe } from '../lib/store';
import { Broadcast, apiBroadcastsUnread, apiBroadcastSeen } from '../lib/api';

/** The owner's messages: shown once to every signed-in user (also when push is off), one after another. */
export function BroadcastInbox() {
  const me = useMe();
  const [list, setList] = useState<Broadcast[]>([]);
  const load = useCallback(async () => {
    if (!me?.id || me.role === 'admin') return;
    try { setList((await apiBroadcastsUnread()).broadcasts); } catch { /* try again later */ }
  }, [me?.id, me?.role]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load]);
  const cur = list[0];
  if (!cur) return null;
  const close = () => { setList((l) => l.filter((x) => x.id !== cur.id)); apiBroadcastSeen(cur.id).catch(() => {}); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 22, padding: 20, width: '100%', maxWidth: 360, gap: 10, alignItems: 'center' }}>
          <T size={34}>🔔</T>
          <T w="black" size={18} align="center">{cur.title}</T>
          {!!cur.body && <T size={14} color={C.sub} align="center">{cur.body}</T>}
          <View style={{ alignSelf: 'stretch', marginTop: 6 }}><Btn title="تمام" onPress={close} /></View>
        </View>
      </View>
    </Modal>
  );
}
