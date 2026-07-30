import type { ClassId, PlayerState } from '../types';
import { createPlayer } from './store';

/**
 * Local account layer.
 *
 * This is a device-local stand-in for real authentication, not a replacement
 * for it. Anything running in the browser is readable by whoever owns the
 * browser, so the salted hash below only stops a reused password from sitting
 * in plain text in devtools. When the authoritative server lands, `AccountStore`
 * is the seam: swap the four methods for API calls and delete nothing else.
 */

export type Gender = 'male' | 'female';

export interface Account {
  username: string;
  salt: string;
  hash: string;
  createdAt: number;
  lastSeenAt: number;
  /** Null until the intake form is completed. */
  character: PlayerState | null;
}

export interface CharacterDraft {
  name: string;
  gender: Gender;
  classId: ClassId;
}

/** Minimal surface so tests and the server build can supply their own. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const K_ACCOUNTS = 'overtime.accounts.v1';
const K_SESSION = 'overtime.session.v1';

/**
 * localStorage throws in sandboxed frames and in Safari private mode, so it is
 * probed once and swapped for an in-memory map on failure. Callers check
 * `.durable` if they want to warn the player that progress will not survive a
 * reload; nothing else in the codebase needs to care.
 */
export function safeStorage(): StorageLike & { durable: boolean } {
  const mem = new Map<string, string>();
  const fallback = {
    durable: false,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  try {
    const probe = '__overtime_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return {
      durable: true,
      getItem: (k) => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
      removeItem: (k) => window.localStorage.removeItem(k),
    };
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Credentials                                                        */
/* ------------------------------------------------------------------ */

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function makeSalt(): string {
  const bytes = new Uint8Array(12);
  if (typeof globalThis.crypto?.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return toHex(bytes);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const input = `${salt}|${password}`;
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return toHex(new Uint8Array(digest));
  }
  // Insecure contexts only. Marked so a later migration can spot and rehash it.
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a$${(h >>> 0).toString(16)}`;
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export type AuthResult = { ok: true; account: Account } | { ok: false; reason: string };

export class AccountStore {
  private accounts: Record<string, Account> = {};
  private sessionKey: string | null = null;

  constructor(private storage: StorageLike = safeStorage()) {
    this.load();
  }

  private load(): void {
    try {
      this.accounts = JSON.parse(this.storage.getItem(K_ACCOUNTS) ?? '{}') ?? {};
    } catch {
      this.accounts = {};
    }
    const session = this.storage.getItem(K_SESSION);
    this.sessionKey = session && this.accounts[session] ? session : null;
  }

  private flush(): void {
    this.storage.setItem(K_ACCOUNTS, JSON.stringify(this.accounts));
  }

  private static key(username: string): string {
    return username.trim().toLowerCase();
  }

  get current(): Account | null {
    return this.sessionKey ? (this.accounts[this.sessionKey] ?? null) : null;
  }

  get count(): number {
    return Object.keys(this.accounts).length;
  }

  async register(username: string, password: string, confirm: string): Promise<AuthResult> {
    const name = username.trim();
    if (name.length < 3) return { ok: false, reason: 'Registered name needs at least 3 characters.' };
    if (password.length < 6) return { ok: false, reason: 'Access code needs at least 6 characters.' };
    if (password !== confirm) return { ok: false, reason: 'The two access codes do not match.' };
    const key = AccountStore.key(name);
    if (this.accounts[key]) return { ok: false, reason: 'That name is already on file. Sign in instead.' };

    const salt = makeSalt();
    const account: Account = {
      username: name,
      salt,
      hash: await hashPassword(password, salt),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      character: null,
    };
    this.accounts[key] = account;
    this.sessionKey = key;
    this.storage.setItem(K_SESSION, key);
    this.flush();
    return { ok: true, account };
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const key = AccountStore.key(username);
    const account = this.accounts[key];
    if (!account) return { ok: false, reason: 'No account under that name on this device.' };
    if ((await hashPassword(password, account.salt)) !== account.hash) {
      return { ok: false, reason: 'Access code rejected.' };
    }
    account.lastSeenAt = Date.now();
    this.sessionKey = key;
    this.storage.setItem(K_SESSION, key);
    this.flush();
    return { ok: true, account };
  }

  logout(): void {
    this.sessionKey = null;
    this.storage.removeItem(K_SESSION);
  }

  /** Completes the intake form and writes the new character to the account. */
  createCharacter(draft: CharacterDraft): { ok: false; reason: string } | { ok: true; player: PlayerState } {
    const account = this.current;
    if (!account) return { ok: false, reason: 'Not signed in.' };
    const name = draft.name.trim();
    if (name.length < 2) return { ok: false, reason: 'The paperwork needs a name of at least 2 characters.' };

    const player = createPlayer(name, draft.classId);
    player.gender = draft.gender;
    account.character = player;
    this.flush();
    return { ok: true, player };
  }

  /** Call after any state mutation; cheap enough to debounce at ~400ms. */
  save(player: PlayerState): void {
    const account = this.current;
    if (!account) return;
    account.character = player;
    account.lastSeenAt = Date.now();
    this.flush();
  }
}

/** Which screen the shell should show on boot. */
export function routeFor(store: AccountStore): 'auth' | 'create' | 'game' {
  const account = store.current;
  if (!account) return 'auth';
  return account.character ? 'game' : 'create';
}
