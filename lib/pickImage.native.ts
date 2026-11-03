/**
 * Android / iPhone build: choose a picture from the gallery (or the camera) and shrink it to a small JPEG
 * so it uploads fast. The web build uses pickImage.ts instead (Metro picks this file only for native builds).
 */
export const canPickImage = true;

export async function pickImage(max = 1100, _png = false): Promise<string | null> {
  try {
    const ImagePicker = require('expo-image-picker');
    const Manipulator = require('expo-image-manipulator');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm && perm.granted === false) return null;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false });
    if (res.canceled || !res.assets || !res.assets[0]) return null;
    const a = res.assets[0];
    const w = a.width || max, h = a.height || max;
    const scale = Math.min(1, max / Math.max(w, h));
    for (const q of [0.72, 0.6, 0.5, 0.4, 0.3]) {
      const out = await Manipulator.manipulateAsync(a.uri, scale < 1 ? [{ resize: { width: Math.round(w * scale), height: Math.round(h * scale) } }] : [], { compress: q, format: Manipulator.SaveFormat.JPEG, base64: true });
      const data = out.base64 ? `data:image/jpeg;base64,${out.base64}` : '';
      // the server accepts up to ~600 KB of text
      if (data && data.length < 560000) return data;
    }
    return null;
  } catch {
    return null;
  }
}
