import { Platform } from 'react-native';

/**
 * One place to make the whole app a little smaller (text, icons, buttons, round badges).
 * Change these two numbers to tune it: 1 = the old size.
 */
export const PHONE_SCALE = 1; // phones and narrow windows (app + web): the original size
export const DESKTOP_SCALE = 0.9; // wide web windows (a computer)

let phoneScale = PHONE_SCALE;
let desktopScale = DESKTOP_SCALE;
/** The owner's choice from the control panel (falls back to the defaults above). */
export const setScaleConfig = (phone?: number, desktop?: number) => {
  phoneScale = phone && phone >= 0.8 && phone <= 1.2 ? phone : PHONE_SCALE;
  desktopScale = desktop && desktop >= 0.8 && desktop <= 1.2 ? desktop : DESKTOP_SCALE;
};
let cur = Platform.OS === 'web' && typeof window !== 'undefined' && window.innerWidth >= 1000 ? DESKTOP_SCALE : PHONE_SCALE;
export const setUiScale = (wide: boolean) => { cur = wide ? desktopScale : phoneScale; };

/** Scales a size (icons, paddings, round badges). */
export const sc = (n: number) => Math.round(n * cur * 10) / 10;
/** Scales a font size but never below 10 (small captions that are already tiny stay as they are). */
export const fs = (n: number) => (n <= 10 ? n : Math.max(10, sc(n)));
