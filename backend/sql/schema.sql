CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','provider','courier','admin')),
  address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','rejected','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS providers (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone VARCHAR(20) NOT NULL,
  delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active','pending','rejected','suspended')),
  is_open BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  available BOOLEAN NOT NULL DEFAULT TRUE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_number BIGSERIAL UNIQUE,
  customer_user_id BIGINT NOT NULL REFERENCES users(id),
  provider_id BIGINT REFERENCES providers(id),
  courier_user_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','ready','on_the_way','delivered','rejected','cancelled')),
  total NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_user_id BIGINT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_provider ON products(provider_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, created_at);


-- Centralized domain data missing from the initial release scaffold.
CREATE TABLE IF NOT EXISTS appointments (
  id BIGSERIAL PRIMARY KEY,
  customer_user_id BIGINT NOT NULL REFERENCES users(id),
  provider_id BIGINT NOT NULL REFERENCES providers(id),
  doctor_product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  appointment_date DATE NOT NULL,
  appointment_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','completed','cancelled')),
  fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_provider ON appointments(provider_id, appointment_date, appointment_time);

CREATE TABLE IF NOT EXISTS invoices (
  id BIGSERIAL PRIMARY KEY,
  invoice_number BIGSERIAL UNIQUE,
  customer_user_id BIGINT NOT NULL REFERENCES users(id),
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delivery','booking')),
  total NUMERIC(10,2) NOT NULL CHECK (total >= 0),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (order_id IS NOT NULL OR appointment_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  maintenance_message TEXT NOT NULL DEFAULT 'التطبيق متوقف مؤقتًا للصيانة',
  announcement TEXT NOT NULL DEFAULT '',
  auto_assign BOOLEAN NOT NULL DEFAULT FALSE,
  support_phone TEXT NOT NULL DEFAULT '',
  support_name TEXT NOT NULL DEFAULT 'الدعم الفني',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app_settings(id) VALUES(1) ON CONFLICT (id) DO NOTHING;

-- Phase 3: soft-delete so order/invoice history stays intact when the owner removes a service.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Phase 4: delivery areas. The owner decides which areas the app serves and the delivery price for each.
CREATE TABLE IF NOT EXISTS regions (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 10 CHECK (delivery_fee >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS region_id BIGINT REFERENCES regions(id) ON DELETE SET NULL;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS regions_seeded BOOLEAN NOT NULL DEFAULT FALSE;

-- Phase 4 (part B): central orders, chat and bookings.
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS available_since TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS region_id BIGINT REFERENCES regions(id) ON DELETE SET NULL;
ALTER TABLE messages ALTER COLUMN sender_user_id DROP NOT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_role TEXT NOT NULL DEFAULT 'customer';
-- Two customers can never hold the same doctor slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appt_slot ON appointments(doctor_product_id, appointment_date, appointment_time) WHERE status IN ('pending','confirmed');
CREATE INDEX IF NOT EXISTS idx_orders_courier ON orders(courier_user_id, status);

-- Order statuses, including the courier steps: picked up -> on the way -> arrived -> delivered.
-- orders_status_v2 (an older, shorter list) must never exist next to v3: it would reject the new steps.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_v2;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_v3') THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_v3 CHECK (status IN ('pending','accepted','ready','picked_up','on_the_way','arrived','delivered','rejected','cancelled','quoted','unavailable'));
  END IF;
END $$;

-- Free-text requests to supermarkets / pharmacies: the photo (a prescription, a shopping list) lives apart from the order
-- so the 4-second sync never downloads pictures.
CREATE TABLE IF NOT EXISTS order_images (
  order_id BIGINT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  image TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Announcements board (owner only) and Web Push subscriptions.
CREATE TABLE IF NOT EXISTS ads (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  image BYTEA NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Provider logos and product pictures (apart from the catalog so the 4-second sync stays light).
CREATE TABLE IF NOT EXISTS provider_logos (
  provider_id BIGINT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  image BYTEA NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS product_images (
  product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  image BYTEA NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================================================
-- Commissions, counters reset, audit log, login picture (all controlled from the owner's panel)
-- =====================================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
UPDATE orders SET delivered_at = updated_at WHERE status = 'delivered' AND delivered_at IS NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
UPDATE appointments SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS commissions_seeded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS commission_rules (
  id BIGSERIAL PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('provider','courier')),
  scope TEXT NOT NULL CHECK (scope IN ('all','type','provider','courier')),
  provider_type TEXT,
  provider_id BIGINT,
  courier_user_id BIGINT,
  kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value NUMERIC(10,2) NOT NULL CHECK (value >= 0),
  min_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT NOT NULL DEFAULT '',
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comm_rules_target ON commission_rules(target, active);

CREATE TABLE IF NOT EXISTS commission_settlements (
  id BIGSERIAL PRIMARY KEY,
  party TEXT NOT NULL CHECK (party IN ('provider','courier')),
  provider_id BIGINT,
  courier_user_id BIGINT,
  amount NUMERIC(12,2) NOT NULL,
  entries_count INT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The ledger: one accrual per (order or booking, kind); cancellations / returns are separate negative adjustments.
CREATE TABLE IF NOT EXISTS commission_entries (
  id BIGSERIAL PRIMARY KEY,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('accrual','adjustment')),
  kind TEXT NOT NULL CHECK (kind IN ('provider','courier')),
  order_id BIGINT,
  appointment_id BIGINT,
  provider_id BIGINT,
  courier_user_id BIGINT,
  base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount NUMERIC(12,2) NOT NULL,
  rule_id BIGINT,
  rule_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  parent_id BIGINT REFERENCES commission_entries(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','settled')),
  settlement_id BIGINT REFERENCES commission_settlements(id),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_order ON commission_entries(order_id, kind) WHERE entry_type = 'accrual' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_appt ON commission_entries(appointment_id, kind) WHERE entry_type = 'accrual' AND appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comm_provider ON commission_entries(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_courier ON commission_entries(courier_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_parent ON commission_entries(parent_id);
CREATE INDEX IF NOT EXISTS idx_comm_created ON commission_entries(created_at);

-- Counter resets only move the "since" line of the displayed counters; no order / invoice / commission row is touched.
CREATE TABLE IF NOT EXISTS counter_resets (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('all','type','provider')),
  provider_type TEXT,
  provider_id BIGINT,
  counters TEXT[] NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','schedule')),
  schedule_id BIGINT,
  note TEXT NOT NULL DEFAULT '',
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_counter_resets_at ON counter_resets(reset_at DESC);
CREATE TABLE IF NOT EXISTS counter_schedules (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('all','type','provider')),
  provider_type TEXT,
  provider_id BIGINT,
  counters TEXT[] NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('once','daily','weekly','monthly')),
  run_time TEXT NOT NULL DEFAULT '00:00',
  day_of_week SMALLINT,
  day_of_month SMALLINT,
  run_date DATE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  before JSONB,
  after JSONB,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS site_images (
  key TEXT PRIMARY KEY,
  image BYTEA NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default commissions (seeded once; afterwards the owner edits them from the panel).
DO $$
BEGIN
  IF NOT (SELECT commissions_seeded FROM app_settings WHERE id = 1) THEN
    INSERT INTO commission_rules(target, scope, provider_type, kind, value, effective_from, note) VALUES
      ('provider','type','supermarket','percent',10,'2000-01-01','افتراضي'),
      ('provider','type','pharmacy','percent',10,'2000-01-01','افتراضي'),
      ('provider','type','restaurant','fixed',15,'2000-01-01','افتراضي'),
      ('provider','type','clinic','fixed',15,'2000-01-01','افتراضي'),
      ('provider','type','maker','fixed',15,'2000-01-01','افتراضي'),
      ('provider','type','store','fixed',15,'2000-01-01','افتراضي'),
      ('courier','all',NULL,'fixed',5,'2000-01-01','افتراضي');
    UPDATE app_settings SET commissions_seeded = TRUE WHERE id = 1;
  END IF;
END $$;

-- =====================================================================================
-- Speed under load (indexes only; no data is touched)
-- =====================================================================================
CREATE INDEX IF NOT EXISTS idx_orders_open_offers ON orders(status, created_at DESC) WHERE courier_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_provider_delivered ON orders(provider_id, delivered_at) WHERE status = 'delivered';
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_courier_created ON orders(courier_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appts_provider_completed ON appointments(provider_id, completed_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_appts_customer_created ON appointments(customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appts_slots ON appointments(appointment_date, status);
CREATE INDEX IF NOT EXISTS idx_users_courier_online ON users(role, status, available);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, id);

-- Download link of the Android app (the owner edits it from the panel)
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS apk_url TEXT NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS credits TEXT NOT NULL DEFAULT '';

-- Owner's label on a customer account, shown to shops and couriers on that customer's orders ('' = none, 'trusted', 'watch', 'fraud')
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_flag TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS flag_note TEXT NOT NULL DEFAULT '';
-- supervisors (owner-created staff): the role is allowed, and the areas they run are kept as "1,4,7"
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('customer','provider','courier','admin','supervisor'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS sup_regions TEXT NOT NULL DEFAULT '';
-- delivery price from the shop's area to the customer's area (each direction has its own price)
CREATE TABLE IF NOT EXISTS route_prices (
  from_region_id BIGINT NOT NULL,
  to_region_id BIGINT NOT NULL,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_region_id, to_region_id)
);

-- =====================================================================================
-- Services (restaurants, pharmacies, clinics...) that the owner renames / stops / orders / adds from the panel.
-- The six original services are copied here the first time the owner changes something.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS service_types (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  single TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🛍️',
  template TEXT NOT NULL CHECK (template IN ('cart','request','booking','maker','errand')),
  sort_order INT NOT NULL DEFAULT 100,
  size TEXT NOT NULL DEFAULT 'small' CHECK (size IN ('small','medium','large')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  show_home BOOLEAN NOT NULL DEFAULT TRUE,
  can_products BOOLEAN NOT NULL DEFAULT TRUE,
  builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- failed-login counter per phone: stops password guessing without blocking other users on the same mobile network
CREATE TABLE IF NOT EXISTS login_attempts(
  key TEXT PRIMARY KEY,
  fails INT NOT NULL DEFAULT 0,
  first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ
);

-- opening hours: the owner sets when the app opens / closes (Cairo time); outside them customers see a closed screen
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS hours_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS open_time TEXT NOT NULL DEFAULT '10:00';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS close_time TEXT NOT NULL DEFAULT '00:00';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS open_days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS grace_min INT NOT NULL DEFAULT 30;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS closed_message TEXT NOT NULL DEFAULT 'تم إغلاق التطبيق، سيتم التشغيل الساعة {وقت_الفتح}';

-- 20261113: deleting an account frees its phone number; a deleted number registers again as a pending account
ALTER TABLE users ADD COLUMN IF NOT EXISTS orig_phone VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_users_orig_phone ON users(orig_phone) WHERE orig_phone IS NOT NULL;
UPDATE users SET deleted_at = NOW() WHERE role = 'provider' AND deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM providers p WHERE p.owner_user_id = users.id AND p.deleted_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM providers p WHERE p.owner_user_id = users.id AND p.deleted_at IS NULL);
UPDATE users SET orig_phone = phone, phone = 'd' || id || '_' || right(phone, 11) WHERE deleted_at IS NOT NULL AND orig_phone IS NULL;

-- 20261113: medical labs
ALTER TABLE service_types DROP CONSTRAINT IF EXISTS service_types_template_check;
ALTER TABLE service_types ADD CONSTRAINT service_types_template_check CHECK (template IN ('cart','request','booking','maker','errand','lab'));
INSERT INTO service_types(key, label, single, emoji, template, sort_order, size, active, show_home, can_products, builtin)
  SELECT 'lab', 'المعامل والتحاليل', 'معمل', '🧪', 'lab', 45, 'large', FALSE, TRUE, FALSE, TRUE
  WHERE EXISTS (SELECT 1 FROM service_types) ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS lab_files (
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rx','report')),
  mime TEXT NOT NULL DEFAULT 'image',
  name TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (appointment_id, kind)
);

ALTER TABLE service_types ADD COLUMN IF NOT EXISTS tagline VARCHAR(160);
UPDATE service_types SET size='small' WHERE key='lab' AND size='large';

-- Day closing: the owner collects the platform commission, the shop's counters restart, finished orders move out of its lists.
-- Nothing is deleted. A partial payment carries the shortfall forward as a new due adjustment (carry_entry_id).
CREATE TABLE IF NOT EXISTS day_closings (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES providers(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_from TIMESTAMPTZ,
  closed_by BIGINT,
  orders_count INT NOT NULL DEFAULT 0,
  sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_due NUMERIC(12,2) NOT NULL DEFAULT 0,
  received NUMERIC(12,2) NOT NULL DEFAULT 0,
  carried NUMERIC(12,2) NOT NULL DEFAULT 0,
  settlement_id BIGINT REFERENCES commission_settlements(id),
  carry_entry_id BIGINT REFERENCES commission_entries(id),
  note TEXT NOT NULL DEFAULT '',
  undone_at TIMESTAMPTZ,
  undone_by BIGINT,
  CONSTRAINT day_closings_amounts CHECK (received >= 0 AND carried >= 0 AND received <= commission_due)
);
CREATE INDEX IF NOT EXISTS idx_day_closings_provider ON day_closings(provider_id, closed_at DESC);
-- an optional second phone number a customer can leave (no code confirmation)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone2 VARCHAR(20);

-- The owner announces a new app version: every user sees an update banner until the installed version reaches it.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS update_version TEXT NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS update_message TEXT NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS update_required BOOLEAN NOT NULL DEFAULT FALSE;

-- In-app support chat: one conversation per user with the platform; the owner (and supervisors the owner allows) answer.
CREATE TABLE IF NOT EXISTS support_threads (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  last_message TEXT NOT NULL DEFAULT '',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unread_staff INT NOT NULL DEFAULT 0,
  unread_user INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS support_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender_user_id BIGINT NOT NULL REFERENCES users(id),
  sender_name TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_msgs_thread ON support_messages(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_support_threads_last ON support_threads(status, last_message_at DESC);
-- a supervisor works the support inbox only while the owner switches this on (default OFF)
ALTER TABLE users ADD COLUMN IF NOT EXISTS support_chat BOOLEAN NOT NULL DEFAULT FALSE;
-- the GitHub release the update notice was last taken from (the server announces new app versions by itself)
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS update_release_tag TEXT NOT NULL DEFAULT '';

-- Live tracking: the customer's saved spot, the shop's spot, and the courier's last known position.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lat DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lng DOUBLE PRECISION;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
CREATE TABLE IF NOT EXISTS courier_locations (
  courier_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy REAL,
  heading REAL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- colour theme chosen by the owner (applies to every user)
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'default';

-- Offers / discounts set by the OWNER only. provider_id NULL = every shop. The discounted price is applied by the server at checkout.
CREATE TABLE IF NOT EXISTS offers (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  percent SMALLINT NOT NULL CHECK (percent BETWEEN 1 AND 90),
  provider_id BIGINT REFERENCES providers(id) ON DELETE CASCADE,
  color TEXT NOT NULL DEFAULT 'red',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(active, provider_id);

-- Delivery price by distance (owner switch). 'region' = the area prices (as before); 'km' = price per kilometre between the shop and the customer.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS fee_mode TEXT NOT NULL DEFAULT 'region';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS fee_per_km NUMERIC(8,2) NOT NULL DEFAULT 5;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS fee_min NUMERIC(8,2) NOT NULL DEFAULT 10;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS fee_max NUMERIC(8,2) NOT NULL DEFAULT 40;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS fee_factor NUMERIC(4,2) NOT NULL DEFAULT 1.3;

-- Owner switch for maps and live location. map_enabled=false: the app works as before (typed address only, no maps, no tracking).
-- map_required: a delivery pin is needed to confirm an order (only when maps are on).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS map_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS map_required BOOLEAN NOT NULL DEFAULT TRUE;

-- Customer ratings: one per delivered order (the shop, and the courier if there was one). The owner can hide a comment.
CREATE TABLE IF NOT EXISTS ratings (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_user_id BIGINT NOT NULL REFERENCES users(id),
  provider_id BIGINT REFERENCES providers(id),
  courier_user_id BIGINT REFERENCES users(id),
  provider_stars SMALLINT CHECK (provider_stars BETWEEN 1 AND 5),
  courier_stars SMALLINT CHECK (courier_stars BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR char_length(comment) <= 500),
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ratings_provider ON ratings(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ratings_courier ON ratings(courier_user_id);

-- UI size chosen by the owner: phones (app + narrow web) and computers (wide web). 1.00 = the original size.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ui_phone_scale NUMERIC(4,2) NOT NULL DEFAULT 1.00;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ui_desktop_scale NUMERIC(4,2) NOT NULL DEFAULT 0.90;
-- shops and couriers lose sight of the customer's data some minutes after delivery (the owner can switch it off)
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS privacy_hide BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS privacy_minutes INTEGER NOT NULL DEFAULT 1;

-- Discount codes: the owner makes a code (amount or percent) for some days, for all shops or chosen shops, for everyone or one customer.
CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{4,20}$'),
  kind TEXT NOT NULL CHECK (kind IN ('amount','percent')),
  value NUMERIC(8,2) NOT NULL CHECK (value > 0),
  max_discount NUMERIC(8,2) CHECK (max_discount IS NULL OR max_discount > 0),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NOT NULL,
  provider_ids BIGINT[],
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  per_user SMALLINT CHECK (per_user IS NULL OR per_user BETWEEN 1 AND 100),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS coupon_uses (
  id BIGSERIAL PRIMARY KEY,
  coupon_id BIGINT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  group_ref BIGINT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (coupon_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_uses_user ON coupon_uses(coupon_id, user_id);

-- 20261201: feature switches (owner), per-shop order mode, menu pictures
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS order_mode TEXT;
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_order_mode_check;
ALTER TABLE providers ADD CONSTRAINT providers_order_mode_check CHECK (order_mode IS NULL OR order_mode IN ('cart','request','menu'));
CREATE TABLE IF NOT EXISTS menu_images (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  image BYTEA NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_menu_images_provider ON menu_images(provider_id, sort_order, id);

-- Courier's own picture: a new upload waits for the owner's approval; customers only ever see the approved one
CREATE TABLE IF NOT EXISTS courier_photos (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image BYTEA,
  mime TEXT,
  pending_image BYTEA,
  pending_mime TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Customer <-> shop chat BEFORE an order (the owner can switch it off for everybody or for one shop)
ALTER TABLE providers ADD COLUMN IF NOT EXISTS chat_disabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS chat_threads (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  unread_customer INT NOT NULL DEFAULT 0,
  unread_provider INT NOT NULL DEFAULT 0,
  last_message TEXT NOT NULL DEFAULT '',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_provider ON chat_threads(provider_id, last_message_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  from_customer BOOLEAN NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);
CREATE TABLE IF NOT EXISTS chat_reports (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, reporter_id)
);

-- Prescription forwarding: the clinic writes it, the patient approves the pharmacy, the pharmacy prepares it; valid for 7 days
CREATE TABLE IF NOT EXISTS prescriptions (
  id BIGSERIAL PRIMARY KEY,
  patient_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_provider_id BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  pharmacy_provider_id BIGINT REFERENCES providers(id) ON DELETE SET NULL,
  meds TEXT NOT NULL DEFAULT '',
  image BYTEA,
  mime TEXT,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','sent','ready','picked_up','delivery','cancelled')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rx_pharmacy ON prescriptions(pharmacy_provider_id, status);

-- A customer's favorite shops and products
CREATE TABLE IF NOT EXISTS favorites (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('provider','product')),
  ref_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind, ref_id)
);

-- One alert per order and stage when an order sits too long, and one daily report per day
CREATE TABLE IF NOT EXISTS late_alerts (
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, stage)
);
CREATE TABLE IF NOT EXISTS report_log (
  day DATE PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A customer's saved delivery addresses (home, work, ...)
CREATE TABLE IF NOT EXISTS saved_addresses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_addresses_user ON saved_addresses(user_id);

-- The owner can pin a shop to the top of its list (1 = first); NULL = not pinned
ALTER TABLE providers ADD COLUMN IF NOT EXISTS pin_rank INT;

-- Voice orders (switch "voice"): a short recording (max 45 s) sent with a written request; the server keeps it 30 days
CREATE TABLE IF NOT EXISTS order_voice (
  order_id BIGINT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  audio TEXT NOT NULL,
  seconds INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
