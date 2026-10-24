import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

/**
 * Web only: every browser tab shares one login by default. To test several roles at once (customer, shop,
 * courier, owner) open the app with ?session=tab in each tab; that tab then keeps its own login, cart and cache.
 */
function detectTabSession(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    if (/[?&]session=tab\b/.test(window.location.search)) window.sessionStorage.setItem('abis_tab_session', '1');
    return window.sessionStorage.getItem('abis_tab_session') === '1';
  } catch { return false; }
}
export const isTabSession = detectTabSession();

export const storage = {
  getItem(k: string): Promise<string | null> {
    return isTabSession ? Promise.resolve(window.sessionStorage.getItem(k)) : AsyncStorage.getItem(k);
  },
  setItem(k: string, v: string): Promise<void> {
    if (isTabSession) { window.sessionStorage.setItem(k, v); return Promise.resolve(); }
    return AsyncStorage.setItem(k, v);
  },
  removeItem(k: string): Promise<void> {
    if (isTabSession) { window.sessionStorage.removeItem(k); return Promise.resolve(); }
    return AsyncStorage.removeItem(k);
  },
};
