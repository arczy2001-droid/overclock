import { BALANCE } from '../config/balance';
import { CLASSES } from '../data/content';
import type {
  BattleResult,
  Buff,
  ClassId,
  Combatant,
  CombatEvent,
  CombatEventType,
  DerivedStats,
  FloorDefinition,
} from '../types';
import { Rng } from './rng';
import { clamp } from './stats';

/**
 * Pure, deterministic auto-battler.
 *
 * The player has zero input once `runBattle` is called: this function receives
 * a fully-resolved snapshot, plays the whole fight, and returns a log the UI
 * replays at whatever speed it likes. Same seed + same snapshot = same fight,
 * which is what lets an authoritative server re-run and verify a result.
 */

export interface BattleInput {
  seed: number;
  floor: FloorDefinition;
  operator: {
    id: string;
    name: string;
    classId: ClassId;
    stats: DerivedStats;
  };
}

/* ------------------------------------------------------------------ */
/* Setup                                                              */
/* ------------------------------------------------------------------ */

function makeCombatant(
  id: string,
  name: string,
  side: Combatant['side'],
  stats: DerivedStats,
  classId?: ClassId,
): Combatant {
  return {
    id,
    name,
    side,
    classId,
    hp: stats.maxHp,
    stats: { ...stats },
    charge: 0,
    buffs: [],
    runtime: { armorBypassedUntilRound: -1, lastDamageTaken: 0, lastAttackerId: null },
  };
}

/* ------------------------------------------------------------------ */
/* Stat resolution with buffs                                         */
/* ------------------------------------------------------------------ */

function effectiveStats(unit: Combatant): DerivedStats {
  const out = { ...unit.stats };
  for (const buff of unit.buffs) {
    out.dodge += buff.modifiers.dodgePct ?? 0;
    out.armor += buff.modifiers.armor ?? 0;
    out.critChance += buff.modifiers.critChancePct ?? 0;
    out.attack *= 1 + (buff.modifiers.damagePct ?? 0);
  }
  out.dodge = clamp(out.dodge, 0, BALANCE.stats.dodgeCap);
  out.critChance = clamp(out.critChance, 0, BALANCE.stats.critCap);
  return out;
}

/* ------------------------------------------------------------------ */
/* Engine                                                             */
/* ------------------------------------------------------------------ */

