#!/bin/sh
# Database roles (design note M1.2, decision 3). The postgres image runs this
# once, on first start with an empty volume (/docker-entrypoint-initdb.d).
# Safe to run again by hand: it creates missing roles and (re)sets their
# passwords from the environment. Grants live in migration 0004.
#
#   vault_migrator  owns the database and its schema, runs migrations (the
#                   one-shot migrate service only).
#   vault_app       web and worker: not a superuser, owns no table.
#
# The entrypoint may source this file, so it never calls `exit` or `set -u`.
# Passwords are read inside psql with \getenv, so they never appear on a
# command line.
: "${VAULT_MIGRATOR_PASSWORD:?Set VAULT_MIGRATOR_PASSWORD}"
: "${VAULT_APP_PASSWORD:?Set VAULT_APP_PASSWORD}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv migrator_password VAULT_MIGRATOR_PASSWORD
\getenv app_password VAULT_APP_PASSWORD
\getenv database POSTGRES_DB
select 'create role vault_migrator' where not exists (select from pg_roles where rolname = 'vault_migrator') \gexec
select 'create role vault_app' where not exists (select from pg_roles where rolname = 'vault_app') \gexec
alter role vault_migrator with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'migrator_password';
alter role vault_app with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'app_password';
-- The database owner owns the public schema (pg_database_owner), so the
-- migrator can create tables there; nobody else can (Postgres 15+ default).
alter database :"database" owner to vault_migrator;
revoke create on schema public from public;
SQL
