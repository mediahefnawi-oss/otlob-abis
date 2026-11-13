import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { mapHtml, MapMarker, MapLine } from '../lib/mapHtml';

/** Phone: the Leaflet page inside a WebView (react-native-webview is added by the APK build). */
export default function MapView({ markers, lines, fitKey, height = 220, pickable, onPick }: { markers: MapMarker[]; lines?: MapLine[]; fitKey?: string | number; height?: number; pickable?: boolean; onPick?: (p: { lat: number; lng: number }) => void }) {
  const WebView = require('react-native-webview').WebView;
  const ref = useRef<any>(null);
  const lastFit = useRef(fitKey);
  const first = useRef(mapHtml(markers, { pickable, lines }));
  useEffect(() => {
    const refit = lastFit.current !== fitKey; lastFit.current = fitKey;
    try { ref.current?.postMessage(JSON.stringify({ markers, lines, refit })); } catch { /* the map is optional */ }
  }, [JSON.stringify(markers), JSON.stringify(lines || []), fitKey]);
  return (
    <View style={{ height, borderRadius: 16, overflow: 'hidden', backgroundColor: '#E9EEE8' }}>
      <WebView
        ref={ref} originWhitelist={['*']} source={{ html: first.current, baseUrl: 'https://otlobabis.com' }} javaScriptEnabled domStorageEnabled
        nestedScrollEnabled setSupportMultipleWindows={false}
        onMessage={(e: any) => { try { const d = JSON.parse(e.nativeEvent.data); if (d.picked && onPick) onPick(d.picked); } catch { /* not ours */ } }}
        style={{ backgroundColor: '#E9EEE8' }}
      />
    </View>
  );
}
