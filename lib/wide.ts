import { useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

/** Web only: a wide window (a computer) gets a side menu; phones and the app never do. */
export const WIDE_MIN = 1000;
export const useWide = () => {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= WIDE_MIN;
};

export type NavItem = { key: string; label: string; icon: string; badge?: number };
export type NavState = { items: NavItem[]; active: string; go: (k: string) => void } | null;

let state: NavState = null;
const subs = new Set<() => void>();

/** The tab host publishes its tabs here so the side menu (outside the navigator) can show them. */
export function setNav(s: NavState) {
  state = s;
  subs.forEach((f) => f());
}

export function useNav(): NavState {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  return state;
}
