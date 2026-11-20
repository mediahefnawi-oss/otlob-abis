// Runs after `expo export --platform web` (and inject-splash): makes the site readable by Google so a search for
// "أطلب أبيس" / "اطلب ابيس" / "Otlob Abis" finds the app and its download link.
// - dist/index.html: real <title>, description, canonical, Open Graph, structured data (JSON-LD) and a <noscript> text
//   block (the app itself is JavaScript, which Google reads late and badly).
// - dist/download.html: points its canonical / og:url / og:image at SITE_URL.
// - dist/robots.txt + dist/sitemap.xml.
// SITE_URL = the public address of the site. Override with the SITE_URL env var if the site moves.
const fs = require('fs');
const path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const SITE = (process.env.SITE_URL || 'https://otlobabis.com').replace(/\/$/, '');
const APK = 'https://github.com/mediahefnawi-oss/otlob-abis/releases/latest/download/otlob-abis.apk';
const NAME = 'أطلب أبيس';
const ALT = ['اطلب ابيس', 'أطلب ابيس', 'اطلب أبيس', 'Otlob Abis', 'OtlobAbis'];
const TITLE = 'أطلب أبيس | اطلب ابيس – تطبيق الطلبات والتوصيل في أبيس';
const DESC = 'أطلب أبيس (Otlob Abis): اطلب أكلك ومشترياتك وخدماتك من أبيس بضغطة واحدة. مطاعم وسوبر ماركت وصيدليات وعيادات وصنايعية وتوصيل لحد باب البيت. حمّل التطبيق للأندرويد.';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const OWNER = { '@type': 'Person', '@id': SITE + '/#owner', name: 'المهندس أحمد الحفناوي', alternateName: 'Eng. Ahmed El-Hefnawy' };
const DEV = { '@type': 'Organization', '@id': SITE + '/#ostorya', name: 'Ostorya', alternateName: 'أوستوريا', logo: SITE + '/ostorya-logo.png', founder: { '@id': SITE + '/#owner' } };
const today = new Date().toISOString().slice(0, 10);

const ld = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', '@id': SITE + '/#site', url: SITE + '/', name: NAME, alternateName: ALT, inLanguage: 'ar' },
    OWNER, DEV,
    { '@type': 'Organization', '@id': SITE + '/#org', founder: { '@id': SITE + '/#owner' }, sameAs: ['https://www.facebook.com/share/1Ej9N2KRaR/'], name: NAME, alternateName: ALT, url: SITE + '/', logo: SITE + '/download-icon.png' },
    {
      '@type': 'MobileApplication', name: NAME, alternateName: ALT, operatingSystem: 'ANDROID',
      applicationCategory: 'ShoppingApplication', inLanguage: 'ar', url: SITE + '/download.html', downloadUrl: APK,
      image: SITE + '/download-icon.png', description: DESC, publisher: { '@id': SITE + '/#org' }, author: { '@id': SITE + '/#ostorya' },
      copyrightHolder: { '@id': SITE + '/#owner' }, copyrightYear: new Date().getFullYear(),
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'EGP' },
    },
  ],
};

const head =
  '<meta name="description" content="' + esc(DESC) + '">' +
  '<link rel="canonical" href="' + SITE + '/">' +
  '<meta name="robots" content="index,follow">' +
  '<meta name="author" content="شركة Ostorya التابعة للمهندس أحمد الحفناوي">' +
  '<meta name="copyright" content="© أطلب أبيس – جميع الحقوق محفوظة لشركة Ostorya التابعة للمهندس أحمد الحفناوي">' +
  '<meta property="og:type" content="website"><meta property="og:locale" content="ar_EG">' +
  '<meta property="og:site_name" content="' + NAME + '">' +
  '<meta property="og:title" content="' + esc(TITLE) + '">' +
  '<meta property="og:description" content="' + esc(DESC) + '">' +
  '<meta property="og:url" content="' + SITE + '/">' +
  '<meta property="og:image" content="' + SITE + '/download-icon.png">' +
  '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>';

const noscript =
  '<noscript><main dir="rtl" style="color:#F5F3EA;font-family:Tahoma,Arial,sans-serif;max-width:460px;margin:40px auto;padding:0 20px;text-align:center">' +
  '<h1>أطلب أبيس – Otlob Abis</h1>' +
  '<p>تطبيق أطلب أبيس (اطلب ابيس): اطلب من المطاعم والسوبر ماركت والصيدليات، واحجز عند الدكتور، واطلب من الصنايعية، والتوصيل لحد باب بيتك في أبيس.</p>' +
  '<p><a style="color:#F2B51D" href="' + SITE + '/download.html">تحميل تطبيق أطلب أبيس للأندرويد</a></p>' +
  '<p><a style="color:#F2B51D" href="https://www.facebook.com/share/1Ej9N2KRaR/">صفحة أطلب أبيس على فيسبوك</a> • <a style="color:#F2B51D" href="' + SITE + '/privacy.html">سياسة الخصوصية</a></p>' +
  '<p style="font-size:13px;opacity:.8">تصميم وتطوير شركة Ostorya التابعة للمهندس أحمد الحفناوي – © جميع حقوق الملكية محفوظة</p>' +
  '</main></noscript>';

// index.html
const idx = path.join(dist, 'index.html');
if (!fs.existsSync(idx)) { console.error('inject-seo: dist/index.html not found'); process.exit(1); }
let html = fs.readFileSync(idx, 'utf8');
if (html.includes('application/ld+json')) {
  console.log('inject-seo: index already done');
} else {
  html = /<html[^>]*\blang=/i.test(html) ? html.replace(/(<html[^>]*\blang=")[^"]*"/i, '$1ar"') : html.replace(/<html/i, '<html lang="ar"');
  html = /<title>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/i, '<title>' + esc(TITLE) + '</title>')
    : html.replace(/<\/head>/i, '<title>' + esc(TITLE) + '</title></head>');
  html = html.replace(/<meta\s+name="description"[^>]*>/gi, '');
  html = html.replace(/<\/head>/i, head + '</head>').replace(/<body[^>]*>/i, (m) => m + noscript);
  fs.writeFileSync(idx, html);
}

// download.html: same absolute address as the rest of the site
const dl = path.join(dist, 'download.html');
if (fs.existsSync(dl)) {
  let d = fs.readFileSync(dl, 'utf8');
  d = d.split('https://otlob-abis-app.vercel.app').join(SITE);
  fs.writeFileSync(dl, d);
}

fs.writeFileSync(path.join(dist, 'robots.txt'), 'User-agent: *\nAllow: /\n\nSitemap: ' + SITE + '/sitemap.xml\n');
const urls = [['/', '1.0'], ['/download.html', '0.9'], ['/privacy.html', '0.3']];
fs.writeFileSync(path.join(dist, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map(([u, p]) => '  <url><loc>' + SITE + u + '</loc><lastmod>' + today + '</lastmod><priority>' + p + '</priority></url>').join('\n') +
  '\n</urlset>\n');
console.log('inject-seo: ok (' + SITE + ')');
