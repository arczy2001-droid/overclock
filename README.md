# OVERTIME.EXE

A browser idle RPG. You are a gig-economy dungeon courier climbing a building that is
legally several buildings. High-tech, low-life, dystopian bureaucracy, dark humour.

## Try it

Open `ui/index.html` in a browser. It is a complete playable prototype — attack floors,
allocate `Krzepa / Spryt / Przenikliwość / Bateria / Charyzma`, equip and upgrade gear,
vent heat, book guard shifts, buy vehicles. State is in memory for the session only.

The "skip ahead 1 hour" button on the Guard duty tab exists so you can see the expedition
collection flow without waiting eight hours.

## Use the engine

```bash
npx tsc                          # typechecks clean, strict mode
node build/tools/simulate.js 120 # auto-play balance sim, 120 in-game days
```

```ts
import { createPlayer, attackFloor, deriveStats } from './src';

const player = createPlayer('K. NOWAK', 'hacker');
const outcome = attackFloor(player);
if (outcome.ok) {
  outcome.result.log.forEach((event) => console.log(event.text));
}
```

## Layout

| Path | What |
|---|---|
| `docs/ARCHITECTURE.md` | full spec: authority model, combat, scaling, UI architecture, balance method |
| `schema/*.schema.json` | JSON Schema for player state, items, combat, floor scaling |
| `schema/example-save.json` | a real save produced by the engine, two floors in |
| `src/config/balance.ts` | every tunable number in the game |
| `src/systems/combat.ts` | the auto-battler |
| `src/systems/overheat.ts` | heat, vehicles, coolant, local-midnight reset |
| `src/systems/expedition.ts` | passive guard duty |
| `tools/simulate.ts` | auto-play simulator for balance passes |
| `ui/index.html` | playable prototype, self-contained |

## Three rules the codebase keeps

1. **Nothing calls `Math.random()` inside a system.** Every roll goes through a seeded
   stream so a server can replay any battle or reward and reject a fabricated one.
2. **Nothing reads the clock implicitly.** `now` is an argument. Offline progress, the
   midnight reset and the expedition timer are all just timestamp comparisons.
3. **Every tunable number lives in `config/balance.ts`.** If you find a magic constant in
   a system file, it is a bug.
