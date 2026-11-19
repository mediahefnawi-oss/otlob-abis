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
  const offY = useRef(0);   // where the page is scrolled to now
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
          // once the room under the content exists, move the page so the field being typed in sits just above the keyboard
          setTimeout(() => {
            try {
              const input = (TextInput as any).State?.currentlyFocusedInput?.();
              if (!input || typeof kbTop !== 'number' || !input.measureInWindow) return;
              input.measureInWindow((_ix: number, iy: number, _iw: number, ih: number) => {
                const over = iy + ih + 28 - kbTop;                    // how far the field's bottom is below the free area
                if (over > 0) inner.current?.scrollTo?.({ y: Math.max(0, offY.current + over), animated: true });
                else if (iy < y + 8) inner.current?.scrollTo?.({ y: Math.max(0, offY.current + (iy - y - 40)), animated: true });
              });
            } catch { /* the page simply stays where it is */ }
          }, 140);
        });
      } catch { /* never break typing */ }
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setPad(0));
    return () => { show.remove(); hide.remove(); };
  }, [horizontal]);
  let cc = props.contentContainerStyle;
  if (pad > 0) { const base = StyleSheet.flatten(cc) || {}; cc = [base, { paddingBottom: (Number((base as any).paddingBottom) || 0) + pad }]; }
  const onScroll = useCallback((ev: any) => { offY.current = ev?.nativeEvent?.contentOffset?.y || 0; if (props.onScroll) props.onScroll(ev); }, [props.onScroll]);
  return <RNScrollView scrollEventThrottle={16} {...props} onScroll={horizontal ? props.onScroll : onScroll} ref={setRef} contentContainerStyle={cc} />;
});
export type ScrollView = any;
