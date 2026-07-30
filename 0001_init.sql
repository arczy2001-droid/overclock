-- ============================================================
-- OVERTIME.EXE — Postgres schema
--
-- Normalise what you query ACROSS players (accounts, progression,
-- leaderboards, inventory). Keep genuinely per-item, high-churn,
-- schema-fluid data as JSONB. Item modifier rolls are never queried
-- across players, so they stay a blob; highest_floor_cleared is a
-- leaderboard column, so it does not.
--
-- Works on Postgres 14+. For SQLite: drop the extensions, swap
-- citext -> text collate nocase, uuid -> text, jsonb -> json,
-- timestamptz -> integer epoch. Everything else survives.
-- ============================================================

-- Applied by db/migrate.ts, which records it in schema_migrations.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive usernames

-- ------------------------------------------------------------
-- Enums. Cheap to add values to, expensive to remove — which is
-- the correct incentive for a live game's content identifiers.
-- ------------------------------------------------------------
CREATE TYPE class_id  AS ENUM ('corpo_rat', 'scavenger', 'hacker');
CREATE TYPE gender_id AS ENUM ('male', 'female');
CREATE TYPE slot_id   AS ENUM ('helmet', 'armor', 'gloves', 'pants', 'boots', 'weapon');
CREATE TYPE rarity_id AS ENUM ('salvage', 'standard', 'licensed', 'blackmarket', 'prototype');

-- ============================================================
-- ACCOUNTS & SESSIONS
-- ============================================================

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        citext NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 24),
  -- argon2id, produced SERVER-SIDE. The client-side SHA-256 in the
  -- prototype is deleted outright: it was obfuscation standing in for a
  -- server, and now there is a server.
  password_hash   text NOT NULL,
  email           citext UNIQUE,          -- nullable: recovery is opt-in
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deleted'))
);

-- Opaque random tokens, stored hashed, revocable. Preferred over stateless
-- JWTs here: banning a cheating account must take effect immediately, not
-- whenever their token happens to expire.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,    -- sha256 of the bearer token
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text,
  ip            inet
);
CREATE INDEX sessions_account_idx ON sessions (account_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx  ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ============================================================
-- CHARACTERS
-- ============================================================

CREATE TABLE characters (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                  text NOT NULL CHECK (length(name) BETWEEN 2 AND 18),
  gender                gender_id NOT NULL,
  class_id              class_id NOT NULL,
  -- IANA zone. The 00:00 heat reset is the player's midnight, not UTC's,
  -- so the server needs to know which midnight they meant.
  timezone              text NOT NULL DEFAULT 'UTC',

  level                 int NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 200),
  xp                    bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  unspent_points        int NOT NULL DEFAULT 0 CHECK (unspent_points >= 0),

  -- The five upgradeable attributes get real columns: they are validated on
  -- every write and read on every request. Pancerz/armor is deliberately
  -- absent — it comes only from gear, and inventing a column for it would
  -- invite someone to write to it.
  alloc_brawn           int NOT NULL DEFAULT 0 CHECK (alloc_brawn    >= 0),
  alloc_agility         int NOT NULL DEFAULT 0 CHECK (alloc_agility  >= 0),
  alloc_insight         int NOT NULL DEFAULT 0 CHECK (alloc_insight  >= 0),
  alloc_battery         int NOT NULL DEFAULT 0 CHECK (alloc_battery  >= 0),
  alloc_charisma        int NOT NULL DEFAULT 0 CHECK (alloc_charisma >= 0),

  -- BIGINT, not INT. The balance sim reaches ~8e8 credits inside 90 days;
  -- int4 tops out at 2.1e9 and an idle game is a machine for making numbers
  -- larger than you planned.
  credits               bigint NOT NULL DEFAULT 500 CHECK (credits    >= 0),
  processors            bigint NOT NULL DEFAULT 5   CHECK (processors >= 0),

  vehicle_tier          smallint NOT NULL DEFAULT 0 CHECK (vehicle_tier BETWEEN 0 AND 4),

  highest_floor_cleared int NOT NULL DEFAULT 0 CHECK (highest_floor_cleared >= 0),
  current_floor         int NOT NULL DEFAULT 1 CHECK (current_floor >= 1),
  total_runs            int NOT NULL DEFAULT 0,
  total_wins            int NOT NULL DEFAULT 0,

  flags                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Optimistic lock. Two open tabs are the normal case for an idle game.
  version               bigint NOT NULL DEFAULT 0,

  CHECK (current_floor <= highest_floor_cleared + 1)
);

-- One character per account for now; drop this index to allow alts later.
CREATE UNIQUE INDEX characters_one_per_account ON characters (account_id);
CREATE INDEX characters_leaderboard_idx
  ON characters (highest_floor_cleared DESC, updated_at ASC);

