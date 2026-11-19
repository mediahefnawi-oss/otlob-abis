#!/usr/bin/env bash
# Sends one notification to every registered phone (Android/FCM). Usage:
#   bash /opt/otlob/deploy/push-all.sh                       (the default text below)
#   bash /opt/otlob/deploy/push-all.sh "العنوان" "النص"
# Nothing secret is printed. Dead tokens are skipped by Firebase (counted as failures).
set -e
cd /opt/otlob
TITLE="${1:-جاهزين يا بطل؟ 💪🔥}"
BODY="${2:-الأربعاء بإذن الله بنشتغل.. استعد للشغل والكسب! أطلب أبيس... سهّلها على روحك}"
docker compose --env-file .env -f deploy/docker-compose.vps.yml exec -T -e PUSH_TITLE="$TITLE" -e PUSH_BODY="$BODY" api node -e '
const {Pool}=require("pg");const admin=require("firebase-admin");
(async()=>{
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const r=await pool.query("SELECT DISTINCT endpoint FROM push_subscriptions WHERE endpoint LIKE $1",["fcm:%"]);
admin.initializeApp({credential:admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
const tokens=r.rows.map(x=>x.endpoint.slice(4));
const msg=t=>({token:t,notification:{title:process.env.PUSH_TITLE,body:process.env.PUSH_BODY},android:{priority:"high",notification:{channelId:"orders"}}});
let ok=0,bad=0;
for(let i=0;i!==tokens.length;i+=500){
  const res=await admin.messaging().sendEach(tokens.slice(i,i+500).map(msg));
  ok+=res.successCount;bad+=res.failureCount;
}
console.log("اتبعت لـ",ok,"موبايل | فشل",bad,"| الاجمالي",tokens.length);
process.exit(0)})().catch(e=>{console.log("خطأ:",e.code||e.message);process.exit(1)});
'
