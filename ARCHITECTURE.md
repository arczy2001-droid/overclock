# OVERTIME.EXE — system architecture & technical specification

A browser idle RPG about gig-economy dungeon couriers in a city that has replaced
government with customer service. High-tech, low-life, and extremely well documented.

---

## 1. Module map

```
src/
├── types.ts                 all persisted + transient shapes, no logic
├── config/balance.ts        every tunable number, single file, no magic constants elsewhere
├── data/content.ts          classes, ultimates, vehicles, item bases, affixes, flavour
├── systems/
│   ├── rng.ts               seeded mulberry32 — nothing calls Math.random()
│   ├── stats.ts             attributes → DerivedStats, levelling, point spending
│   ├── combat.ts            the auto-battler; pure, deterministic, returns a replay log
│   ├── floors.ts            floor generation + loot rolls
│   ├── overheat.ts          heat, vehicles, coolant, local-midnight reset
│   └── expedition.ts        passive guard duty, offline-safe
└── state/store.ts           save/load, migrations, and the orchestrated player actions
```

**Dependency rule:** systems may import `config` and `data`, never `state`. `state/store.ts`
is the only module that mutates `PlayerState` in response to a player action, which keeps
every system unit-testable in isolation.

---

## 2. Authority model

Every system is written as a **pure function of `(state, seed, now)`**. Nothing reads the
clock or the RNG implicitly. This is not stylistic — it is what makes the game
server-verifiable:

| Client sends | Server recomputes | Server rejects if |
|---|---|---|
| `attackFloor(floor)` | `canAttack` → `runBattle(seed, floor, snapshot)` | heat insufficient, or the replayed log disagrees |
| `collectExpedition()` | `Rng(storedSeed)` reward roll | `now < endsAt`, or the seed was resubmitted |
| `useCoolant()` | `coolantUsedToday` against the stored `dayKey` | more than 10 charges in one local day |

The seed for a battle comes from the server in production. Rewards for a passive
expedition are rolled **at collection time from the seed stored at launch**, so a player
cannot peek at the outcome and reload to reroll it.

`saveGame` / `loadGame` in `state/store.ts` are the only functions that touch storage.
Swapping them for API calls is the whole of the client→authoritative migration.

---

## 3. Core loop

```
        ┌──────────────── local midnight ────────────────┐
        │                                                 │
        ▼                                                 │
   heat = 0 ──▶ attack floor ──▶ heat += cost ──▶ win? ───┼─▶ credits, xp, gear, floor+1
   coolant = 10       ▲              │                    │
        │             │              ▼                    │
        │             │         heat == 100 ──────────────┘
        │             │              │
        │             └── coolant ◀──┤ (10/day, −20 each)
        │                            │
        └────────────── guard duty ◀─┘  (ignores heat entirely)
```

The overheat meter is the only real gate on active play, which makes the design question
of the game *"do I burn heat on the next floor, or bank a shift?"* Guard duty deliberately
ignores heat: when the rig is cooked, there is always something to do, and that something
is the idle half of the product.

Losing a fight still costs the heat. Without that, floor choice carries no risk and the
optimal play is to spam the deepest floor until it happens to work.

---

## 4. Combat engine

`runBattle(input) → BattleResult` plays the entire fight in one synchronous call and hands
back a log. The UI replays that log at whatever speed it likes; changing the animation
speed cannot change the outcome.

**Turn structure**

1. Order is fixed at battle start by `initiative` (base 10 + 0.6 × Spryt), ties broken by
   the seeded stream.
2. On a combatant's turn: tick buffs → gain charge → fire ultimate if charge is 100 →
   attack (unless the ultimate consumed the action).
3. Round cap 60. Reaching it is a **loss** (`outcome: 'throttled'`) — otherwise a
   sufficiently tanky build could stalemate forever on a floor it cannot kill.

**Charge meter**

