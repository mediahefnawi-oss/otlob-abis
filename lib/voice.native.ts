/**
 * Voice order, Android / iPhone build: records with expo-audio (small mono AAC, about 24 kbit/s) and plays with it.
 * The dependency is loaded lazily so a build without it still opens; the recording button then says it is unavailable.
 */
export const MAX_SECONDS = 45;
export type Recorded = { audio: string; seconds: number };

let lib: any = null;
function load() { if (lib === null) { try { lib = require('expo-audio'); } catch { lib = false; } } return lib; }
export const canRecord = true;

let rec: any = null, startedAt = 0;

export async function startRecording(): Promise<boolean> {
  try {
    const A = load(); if (!A) return false;
    const perm = await A.AudioModule.requestRecordingPermissionsAsync();
    if (!perm || !perm.granted) return false;
    await A.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    rec = new A.AudioModule.AudioRecorder({ ...A.RecordingPresets.LOW_QUALITY, sampleRate: 16000, numberOfChannels: 1, bitRate: 24000 });
    await rec.prepareToRecordAsync();
    rec.record();
    startedAt = Date.now();
    return true;
  } catch {
    rec = null;
    return false;
  }
}
export async function stopRecording(): Promise<Recorded | null> {
  const r = rec; rec = null;
  if (!r) return null;
  try {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    await r.stop();
    const A = load();
    try { await A.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }); } catch { /* ignore */ }
    const uri = r.uri; if (!uri) return null;
    const blob = await (await fetch(uri)).blob();
    const data: string | null = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onerror = () => resolve(null);
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.readAsDataURL(blob);
    });
    if (!data) return null;
    // the file reader may label it application/octet-stream: the server wants an audio type
    const b64 = data.slice(data.indexOf(',') + 1);
    return { audio: `data:audio/mp4;base64,${b64}`, seconds: Math.min(seconds, MAX_SECONDS) };
  } catch {
    return null;
  }
}
export async function cancelRecording() { try { await rec?.stop(); } catch { /* ignore */ } rec = null; }

export function playAudio(dataUrl: string, onEnd: () => void): () => void {
  try {
    const A = load(); if (!A) { onEnd(); return () => {}; }
    const player = A.createAudioPlayer({ uri: dataUrl });
    const sub = player.addListener('playbackStatusUpdate', (s: any) => { if (s && s.didJustFinish) { try { sub.remove(); player.remove(); } catch { /* ignore */ } onEnd(); } });
    player.play();
    return () => { try { sub.remove(); player.pause(); player.remove(); } catch { /* ignore */ } };
  } catch {
    onEnd();
    return () => {};
  }
}
