import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Icon, Chip, Sheet, Field, toast, confirmDialog } from './ui';
import { useStore } from '../lib/store';
import { SavedAddress, apiAddresses, apiAddressAdd, apiAddressDelete } from '../lib/api';

/** Above the address box at checkout: tap a saved address (البيت، الشغل...) to fill it, or save the one typed now. */
export function AddressPicker({ address, onPick }: { address: string; onPick: (a: string) => void }) {
  const { db } = useStore();
  const on = !!db.settings.features?.addresses;
  const [list, setList] = useState<SavedAddress[]>([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiAddresses().then((r) => setList(r.enabled ? r.addresses : [])).catch(() => {}); }, []);
  useEffect(() => { if (on) load(); }, [on, load]);
  if (!on) return null;
  const save = async () => {
    setBusy(true);
    try { await apiAddressAdd(label, address); setOpen(false); setLabel(''); load(); toast('تم حفظ العنوان ✅'); }
    catch (e: any) { toast(e?.message || 'تعذر الحفظ', 'err'); }
    finally { setBusy(false); }
  };
  const del = (a: SavedAddress) => confirmDialog({ title: `حذف عنوان «${a.label}»؟`, danger: true, confirmText: 'حذف', onConfirm: () => { apiAddressDelete(a.id).then(load).catch((e) => toast(e?.message || 'تعذر الحذف', 'err')); } });
  return (
    <View style={{ gap: 8 }}>
      {!!list.length && (
        <>
          <T w="bold" size={12.5}>عناويني المحفوظة</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {list.map((a) => (
              <Pressable key={a.id} onLongPress={() => del(a)}>
                <Chip label={`📍 ${a.label}`} active={address.trim() === a.address} onPress={() => onPick(a.address)} />
              </Pressable>
            ))}
          </ScrollView>
          <T size={11} color={C.sub}>اضغط على العنوان لاستخدامه، واضغط مطولًا لحذفه.</T>
        </>
      )}
      {address.trim().length >= 6 && !list.some((a) => a.address === address.trim()) && list.length < 5 && (
        <Pressable onPress={() => setOpen(true)} style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <Icon name="bookmark-outline" size={16} color={C.goldDeep} /><T w="bold" size={12.5} color={C.goldDeep}>احفظ العنوان ده</T>
        </Pressable>
      )}
      <Sheet visible={open} onClose={() => setOpen(false)} title="حفظ العنوان">
        <T size={12.5} color={C.sub}>{address}</T>
        <Field label="اسم العنوان" icon="bookmark" value={label} onChangeText={setLabel} placeholder="البيت، الشغل، بيت جدي..." />
        <Btn title="حفظ" icon="checkmark" loading={busy} onPress={save} />
      </Sheet>
    </View>
  );
}
