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
