/* ==========================================================
   OVERTIME.EXE — API client
   Served from the same origin as the API, so the session cookie
   is first-party and nothing here ever touches a token.
   ========================================================== */

window.API = (() => {
  async function call(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET',
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      // Distinguish "the network is down" from "the server said no" — they
      // need different messages and one of them is not the player's fault.
      throw new ApiError(0, 'Cannot reach the registry. Check your connection.', 'offline');
    }

    if (response.status === 204) return null;

    let payload = null;
    try { payload = await response.json(); } catch { /* empty body */ }

    if (!response.ok) {
      throw new ApiError(
        response.status,
        payload?.error || 'The system is having a moment.',
        payload?.code || 'error',
      );
    }
    return payload;
  }

  class ApiError extends Error {
    constructor(status, message, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const post = (path, body) => call(path, { method: 'POST', body });

  return {
    ApiError,

    /* --- session ------------------------------------------ */
    me:        ()                    => call('/api/me'),
    register:  (username, password)  => post('/api/auth/register', { username, password }),
    login:     (username, password)  => post('/api/auth/login',    { username, password }),
    logout:    ()                    => post('/api/auth/logout'),

    /* --- character ---------------------------------------- */
    content:   ()                    => call('/api/content'),
    state:     ()                    => call('/api/state'),
    createCharacter: (name, gender, classId) =>
      post('/api/character', {
        name, gender, classId,
        // Sent once at intake, validated server-side. The heat reset is the
        // player's midnight, and the server has to know which one that is.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      }),

    spendPoint: (stat)  => post('/api/stats/spend', { stat }),
    buyPoint:   (stat)  => post('/api/stats/buy',   { stat }),

    equip:      (itemId) => post('/api/items/equip',   { itemId }),
    unequip:    (slot)   => post('/api/items/unequip', { slot }),
    sell:       (itemId) => post('/api/items/sell',    { itemId }),
    upgrade:    (itemId) => post('/api/items/upgrade', { itemId }),

    /* --- combat ------------------------------------------- */
    setFloor:   (floor) => post('/api/floor', { floor }),
    attack:     ()      => post('/api/attack'),

    /* --- heat & shop -------------------------------------- */
    vent:       ()      => post('/api/heat/vent'),
    buyCoolant: ()      => post('/api/shop/coolant'),
    buyVehicle: (tier)  => post('/api/shop/vehicle', { tier }),
    buyCrate:   ()      => post('/api/shop/crate'),

    /* --- expeditions -------------------------------------- */
    startShift:   (hours) => post('/api/expedition/start', { hours }),
    collectShift: ()      => post('/api/expedition/collect'),
    skipShift:    ()      => post('/api/expedition/skip'),

    leaderboard: () => call('/api/leaderboard'),
  };
})();

/**
 * The server speaks PlayerState; this UI was written against a flatter local
 * shape. Rather than rewrite every render function, translate at the boundary.
 * One adapter is easier to keep correct than forty field renames.
 */
window.fromServer = function fromServer(state) {
  return {
    name: state.name,
    gender: state.gender,
    classId: state.classId,
    level: state.level,
    xp: state.xp,
    points: state.unspentPoints,
    alloc: state.allocated,
    credits: state.wallet.credits,
    procs: state.wallet.processors,
    inv: state.inventory,
    eq: state.equipped,
    heat: state.overheat.value,
    coolantUsed: state.overheat.coolantUsedToday,
    vehicle: state.overheat.vehicleTier,
    floor: state.progress.currentFloor,
    cleared: state.progress.highestFloorCleared,
    exped: state.expedition
      ? {
          h: state.expedition.durationHours,
          start: state.expedition.startedAt,
          end: state.expedition.endsAt,
          floor: state.expedition.floorSnapshot,
        }
      : null,
    timezone: state.timezone,
    offset: 0,
    busy: false,
  };
};
