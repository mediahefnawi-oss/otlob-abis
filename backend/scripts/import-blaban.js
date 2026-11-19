'use strict';
/**
 * Adds the menu of «بلبن» (from the pictures the owner sent) to the existing shop. Safe to run twice:
 * a product whose name already exists in that shop is skipped (nothing is deleted or overwritten).
 *   check only:  node scripts/import-blaban.js
 *   write:       node scripts/import-blaban.js --apply
 * Optional: PROVIDER_ID=123 when more than one shop matches the name.
 */
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const apply = process.argv.includes('--apply');
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'blaban', 'menu.json'), 'utf8'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : process.env.NODE_ENV === 'production' && !/@(db|localhost|127\.)/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined });
(async () => {
  const want = process.env.PROVIDER_ID ? [process.env.PROVIDER_ID] : null;
  const q = want
    ? await pool.query('SELECT id, name, type FROM providers WHERE id=$1 AND deleted_at IS NULL', [want[0]])
    : await pool.query("SELECT id, name, type FROM providers WHERE deleted_at IS NULL AND (name LIKE '%بلبن%' OR name ILIKE '%b%laban%' OR name ILIKE '%blaban%')");
  if (q.rowCount !== 1) { console.log(q.rowCount ? 'أكتر من محل مطابق، حدد واحد: PROVIDER_ID=<رقم> node scripts/import-blaban.js' : 'ما لقيتش محل اسمه بلبن'); console.log(q.rows); process.exit(1); }
  const shop = q.rows[0];
  console.log(`المحل: #${shop.id} ${shop.name} (${shop.type})`);
  const have = new Set((await pool.query('SELECT name FROM products WHERE provider_id=$1', [shop.id])).rows.map(r => r.name.trim()));
  let add = 0, skip = 0, pics = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const g of menu) for (const it of g.items) {
      const [name, price, desc = '', img] = it;
      if (have.has(name)) { skip++; continue; }
      add++;
      console.log(`  + ${g.cat} | ${name} | ${price} ج`);
      if (!apply) continue;
      const data = { kind: 'item', emoji: g.emoji, category: g.cat, desc: desc || '' };
      const r = await client.query('INSERT INTO products(provider_id, name, price, data) VALUES($1,$2,$3,$4) RETURNING id', [shop.id, name, Number(price), JSON.stringify(data)]);
      const f = img || g.img;
      if (f) { await client.query("INSERT INTO product_images(product_id, image, mime) VALUES($1,$2,'image/jpeg')", [r.rows[0].id, fs.readFileSync(path.join(__dirname, 'blaban', f + '.jpg'))]); pics++; }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  console.log(apply ? `تمت الإضافة: ${add} منتج (${pics} بصورة)، اتجاهل ${skip} موجود قبل كده.` : `تجربة فقط (ما اتكتبش حاجة): هيتضاف ${add} منتج، ويتجاهل ${skip}. شغّله تاني مع --apply للكتابة.`);
  await pool.end();
})().catch(e => { console.error('فشل:', e.message); process.exit(1); });
