import React, { useEffect, useRef, useState } from 'react';
import { View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, toast } from './ui';
import { useStore } from '../lib/store';
import { apiRequest } from '../lib/api';
import { canRecord, startRecording, stopRecording, cancelRecording, playAudio, MAX_SECONDS, Recorded } from '../lib/voice';

/** Record up to 45 seconds. Shown only when the owner switched "voice" on. `onChange` gets the recording, or null when deleted. */
export function VoiceRecorder({ value, onChange }: { value: Recorded | null; onChange: (v: Recorded | null) => void }) {
  const { db } = useStore();
  const [rec, setRec] = useState(false);
  const [secs, setSecs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<any>(null);
  const stopPlay = useRef<null | (() => void)>(null);
  useEffect(() => () => { clearInterval(timer.current); stopPlay.current?.(); cancelRecording(); }, []);
  if (!db.settings.features?.voice) return null;

  const finish = async () => {
    clearInterval(timer.current);
    setRec(false);
    const r = await stopRecording();
    if (!r) return toast('التسجيل ما اشتغلش، جرّب تاني', 'err');
    onChange(r);
  };
  const begin = async () => {
    if (!canRecord) return toast('التسجيل غير متاح في المتصفح ده', 'info');
    const ok = await startRecording();
    if (!ok) return toast('ما قدرناش نفتح الميكروفون. اسمح للتطبيق بالميكروفون وجرّب تاني', 'err');
    setRec(true); setSecs(0);
    let n = 0;
    timer.current = setInterval(() => { n += 1; setSecs(n); if (n >= MAX_SECONDS) finish(); }, 1000);
  };
  const play = () => {
    if (!value) return;
    if (playing) { stopPlay.current?.(); setPlaying(false); return; }
    setPlaying(true);
    stopPlay.current = playAudio(value.audio, () => setPlaying(false), (why) => { setPlaying(false); toast(why === 'format' ? 'الجهاز ده مش قادر يشغّل التسجيل' : 'ما اشتغلش، اضغط تاني', 'err'); });
  };

  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={26}>🎤</T>
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>قول طلبك بصوتك</T>
          <T size={12} color={C.sub}>{rec ? `بنسجّل... ${secs} / ${MAX_SECONDS} ثانية` : value ? `تسجيل ${value.seconds} ثانية جاهز` : `اضغط وسجّل لحد ${MAX_SECONDS} ثانية بدل ما تكتب`}</T>
        </View>
      </View>
      {rec ? (
        <Btn variant="danger" icon="stop" title="إيقاف التسجيل" onPress={finish} />
      ) : value ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn variant="soft" icon={playing ? 'pause' : 'play'} title={playing ? 'إيقاف' : 'اسمع التسجيل'} style={{ flex: 1 }} onPress={play} />
          <Btn variant="soft" icon="mic" title="سجّل تاني" style={{ flex: 1 }} onPress={() => { stopPlay.current?.(); setPlaying(false); onChange(null); begin(); }} />
          <Btn variant="danger" icon="trash" title="حذف" style={{ flex: 0.6 }} onPress={() => { stopPlay.current?.(); setPlaying(false); onChange(null); }} />
        </View>
      ) : (
        <Btn variant="soft" icon="mic" title="ابدأ التسجيل" onPress={begin} />
      )}
    </Card>
  );
}

/** On an order: the shop / courier / customer taps to hear the recording (fetched only then, so the sync stays light). */
export function VoicePlayer({ orderId, secs }: { orderId: string; secs?: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const stop = useRef<null | (() => void)>(null);
  const audio = useRef<string | null>(null);
  useEffect(() => () => { stop.current?.(); }, []);
  const tap = async () => {
    if (state === 'playing') { stop.current?.(); return setState('idle'); }
    try {
      if (!audio.current) {
        setState('loading');
        const r = await apiRequest<{ audio: string; seconds: number }>(`/api/orders/${encodeURIComponent(orderId)}/voice`);
        audio.current = r.audio;
      }
      setState('playing');
      stop.current = playAudio(audio.current, () => setState('idle'), (why) => {
        setState('idle');
        // 'blocked': the browser wants the tap itself to start the sound; the recording is already downloaded, so the next tap plays at once
        toast(why === 'blocked' ? 'اضغط مرة تانية للتشغيل ▶️' : why === 'format' ? 'الجهاز ده مش قادر يشغّل التسجيل. جرّب من متصفح تاني أو من التطبيق' : 'تعذر تشغيل التسجيل، جرّب تاني', why === 'blocked' ? 'info' : 'err');
      });
    } catch (e: any) {
      setState('idle');
      toast(e?.message || 'تعذر تشغيل التسجيل', 'err');
    }
  };
  return (
    <Pressable onPress={tap} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.white, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: C.line }}>
      <T size={20}>{state === 'playing' ? '⏸️' : '▶️'}</T>
      <T w="bold" size={13} style={{ flex: 1 }}>🎤 رسالة صوتية{secs ? ` (${secs} ثانية)` : ''}</T>
      <T size={12} color={C.sub}>{state === 'loading' ? 'بتحمّل...' : state === 'playing' ? 'اضغط للإيقاف' : 'اضغط للسماع'}</T>
    </Pressable>
  );
}
