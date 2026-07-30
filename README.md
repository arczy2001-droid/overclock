# OVERTIME.EXE

A browser idle RPG. You are a gig-economy dungeon courier climbing a building that is
legally several buildings. High-tech, low-life, dystopian bureaucracy, dark humour.

## Run it

```bash
cp .env.example .env          # change POSTGRES_PASSWORD
docker compose up --build     # migrations run on boot
open http://localhost:8080
```

The API serves the client from the same origin, so the session cookie is
first-party and CORS never enters the picture.

Local development against the compose database only:

```bash
docker compose up -d db
cd server && npm install && npm run migrate && npm run dev
```

## Try it

Open `ui/index.html` in a browser. Register an account, fill in the intake form, and the
dashboard opens: attack floors, allocate `Krzepa / Spryt / Przenikliwość / Bateria /
Charyzma`, equip and upgrade gear, vent heat, book guard shifts, buy vehicles.

Accounts, characters and every rule now live on the server. The client renders; it does
not decide. Sign in from any device and your character follows.

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
| `db/migrations/` | forward-only SQL migrations, applied by `db/migrate.ts` |
| `db/critical-queries.sql` | the four statements carrying the race and anti-cheat guarantees |
| `server/src/routes/combat.ts` | atomic heat spend, authoritative battle, loot grant |
| `server/src/mapper.ts` | the only module that knows both the row shape and `PlayerState` |
| `ui/api.js` | browser API client and the server→UI state adapter |
| `tools/simulate.ts` | auto-play simulator for balance passes |
| `ui/index.html` | playable prototype, self-contained |

## Three rules the codebase keeps

1. **Nothing calls `Math.random()` inside a system.** Every roll goes through a seeded
   stream, and the server stores the seed — so any battle can be replayed months later
   and checked against the result that was paid out.
2. **Nothing reads the clock implicitly.** `now` is an argument. Offline progress, the
   midnight reset and the expedition timer are all just timestamp comparisons.
3. **Every tunable number lives in `config/balance.ts`.** If you find a magic constant in
   a system file, it is a bug.
4. **Rules live in `WHERE` clauses, not in `if` statements.** Never read a balance, check
   it, then write it. Put the condition in the statement and let zero affected rows mean
   "declined".
