/**
 * The map is a small Leaflet page over free OpenStreetMap tiles (no key, no cost). It is shown inside a WebView on the phone
 * and an iframe on the web. The page receives new markers and route lines through window.setMarkers([...], refit, lines) so the map never reloads.
 */
export type MapMarker = { lat: number; lng: number; kind: 'courier' | 'shop' | 'dest' | 'me'; label?: string };
/** base = the whole planned route (faint), done = the part already travelled, todo = what is left. */
export type MapLine = { kind: 'base' | 'done' | 'todo'; pts: [number, number][] };
const ICON: Record<MapMarker['kind'], string> = { courier: '🛵', shop: '🏪', dest: '🏠', me: '📍' };
export const MARKER_ICON = ICON;

const SVG = (inner: string, c: string, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const BIKE = SVG('<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17L9 8h5l4.5 9M9 8H7M14 8l-2.5 9"/>', '#F2B51D', 22);
const STORE = SVG('<path d="M3 9l1.6-5h14.8L21 9M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12v8h14v-8M10 20v-5h4v5"/>', '#0E7A4F', 20);
const HOME = SVG('<path d="M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5"/>', '#00211A', 18);

export function mapHtml(markers: MapMarker[], opts: { pickable?: boolean; lines?: MapLine[] } = {}) {
  const first = JSON.stringify(markers);
  const firstLines = JSON.stringify(opts.lines || []);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;height:100%;width:100%;background:#EEEDE6}
.pin{font-size:26px;line-height:30px;text-align:center;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
.pc{width:40px;height:40px;border-radius:50%;background:#00211A;border:2.5px solid #F2B51D;display:flex;align-items:center;justify-content:center;margin:0 auto;box-shadow:0 0 0 7px rgba(14,122,79,.2),0 3px 8px rgba(0,0,0,.35)}
.ps{width:32px;height:32px;border-radius:50%;background:#fff;border:2.5px solid #0E7A4F;display:flex;align-items:center;justify-content:center;margin:4px auto 0;box-shadow:0 2px 6px rgba(0,0,0,.3)}
.pd{width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#F2B51D;border:2.5px solid #fff;margin:0 auto;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
.pd>div{transform:rotate(45deg);display:flex}
.lbl{font:700 11px sans-serif;background:#00211A;color:#fff;border-radius:10px;padding:2px 8px;white-space:nowrap;text-align:center;margin:3px auto 0;width:max-content}
.leaflet-control-attribution{font-size:9px}.leaflet-bar a{width:30px;height:30px;line-height:30px}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
if(typeof L==='undefined'){document.body.innerHTML='<p style="font:14px sans-serif;text-align:center;padding:24px;color:#5B6B65">تعذر تحميل الخريطة، تأكد من اتصال الإنترنت</p>';throw new Error('no map');}
var ICON=${JSON.stringify(ICON)};var SV={courier:${JSON.stringify(BIKE)},shop:${JSON.stringify(STORE)},dest:${JSON.stringify(HOME)}};
var map=L.map('m',{zoomControl:true,attributionControl:true}).setView([31.0,29.95],13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
var layer=L.layerGroup().addTo(map),lineLayer=L.layerGroup().addTo(map),fitted=false,pick=${opts.pickable ? 'true' : 'false'};
var cm=null,cmKey='',anim=null;
function esc(s){return String(s).replace(/[<>&"]/g,'')}
function pinHtml(m){
  var lbl=m.label?'<div class="lbl">'+esc(m.label)+'</div>':'';
  if(m.kind==='courier')return '<div class="pc">'+SV.courier+'</div>'+lbl;
  if(m.kind==='shop')return '<div class="ps">'+SV.shop+'</div>'+lbl;
  if(m.kind==='dest')return '<div class="pd"><div>'+SV.dest+'</div></div>'+lbl;
  return '<div class="pin">'+ICON[m.kind]+'</div>'+lbl;
}
function mk(m){return L.marker([m.lat,m.lng],{icon:L.divIcon({className:'',html:pinHtml(m),iconSize:[64,60],iconAnchor:[32,m.kind==='dest'?34:24]})})}
function glide(marker,to){
  if(anim)cancelAnimationFrame(anim);
  var a=marker.getLatLng(),t0=Date.now(),D=900;
  (function step(){var k=Math.min(1,(Date.now()-t0)/D);marker.setLatLng([a.lat+(to[0]-a.lat)*k,a.lng+(to[1]-a.lng)*k]);if(k<1)anim=requestAnimationFrame(step)})();
}
function drawLines(lines){
  lineLayer.clearLayers();
  var st={base:{color:'#0A5A3C',weight:10,opacity:.16,lineCap:'round',lineJoin:'round'},todo:{color:'#6E9A88',weight:5,opacity:.95,dashArray:'1 9',lineCap:'round',lineJoin:'round'},done:{color:'#0E7A4F',weight:6,opacity:1,lineCap:'round',lineJoin:'round'}};
  ['base','todo','done'].forEach(function(k){lines.forEach(function(l){if(l.kind===k&&l.pts&&l.pts.length>1)L.polyline(l.pts,st[k]).addTo(lineLayer)})});
}
function setMarkers(list,refit,lines){
  var pts=[];
  if(lines)drawLines(lines);
  var couriers=list.filter(function(m){return m.kind==='courier'});
  var smooth=couriers.length===1&&cm&&cmKey===(couriers[0].label||'');
  layer.clearLayers();
  if(!smooth&&cm){cm=null;}
  list.forEach(function(m){
    pts.push([m.lat,m.lng]);
    if(m.kind==='courier'&&couriers.length===1){
      if(smooth){glide(cm,[m.lat,m.lng]);cm.addTo(layer);}
      else{cm=mk(m).addTo(layer);cmKey=m.label||'';}
      return;
    }
    mk(m).addTo(layer);
  });
  if(!couriers.length)cm=null;
  if(lines)lines.forEach(function(l){if(l.kind==='base'||l.kind==='todo')l.pts.forEach(function(p){pts.push(p)})});
  if(pts.length&&(!fitted||refit)){fitted=true;if(pts.length==1)map.setView(pts[0],16);else map.fitBounds(pts,{padding:[44,44],maxZoom:17});}
}
window.setMarkers=setMarkers;
function onData(d){if(d&&d.markers)setMarkers(d.markers,d.refit,d.lines)}
document.addEventListener('message',function(e){try{onData(JSON.parse(e.data))}catch(x){}});
window.addEventListener('message',function(e){try{onData(typeof e.data==='string'?JSON.parse(e.data):e.data)}catch(x){}});
if(pick){map.on('click',function(e){var m=[{lat:e.latlng.lat,lng:e.latlng.lng,kind:'me'}];setMarkers(m,false);var s=JSON.stringify({picked:{lat:e.latlng.lat,lng:e.latlng.lng}});if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(s);else parent.postMessage(s,'*');});}
setMarkers(${first},true,${firstLines});
</script></body></html>`;
}
