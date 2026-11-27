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
  const html = `<html><head><meta name="viewport" content="width=device-width"><style>@page{margin:0}body{margin:0}img{width:100%;display:block}</style></head><body><img src="data:image/png;base64,${b64}"/></body></html>`;
  // 80 mm = 226 pt, 58 mm = 164 pt wide; the height follows the page
  const width = Math.round(widthMm * 2.835);
  await PR().printAsync({ html, width, height: 1200 });
}
export function openWhatsAppChat(phone: string, text = '') {
  const p = String(phone || '').replace(/\D/g, '').replace(/^0/, '20');
  Linking.openURL(`https://wa.me/${p}${text ? '?text=' + encodeURIComponent(text) : ''}`).catch(() => {});
}