| Source | Gain |
|---|---|
| Own turn | `14 + 0.22 × Przenikliwość`, × gear `chargeRatePct` |
| Taking a hit | +5 |
| Clean dodge | +9 |

Enemies do not build charge and have no ultimates. Player agency in an auto-battler lives
entirely in the build, so the interesting number is how fast *your* meter fills.

**Damage pipeline**

```
dodge check  →  variance 0.9–1.1  →  crit  →  flat armor subtraction
final = max(raw × 0.10, raw − armor)      // armor can never fully negate a hit
```

Armor is flat subtraction, per spec (`Pancerz`), with a 10% floor so that stacking armor
soft-caps instead of producing invulnerability.

**Ultimates** (all fire automatically at 100% charge, then reset to 0)

| Class | Ultimate | Effect | Consumes turn |
|---|---|---|---|
| Corpo-rat | `Corporate Restructuring` | 3 strikes at 0.62× each, then +30% dodge for 3 turns | yes |
| Scavenger | `Jury-Rigged Armor` | heal `armor × 4 + 8% maxHP`; reflect 30% of the last hit taken | no — still attacks |
| Hacker | `Format C:` | target armor reads 0 for this round and the next; instant kill at ≤10% HP | only on execute |

Two of the three are free actions on purpose. The Scavenger's is a sustain button and the
Hacker's is a setup button; making them consume the turn would make both a net DPS loss.

---

## 5. Overheat

```
cost(floor)  = clamp(10 × (1 + floor((floor−1)/25) × 0.05), 2, 20) × (1 − cooling)
cooling      = clamp(vehicleReduction + gear coolingPct, 0, 0.75)
canAttack    = heat + cost ≤ 100          // no partial commits
```

Vehicle tiers give −10 / −20 / −30 / −50%, bought strictly in order. Gear `coolingPct`
stacks additively on top, clamped at 75% combined so heat is always a real cost.

**Daily reset.** `dayKey` is `YYYY-MM-DD` rendered in the player's **IANA timezone**, not
UTC. `applyDailyReset` compares it on every read and zeroes heat and coolant when it
changes. This is idempotent, survives offline periods of any length, and needs no cron job
— which matters, because a nightly server sweep over every account is the kind of thing
that works fine until it doesn't.

**Budget.** 100 heat + 10 coolant charges × 20 = 300 heat per day ≈ 30 attacks on foot,
60 with a Tier 4 shuttle. That figure is the primary retention dial for the whole game.

---

## 6. Floor scaling

```
hp(n)      = (120 + 70n) × 1.016^(n−1) × (boss ? 2.2  : 1)
attack(n)  = (6 + 11n)                 × (boss ? 1.35 : 1)
armor(n)   = (2 + 2.2n)                × (boss ? 1.4  : 1)
credits(n) = (45 + 10n) × 1.012^(n−1)  × (boss ? 3    : 1)
xp(n)      = (40 + 4n)  × 1.012^(n−1)  × (boss ? 3    : 1)
```

**Why linear-plus-creep rather than pure exponential.** Player damage grows roughly
*linearly* with depth, because item level equals the floor it dropped from. A purely
exponential enemy curve therefore produces a hard wall the player can never out-scale no
matter how long they idle — the classic idle-RPG death spiral. Linear base with ~1.6%
compounding keeps every floor theoretically beatable while slowing the climb to a crawl in
the deep sectors, which is exactly where the passive half of the game should take over.

Enemy attack is tuned to track *player armor* (~8 × floor at depth) plus roughly one
twelfth of player HP, so fights stay around 8–15 rounds at every depth instead of
trivialising once gear armor outruns enemy damage.

`getFloor(n)` is seeded from `n` alone: floor 47 is the same hostile with the same numbers
for every player forever. Bosses every 10 floors, sector name every 10 floors.

---

## 7. Passive expeditions

