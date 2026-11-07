import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { mapHtml, MapMarker } from '../lib/mapHtml';

/** Web: the same Leaflet page inside an iframe. */
export default function MapView({ markers, height = 220, pickable, onPick }: { markers: MapMarker[]; height?: number; pickable?: boolean; onPick?: (p: { lat: number; lng: number }) => void }) {
  const ref = useRef<any>(null);
  const first = useRef(mapHtml(markers, { pickable }));
  useEffect(() => {
    const w = ref.current?.contentWindow;
    if (w) { try { w.postMessage(JSON.stringify({ markers, refit: false }), '*'); } catch { /* the map is optional */ } }
  }, [JSON.stringify(markers)]);
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
