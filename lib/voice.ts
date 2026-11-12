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

/** data URL -> a temporary blob address (browsers play these more reliably than a long data URL, and a recording without a stored length plays too) */
function toBlobUrl(dataUrl: string): string | null {
  try {
    const m = /^data:([^,]*?);base64,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: m[1].replace(/;base64$/, '') || 'audio/webm' }));
  } catch { return null; }
}

/**
 * Plays a recording. Returns a function that stops it. `onEnd` is called when it finishes by itself; `onError` (optional) says why it could not
 * play: 'blocked' = the browser wants another tap, 'format' = this device cannot play that recording, 'other'.
 */
export function playAudio(dataUrl: string, onEnd: () => void, onError?: (why: 'blocked' | 'format' | 'other') => void): () => void {
  const url = toBlobUrl(dataUrl);
  const a = new (globalThis as any).Audio(url || dataUrl);
  let dead = false;
  const done = () => { if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } } };
  const fail = (why: 'blocked' | 'format' | 'other') => { if (dead) return; dead = true; done(); if (onError) onError(why); else onEnd(); };
  a.onended = () => { if (!dead) { dead = true; done(); onEnd(); } };
  a.onerror = () => fail(a.error && a.error.code === 4 ? 'format' : 'other');
  a.preload = 'auto';
  const p = a.play();
  if (p && p.catch) p.catch((e: any) => fail(e && e.name === 'NotAllowedError' ? 'blocked' : e && e.name === 'NotSupportedError' ? 'format' : 'other'));
  return () => { dead = true; try { a.pause(); } catch { /* ignore */ } done(); };
}