Timestamp-driven, never ticked. A closed tab, a dead battery and a three-day absence all
produce identical results because the only question ever asked is `now >= endsAt`.

```
creditsPerHour = 210 × (1 + 0.085 × highestFloorCleared) × durationBonus
durationBonus  = 1h: 1.00   4h: 1.08   8h: 1.18
```

The duration bonus rewards patience rather than re-booking every hour. `floorSnapshot` is
locked at launch, so clearing floors mid-shift does not retroactively raise the rate.

---

## 8. UI layout architecture

Design thesis: **the interface is a municipal form that thinks it is a weapon.** Panels
carry clause codes (`§3.1`), the tab bar is a filing index, and every empty state is
written in the voice of an institution that has stopped pretending to care.

### Structure

```
┌──────────────────────────────────────────────────┬────────┐
│ MASTHEAD                                         │ T      │
│  wordmark · form code · operator strip           │ H      │
│  name/class · level+xp · credits · processors    │ E      │
├──────────────────────────────────────────────────┤ R      │
│ TAB INDEX  01 Personnel  02 Deployment           │ M      │
│            03 Guard duty 04 Requisition          │ A      │
├──────────────────────────────────────────────────┤ L      │
│ PANEL (auto-fit card grid, min 288px)            │        │
│  ┌────────────┐ ┌────────────┐                   │ column │
│  │ §1.1 attrs │ │ §1.2 stats │                   │        │
│  └────────────┘ └────────────┘                   │ sticky │
└──────────────────────────────────────────────────┴────────┘
```

`grid-template-columns: 1fr 92px` at the shell level; cards inside each panel use
`repeat(auto-fit, minmax(288px, 1fr))` so nothing needs a breakpoint to reflow.

### The signature element

A sticky vertical **thermal column** on the right edge: hazard-striped fill, 20% tick
marks, percentage readout, vent button, and a live countdown to the 00:00 reset. Its fill
also writes a global `--heat` custom property, and the entire interface's accent colour is
derived from it:

```css
--heat-tint: color-mix(in oklab, var(--cyan) calc((1 - var(--heat)) * 100%), var(--magenta));
```

Tab underlines, the attack button and the page's ambient glow all shift from cyan toward
magenta as the rig cooks. The player learns their heat state peripherally, without reading
a number. Below 880px the column becomes a horizontal strip pinned above the tabs
(`order: -1`) and the same `--fill` variable drives width instead of height.

### Tokens

| Role | Value |
|---|---|
| Base / panel / raised | `#07090D` `#10141C` `#151B25` |
| Rule / faint / dim / ink | `#1E2733` `#3B4653` `#65727F` `#C3CEDB` |
| Data, primary | cyan `#34D9F0` |
| Heat, danger, ultimates | magenta `#FF2E88` |
| Kredyty | amber `#F5A623` |
| Procesory, charge | violet `#8B6BFF` |
| Success, healing | `#3DDC97` |

Rarity uses the same five: Salvage dim → Standard ink → Licensed cyan → Black Market
magenta → Prototype amber. No sixth colour is introduced anywhere.

**Type:** Saira Condensed 700/900 for display, numerals and labels — condensed, slightly
official, reads as signage rather than as sci-fi. IBM Plex Mono 400/500/600 for everything
else, including body copy, because a terminal that mixes a proportional body face into its
data tables stops looking like a terminal. Both carry Latin Extended, which the Polish
attribute names require.

### Component inventory

| Component | Used by |
|---|---|
| `.card` + `.clause` | every panel section |
| `.attr` row | attribute allocation (point spend + credit buy) |
| `.dl` definition list | derived stats, floor briefing |
| `.slot` / `.item` | 6 equipment slots, inventory |
| `.hpbar` / `.chargebar` | combat replay |
| `.log` | combat replay, colour-coded per event type |
| `.progress` | expedition timer |
| `.veh` | vehicle and shop rows |
| `.toast` | rejected actions |