export function runBattle(input: BattleInput): BattleResult {
  const rng = new Rng(input.seed);
  const log: CombatEvent[] = [];
  let round = 0;
  let damageDealt = 0;
  let damageTaken = 0;

  const operator = makeCombatant(
    input.operator.id,
    input.operator.name,
    'operator',
    input.operator.stats,
    input.operator.classId,
  );
  const hostile = makeCombatant('hostile', input.floor.enemyName, 'hostile', input.floor.stats);
  const units = [operator, hostile];

  const snapshot = (): Record<string, number> => ({
    [operator.id]: Math.max(0, Math.round(operator.hp)),
    [hostile.id]: Math.max(0, Math.round(hostile.hp)),
  });

  const emit = (type: CombatEventType, text: string, extra: Partial<CombatEvent> = {}) => {
    log.push({ round, type, text, hpSnapshot: snapshot(), ...extra });
  };

  emit(
    'battle_start',
    `FLOOR ${input.floor.floor} — ${input.floor.sector}. Hostile on file: ${hostile.name}.`,
  );

  /* --- damage pipeline ------------------------------------------- */

  const dealDamage = (
    attacker: Combatant,
    defender: Combatant,
    rawMultiplier: number,
    label: string,
    opts: { canDodge?: boolean; canCrit?: boolean; ignoreArmor?: boolean } = {},
  ) => {
    const { canDodge = true, canCrit = true, ignoreArmor = false } = opts;
    const atk = effectiveStats(attacker);
    const def = effectiveStats(defender);

    if (canDodge && rng.chance(def.dodge)) {
      defender.charge = clamp(defender.charge + BALANCE.charge.gainOnDodge, 0, BALANCE.charge.max);
      emit('dodge', `${defender.name} is simply not there. ${label} hits municipal concrete.`, {
        sourceId: attacker.id,
        targetId: defender.id,
      });
      return 0;
    }

    const variance = rng.range(BALANCE.combat.varianceMin, BALANCE.combat.varianceMax);
    const isCrit = canCrit && rng.chance(atk.critChance);
    let raw = atk.attack * rawMultiplier * variance * (isCrit ? atk.critMultiplier : 1);

    const armorIsOffline = ignoreArmor || defender.runtime.armorBypassedUntilRound >= round;
    const armor = armorIsOffline ? 0 : def.armor;
    const dealt = Math.max(raw * BALANCE.stats.minDamageThrough, raw - armor);
    const final = Math.max(1, Math.round(dealt));

    defender.hp -= final;
    defender.runtime.lastDamageTaken = final;
    defender.runtime.lastAttackerId = attacker.id;
    defender.charge = clamp(defender.charge + BALANCE.charge.gainOnDamaged, 0, BALANCE.charge.max);

    if (attacker.side === 'operator') damageDealt += final;
    else damageTaken += final;

    emit(isCrit ? 'crit' : 'attack', formatHit(attacker, defender, label, final, isCrit, armorIsOffline), {
      sourceId: attacker.id,
      targetId: defender.id,
      amount: final,
    });

    if (defender.hp <= 0) {
      emit('death', `${defender.name} stops complying. Permanently.`, { targetId: defender.id });
    }
    return final;
  };

  /* --- ultimates --------------------------------------------------- */

  const fireUltimate = (unit: Combatant, target: Combatant): { consumesTurn: boolean } => {
    const cls = unit.classId ? CLASSES[unit.classId] : null;
    if (!cls) return { consumesTurn: false };
    unit.charge = 0;
    emit('ultimate', `>> ${cls.ultimate.name.toUpperCase()} <<`, { sourceId: unit.id });

    switch (cls.ultimate.id) {
      /* Three precision strikes, then +30% evasion for 3 turns. */
      case 'corporate_restructuring': {
        for (let i = 0; i < 3 && target.hp > 0; i++) {
          dealDamage(unit, target, 0.62, `restructuring pass ${i + 1}/3`, { canCrit: true });
        }
        applyBuff(unit, {
          id: 'restructuring_evasion',
          label: 'Plausible Deniability',
          turns: 3,
          modifiers: { dodgePct: 0.3 },
        }, emit);
        return { consumesTurn: true };
      }

      /* Weld the plating back on, and return 30% of the last hit to sender. */
      case 'jury_rigged_armor': {
        const stats = effectiveStats(unit);
        const heal = Math.round(stats.armor * 4 + stats.maxHp * 0.08);
        unit.hp = Math.min(stats.maxHp, unit.hp + heal);
        emit('heal', `${unit.name} welds ${heal} HP of plating back on. It holds. Mostly.`, {
          sourceId: unit.id,
          amount: heal,
        });

        const reflect = Math.round(unit.runtime.lastDamageTaken * 0.3);
        if (reflect > 0 && target.hp > 0) {
          target.hp -= reflect;
          damageDealt += reflect;
          emit('reflect', `${reflect} damage returned to sender, postage due.`, {
            sourceId: unit.id,
            targetId: target.id,
            amount: reflect,
          });
          if (target.hp <= 0) {
            emit('death', `${target.name} is refunded out of existence.`, { targetId: target.id });
          }
        }
        return { consumesTurn: false }; // still gets a normal attack this turn
      }

      /* Strip armor for a turn; delete anything under 10% HP. */
      case 'format_c': {
        target.runtime.armorBypassedUntilRound = round + 1;
        emit('buff_applied', `${target.name}'s plating is unmounted. Filesystem exposed.`, {
          targetId: target.id,
        });

        const threshold = target.stats.maxHp * 0.1;
        if (target.hp > 0 && target.hp <= threshold) {
          const overkill = Math.round(target.hp);
          target.hp = 0;
          damageDealt += overkill;
          emit('execute', `rm -rf ${target.name}. No confirmation prompt.`, {
            sourceId: unit.id,
            targetId: target.id,
            amount: overkill,
          });
          emit('death', `${target.name} is deleted. Recycle bin unavailable.`, { targetId: target.id });
          return { consumesTurn: true };
        }
        return { consumesTurn: false };
      }
    }
    return { consumesTurn: false };
  };

  /* --- turn order --------------------------------------------------- */

  const order = [...units].sort((a, b) => {
    const diff = effectiveStats(b).initiative - effectiveStats(a).initiative;
    return diff !== 0 ? diff : rng.next() - 0.5;
  });

  /* --- main loop ---------------------------------------------------- */

  let outcome: BattleResult['outcome'] = 'throttled';

  loop: for (round = 1; round <= BALANCE.combat.maxRounds; round++) {
    emit('round_start', `— round ${round} —`);

    for (const unit of order) {
      if (unit.hp <= 0) continue;
      const target = units.find((u) => u.id !== unit.id)!;
      if (target.hp <= 0) break loop;

      tickBuffs(unit, emit);

      const gain = unit.side === 'operator' ? unit.stats.chargeRate : BALANCE.charge.enemyGainPerTurn;
      unit.charge = clamp(unit.charge + gain, 0, BALANCE.charge.max);
      emit('turn_start', `${unit.name} acts. [charge ${Math.round(unit.charge)}%]`, {
        sourceId: unit.id,
      });

      let consumed = false;
      if (unit.side === 'operator' && unit.charge >= BALANCE.charge.max) {
        consumed = fireUltimate(unit, target).consumesTurn;
      }
      if (target.hp <= 0) break loop;

      if (!consumed) {
        dealDamage(unit, target, 1, 'strike');
      }
      if (target.hp <= 0) break loop;
    }
  }

  if (operator.hp <= 0) outcome = 'operator_down';
  else if (hostile.hp <= 0) outcome = 'hostile_down';

  const victory = outcome === 'hostile_down';
  emit(
    'battle_end',
    victory
      ? `Floor ${input.floor.floor} cleared. Paperwork filed automatically.`
      : outcome === 'throttled'
        ? 'Thermal throttle. The fight is called on a technicality. You lose.'
        : 'Operator offline. Respawn fee deducted from nothing.',
  );

  return {
    seed: input.seed,
    floor: input.floor.floor,
    victory,
    rounds: Math.min(round, BALANCE.combat.maxRounds),
    outcome,
    log,
    damageDealt,
    damageTaken,
    rewards: null, // filled in by the progression layer, which owns the economy
  };
}

