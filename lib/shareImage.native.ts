import { Linking } from 'react-native';
/** Phone app: view-shot draws the invoice to a PNG; expo-sharing opens the share sheet; expo-print sends it to the (Bluetooth / Wi-Fi) printer. */
const VS = (): any => require('react-native-view-shot');
const SH = (): any => require('expo-sharing');
const PR = (): any => require('expo-print');
const FS = (): any => require('expo-file-system/legacy');

export async function captureView(node: any): Promise<string> {
  const uri: string = await VS().captureRef(node, { format: 'png', quality: 1, result: 'tmpfile', pixelRatio: 3 });
  return uri;
}
export async function shareImage(uri: string, _name: string, _text: string): Promise<'shared' | 'downloaded'> {
  const S = SH();
  if (!(await S.isAvailableAsync())) throw new Error('المشاركة غير متاحة على هذا الجهاز');
  await S.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'إرسال الفاتورة' });
  return 'shared';
}
export async function printImage(uri: string, widthMm: number): Promise<void> {
  const b64: string = await FS().readAsStringAsync(uri, { encoding: 'base64' });
  // the picture is exactly the printable width of the roll (72 mm / 48 mm); the paper size is the one chosen in the print dialog
  const html = `<html><head><meta name="viewport" content="width=device-width"><style>@page{margin:0}html,body{margin:0;padding:0;background:#fff}img{width:${widthMm}mm;display:block}</style></head><body><img src="data:image/png;base64,${b64}"/></body></html>`;
  await PR().printAsync({ html });
}
export function openWhatsAppChat(phone: string, text = '') {
  const p = String(phone || '').replace(/\D/g, '').replace(/^0/, '20');
  Linking.openURL(`https://wa.me/${p}${text ? '?text=' + encodeURIComponent(text) : ''}`).catch(() => {});
}
