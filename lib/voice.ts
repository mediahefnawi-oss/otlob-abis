/**
 * Voice order, web build: records with the browser microphone (MediaRecorder) and plays with an <audio> element.
 * The Android/iPhone build uses voice.native.ts (Metro picks it for native builds only).
 */
export const MAX_SECONDS = 45;
export const canRecord = typeof navigator !== 'undefined' && !!(navigator as any).mediaDevices?.getUserMedia && typeof (globalThis as any).MediaRecorder !== 'undefined';
export type Recorded = { audio: string; seconds: number };

let rec: any = null, stream: any = null, chunks: any[] = [], startedAt = 0, mime = '';

export async function startRecording(): Promise<boolean> {
  try {
    stream = await (navigator as any).mediaDevices.getUserMedia({ audio: true });
    const MR = (globalThis as any).MediaRecorder;
    const pick = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MR.isTypeSupported?.(m));
    rec = pick ? new MR(stream, { mimeType: pick, audioBitsPerSecond: 24000 }) : new MR(stream);
    mime = rec.mimeType || pick || 'audio/webm';
    chunks = [];
    rec.ondataavailable = (e: any) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start();
    startedAt = Date.now();
    return true;
  } catch {
    cleanup();
    return false;
  }
}
function cleanup() {
  try { stream?.getTracks().forEach((t: any) => t.stop()); } catch { /* ignore */ }
  rec = null; stream = null;
}
export function stopRecording(): Promise<Recorded | null> {
  return new Promise((resolve) => {
    if (!rec) return resolve(null);
    const r = rec;
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    r.onstop = () => {
      cleanup();
      const blob = new Blob(chunks, { type: mime });
      const fr = new FileReader();
      fr.onerror = () => resolve(null);
      fr.onload = () => resolve(typeof fr.result === 'string' ? { audio: fr.result.replace(/^data:([^;,]+)(;[^,]*)?;base64,/, (_m, t) => `data:${t.split(';')[0]};codecs=${/opus/.test(mime) ? 'opus' : 'mp4a'};base64,`).replace(/;codecs=mp4a;base64/, ';base64'), seconds: Math.min(seconds, MAX_SECONDS) } : null);
      fr.readAsDataURL(blob);
    };
    try { r.stop(); } catch { cleanup(); resolve(null); }
  });
}
export async function cancelRecording() { try { rec?.stop(); } catch { /* ignore */ } cleanup(); }

/** Plays a recording. Returns a function that stops it; `onEnd` is called when it finishes by itself. */
export function playAudio(dataUrl: string, onEnd: () => void): () => void {
  const a = new (globalThis as any).Audio(dataUrl);
  a.onended = onEnd; a.onerror = onEnd;
  a.play().catch(onEnd);
  return () => { try { a.pause(); } catch { /* ignore */ } };
}
