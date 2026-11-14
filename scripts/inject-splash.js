// Runs after `expo export --platform web`: puts a dark-green screen with the logo straight into dist/index.html,
// so the visitor sees the brand from the first moment instead of a blank page while the big JS bundle downloads.
// App.tsx removes #boot as soon as the app has drawn its own first screen.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(file)) { console.error('inject-splash: dist/index.html not found'); process.exit(1); }
const logo = fs.readFileSync(path.join(__dirname, 'splash-logo.webp')).toString('base64');
let html = fs.readFileSync(file, 'utf8');
if (html.includes('id="boot"')) { console.log('inject-splash: already there'); process.exit(0); }
const css = '<style>html,body{background:#00211A}#boot{position:fixed;inset:0;z-index:2147483647;background:#00211A;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;transition:opacity .25s}#boot img{width:240px;max-width:60vw;height:auto}#boot i{width:22px;height:22px;border:3px solid rgba(242,181,29,.25);border-top-color:#F2B51D;border-radius:50%;animation:bs .8s linear infinite}@keyframes bs{to{transform:rotate(360deg)}}</style>';
const div = '<div id="boot"><img alt="" src="data:image/webp;base64,' + logo + '"/><i></i></div>';
if (!/<\/head>/i.test(html) || !/<body[^>]*>/i.test(html)) { console.error('inject-splash: unexpected index.html'); process.exit(1); }
html = html.replace(/<\/head>/i, css + '</head>').replace(/<body[^>]*>/i, (m) => m + div);
fs.writeFileSync(file, html);
console.log('inject-splash: ok');
