import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BALANCE } from '../../../src/config/balance.js';
import { runBattle } from '../../../src/systems/combat.js';
import { getFloor, rollFloorRewards } from '../../../src/systems/floors.js';
import { heatCost } from '../../../src/systems/overheat.js';
import { deriveStats, grantXp } from '../../../src/systems/stats.js';
import { requireCharacter } from '../auth.js';
import { GameError, pool, tx, type Client } from '../db.js';
import { insertItems, loadCharacter, saveCharacter } from '../mapper.js';
import { dayKey } from '../time.js';

/**
 * The floor attack. Everything the client used to decide, the server now
 * decides: whether there is heat for it, what the enemy is, what the dice
 * said, and what it paid.
 *
 * Order is deliberate. Heat is charged BEFORE the fight, inside the same
 * transaction, so a loss still costs temperature — without that, floor choice
 * carries no risk and the optimal play is to spam the deepest floor until it
 * happens to work. If the handler throws, the transaction rolls back and the
 * heat comes with it: there is no state where a player paid for a fight that
 * never happened.
 */

const setFloorBody = z.object({ floor: z.number().int().min(1).max(10_000) });

/**
 * Charges heat atomically. The day row is created on first use, so the
 * midnight reset is not an event — tomorrow's row simply does not exist yet.
 * Zero rows back means the combined value would exceed 100, which is refused
 * outright rather than clamped: 98 heat with a 6-cost floor is a stop.
 */
async function spendHeat(
  client: Client,
  characterId: string,
  key: string,
  cost: number,
): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO character_days AS d (character_id, day_key, heat, attacks)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (character_id, day_key) DO UPDATE
        SET heat = d.heat + EXCLUDED.heat, attacks = d.attacks + 1
      WHERE d.heat + EXCLUDED.heat <= $4
     RETURNING heat`,
    [characterId, key, cost, BALANCE.overheat.max],
  );
  if (!rows[0]) {
    throw new GameError(409, 'Core temperature critical. Vent heat or wait for the 00:00 reset.', 'too_hot');
  }
  return Number(rows[0].heat);
}

export default async function combatRoutes(app: FastifyInstance) {
  /** Preview a floor without committing to it. Read-only, no heat. */
  app.get('/api/floor/:n', async (request) => {
    const session = requireCharacter(request);
    const n = Number((request.params as { n: string }).n);
    if (!Number.isInteger(n) || n < 1) throw new GameError(400, 'Bad floor number.', 'bad_floor');

    const player = await loadCharacter(pool, session.characterId);
    if (n > player.progress.highestFloorCleared + 1) {
      throw new GameError(403, 'That floor is not unlocked yet.', 'locked_floor');
    }
    return { floor: getFloor(n), heatCost: heatCost(player, n) };
  });

  app.post('/api/floor', async (request) => {
    const session = requireCharacter(request);
    const { floor } = setFloorBody.parse(request.body);
    return tx(async (client) => {
      const player = await loadCharacter(client, session.characterId, { forUpdate: true });
      if (floor > player.progress.highestFloorCleared + 1) {
        throw new GameError(403, 'That floor is not unlocked yet.', 'locked_floor');
      }
      player.progress.currentFloor = floor;
      await saveCharacter(client, player);
      return { state: await loadCharacter(client, session.characterId) };
    });
  });

  app.post('/api/attack', async (request) => {
    const session = requireCharacter(request);

    return tx(async (client) => {
      // FOR UPDATE serialises concurrent attacks on one character. The WHERE
      // guard in spendHeat is belt to this braces: the lock stops two tabs,
      // the guard stops a logic bug in anything that forgets the lock.
      const player = await loadCharacter(client, session.characterId, { forUpdate: true });

      const floorNumber = player.progress.currentFloor;
      const floor = getFloor(floorNumber);
      const cost = heatCost(player, floorNumber);
      const key = dayKey(player.timezone);
      const heatBefore = player.overheat.value;

      const heatAfter = await spendHeat(client, session.characterId, key, cost);

      // The seed is generated here and never accepted from the client. It is
      // stored on the battle row, so any fight can be replayed months later to
      // check the result — the engine is deterministic, which is what makes a
      // ~100 byte audit trail sufficient instead of a 4KB log.
      const seed = randomInt(0, 2 ** 31);
      const stats = deriveStats(player);
      const result = runBattle({
        seed,
        floor,
        operator: { id: player.id, name: player.name, classId: player.classId, stats },
      });

      player.progress.totalRuns += 1;
      let levelsGained = 0;
      let advanced = false;

      if (result.victory) {
        const rewards = rollFloorRewards(seed, floor);
        player.wallet.credits += rewards.credits;
        player.wallet.processors += rewards.processors;
        levelsGained = grantXp(player, rewards.xp).levelsGained;
        player.progress.totalWins += 1;

        if (floorNumber > player.progress.highestFloorCleared) {
          player.progress.highestFloorCleared = floorNumber;
          player.progress.currentFloor = floorNumber + 1;
          advanced = true;
        }

        const stored = await insertItems(client, session.characterId, rewards.items, 'floor');
        result.rewards = { ...rewards, items: stored };

        await client.query(
          `UPDATE character_days
              SET wins = wins + 1, credits_earned = credits_earned + $3
            WHERE character_id = $1 AND day_key = $2`,
          [session.characterId, key, rewards.credits],
        );
      }

      await saveCharacter(client, player);

      await client.query(
        `INSERT INTO battles (character_id, floor, seed, victory, outcome, rounds,
                              heat_before, heat_cost, stat_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          session.characterId,
          floorNumber,
          seed,
          result.victory,
          result.outcome,
          result.rounds,
          heatBefore,
          cost,
          JSON.stringify(stats),
        ],
      );

      return {
        state: await loadCharacter(client, session.characterId),
        battle: {
          victory: result.victory,
          outcome: result.outcome,
          rounds: result.rounds,
          log: result.log,
          rewards: result.rewards,
          levelsGained,
          advanced,
          heat: heatAfter,
        },
      };
    });
  });
}
