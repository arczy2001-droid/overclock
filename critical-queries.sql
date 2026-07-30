-- ============================================================
-- The four statements that matter.
--
-- Every one of these replaces a read-modify-write with a single atomic
-- statement whose WHERE clause IS the rule. If the statement returns zero
-- rows, the action was not allowed — no separate check, nothing to race.
--
-- Two browser tabs, a double-tapped button on a flaky connection, and a
-- deliberate replay attack all take the same path through these, and all
-- three lose.
-- ============================================================


-- ------------------------------------------------------------
-- 1. SPEND HEAT
--
-- The day row is created on first use, so the "midnight reset" needs no
-- job: tomorrow's row simply does not exist yet, and the first attack
-- after midnight inserts it at heat 0.
--
-- The WHERE on the DO UPDATE branch is the gate. Zero rows returned means
-- the rig is too hot. Note it guards the *combined* value, so partial
-- commits are impossible: 98 heat with a 6-cost floor is refused, not
-- clamped to 100.
--
-- $1 character_id  $2 day_key (computed in the character's tz)  $3 heat cost
-- ------------------------------------------------------------
INSERT INTO character_days AS d (character_id, day_key, heat, attacks)
VALUES ($1, $2, $3, 1)
ON CONFLICT (character_id, day_key) DO UPDATE
   SET heat    = d.heat + EXCLUDED.heat,
       attacks = d.attacks + 1
 WHERE d.heat + EXCLUDED.heat <= 100
RETURNING heat, attacks;


-- ------------------------------------------------------------
-- 2. VENT COOLANT
--
-- Ten charges per local day, −20 each, and no venting when already cold.
-- All three conditions live in the WHERE, so the ration cannot be
-- oversubscribed by concurrent requests.
--
-- $1 character_id  $2 day_key
-- ------------------------------------------------------------
UPDATE character_days
   SET heat         = GREATEST(0, heat - 20),
       coolant_used = coolant_used + 1
 WHERE character_id = $1
   AND day_key      = $2
   AND coolant_used < 10
   AND heat > 0
RETURNING heat, coolant_used, 10 - coolant_used AS charges_left;


-- ------------------------------------------------------------
-- 3. COLLECT AN EXPEDITION
--
-- Idempotent by construction. `collected_at IS NULL` means a retried
-- request — the normal outcome of a phone losing signal mid-tap — pays
-- out exactly once. `ends_at <= now()` is checked by the database, so a
-- client with a fast clock gains nothing.
--
-- Returns the stored seed; the reward roll happens in application code
-- from that seed, then the payout is written back to the same row.
--
-- $1 expedition_id  $2 character_id
-- ------------------------------------------------------------
UPDATE expeditions
   SET collected_at = now()
 WHERE id           = $1
   AND character_id = $2
   AND collected_at IS NULL
   AND ends_at     <= now()
RETURNING seed, duration_hours, floor_snapshot;


-- ------------------------------------------------------------
-- 4. EQUIP AN ITEM
--
-- Unequip whatever holds the slot, then claim it. Inside one transaction
-- the partial unique index guarantees the slot is never doubly occupied,
-- even if the same request arrives twice.
--
-- $1 character_id  $2 item_id
-- ------------------------------------------------------------
BEGIN;

UPDATE items
   SET equipped_slot = NULL
 WHERE character_id  = $1
   AND equipped_slot = (SELECT slot FROM items WHERE id = $2 AND character_id = $1);

UPDATE items
   SET equipped_slot = slot
 WHERE id           = $2
   AND character_id = $1
RETURNING id, slot;

COMMIT;


-- ------------------------------------------------------------
-- Bonus: spending currency safely.
--
-- Never SELECT a balance, check it in application code, then UPDATE.
-- Put the check in the WHERE and let zero rows mean "declined".
--
-- $1 character_id  $2 cost
-- ------------------------------------------------------------
UPDATE characters
   SET credits = credits - $2
 WHERE id      = $1
   AND credits >= $2
RETURNING credits;
