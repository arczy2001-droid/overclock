import { BALANCE } from '../config/balance';
import { VEHICLES } from '../data/content';
import type { OverheatState, PlayerState, VehicleTier } from '../types';
import { clamp, deriveStats } from './stats';

/**
 * The overheat meter is the game's only real gate on active play.
 *
 * Rules, in order of precedence:
 *  1. Heat is generated per active floor attack, never by passive expeditions.
 *  2. Vehicle reduction and gear cooling are additive, then clamped.
 *  3. The meter resets to 0 at the player's local midnight, not UTC midnight.
 *  4. Coolant gives 10 charges per local day, each worth -20 heat.
 */

/* ------------------------------------------------------------------ */
/* Day boundaries                                                     */
/* ------------------------------------------------------------------ */

/** `YYYY-MM-DD` in the player's timezone. Two calls either side of local
 *  midnight return different keys — that is the whole reset mechanism. */
export function localDayKey(timestamp: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

/** Epoch ms of the next local midnight — drives the countdown in the UI. */
export function nextMidnight(timestamp: number, timezone: string): number {
  const oneMinute = 60_000;
  const today = localDayKey(timestamp, timezone);
  // Walk forward in coarse steps, then refine. Cheap, timezone-rule-proof,
  // and correct across DST shifts without shipping a tz database.
  let cursor = timestamp;
  const step = 30 * oneMinute;
  while (localDayKey(cursor, timezone) === today) cursor += step;
  let low = cursor - step;
  while (low < cursor) {
    const mid = low + Math.floor((cursor - low) / 2 / oneMinute) * oneMinute;
    if (mid <= low) break;
    if (localDayKey(mid, timezone) === today) low = mid;
    else cursor = mid;
  }
  return cursor;
}

/** Call before reading or mutating heat. Idempotent. */
export function applyDailyReset(player: PlayerState, now: number = Date.now()): boolean {
  const key = localDayKey(now, player.timezone);
  if (player.overheat.dayKey === key) return false;
  player.overheat.dayKey = key;
  player.overheat.value = 0;
  player.overheat.coolantUsedToday = 0;
  return true;
}

/* ------------------------------------------------------------------ */
/* Heat generation                                                    */
/* ------------------------------------------------------------------ */

export function vehicleReduction(tier: VehicleTier): number {
  return BALANCE.overheat.vehicleReduction[tier] ?? 0;
}

/** Combined vehicle + gear cooling, clamped so heat can never reach zero cost. */
export function totalCoolingPct(player: PlayerState): number {
  const gear = deriveStats(player).coolingPct;
  return clamp(vehicleReduction(player.overheat.vehicleTier) + gear, 0, BALANCE.overheat.maxTotalReduction);
}

/** Raw heat a floor demands before any reduction. */
export function baseHeatForFloor(floor: number): number {
  const o = BALANCE.overheat;
  const steps = Math.floor((floor - 1) / o.heatFloorStepSize);
  return clamp(o.baseHeatPerAttack * (1 + steps * o.heatPerFloorStep), o.heatMin, o.heatCap);
}

/** What this specific player pays to attack this specific floor. */
export function heatCost(player: PlayerState, floor: number): number {
  const raw = baseHeatForFloor(floor) * (1 - totalCoolingPct(player));
  return Math.max(BALANCE.overheat.heatMin, Math.round(raw * 10) / 10);
}

export interface HeatCheck {
  allowed: boolean;
  cost: number;
  current: number;
  projected: number;
  reason?: string;
}

/**
 * An attack is allowed only if the rig can absorb the whole cost. Partial
 * commits are not permitted: 98/100 heat with a 6-cost floor means stop.
 */
export function canAttack(player: PlayerState, floor: number, now: number = Date.now()): HeatCheck {
  applyDailyReset(player, now);
  const cost = heatCost(player, floor);
  const current = player.overheat.value;
  const projected = current + cost;
  if (projected > BALANCE.overheat.max) {
    return {
      allowed: false,
      cost,
      current,
      projected,
      reason: 'Core temperature critical. Vent heat or wait for the 00:00 reset.',
    };
  }
  return { allowed: true, cost, current, projected };
}

/** Commit the heat. Call only after a successful `canAttack`. */
export function applyHeat(player: PlayerState, floor: number, now: number = Date.now()): HeatCheck {
  const check = canAttack(player, floor, now);
  if (!check.allowed) return check;
  player.overheat.value = clamp(check.projected, 0, BALANCE.overheat.max);
  return { ...check, current: player.overheat.value };
}

/* ------------------------------------------------------------------ */
/* Coolant                                                            */
/* ------------------------------------------------------------------ */

export interface CoolantResult {
  ok: boolean;
  removed: number;
  remainingCharges: number;
  reason?: string;
}

export function coolantChargesLeft(player: PlayerState, now: number = Date.now()): number {
  applyDailyReset(player, now);
  return BALANCE.overheat.coolant.dailyCharges - player.overheat.coolantUsedToday;
}

export function useCoolant(player: PlayerState, now: number = Date.now()): CoolantResult {
  applyDailyReset(player, now);
  const left = coolantChargesLeft(player, now);
  if (left <= 0) {
    return {
      ok: false,
      removed: 0,
      remainingCharges: 0,
      reason: 'Daily coolant ration spent. Requisition resets at 00:00.',
    };
  }
  if (player.overheat.value <= 0) {
    return { ok: false, removed: 0, remainingCharges: left, reason: 'Already cold.' };
  }
  const before = player.overheat.value;
  player.overheat.value = clamp(before - BALANCE.overheat.coolant.reductionPerUse, 0, BALANCE.overheat.max);
  player.overheat.coolantUsedToday += 1;
  return {
    ok: true,
    removed: before - player.overheat.value,
    remainingCharges: left - 1,
  };
}

/* ------------------------------------------------------------------ */
/* Vehicles                                                           */
/* ------------------------------------------------------------------ */

export type PurchaseResult = { ok: true } | { ok: false; reason: string };

export function buyVehicle(player: PlayerState, tier: VehicleTier): PurchaseResult {
  const vehicle = VEHICLES.find((v) => v.tier === tier);
  if (!vehicle) return { ok: false, reason: 'No such vehicle on the lot.' };
  if (player.overheat.vehicleTier >= tier) return { ok: false, reason: 'Already owned.' };
  if (player.overheat.vehicleTier !== tier - 1) {
    return { ok: false, reason: 'Tiers must be bought in order. Finance says so.' };
  }
  if (player.wallet.credits < vehicle.costCredits) {
    return { ok: false, reason: `Needs ${vehicle.costCredits.toLocaleString()} credits.` };
  }
  if (player.wallet.processors < vehicle.costProcessors) {
    return { ok: false, reason: `Needs ${vehicle.costProcessors} processors.` };
  }
  player.wallet.credits -= vehicle.costCredits;
  player.wallet.processors -= vehicle.costProcessors;
  player.overheat.vehicleTier = tier;
  player.flags.unlocks.push(`vehicle_t${tier}`);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* UI helper                                                          */
/* ------------------------------------------------------------------ */

export interface HeatSummary {
  value: number;
  cost: number;
  attacksRemaining: number;
  coolantLeft: number;
  coolingPct: number;
  vehicleName: string;
  resetsAt: number;
}

export function heatSummary(player: PlayerState, now: number = Date.now()): HeatSummary {
  applyDailyReset(player, now);
  const cost = heatCost(player, player.progress.currentFloor);
  const state: OverheatState = player.overheat;
  return {
    value: state.value,
    cost,
    attacksRemaining: Math.floor((BALANCE.overheat.max - state.value) / cost),
    coolantLeft: coolantChargesLeft(player, now),
    coolingPct: totalCoolingPct(player),
    vehicleName: VEHICLES.find((v) => v.tier === state.vehicleTier)?.name ?? 'On Foot',
    resetsAt: nextMidnight(now, player.timezone),
  };
}
