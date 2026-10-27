import { Platform } from 'react-native';

/**
 * Lets the customer choose (or photograph) a prescription / shopping list and shrinks it to a small JPEG
 * so it uploads fast. Web only for now: a native build needs expo-image-picker.
 */
export const canPickImage = Platform.OS === 'web' && typeof document !== 'undefined';

function shrink(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const img = new (window as any).Image();
      img.onerror = () => resolve(null);
      img.onload = () => {
        const MAX = 1100;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // the server accepts up to ~600 KB of text: lower the quality until it fits
        for (const q of [0.72, 0.6, 0.5, 0.4, 0.3]) {
          const out = canvas.toDataURL('image/jpeg', q);
          if (out.length < 560000) return resolve(out);
        }
        resolve(null);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function pickImage(): Promise<string | null> {
  if (!canPickImage) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      resolve(file ? await shrink(file) : null);
    };
    input.click();
  });
}
