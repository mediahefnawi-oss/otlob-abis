Commission / counters tests (run with Bun against a throw-away PostgreSQL that already has sql/schema.sql applied):
  TEST_DB=postgres://user@127.0.0.1:5544/dbname bun comm.test.js
  TEST_DB=... bun integ.test.js
They TRUNCATE the data tables: never point them at the production database.
