-- Read-only role for Grafana on the Flagsmith database. Idempotent: safe to run on every `docker compose up`.
-- Run by the one-shot `db-roles` compose service after the Flagsmith migrations (so the tables exist).
-- psql variable: ro_password
--
-- Only the tables FlagScope queries are granted (see docs/events-sql.md). Users, tokens and the warehouse
-- connection config (which can hold credentials) are deliberately NOT granted.

SELECT format('CREATE ROLE grafana_ro LOGIN PASSWORD %L', :'ro_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro')
\gexec

SELECT format('ALTER ROLE grafana_ro WITH LOGIN PASSWORD %L', :'ro_password')
\gexec

ALTER ROLE grafana_ro SET default_transaction_read_only = on;
ALTER ROLE grafana_ro SET statement_timeout = '15s';
ALTER ROLE grafana_ro NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE flagsmith TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND (
        (tablename LIKE 'experimentation\_%' AND tablename NOT LIKE 'experimentation\_warehouse%')
        OR tablename LIKE 'features\_%'
        OR tablename LIKE 'multivariate\_%'
        OR tablename = 'environments_environment'
      )
  LOOP
    EXECUTE format('GRANT SELECT ON %I.%I TO grafana_ro', t.schemaname, t.tablename);
  END LOOP;
END
$$;
