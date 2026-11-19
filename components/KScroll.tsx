import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView as RNScrollView, Keyboard, Platform, StyleSheet, TextInput, findNodeHandle } from 'react-native';

/**
 * The app's ScrollView. It behaves exactly like the normal one, except while the keyboard is open:
 * room is left under the content (only as much as the keyboard really covers) and the field being typed in is scrolled into view,
 * so every typing screen in the app stays easy: you always see what you write.
 */
export const ScrollView = forwardRef<any, any>(function KScrollView(props, fwd) {
  const inner = useRef<any>(null);
  const [pad, setPad] = useState(0);
  const setRef = useCallback((r: any) => {
    inner.current = r;
    if (typeof fwd === 'function') fwd(r); else if (fwd) (fwd as any).current = r;
  }, [fwd]);
  const horizontal = !!props.horizontal;
  useEffect(() => {
    if (Platform.OS === 'web' || horizontal) return;
    const show = Keyboard.addListener('keyboardDidShow', (e: any) => {
      const kbTop = e?.endCoordinates?.screenY;
      try {
        inner.current?.measureInWindow?.((_x: number, y: number, _w: number, h: number) => {
          const covered = typeof kbTop === 'number' ? Math.max(0, y + h - kbTop) : 0;
          setPad(covered);
          setTimeout(() => {
            try {
              const input = (TextInput as any).State?.currentlyFocusedInput?.();
              const node = input && findNodeHandle(input);
              if (node && inner.current?.scrollResponderScrollNativeHandleToKeyboard) inner.current.scrollResponderScrollNativeHandleToKeyboard(node, 90, true);
            } catch { /* the page simply stays where it is */ }
          }, 80);
        });
      } catch { /* never break typing */ }
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setPad(0));
    return () => { show.remove(); hide.remove(); };
  }, [horizontal]);
  let cc = props.contentContainerStyle;
  if (pad > 0) { const base = StyleSheet.flatten(cc) || {}; cc = [base, { paddingBottom: (Number((base as any).paddingBottom) || 0) + pad }]; }
  return <RNScrollView {...props} ref={setRef} contentContainerStyle={cc} />;
});
export type ScrollView = any;
