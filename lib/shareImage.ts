/** Web: turns a drawn invoice into a PNG, shares it (phone browsers) or downloads it, prints it, opens WhatsApp. */
export async function captureView(node: any): Promise<string> {
  const el: HTMLElement | null = node && (node as any).nodeType ? node : (node && node._nativeTag ? null : null);
  if (!el) throw new Error('تعذر تجهيز صورة الفاتورة');
  const h2c: any = (await import('html2canvas')).default;
  const canvas = await h2c(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
  return canvas.toDataURL('image/png');
}
const toBlob = async (dataUri: string) => (await fetch(dataUri)).blob();

/** the phone's share sheet when the browser has one (the person picks WhatsApp and the chat), otherwise the file is downloaded */
export async function shareImage(dataUri: string, name: string, text: string): Promise<'shared' | 'downloaded'> {
  const blob = await toBlob(dataUri);
  const file = new File([blob], name + '.png', { type: 'image/png' });
  const nav: any = navigator;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try { await nav.share({ files: [file], text }); return 'shared'; } catch (e: any) { if (e && e.name === 'AbortError') return 'shared'; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '.png';
  document.body.appendChild(a); a.click(); a.remove();
  return 'downloaded';
}
export async function printImage(dataUri: string, widthMm: number): Promise<void> {
  const w = window.open('', '_blank');
  if (!w) throw new Error('اسمح بفتح النوافذ المنبثقة للطباعة');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0;size:${widthMm}mm auto}html,body{margin:0;background:#fff}img{width:${widthMm}mm;display:block}</style></head><body><img src="${dataUri}" onload="setTimeout(function(){window.print()},200)"></body></html>`);
  w.document.close();
}
export function openWhatsAppChat(phone: string, text = '') {
  const p = String(phone || '').replace(/\D/g, '').replace(/^0/, '20');
  const url = `https://wa.me/${p}${text ? '?text=' + encodeURIComponent(text) : ''}`;
  window.open(url, '_blank');
}
