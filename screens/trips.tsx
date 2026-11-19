import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { ScrollView } from '../components/KScroll';
import { C, shadow } from '../lib/theme';
import { T, Icon, Card, Btn, Empty, Header, Field, Chip, toast, confirmDialog } from '../components/ui';
import { Trip, MyTrip, apiTrips, apiMyTrips, apiTripBook, apiTripCancelBooking, apiCaptainTrips, apiCaptainTripCreate, apiCaptainTripStatus, apiCaptainTripCancel, apiGates } from '../lib/api';

const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');
const DAYS = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
const when = (ms: number) => { const d = new Date(ms); const h = d.getHours(), m = d.getMinutes(); const hh = h % 12 === 0 ? 12 : h % 12; return `${DAYS[(d.getDay() + 1) % 7]} ${d.getDate()}/${d.getMonth() + 1} الساعة ${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'ص' : 'م'}`; };
const STATUS: Record<string, string> = { open: 'مفتوحة للحجز', started: 'اتحركت', done: 'خلصت', cancelled: 'ملغية' };

/** Customer: the intercity cars that are announced, pick seats and book. */
export function TripsScreen({ navigation }: any) {
  const [list, setList] = useState<Trip[] | null>(null);
  const [mine, setMine] = useState<MyTrip[]>([]);
  const [closed, setClosed] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<number, number[]>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [veh, setVeh] = useState<number | null>(null);      // filter by vehicle type
  const load = useCallback(async () => {
    try { const [a, b] = await Promise.all([apiTrips(), apiMyTrips()]); setList(a.trips); setMine(b.trips); }
    catch (e) { toast(errText(e), 'err'); setList((l) => l || []); }
    try { const g = (await apiGates()).closed?.trips; setClosed(g ? (g.message || 'الحجز متوقف مؤقتاً') : null); } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  const toggle = (id: number, seat: number) => setPick((p) => { const cur = p[id] || []; return { ...p, [id]: cur.includes(seat) ? cur.filter((x) => x !== seat) : [...cur, seat].sort((a, b) => a - b) }; });
  const book = async (t: Trip) => {
    const seats = pick[t.id] || [];
    if (!seats.length) return toast('اختار كرسي واحد على الأقل', 'err');
    setBusy(t.id);
    try { await apiTripBook(t.id, seats); toast(`تم حجز ${seats.length} كرسي ✅`); setPick((p) => ({ ...p, [t.id]: [] })); await load(); }
    catch (e) { toast(errText(e), 'err'); await load(); } finally { setBusy(null); }
  };
  const cancel = (id: number) => confirmDialog({ title: 'إلغاء الحجز', message: 'هتلغي كل كراسيك في الرحلة دي؟', confirmText: 'إلغاء الحجز', onConfirm: async () => { try { await apiTripCancelBooking(id); toast('تم إلغاء الحجز'); await load(); } catch (e) { toast(errText(e), 'err'); } } });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="رحلات المحافظات" subtitle="احجز كرسيك في عربية رايحة محافظتك" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 30 }}>
        {!!closed && <Card style={{ backgroundColor: '#FFF3E0' }}><T w="bold" color="#B26A00">{closed}</T></Card>}
        {mine.filter((m) => m.status !== 'cancelled' || true).length > 0 && (
          <>
            <T w="black" size={16}>حجوزاتي</T>
            {mine.map((m) => (
              <Card key={m.id} style={{ gap: 6, borderWidth: 1.5, borderColor: m.status === 'cancelled' ? C.red : C.green }}>
                <T w="black">إلى {m.dest} — {STATUS[m.status] || m.status}</T>
                <T size={13} color={C.sub}>{when(m.departAt)} • من {m.fromText || '—'}</T>
                <T size={13}>كراسيك: {m.mySeats.join('، ')} • {m.price * m.mySeats.length} ج ({m.price} ج للكرسي)</T>
                <T size={12.5} color={C.sub}>{m.driver.name} • {[m.driver.model, m.driver.color, m.driver.plate].filter(Boolean).join(' • ')}</T>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="اتصل بالكابتن" icon="call" small variant="soft" style={{ flex: 1 }} onPress={() => Linking.openURL(`tel:${m.driver.phone}`)} />
                  {m.status === 'open' && <Btn title="إلغاء الحجز" small variant="soft" style={{ flex: 1 }} onPress={() => cancel(m.id)} />}
                </View>
              </Card>
            ))}
          </>
        )}
        <T w="black" size={16}>رحلات متاحة</T>
        {(() => { const vs = Array.from(new Map((list || []).filter((t) => t.vehicle).map((t) => [t.vehicle!.id, t.vehicle!.name])).entries()); return vs.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}><Chip label="الكل" active={veh === null} onPress={() => setVeh(null)} />{vs.map(([id, name]) => <Chip key={id} label={String(name)} active={veh === id} onPress={() => setVeh(id)} />)}</ScrollView> : null; })()}
        {list === null ? <Empty title="جاري التحميل..." /> : list.filter((t) => veh === null || t.vehicle?.id === veh).length === 0 ? <Empty title="مفيش رحلات معلنة دلوقتي" /> : list.filter((t) => veh === null || t.vehicle?.id === veh).map((t) => {
          const sel = pick[t.id] || [];
          return (
            <Card key={t.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <T w="black" size={17}>🚗 إلى {t.dest}</T>
                {!!t.vehicle && <View style={{ backgroundColor: C.greenSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}><T w="black" size={11.5} color={C.green}>{t.vehicle.name}</T></View>}
                <T w="black" size={17} color={C.green}>{t.price} ج</T>
              </View>
              <T size={13} color={C.sub}>{when(t.departAt)}{t.fromText ? ` • من ${t.fromText}` : ''}</T>
              {!!t.note && <T size={13}>{t.note}</T>}
              {t.driver && <T size={12.5} color={C.sub}>{t.driver.name} • {[t.driver.model, t.driver.color, t.driver.plate].filter(Boolean).join(' • ')}</T>}
              <T size={13} w="bold">{t.free > 0 ? `فاضل ${t.free} من ${t.seats} كراسي` : 'اكتمل العدد'}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {Array.from({ length: t.seats }, (_, i) => i + 1).map((n) => {
                  const taken = t.booked.includes(n), mineSeat = (t.mine || []).includes(n), on = sel.includes(n);
                  return (
                    <Pressable key={n} disabled={taken} onPress={() => toggle(t.id, n)} style={{ width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: mineSeat ? C.gold : taken ? '#E3E6E3' : on ? C.green : C.greenSoft, ...(taken ? {} : shadow) }}>
                      <T w="black" color={mineSeat ? '#fff' : taken ? '#9AA39C' : on ? '#fff' : C.green}>{n}</T>
                    </Pressable>
                  );
                })}
              </View>
              <T size={11.5} color={C.sub}>الرمادي محجوز • الذهبي كراسيك</T>
              <Btn title={sel.length ? `احجز ${sel.length} كرسي — ${sel.length * t.price} ج` : 'اختار كراسيك'} icon="checkmark-circle" disabled={!!closed || t.free === 0} loading={busy === t.id} onPress={() => book(t)} />
            </Card>
          );
        })}
      </ScrollView>
    </View>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Captain: announce a trip (where, when, seats, price), see who booked, start / finish / cancel. */
export function CaptainTripsScreen({ navigation }: any) {
  const [list, setList] = useState<Trip[] | null>(null);
  const [dest, setDest] = useState(''); const [fromText, setFromText] = useState(''); const [seats, setSeats] = useState('4'); const [price, setPrice] = useState(''); const [note, setNote] = useState('');
  const [dayOff, setDayOff] = useState(1); const [time, setTime] = useState('08:00');
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const load = useCallback(async () => { try { const r = await apiCaptainTrips(); setList(r.trips); setAllowed(r.allowed !== false); } catch (e) { toast(errText(e), 'err'); setList((l) => l || []); } }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const dayLabel = (off: number) => { const d = new Date(); d.setDate(d.getDate() + off); return off === 0 ? 'النهاردة' : off === 1 ? 'بكرة' : `${DAYS[(d.getDay() + 1) % 7]} ${d.getDate()}/${d.getMonth() + 1}`; };
  const create = async () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return toast('اكتب الوقت بالشكل 08:30 (24 ساعة)', 'err');
    if (dest.trim().length < 2) return toast('اكتب المحافظة', 'err');
    const n = Number(seats), p = Number(price);
    if (!(n >= 1 && n <= 50)) return toast('عدد الكراسي من 1 إلى 50', 'err');
    if (!(p > 0)) return toast('اكتب سعر الكرسي', 'err');
    const d = new Date(); d.setDate(d.getDate() + dayOff); d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() < Date.now() + 5 * 60000) return toast('الموعد لازم يكون في المستقبل', 'err');
    setBusy(true);
    try { const r = await apiCaptainTripCreate({ dest: dest.trim(), fromText: fromText.trim(), departAt: d.toISOString(), seats: n, price: p, note: note.trim() }); toast(`تم الإعلان وجه الإشعار لـ ${r.notified} عميل 🔔`); setDest(''); setNote(''); await load(); }
    catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="رحلات المحافظات" subtitle="أعلن عن رحلة والعملاء يحجزوا كراسي" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
        {!allowed && <Card><T w="bold" color={C.red} align="center">نوع مركبتك مش مسموح له بإعلان رحلات المحافظات</T></Card>}
        {allowed && <Card style={{ gap: 8 }}>
          <T w="black">إعلان رحلة جديدة</T>
          <Field label="رايح محافظة / مدينة" value={dest} onChangeText={setDest} />
          <Field label="من فين (اختياري)" value={fromText} onChangeText={setFromText} />
          <T size={12.5} w="bold">اليوم</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{[0, 1, 2, 3, 4, 5, 6].map((o) => <Chip key={o} label={dayLabel(o)} active={dayOff === o} onPress={() => setDayOff(o)} />)}</ScrollView>
          <Field label="الساعة (مثال 08:30 أو 18:00)" value={time} onChangeText={setTime} />
          <Field label="عدد الكراسي" value={seats} onChangeText={setSeats} keyboardType="number-pad" />
          <Field label="سعر الكرسي (ج)" value={price} onChangeText={setPrice} keyboardType="number-pad" />
          <Field label="ملاحظات (اختياري)" value={note} onChangeText={setNote} />
          <Btn title="أعلن الرحلة وابعت إشعار للعملاء" icon="megaphone" onPress={create} loading={busy} />
        </Card>}
        <T w="black" size={16}>رحلاتي</T>
        {list === null ? <Empty title="جاري التحميل..." /> : list.length === 0 ? <Empty title="لسه ما أعلنتش عن رحلات" /> : list.map((t) => (
          <Card key={t.id} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T w="black">إلى {t.dest}</T><T color={C.green} w="bold">{STATUS[t.status] || t.status}</T></View>
            <T size={13} color={C.sub}>{when(t.departAt)} • {t.price} ج للكرسي • محجوز {t.seats - t.free} من {t.seats}</T>
            {(t.passengers || []).map((p) => (
              <Pressable key={p.seat} onPress={() => Linking.openURL(`tel:${p.phone}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.greenSoft, borderRadius: 10, padding: 8 }}>
                <T w="black" color={C.green}>{p.seat}</T><T style={{ flex: 1 }}>{p.name}</T><Icon name="call" size={18} color={C.green} /><T size={12} color={C.sub}>{p.phone}</T>
              </Pressable>
            ))}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {t.status === 'open' && <Btn title="بدأنا الرحلة" icon="play" small style={{ flex: 1 }} onPress={() => run(() => apiCaptainTripStatus(t.id, 'started'), 'الرحلة بدأت')} />}
              {t.status === 'started' && <Btn title="خلصنا" icon="checkmark-circle" small style={{ flex: 1 }} onPress={() => run(() => apiCaptainTripStatus(t.id, 'done'), 'تمت الرحلة')} />}
              {(t.status === 'open' || t.status === 'started') && <Btn title="إلغاء الرحلة" small variant="soft" style={{ flex: 1 }} onPress={() => confirmDialog({ title: 'إلغاء الرحلة', message: t.free < t.seats ? 'العملاء اللي حجزوا هيتبلغوا بالإلغاء.' : 'هتلغي الرحلة؟', confirmText: 'إلغاء الرحلة', onConfirm: () => run(() => apiCaptainTripCancel(t.id), 'تم الإلغاء') })} />}
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
