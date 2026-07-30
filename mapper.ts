import type { Item, Loadout, PlayerState, SlotId } from '../../src/types.js';
import type { Client, Queryable } from './db.js';
import { GameError } from './db.js';
import { dayKey } from './time.js';

/**
 * The database is normalised; the engine wants one PlayerState object. This
 * module is the only place that knows both shapes.
 *
 * Loads take four queries and are cheap. Writes are deliberately explicit:
 * there is no ORM change-tracking, so nothing gets persisted by accident, and
 * you can read exactly which columns an action is allowed to move.
 */

const SLOTS: SlotId[] = ['helmet', 'armor', 'gloves', 'pants', 'boots', 'weapon'];

interface LoadOptions {
  /** Takes a row lock so concurrent attacks on one character serialise. */
  forUpdate?: boolean;
}

export async function loadCharacter(
  client: Queryable,
  characterId: string,
  opts: LoadOptions = {},
): Promise<PlayerState> {
  const { rows } = await client.query(
    `SELECT * FROM characters WHERE id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [characterId],
  );
  const c = rows[0];
  if (!c) throw new GameError(404, 'Character not found.', 'no_character');

  const today = dayKey(c.timezone);

  const [{ rows: itemRows }, { rows: dayRows }, { rows: expRows }] = await Promise.all([
    client.query(`SELECT * FROM items WHERE character_id = $1 ORDER BY ilvl DESC, acquired_at DESC`, [characterId]),
    client.query(`SELECT * FROM character_days WHERE character_id = $1 AND day_key = $2`, [characterId, today]),
    client.query(
      `SELECT * FROM expeditions WHERE character_id = $1 AND collected_at IS NULL LIMIT 1`,
      [characterId],
    ),
  ]);

  const inventory: Item[] = itemRows.map(toItem);
  const equipped: Loadout = { helmet: null, armor: null, gloves: null, pants: null, boots: null, weapon: null };
  for (const row of itemRows) {
    if (row.equipped_slot) equipped[row.equipped_slot as SlotId] = row.id;
  }

  // No row for today means the day has not started yet, which is exactly the
  // same thing as a fresh meter. That is why the reset needs no job.
  const day = dayRows[0] ?? { heat: 0, coolant_used: 0 };
  const exp = expRows[0];

  return {
    schemaVersion: 1,
    id: c.id,
    name: c.name,
    classId: c.class_id,
    gender: c.gender,
    timezone: c.timezone,
    createdAt: c.created_at.getTime(),
    lastSeenAt: c.updated_at.getTime(),
    level: c.level,
    xp: c.xp,
    unspentPoints: c.unspent_points,
    allocated: {
      brawn: c.alloc_brawn,
      agility: c.alloc_agility,
      insight: c.alloc_insight,
      battery: c.alloc_battery,
      charisma: c.alloc_charisma,
    },
    wallet: { credits: c.credits, processors: c.processors },
    inventory,
    equipped,
    overheat: {
      value: Number(day.heat),
      coolantUsedToday: day.coolant_used,
      dayKey: today,
      vehicleTier: c.vehicle_tier,
    },
    progress: {
      highestFloorCleared: c.highest_floor_cleared,
      currentFloor: c.current_floor,
      totalRuns: c.total_runs,
      totalWins: c.total_wins,
    },
    expedition: exp
      ? {
          active: true,
          durationHours: exp.duration_hours,
          startedAt: exp.started_at.getTime(),
          endsAt: exp.ends_at.getTime(),
          floorSnapshot: exp.floor_snapshot,
          seed: Number(exp.seed),
        }
      : null,
    flags: c.flags ?? { tutorialDone: false, unlocks: [] },
  };
}

function toItem(row: any): Item {
  return {
    uid: row.id,
    baseId: row.base_id,
    name: row.name,
    slot: row.slot,
    rarity: row.rarity,
    ilvl: row.ilvl,
    plus: row.plus,
    modifiers: row.modifiers,
    affixes: row.affixes,
    sellValue: row.sell_value,
    locked: row.locked,
  };
}

/**
 * Writes back only the scalar columns an action may legitimately change.
 * Heat lives in character_days and is never written from here — it moves
 * exclusively through the atomic statements in db/critical-queries.sql.
 */
export async function saveCharacter(client: Client, player: PlayerState): Promise<void> {
  await client.query(
    `UPDATE characters SET
       level = $2, xp = $3, unspent_points = $4,
       alloc_brawn = $5, alloc_agility = $6, alloc_insight = $7,
       alloc_battery = $8, alloc_charisma = $9,
       credits = $10, processors = $11, vehicle_tier = $12,
       highest_floor_cleared = $13, current_floor = $14,
       total_runs = $15, total_wins = $16, flags = $17
     WHERE id = $1`,
    [
      player.id,
      player.level,
      player.xp,
      player.unspentPoints,
      player.allocated.brawn,
      player.allocated.agility,
      player.allocated.insight,
      player.allocated.battery,
      player.allocated.charisma,
      player.wallet.credits,
      player.wallet.processors,
      player.overheat.vehicleTier,
      player.progress.highestFloorCleared,
      player.progress.currentFloor,
      player.progress.totalRuns,
      player.progress.totalWins,
      JSON.stringify(player.flags),
    ],
  );
}

/** Inserts freshly rolled loot and returns it with database-assigned ids. */
export async function insertItems(
  client: Client,
  characterId: string,
  items: Item[],
  source: 'floor' | 'expedition' | 'starter' | 'shop',
): Promise<Item[]> {
  const out: Item[] = [];
  for (const item of items) {
    const { rows } = await client.query(
      `INSERT INTO items (character_id, base_id, name, slot, rarity, ilvl, plus,
                          modifiers, affixes, sell_value, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        characterId,
        item.baseId,
        item.name,
        item.slot,
        item.rarity,
        item.ilvl,
        item.plus,
        JSON.stringify(item.modifiers),
        JSON.stringify(item.affixes),
        item.sellValue,
        source,
      ],
    );
    out.push(toItem(rows[0]));
  }
  return out;
}

/** Equips an item, vacating the slot first. The partial unique index on
 *  (character_id, equipped_slot) is the real guarantee; this is the happy path. */
export async function equip(client: Client, characterId: string, itemId: string): Promise<SlotId> {
  const { rows } = await client.query(
    `SELECT slot FROM items WHERE id = $1 AND character_id = $2`,
    [itemId, characterId],
  );
  if (!rows[0]) throw new GameError(404, 'Item not in your inventory.', 'no_item');
  const slot = rows[0].slot as SlotId;

  await client.query(
    `UPDATE items SET equipped_slot = NULL WHERE character_id = $1 AND equipped_slot = $2`,
    [characterId, slot],
  );
  await client.query(`UPDATE items SET equipped_slot = slot WHERE id = $1`, [itemId]);
  return slot;
}

export async function unequip(client: Client, characterId: string, slot: SlotId): Promise<void> {
  if (!SLOTS.includes(slot)) throw new GameError(400, 'Unknown equipment slot.', 'bad_slot');
  await client.query(
    `UPDATE items SET equipped_slot = NULL WHERE character_id = $1 AND equipped_slot = $2`,
    [characterId, slot],
  );
}
