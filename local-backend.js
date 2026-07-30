/* ==========================================================
   OVERTIME.EXE — local backend

   Implements exactly the same method surface as the HTTP client in api.js,
   backed by localStorage and the game engine already present in index.html.
   The UI cannot tell the two apart: both return { state: <PlayerState> }.

   This is what runs on GitHub Pages and any other static host. It is
   client-authoritative by necessity — everything is editable in devtools —
   which is acceptable for a single-player idle game and stops being
   acceptable the moment there is a shared leaderboard.

   Engine functions (runBattle, getFloor, heatCost, derive, rollItem, …) are
   defined in the inline script in index.html. They are only referenced when a
   method is actually called, by which point that script has run.
   ========================================================== */

window.LOCAL_BACKEND = (() => {
  const K_ACCOUNTS = 'overtime.accounts.v1';
  const K_SESSION = 'overtime.session.v1';

  /* localStorage throws in sandboxed frames and in Safari private mode, so it
     is probed once and swapped for an in-memory map. The game then works for
     the session and says so on the sign-in panel. */
  const Store = (() => {
    const mem = Object.create(null);
    let live = false;
    try {
      localStorage.setItem('__probe__', '1');
      localStorage.removeItem('__probe__');
      live = true;
    } catch { live = false; }
    return {
      live,
      get: (k) => { try { return live ? localStorage.getItem(k) : mem[k] ?? null; } catch { return mem[k] ?? null; } },
      set: (k, v) => { try { live ? localStorage.setItem(k, v) : (mem[k] = v); } catch { mem[k] = v; } },
      del: (k) => { try { live ? localStorage.removeItem(k) : delete mem[k]; } catch { delete mem[k]; } },
    };
  })();

  const fail = (status, message, code) => { throw new API.ApiError(status, message, code); };

  let accounts = {};
  try { accounts = JSON.parse(Store.get(K_ACCOUNTS) || '{}') || {}; } catch { accounts = {}; }
  const flush = () => Store.set(K_ACCOUNTS, JSON.stringify(accounts));

  const sessionKey = () => Store.get(K_SESSION);
  const account = () => {
    const key = sessionKey();
    const acc = key ? accounts[key] : null;
    if (!acc) fail(401, 'Not signed in.', 'unauthenticated');
    return acc;
  };

  /* --- credentials ---------------------------------------- */

  const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  function makeSalt() {
    const a = new Uint8Array(12);
    if (window.crypto?.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return toHex(a);
  }

  /* Obfuscation, not security: anything in the browser is readable by whoever
     owns the browser. It stops a reused password sitting in devtools in plain
     text, and that is the whole claim. Server mode uses argon2id instead. */
  async function hashPass(password, salt) {
    const input = salt + '|' + password;
    if (window.crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      return toHex(new Uint8Array(buf));
    }
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'fnv1a$' + (h >>> 0).toString(16);
  }

  /* --- state shape ---------------------------------------- */

  const todayKey = () => new Date().toLocaleDateString('en-CA');

  /** Flat working shape → the PlayerState the UI's adapter expects. */
  function toWire(f) {
    return {
      schemaVersion: 1,
      id: 'local',
      name: f.name,
      classId: f.classId,
      gender: f.gender,
      timezone: f.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      createdAt: f.createdAt || Date.now(),
      lastSeenAt: Date.now(),
      level: f.level,
      xp: f.xp,
      unspentPoints: f.points,
      allocated: f.alloc,
      wallet: { credits: f.credits, processors: f.procs },
      inventory: f.inv,
      equipped: f.eq,
      overheat: {
        value: f.heat,
        coolantUsedToday: f.coolantUsed,
        dayKey: f.dayKey || todayKey(),
        vehicleTier: f.vehicle,
      },
      progress: {
        highestFloorCleared: f.cleared,
        currentFloor: f.floor,
        totalRuns: f.runs || 0,
        totalWins: f.wins || 0,
      },
      expedition: f.exped
        ? {
            active: true,
            durationHours: f.exped.h,
            startedAt: f.exped.start,
            endsAt: f.exped.end,
            floorSnapshot: f.exped.floor,
            seed: f.exped.seed,
          }
        : null,
      flags: { tutorialDone: true, unlocks: [] },
    };
  }

  /**
   * Loads the signed-in character into the engine's global `S`, applies the
   * midnight reset, and returns it. Every mutating method goes through here so
   * the engine helpers (derive, heatCost, itemMods) always read current state.
   */
  function open() {
    const acc = account();
    if (!acc.character) fail(409, 'No character on this account yet.', 'no_character');
    S = fromServer(acc.character);
    // The reset is not an event: a different day key simply means a fresh
    // meter. Same rule as the server's per-day rows, minus the row.
    const key = todayKey();
    if (S.dayKey !== key) { S.dayKey = key; S.heat = 0; S.coolantUsed = 0; }
    return acc;
  }

  /** Persists `S` back to the account and returns the API-shaped reply. */
  function commit(acc, extra = {}) {
    acc.character = toWire(S);
    acc.lastSeenAt = Date.now();
    flush();
    return { state: acc.character, ...extra };
  }

  const rngSeed = () => (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;

  /* --- interface ------------------------------------------- */

  return {
    mode: 'local',
    storageDurable: Store.live,
    ApiError: API.ApiError,

    async me() {
      const key = sessionKey();
      const acc = key ? accounts[key] : null;
      if (!acc) fail(401, 'Not signed in.', 'unauthenticated');
      return acc.character
        ? { account: { id: key, username: acc.username }, next: 'game', state: acc.character }
        : { account: { id: key, username: acc.username }, next: 'create', state: null };
    },

    async register(username, password) {
      const key = username.trim().toLowerCase();
      if (accounts[key]) fail(409, 'That name is already on file. Sign in instead.', 'username_taken');
      const salt = makeSalt();
      accounts[key] = {
        username: username.trim(),
        salt,
        hash: await hashPass(password, salt),
        createdAt: Date.now(),
        character: null,
      };
      flush();
      Store.set(K_SESSION, key);
      return { account: { id: key, username: username.trim() }, next: 'create' };
    },

    async login(username, password) {
      const key = username.trim().toLowerCase();
      const acc = accounts[key];
      // Same message either way, so the form is not a username oracle.
      if (!acc || (await hashPass(password, acc.salt)) !== acc.hash) {
        fail(401, 'Name or access code rejected.', 'bad_credentials');
      }
      Store.set(K_SESSION, key);
      return { account: { id: key, username: acc.username }, next: acc.character ? 'game' : 'create' };
    },

    async logout() { Store.del(K_SESSION); return { ok: true }; },

    async state() { const acc = open(); return commit(acc); },

    async content() {
      return { classes: CLASSES, vehicles: VEHICLES, balance: { maxHeat: B.heat.max } };
    },

    async createCharacter(name, gender, classId) {
      const acc = account();
      if (acc.character) fail(409, 'This account already has a character.', 'has_character');
      newGame(name, gender, classId);            // sets the engine's global S
      S.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      S.dayKey = todayKey();
      S.createdAt = Date.now();
      return commit(acc);
    },

    /* --- attributes -------------------------------------- */
    async spendPoint(stat) {
      const acc = open();
      if (S.points <= 0) fail(409, 'No unspent points.', 'no_points');
      S.points -= 1; S.alloc[stat] += 1;
      return commit(acc);
    },
    async buyPoint(stat) {
      const acc = open();
      const cost = statCost(stat);
      if (S.credits < cost) fail(402, `Needs ${cost.toLocaleString()} credits.`, 'insufficient_credits');
      S.credits -= cost; S.alloc[stat] += 1;
      return commit(acc, { spent: cost });
    },

    /* --- gear --------------------------------------------- */
    async equip(itemId) {
      const acc = open();
      const item = S.inv.find((i) => i.uid === itemId);
      if (!item) fail(404, 'Item not in your inventory.', 'no_item');
      S.eq[item.slot] = item.uid;
      return commit(acc);
    },
    async unequip(slot) { const acc = open(); S.eq[slot] = null; return commit(acc); },
    async sell(itemId) {
      const acc = open();
      const item = S.inv.find((i) => i.uid === itemId);
      if (!item) fail(404, 'Item not in your inventory.', 'no_item');
      if (Object.values(S.eq).includes(itemId)) fail(409, 'Unequip it first.', 'cannot_sell');
      S.credits += item.sellValue;
      S.inv = S.inv.filter((i) => i.uid !== itemId);
      return commit(acc, { credited: item.sellValue });
    },
    async upgrade(itemId) {
      const acc = open();
      const item = S.inv.find((i) => i.uid === itemId);
      if (!item) fail(404, 'Item not in your inventory.', 'no_item');
      if (item.plus >= B.econ.maxPlus) fail(409, 'Fully upgraded.', 'max_upgrade');
      const cost = upCost(item);
      if (S.credits < cost) fail(402, `Needs ${cost.toLocaleString()} credits.`, 'insufficient_credits');
      S.credits -= cost; item.plus += 1;
      item.sellValue = Math.round(item.sellValue * 1.15);
      return commit(acc, { spent: cost });
    },

    /* --- combat -------------------------------------------- */
    async setFloor(floor) {
      const acc = open();
      if (floor < 1 || floor > S.cleared + 1) fail(403, 'That floor is not unlocked yet.', 'locked_floor');
      S.floor = floor;
      return commit(acc);
    },

    async attack() {
      const acc = open();
      const cost = heatCost(S.floor);
      if (S.heat + cost > B.heat.max) {
        fail(409, 'Core temperature critical. Vent heat or wait for the 00:00 reset.', 'too_hot');
      }
      // Heat is charged before the fight, so a loss still costs temperature.
      S.heat = clamp(S.heat + cost, 0, B.heat.max);

      const seed = rngSeed();
      const floor = getFloor(S.floor);
      const res = runBattle(seed, floor, derive());
      S.runs = (S.runs || 0) + 1;

      let rewards = null;
      let levelsGained = 0;
      let advanced = false;

      if (res.victory) {
        const r = rng(seed ^ 0x9e3779b9);
        rewards = {
          credits: Math.round(floor.rw.credits * (0.9 + r() * 0.25)),
          processors: r() < floor.rw.proc ? (floor.boss ? 1 + Math.floor(r() * 3) : 1) : 0,
          xp: floor.rw.xp,
          items: [],
        };
        if (r() < floor.rw.item) rewards.items.push(rollItem(r, floor.floor, floor.boss ? 'licensed' : undefined));
        S.credits += rewards.credits;
        S.procs += rewards.processors;
        S.inv.push(...rewards.items);
        levelsGained = grantXp(rewards.xp);
        S.wins = (S.wins || 0) + 1;
        if (S.floor > S.cleared) { S.cleared = S.floor; S.floor += 1; advanced = true; }
      }

      return commit(acc, {
        battle: {
          victory: res.victory,
          rounds: res.rounds,
          log: res.log,
          rewards,
          levelsGained,
          advanced,
          heat: S.heat,
        },
      });
    },

    /* --- heat and shop ------------------------------------- */
    async vent() {
      const acc = open();
      const left = B.heat.coolantCharges - S.coolantUsed;
      if (S.heat <= 0) fail(409, 'Already cold.', 'already_cold');
      if (left <= 0) fail(409, 'Daily coolant ration spent. Requisition resets at 00:00.', 'no_coolant');
      S.heat = clamp(S.heat - B.heat.coolantCut, 0, B.heat.max);
      S.coolantUsed += 1;
      return commit(acc);
    },
    async buyCoolant() {
      const acc = open();
      const cost = 2;
      if (S.procs < cost) fail(402, `Needs ${cost} processors.`, 'insufficient_processors');
      if (S.coolantUsed <= 0) fail(409, 'Ration is already full.', 'ration_full');
      S.procs -= cost; S.coolantUsed -= 1;
      return commit(acc);
    },
    async buyVehicle(tier) {
      const acc = open();
      const v = VEHICLES.find((x) => x.tier === tier);
      if (!v) fail(404, 'No such vehicle on the lot.', 'no_vehicle');
      if (S.vehicle !== tier - 1) fail(409, 'Tiers must be bought in order. Finance says so.', 'purchase_refused');
      if (S.credits < v.cr || S.procs < v.pr) fail(402, 'Not enough for that tier.', 'purchase_refused');
      S.credits -= v.cr; S.procs -= v.pr; S.vehicle = tier;
      return commit(acc, { vehicle: { name: v.name, reduction: v.red } });
    },
    async buyCrate() {
      const acc = open();
      const cost = 4;
      if (S.procs < cost) fail(402, `Needs ${cost} processors.`, 'insufficient_processors');
      S.procs -= cost;
      const item = rollItem(rng(rngSeed()), Math.max(1, S.cleared || 1));
      S.inv.push(item);
      return commit(acc, { item });
    },

    /* --- expeditions --------------------------------------- */
    async startShift(hours) {
      const acc = open();
      if (S.exped) fail(409, 'Already on guard duty. One shift at a time.', 'shift_active');
      S.exped = {
        h: hours,
        start: Date.now(),
        end: Date.now() + hours * 3_600_000,
        floor: Math.max(1, S.cleared),
        seed: rngSeed(),
      };
      return commit(acc);
    },
    async skipShift() {
      const acc = open();
      if (!S.exped) fail(409, 'Nothing to skip.', 'no_shift');
      const remaining = Math.max(0, S.exped.end - Date.now());
      if (remaining === 0) fail(409, 'Shift is already over. Collect it.', 'already_done');
      const cost = Math.max(1, Math.ceil((remaining / 3_600_000) * 3));
      if (S.procs < cost) fail(402, `Needs ${cost} processors.`, 'insufficient_processors');
      S.procs -= cost; S.exped.end = Date.now();
      return commit(acc, { spent: cost });
    },
    async collectShift() {
      const acc = open();
      if (!S.exped) fail(409, 'No shift on record.', 'nothing_to_collect');
      if (Date.now() < S.exped.end) fail(409, 'Shift still running.', 'nothing_to_collect');

      const e = S.exped;
      const r = rng(e.seed);
      const rt = shiftRates(e.floor, e.h);
      const credits = Math.round(rt.cr * e.h * (0.94 + r() * 0.16));
      let processors = 0;
      for (let i = 0; i < e.h; i++) if (r() < rt.proc) processors += 1;
      const items = [];
      let rolls = rt.items * e.h;
      while (rolls > 0) {
        if (r() < Math.min(1, rolls)) items.push(rollItem(r, Math.max(1, e.floor + B.exped.ilvlOffset)));
        rolls -= 1;
      }
      const xp = Math.round(rt.xp * e.h);
      const incidents = [...new Set(
        Array.from({ length: e.h >= 8 ? 3 : e.h >= 4 ? 2 : 1 },
          () => INCIDENTS[Math.floor(r() * INCIDENTS.length)]),
      )];

      S.credits += credits;
      S.procs += processors;
      S.inv.push(...items);
      const levelsGained = grantXp(xp);
      S.exped = null;

      return commit(acc, { report: { credits, processors, xp, items, incidents, levelsGained } });
    },

    async leaderboard() {
      const acc = account();
      if (!acc.character) return { entries: [] };
      const c = acc.character;
      return {
        entries: [{
          name: c.name, gender: c.gender, class_id: c.classId,
          level: c.level, highest_floor_cleared: c.progress.highestFloorCleared,
        }],
      };
    },
  };
})();

/** One switch, chosen at load. Everything downstream calls NET and neither
 *  knows nor cares which of the two it got. */
window.NET = window.OVERTIME_CONFIG?.apiBase ? window.API : window.LOCAL_BACKEND;
