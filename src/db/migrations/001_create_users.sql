-- Migration 001: users
-- Creates the user_role enum and the users table.
-- All other tables depend on this one — it must run first.

CREATE TYPE user_role AS ENUM ('photographer', 'client');

CREATE TABLE users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL UNIQUE,
  role        user_role   NOT NULL,
  provider_id TEXT        NOT NULL UNIQUE,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
