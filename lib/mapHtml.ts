/**
 * The map is a small Leaflet page over free OpenStreetMap tiles (no key, no cost). It is shown inside a WebView on the phone
 * and an iframe on the web. The page receives new markers through window.setMarkers([...]) so the map never reloads.
 */
export type MapMarker = { lat: number; lng: number; kind: 'courier' | 'shop' | 'dest' | 'me'; label?: string };
const ICON: Record<MapMarker['kind'], string> = { courier: '🛵', shop: '🏪', dest: '🏠', me: '📍' };
export const MARKER_ICON = ICON;

export function mapHtml(markers: MapMarker[], opts: { pickable?: boolean } = {}) {
  const first = JSON.stringify(markers);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;height:100%;width:100%;background:#E9EEE8}.pin{font-size:26px;line-height:30px;text-align:center;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}.lbl{font:700 11px sans-serif;background:#00211A;color:#fff;border-radius:8px;padding:2px 6px;white-space:nowrap}.leaflet-control-attribution{font-size:9px}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
if(typeof L==='undefined'){document.body.innerHTML='<p style="font:14px sans-serif;text-align:center;padding:24px;color:#5B6B65">تعذر تحميل الخريطة، تأكد من اتصال الإنترنت</p>';throw new Error('no map');}
var ICON=${JSON.stringify(ICON)};
var map=L.map('m',{zoomControl:true,attributionControl:true}).setView([31.0,29.95],13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
var layer=L.layerGroup().addTo(map),fitted=false,pick=${opts.pickable ? 'true' : 'false'};
function setMarkers(list,refit){
  layer.clearLayers();var pts=[];
  list.forEach(function(m){
    var h='<div class="pin">'+ICON[m.kind]+'</div>'+(m.label?'<div class="lbl">'+String(m.label).replace(/</g,'')+'</div>':'');
    L.marker([m.lat,m.lng],{icon:L.divIcon({className:'',html:h,iconSize:[60,46],iconAnchor:[30,30]})}).addTo(layer);pts.push([m.lat,m.lng]);
  });
  if(pts.length&&(!fitted||refit)){fitted=true;if(pts.length==1)map.setView(pts[0],16);else map.fitBounds(pts,{padding:[40,40],maxZoom:17});}
}
window.setMarkers=setMarkers;
document.addEventListener('message',function(e){try{var d=JSON.parse(e.data);setMarkers(d.markers,d.refit)}catch(x){}});
window.addEventListener('message',function(e){try{var d=typeof e.data==='string'?JSON.parse(e.data):e.data;if(d&&d.markers)setMarkers(d.markers,d.refit)}catch(x){}});
if(pick){map.on('click',function(e){var m=[{lat:e.latlng.lat,lng:e.latlng.lng,kind:'me'}];setMarkers(m,false);var s=JSON.stringify({picked:{lat:e.latlng.lat,lng:e.latlng.lng}});if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(s);else parent.postMessage(s,'*');});}
setMarkers(${first},true);
</script></body></html>`;
}
