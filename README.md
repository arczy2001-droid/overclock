# OVERTIME.EXE

A browser idle RPG. You are a gig-economy dungeon courier climbing a building that is
legally several buildings. High-tech, low-life, dystopian bureaucracy, dark humour.

## Two ways to run it

The client works with or without the server, chosen by one line in
`ui/config.js`:

| `apiBase` | Mode | Where it runs | Trade |
|---|---|---|---|
| `''` | **Local** | Any static host, including GitHub Pages | One browser, one device. The client is trusted, so everything is editable in devtools. Fine for single-player. |
| `'https://api.example.com'` | **Server** | Anywhere that runs containers | Accounts follow the player across devices, every rule enforced server-side, leaderboards mean something. |

Both share one interface: `ui/api.js` speaks HTTP, `ui/local-backend.js` speaks
localStorage, and the UI cannot tell them apart. The sign-in panel prints which
build is live.

### GitHub Pages (local mode)

Push to `main`; `.github/workflows/pages.yml` publishes `ui/`. Nothing to build.

**Pages cannot host the server** — it serves static files and runs no Node
process and no database. If you want server mode, the API needs a container
host (Fly.io, Railway, Render, a VPS); set `apiBase` to it and add your Pages
origin to `CORS_ORIGINS`. Because that is cross-origin, the API client switches
from the httpOnly session cookie to a Bearer token automatically — browsers
block third-party cookies, so the cookie would silently never be sent.

## Free hosting

**Render (web service) + Neon (Postgres).** Neither needs a credit card.

Render's own free Postgres is a trap for this project — it is deleted 30 days
after creation, which means every player's character vanishes a month after
launch. Use Neon for the database: permanent free tier, 0.5 GB, scales to zero.

Fly.io and Heroku no longer have free tiers, and Railway's $1/month credit
covers a few hours of runtime, not a month.

### Why the sleep does not matter here

Render's free web service spins down after 15 minutes idle and takes 30–60s to
wake. For most apps that is disqualifying. For this one it costs a slow first
request per session and nothing else, because **the architecture has no
background work**:

- the midnight heat reset is a `character_days` row that does not exist yet,
  not a cron job that has to fire at 00:00
- an 8-hour guard shift is two timestamps; it completes while the server is
  asleep and is settled on the next request

Nothing is missed while it sleeps. That was a deliberate design choice made
long before hosting came up, and it is what makes a free tier viable.

### Deploy

1. **Neon** — create a project, copy the *pooled* connection string.
2. **Render** — New → Blueprint, point at this repo. `render.yaml` configures
   everything; paste the Neon string as `DATABASE_URL`.
3. Migrations run on boot. Open the Render URL.

The client is served from the API's own origin, so the session stays an
httpOnly cookie. Leave `apiBase` empty in `ui/config.js` — same origin means
relative paths already work.

### Keep GitHub Pages too

The two are not exclusive, and the best split is:

- **GitHub Pages** → local mode. Instant, no cold start, no infrastructure. A
  playable demo anyone can open.
- **Render + Neon** → server mode, accounts, leaderboard.

If you instead put the client on Pages and only the API on Render, that is
cross-origin: the client drops the httpOnly cookie for a Bearer token in
localStorage, and you must add the Pages origin to `CORS_ORIGINS`. It works,
but it is strictly worse security for no gain.

## Run the server

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
