/* ==========================================================
   OVERTIME.EXE — deployment configuration

   apiBase decides which backend the game uses.

     ''                          → LOCAL MODE. Accounts and saves live in this
                                   browser's localStorage. No server needed, so
                                   this is what GitHub Pages (and any other
                                   static host) runs. Single device, no
                                   leaderboard, and the client is trusted —
                                   which is fine for a single-player idle game
                                   and not fine the moment scores are shared.

     'https://api.example.com'   → SERVER MODE. Every rule is enforced by the
                                   Node + Postgres API. Accounts follow the
                                   player across devices and the client is not
                                   trusted with anything.

   GitHub Pages cannot host the server: it serves static files only, with no
   Node process and no database. If you want server mode, the API has to live
   somewhere that runs containers — Fly.io, Railway, Render, a VPS — and this
   value points at it.
   ========================================================== */

window.OVERTIME_CONFIG = {
  apiBase: '',

  /* Cross-origin note. When apiBase points at a different origin than the page,
     browsers increasingly refuse third-party cookies, so the API client
     switches to a Bearer token automatically. That token is held in
     localStorage, which is XSS-readable — an acceptable trade for a game, not
     for anything that matters. Same-origin deployments keep the httpOnly
     cookie and never touch the token. */
};