/* ------------------------------------------------------------------ */
/* Buff helpers                                                       */
/* ------------------------------------------------------------------ */

type Emit = (type: CombatEventType, text: string, extra?: Partial<CombatEvent>) => void;

function applyBuff(unit: Combatant, buff: Buff, emit: Emit): void {
  const existing = unit.buffs.find((b) => b.id === buff.id);
  if (existing) existing.turns = Math.max(existing.turns, buff.turns);
  else unit.buffs.push({ ...buff });
  emit('buff_applied', `${unit.name}: ${buff.label} (${buff.turns} turns).`, { targetId: unit.id });
}

function tickBuffs(unit: Combatant, emit: Emit): void {
  for (const buff of [...unit.buffs]) {
    buff.turns -= 1;
    if (buff.turns <= 0) {
      unit.buffs = unit.buffs.filter((b) => b !== buff);
      emit('buff_expired', `${unit.name}: ${buff.label} lapsed.`, { targetId: unit.id });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Log copy                                                           */
/* ------------------------------------------------------------------ */

function formatHit(
  attacker: Combatant,
  defender: Combatant,
  label: string,
  amount: number,
  isCrit: boolean,
  armorOffline: boolean,
): string {
  const head = `${attacker.name} → ${defender.name}`;
  const suffix = [
    isCrit ? 'CRIT' : null,
    armorOffline ? 'armor offline' : null,
  ].filter(Boolean).join(', ');
  return `${head}: ${label} for ${amount}${suffix ? ` (${suffix})` : ''}.`;
}
