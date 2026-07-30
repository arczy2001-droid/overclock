/**
 * Every number a designer might want to touch lives here.
 * Systems import from this file; nothing hardcodes a magic constant.
 */

export const BALANCE = {
  /* --- Stat scaling ------------------------------------------------ */
  stats: {
    /** maxHp = (baseHp + battery * hpPerBattery) * classHpMultiplier */
    baseHp: 90,
    hpPerBattery: 11,
    /** attack = (baseAttack + mainStat * attackPerMainStat + offStatBleed) */
    baseAttack: 9,
    attackPerMainStat: 1.35,
    /** Non-main primary attributes still contribute a little. */
    offStatBleed: 0.35,
    /** dodge = charisma / (charisma + dodgeSoftening) */
    dodgeSoftening: 95,
    dodgeCap: 0.6,
    /** crit = baseCrit + insight * critPerInsight */
    baseCrit: 0.04,
    critPerInsight: 0.0035,
    critCap: 0.75,
    baseCritMultiplier: 1.6,
    /** initiative = baseInitiative + agility * initiativePerAgility */
    baseInitiative: 10,
    initiativePerAgility: 0.6,
    /** Fraction of damage that always lands, no matter how much armor. */
    minDamageThrough: 0.1,
  },

  /* --- Charge meter ------------------------------------------------ */
  charge: {
    max: 100,
    /** Gained at the start of the owner's turn. */
    baseGainPerTurn: 14,
    gainPerInsight: 0.22,
    /** Bonus charge for eating a hit — desperation pays. */
    gainOnDamaged: 5,
    /** Bonus charge for a clean dodge. */
    gainOnDodge: 9,
    enemyGainPerTurn: 0,
  },

  /* --- Combat loop -------------------------------------------------- */
  combat: {
    /** Damage roll spread: 0.9x .. 1.1x */
    varianceMin: 0.9,
    varianceMax: 1.1,
    /** Hard stop. Hitting it counts as a loss ("thermal throttle"). */
    maxRounds: 60,
  },

  /* --- Levelling ---------------------------------------------------- */
  progression: {
    pointsPerLevel: 5,
    /** xpToNext(level) = round(xpBase * xpGrowth^(level-1)) */
    xpBase: 90,
    xpGrowth: 1.072,
    maxLevel: 200,
    /** Credit cost to buy a single attribute point outright. */
    statBuyBaseCost: 60,
    statBuyGrowth: 1.045,
  },

  /* --- Floors -------------------------------------------------------- */
  /**
   * Enemy stats are LINEAR in the floor number with a slow exponential creep
   * on top. This is deliberate and it is the single most important balance
   * decision in the game: player damage grows roughly linearly with depth
   * (gear ilvl == floor), so a purely exponential enemy curve produces a hard
   * wall the player can never out-scale, no matter how long they idle.
   * Linear base + 1% creep keeps every floor beatable while still slowing the
   * climb down to a crawl in the deep sectors, which is where the idle half of
   * the game is supposed to take over.
   *
   *   hp(n)     = (hpBase + hpPerFloor * n) * hpGrowth^(n-1)
   *   attack(n) = (attackBase + attackPerFloor * n) * attackGrowth^(n-1)
   */
  floors: {
    hpBase: 120,
    hpPerFloor: 70,
    hpGrowth: 1.016,
    attackBase: 6,
    attackPerFloor: 11,
    attackGrowth: 1.0,
    armorBase: 2,
    armorPerFloor: 2.2,
    dodgeBase: 0.02,
    dodgePerFloor: 0.0016,
    dodgeCap: 0.35,
    initiativeBase: 11,
    initiativePerFloor: 0.35,
    /** Every Nth floor is a boss. */
    bossInterval: 10,
    bossHpMultiplier: 2.2,
    bossAttackMultiplier: 1.35,
    bossArmorMultiplier: 1.4,
    /** Floors per named sector. */
    sectorSize: 10,
    rewards: {
      creditsBase: 45,
      creditsPerFloor: 10,
      creditsGrowth: 1.012,
      xpBase: 40,
      xpPerFloor: 4,
      xpGrowth: 1.012,
      bossRewardMultiplier: 3,
      processorChance: 0.012,
      bossProcessorChance: 0.35,
      itemChance: 0.2,
      bossItemChance: 0.9,
    },
  },

  /* --- Overheat ------------------------------------------------------ */
  overheat: {
    max: 100,
    /** Base heat per active attack before vehicle + gear cooling. */
    baseHeatPerAttack: 10,
    /** Deeper floors cook the rig harder. */
    heatPerFloorStep: 0.05,
    heatFloorStepSize: 25,
    heatCap: 20,
    heatMin: 2,
    coolant: {
      dailyCharges: 10,
      reductionPerUse: 20,
    },
    /** Multiplicative reduction on generated heat, by vehicle tier. */
    vehicleReduction: [0, 0.1, 0.2, 0.3, 0.5] as const,
    /** Gear cooling is additive with the vehicle, then clamped. */
    maxTotalReduction: 0.75,
  },

  /* --- Passive expeditions -------------------------------------------- */
  expeditions: {
    durations: [1, 4, 8] as const,
    /** creditsPerHour = base * (1 + floor * floorFactor) */
    creditsPerHourBase: 210,
    creditsPerHourFloorFactor: 0.085,
    xpPerHourBase: 55,
    xpPerHourFloorFactor: 0.06,
    /** Longer runs are slightly more efficient — rewards patience, not clicking. */
    durationBonus: { 1: 1, 4: 1.08, 8: 1.18 } as Record<number, number>,
    processorChancePerHour: 0.06,
    processorChanceFloorFactor: 0.0025,
    itemRollsPerHour: 0.35,
    /** Items found on guard duty are pulled from slightly below current depth. */
    itemIlvlOffset: -3,
    /** Guard duty ignores heat entirely — that is the whole point of it. */
    ignoresOverheat: true,
  },

  /* --- Economy --------------------------------------------------------- */
  economy: {
    upgradeCostBase: 90,
    upgradeCostGrowth: 1.24,
    /** Item power gained per +1 upgrade level. */
    upgradePowerStep: 0.08,
    maxUpgradeLevel: 15,
    sellValueRatio: 0.25,
    coolantProcessorCost: 2,
    /** Instantly finish a passive expedition. */
    expeditionSkipCostPerHour: 3,
  },
} as const;

export type Balance = typeof BALANCE;
