-- Continuous copy of the main Neon database into the standby database (PostgreSQL logical replication).
-- Run each part ONLY on the database named in its heading. Replace the placeholders; never paste passwords in chat.

-- ===== PART 1: on the MAIN database (once). Needs "Logical replication" switched on in the Neon project settings first. =====
-- CREATE PUBLICATION otlob_pub FOR ALL TABLES;

-- ===== PART 2: on the STANDBY database (once). First apply backend/sql/schema.sql there so the tables exist, then: =====
-- CREATE SUBSCRIPTION otlob_sub
--   CONNECTION 'host=<MAIN_HOST> dbname=<MAIN_DB> user=<MAIN_ROLE> password=<MAIN_PASSWORD> sslmode=require'
--   PUBLICATION otlob_pub WITH (copy_data = true);

-- Check that it is alive (on the standby): shows the last time data arrived.
-- SELECT subname, received_lsn, last_msg_receipt_time FROM pg_stat_subscription;

-- Whenever a new release changes sql/schema.sql: apply it on the STANDBY too, before or right after the main one
-- (logical replication copies rows, not table definitions).
