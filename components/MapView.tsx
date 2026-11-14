import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { mapHtml, MapMarker, MapLine } from '../lib/mapHtml';

/** Web: the same Leaflet page inside an iframe. */
export default function MapView({ markers, lines, fitKey, height = 220, pickable, onPick, focus }: { focus?: { lat: number; lng: number } | null; markers: MapMarker[]; lines?: MapLine[]; fitKey?: string | number; height?: number; pickable?: boolean; onPick?: (p: { lat: number; lng: number }) => void }) {
  const ref = useRef<any>(null);
  const lastFit = useRef(fitKey);
  const first = useRef(mapHtml(markers, { pickable, lines, focus }));
  useEffect(() => {
    const w = ref.current?.contentWindow;
    if (w) { const refit = lastFit.current !== fitKey; lastFit.current = fitKey;
      try { w.postMessage(JSON.stringify({ markers, lines, refit, focus }), '*'); } catch { /* the map is optional */ } }
  }, [JSON.stringify(markers), JSON.stringify(lines || []), fitKey, focus ? `${focus.lat},${focus.lng}` : '']);
  useEffect(() => {
    const on = (e: any) => { try { const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; if (d && d.picked && onPick) onPick(d.picked); } catch { /* not ours */ } };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [onPick]);
  return (
    <View style={{ height, borderRadius: 16, overflow: 'hidden', backgroundColor: '#E9EEE8' }}>
      {React.createElement('iframe', { ref, srcDoc: first.current, style: { border: 0, width: '100%', height: '100%' }, title: 'map' })}
    </View>
  );
}