-- ============================================================
-- DAILY LEDGER
--
-- The single best reason to have a database here.
--
-- Heat and the coolant ration do not "reset at midnight" — a row simply
-- does not exist for tomorrow yet. No cron job, no nightly sweep over
-- every account, no clock-skew bug at the day boundary, and per-day
-- telemetry falls out for free. The row is created by the first attack
-- of the player's local day and never touched again after it.
-- ============================================================

CREATE TABLE character_days (
  character_id   uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  day_key        date NOT NULL,                  -- computed server-side in the character's tz
  heat           numeric(5,2) NOT NULL DEFAULT 0 CHECK (heat BETWEEN 0 AND 100),
  coolant_used   smallint NOT NULL DEFAULT 0 CHECK (coolant_used BETWEEN 0 AND 10),
  attacks        int NOT NULL DEFAULT 0,
  wins           int NOT NULL DEFAULT 0,
  credits_earned bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, day_key)
);

-- ============================================================
-- ITEMS
-- ============================================================

CREATE TABLE items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  base_id       text NOT NULL,                   -- key into the content catalogue
  name          text NOT NULL,
  slot          slot_id NOT NULL,
  rarity        rarity_id NOT NULL,
  ilvl          int NOT NULL CHECK (ilvl >= 1),
  plus          smallint NOT NULL DEFAULT 0 CHECK (plus BETWEEN 0 AND 15),
  modifiers     jsonb NOT NULL,                  -- rolled once, never queried across players
  affixes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  sell_value    bigint NOT NULL DEFAULT 0,
  locked        boolean NOT NULL DEFAULT false,

  -- Equipped state lives on the item, not in a loadout blob on the
  -- character. That way the database enforces the rule rather than
  -- trusting six application code paths to agree.
  equipped_slot slot_id,
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL DEFAULT 'floor'
                  CHECK (source IN ('floor', 'expedition', 'starter', 'shop')),

  CHECK (equipped_slot IS NULL OR equipped_slot = slot)
);

-- A character can have at most one item equipped per slot. Enforced here
-- so a double-submitted equip request cannot produce two weapons.
CREATE UNIQUE INDEX items_one_per_slot
  ON items (character_id, equipped_slot)
  WHERE equipped_slot IS NOT NULL;

CREATE INDEX items_character_idx ON items (character_id, slot);

-- ============================================================
-- EXPEDITIONS
--
-- Rows are never deleted, only marked collected. Deleting them would
-- throw away the audit trail and make double-collect bugs invisible.
-- ============================================================

CREATE TABLE expeditions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id   uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  duration_hours smallint NOT NULL CHECK (duration_hours IN (1, 4, 8)),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ends_at        timestamptz NOT NULL,
  floor_snapshot int NOT NULL CHECK (floor_snapshot >= 1),
  -- Rewards are rolled from this seed AT COLLECTION, not at launch, so the
  -- outcome cannot be peeked at and rerolled. The seed is generated here.
  seed           bigint NOT NULL,
  collected_at   timestamptz,
  payout         jsonb,                          -- written once, at collection

  CHECK (ends_at > started_at)
);

-- At most one uncollected expedition per character. Same principle as the
-- equipment slot: let the database hold the invariant.
CREATE UNIQUE INDEX expeditions_one_active
  ON expeditions (character_id)
  WHERE collected_at IS NULL;

-- ============================================================
-- BATTLE LEDGER
--
-- Store the INPUTS, not the log. A full combat log is a few KB and the
-- engine is deterministic, so {seed, floor, stat snapshot} replays it
-- exactly. That makes this table an anti-cheat audit trail that costs
-- ~100 bytes a fight instead of ~4KB.
-- ============================================================

CREATE TABLE battles (
  id             bigserial PRIMARY KEY,
  character_id   uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  floor          int NOT NULL,
  seed           bigint NOT NULL,
  victory        boolean NOT NULL,
  outcome        text NOT NULL
                   CHECK (outcome IN ('operator_down', 'hostile_down', 'throttled')),
  rounds         smallint NOT NULL,
  heat_before    numeric(5,2) NOT NULL,
  heat_cost      numeric(5,2) NOT NULL,
  -- The derived stats the server used. Lets you replay a fight months later
  -- even after a balance patch changes what those stats would be today.
  stat_snapshot  jsonb NOT NULL,
  fought_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX battles_character_idx ON battles (character_id, fought_at DESC);

-- ============================================================
-- MAINTENANCE
-- ============================================================

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER characters_touch
  BEFORE UPDATE ON characters
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Retention: battles and collected expeditions are append-only and will
-- dominate storage within months. Partition by month or prune on a schedule.
--   DELETE FROM battles WHERE fought_at < now() - interval '90 days';
