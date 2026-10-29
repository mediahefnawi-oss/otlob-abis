# تشغيل السيرفر وقاعدة البيانات المركزية على كمبيوتر

> هذا الملف يشرح تشغيل **السيرفر** (مجلد `backend`) و**قاعدة PostgreSQL** على جهازك بدل Vercel وNeon.
> كل الكود في هذا المشروع هو آخر نسخة بعد كل التعديلات. طريقة التشغيل على كمبيوتر **لم تُجرَّب** من طرفي (لا أملك كمبيوترك)، فاتبعها وأبلغني بأي خطأ يظهر.

## 0) الصورة الكاملة
```
هاتف العميل/المتجر/المندوب  ──(إنترنت)──►  عنوان HTTPS  ──►  السيرفر على كمبيوترك (المنفذ 4000)  ──►  PostgreSQL على كمبيوترك
```
- **السيرفر**: `backend/` (Node.js). يبني جداول القاعدة تلقائيًا عند أول تشغيل، وينشئ حساب المالك من `OWNER_PHONE` و`OWNER_PASSWORD`.
- **التطبيق (الواجهة)**: المجلد الرئيسي (Expo). ينبني كموقع ويب (`npm run build:web`) ويتصل بالسيرفر عبر `EXPO_PUBLIC_API_URL`.
- الكمبيوتر لازم يفضل **شغال ومتصل بالإنترنت** طول ما التطبيق مستخدم.

## 1) الطريقة (أ): Docker — الأسهل
1. نزّل وثبّت **Docker Desktop** وشغّله.
2. في المجلد الرئيسي للمشروع انسخ `.env.docker.example` إلى ملف اسمه `.env` واملأه (كلمة سر القاعدة، `JWT_SECRET` نص عشوائي 32 حرف أو أكثر، رقم وباسورد المالك، و`CORS_ORIGINS` = عنوان الموقع اللي هيفتح منه التطبيق).
3. افتح PowerShell داخل المجلد ونفّذ:
   ```
   docker compose up -d
   ```
4. افتح `http://localhost:4000/api/health`. لازم يظهر `"ok":true` و`"database":"connected"` و`"schema":"ok"`.
5. إيقاف: `docker compose down` (البيانات محفوظة). تشغيل: `docker compose up -d`.

## 2) الطريقة (ب): يدويًا بدون Docker
1. ثبّت **Node.js 20 أو أحدث** من nodejs.org، وثبّت **PostgreSQL 16** من postgresql.org (احفظ كلمة سر المستخدم `postgres`).
2. أنشئ قاعدة باسم `otlob` (من برنامج pgAdmin: Databases ← Create ← Database، أو: `createdb -U postgres otlob`).
3. افتح PowerShell داخل مجلد `backend` ونفّذ:
   ```
   npm install
   copy .env.example .env
   notepad .env
   ```
   عدّل: `DATABASE_URL` (ضع كلمة سر postgres)، `DATABASE_SSL=false`، `JWT_SECRET`، `OWNER_PASSWORD`، `OWNER_PHONE`، `CORS_ORIGINS`.
4. شغّل السيرفر: `npm start` ثم افتح `http://localhost:4000/api/health`.
5. **لتشغيله دائمًا وتلقائيًا مع الجهاز** (وإعادة تشغيله لو وقع):
   ```
   npm install -g pm2
   pm2 start src/server.js --name otlob-api
   pm2 save
   ```
   (على Windows استخدم `pm2-windows-startup` أو أنشئ مهمة في Task Scheduler تشغّل `pm2 resurrect` عند بدء التشغيل.)

## 3) خلّي الموبايلات توصل للسيرفر (HTTPS)
الموبايلات خارج بيتك محتاجة عنوان إنترنت آمن (HTTPS). أسهل حل مجاني:
1. ثبّت **cloudflared** (Cloudflare Tunnel) من موقع Cloudflare.
2. للتجربة السريعة: `cloudflared tunnel --url http://localhost:4000` — هيطلع لك عنوان مثل `https://xxxx.trycloudflare.com`. (يتغير كل مرة.)
3. للاستخدام الدائم بعنوان ثابت: أنشئ **Named Tunnel** من لوحة Cloudflare Zero Trust وربطه بدومين عندك، وشغّله كخدمة (`cloudflared service install`).
- بدائل: فتح منفذ في الراوتر مع DuckDNS وCaddy لإضافة HTTPS (أصعب وأقل أمانًا).
- **مهم:** رابط السيرفر هذا هو قيمة `EXPO_PUBLIC_API_URL` في الخطوة التالية.