### Quality floor

Responsive to 360px; visible `:focus-visible` rings; `prefers-reduced-motion` disables the
log typewriter and every transition; the combat log is the only animated region and it
scrolls rather than moves. No storage APIs are used in the prototype — session memory only.

---

## 8b. Access flow

Three screens, routed on boot by what the account actually contains, so a
half-finished intake resumes at the intake form instead of dropping someone into
an empty dashboard.

```
boot ──▶ session key in storage?
          │no                        │yes
          ▼                          ▼
    ┌───────────┐            account.character?
    │ 00 ACCESS │             │null        │set
    │ sign in / │             ▼            ▼
    │ register  │──────▶ ┌──────────┐  ┌───────────┐
    └───────────┘        │ 00b      │──▶│ 01        │
          ▲              │ INTAKE   │   │ DASHBOARD │
          └── log out ───┴──────────┴───┴───────────┘
```

**Storage.** `overtime.accounts.v1` holds `{ [usernameLower]: Account }`;
`overtime.session.v1` holds the key of the signed-in account. The character save
is nested inside its account, so one device supports several operators without a
second keyspace. Writes are debounced 400ms off `render()` plus a flush on
`beforeunload`.

`localStorage` throws in sandboxed frames and in Safari private mode, so it is
probed once at boot and swapped for an in-memory map on failure. The game never
notices; only the warning banner on the sign-in panel does. `AccountStore` in
`src/state/accounts.ts` is the typed version of the same model and is the seam
for a real server: swap its four methods for API calls and nothing else changes.

**Credentials.** Passwords are salted and SHA-256 hashed via Web Crypto, with an
FNV-1a fallback for insecure contexts, tagged `fnv1a$` so a later migration can
find and rehash them. This is obfuscation, not security — it stops a reused
password sitting in plain text in devtools, and that is the entire claim. Real
accounts need a server; the client cannot be the authority on its own identity.

**Intake.** Name, gender, and one of three factions. Selecting a faction updates
a live preview showing its base attributes, starting HP/attack/dodge/crit/
initiative/charge rate, the health and damage role multipliers, and the ultimate.
Gender is cosmetic: it drives the personnel-file avatar and nothing in combat
ever reads it. The faction is permanent, which the form says out loud, because
finding that out afterwards is how a player ends up with a character they resent.

**User bar.** The masthead carries an ID-badge cluster — SVG avatar tinted by
faction, character name, faction tag, log out — reading as a laminated pass
clipped to a form.

---

## 9. Balance methodology

`tools/simulate.ts` auto-plays all three classes for N in-game days: it allocates points,
equips upgrades, buys vehicles, spends the daily heat budget, runs an 8h shift overnight,
and prints depth, level, attack, HP, armor and credits at checkpoints.

```bash
npx tsc && node build/tools/simulate.js 120
```

Current curve, averaged across the three classes:

| Day | 1 | 3 | 7 | 14 | 30 | 120 |
|---|---|---|---|---|---|---|
| Floor | 3 | 8 | ~18 | ~29 | 40–110 | 140–160 |

Class spread stays inside roughly one sector at every checkpoint. Role separation is
enforced by `hpMultiplier` × `attackMultiplier`: Scavenger 1.45 / 0.80, Corpo-rat
1.05 / 1.00, Hacker 0.95 / 1.20.

Re-run the simulator after touching anything in `config/balance.ts`. It is the only honest
way to find out whether a number that looks reasonable in a spreadsheet produces a wall on
day 11.

---

## 10. Not built yet

Deliberate omissions, in rough priority order: server authority (the shapes are ready,
the endpoints are not), gear comparison tooltips on hover (`compareToEquipped` exists and
is unused by the prototype UI), an offline-progress summary on return, bulk salvage,
prestige / rebirth, and audio. The 60-round throttle cap is currently a flat loss with no
partial reward, which is the first thing worth playtesting.
