import React, { useEffect, useState } from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';
import { T } from './ui';
import { C } from '../lib/theme';
import { apiAuthImage } from '../lib/api';

/** An image behind sign-in: fetched with the token, shown as a data URI. `v` reloads it. */
export function AuthImage({ path, style, v = 0, empty }: { path: string; style: StyleProp<ImageStyle>; v?: number; empty?: React.ReactNode }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let on = true; setSrc(null); apiAuthImage(path).then((x) => { if (on) setSrc(x || ''); }).catch(() => { if (on) setSrc(''); }); return () => { on = false; }; }, [path, v]);
  if (src === null) return <T size={11.5} color={C.sub}>جاري التحميل...</T>;
  if (!src) return <>{empty ?? null}</>;
  return <Image source={{ uri: src }} style={style} resizeMode="cover" />;
}