## 4) الواجهة (الموقع)
**الخيار 1 — تبقى على Vercel** (المستخدم الحالي): في مشروع الموقع على Vercel غيّر `EXPO_PUBLIC_API_URL` إلى عنوان السيرفر الجديد (نوعه **Config** مش Secret) ثم أعد النشر. وفي إعدادات السيرفر اجعل `CORS_ORIGINS` = `https://otlob-abis-app.vercel.app`.

**الخيار 2 — تشغيل الواجهة من الكمبيوتر نفسه:** في المجلد الرئيسي:
```
npm install
$env:EXPO_PUBLIC_API_URL="https://عنوان-السيرفر"
npm run build:web
npx serve dist -l 3000
```
ثم اعرض المنفذ 3000 بنفس الطريقة (Tunnel ثاني) واجعل `CORS_ORIGINS` = عنوان هذه الواجهة بالضبط.

## 5) نقل بياناتك الحالية من Neon (اختياري)
لو عايز تحتفظ بالحسابات والطلبات الحالية (يلزم تثبيت أدوات PostgreSQL):
```
pg_dump "رابط-Neon-الكامل" --no-owner --no-privileges -f neon.sql
psql -U postgres -d otlob -f neon.sql
```
ثم شغّل السيرفر. (لو لا تحتاج البيانات القديمة، ابدأ من قاعدة فاضية وسيُنشئ السيرفر كل شيء.)

## 6) النسخ الاحتياطي (مهم جدًا لأن القاعدة على جهازك)
- يوميًا: `pg_dump -U postgres otlob > backup-2026-01-01.sql` (ضعه في Task Scheduler واحتفظ بنسخة على فلاشة أو سحابة).
- الاستعادة: `psql -U postgres -d otlob -f backup.sql`.
- مع Docker: `docker compose exec db pg_dump -U otlob otlob > backup.sql`.

## 6.5) إشعارات الهاتف (Push) ولوحة الإعلانات
- **الإشعارات**: تحتاج مفتاحين (VAPID) مرة واحدة: نفّذ `npx web-push generate-vapid-keys` وضع القيمتين في `VAPID_PUBLIC_KEY` و`VAPID_PRIVATE_KEY` (وضع بريدك في `VAPID_SUBJECT` بصيغة `mailto:...`) ثم أعد تشغيل السيرفر. بدونهما يعمل التطبيق بالصوت داخل الصفحة فقط.
- **الإعلانات**: يضيفها المالك من الإعدادات (لوحة الإعلانات)، وتُخزَّن الصور داخل قاعدة البيانات، فهي تدخل في النسخ الاحتياطي.

## 7) أمان
- لا تشارك ملف `.env` ولا ترفعه على GitHub (موجود في `.gitignore`).
- غيّر `OWNER_PASSWORD` من داخل التطبيق (حسابي) بعد أول دخول، لأن تغييره من الملف لا يغيّر كلمة سر حساب موجود.
- اضبط الجهاز على **ألا ينام** (Power Settings ← Sleep: Never) واترك Windows Update يعيد التشغيل في وقت لا تعمل فيه.
- حدّث الجهاز وفعّل Firewall، ولا تفتح المنفذ 5432 (القاعدة) على الإنترنت أبدًا.

## 8) تحديث الكود لاحقًا
استبدل الملفات الجديدة في المجلد ثم: `pm2 restart otlob-api` (أو `docker compose up -d --build`). تعديلات القاعدة تُطبَّق تلقائيًا مرة واحدة لكل إصدار.

## 9) ملاحظات
- السيرفر على جهاز واحد يعني **نقطة فشل واحدة**: لو الجهاز أو الإنترنت وقع، التطبيق يقف. الاستضافة السحابية أكثر ثباتًا للتشغيل الفعلي.
- تنبيهات الصوت تعمل والتطبيق مفتوح. إشعارات الهاتف وهو مقفول تحتاج Push (مرحلة لاحقة).
- في السيرفر المحلي لا حاجة لملفات `vercel.json` و`backend/api`، وهي لا تضر.
