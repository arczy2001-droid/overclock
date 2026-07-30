import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GameError, pool, type Client } from './db.js';
import { env } from './env.js';

/**
 * Passwords.
 *
 * argon2id, tuned to roughly 60ms on a modest container. The client-side
 * SHA-256 from the prototype is gone entirely: it existed only because there
 * was nowhere else to put it, and hashing on the client means the hash IS the
 * password as far as the wire is concerned.
 *
 * @node-rs/argon2 ships prebuilt binaries, so this needs no node-gyp and the
 * Docker image stays free of build tooling.
 */
const ARGON_OPTS = {
  memoryCost: 19_456, // 19 MiB — OWASP's current floor
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTS);
}

export async function verifyPassword(stored: string, supplied: string): Promise<boolean> {
  try {
    return await argonVerify(stored, supplied, ARGON_OPTS);
  } catch {
    return false;
  }
}

/**
 * Sessions.
 *
 * Opaque 32-byte tokens, stored hashed. Chosen over stateless JWTs on purpose:
 * banning an account that is duplicating items has to take effect now, not
 * whenever their token happens to expire.
 */
export const SESSION_COOKIE = 'overtime_session';

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export async function createSession(
  client: Client,
  accountId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);
  await client.query(
    `INSERT INTO sessions (account_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, hashToken(token), expires, meta.userAgent ?? null, meta.ip ?? null],
  );
  return token;
}

export async function revokeSession(client: Client, token: string): Promise<void> {
  await client.query(
    `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    maxAge: env.SESSION_TTL_DAYS * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/* ------------------------------------------------------------------ */
/* Request authentication                                             */
/* ------------------------------------------------------------------ */

export interface Session {
  accountId: string;
  username: string;
  characterId: string | null;
  token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

function readToken(request: FastifyRequest): string | null {
  const cookie = request.cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * One round trip resolves session, account and character. Attaching the
 * character id here means no route has to trust a client-supplied one — the
 * commonest way a game API leaks other players' inventories.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const token = readToken(request);
  if (!token) throw new GameError(401, 'Not signed in.', 'unauthenticated');

  const { rows } = await pool.query(
    `SELECT s.token_hash, a.id AS account_id, a.username, a.status, c.id AS character_id
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN characters c ON c.account_id = a.id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  );

  const row = rows[0];
  // Constant-time compare on the way back out too, so a timing side channel
  // cannot confirm whether a guessed token prefix exists.
  if (!row || !timingSafeEqual(row.token_hash, hashToken(token))) {
    throw new GameError(401, 'Session expired. Sign in again.', 'unauthenticated');
  }
  if (row.status !== 'active') {
    throw new GameError(403, 'This account is suspended.', 'suspended');
  }

  request.session = {
    accountId: row.account_id,
    username: row.username,
    characterId: row.character_id ?? null,
    token,
  };
}

/** Routes that need a finished character, not just an account. */
export function requireCharacter(request: FastifyRequest): Session & { characterId: string } {
  const session = request.session;
  if (!session) throw new GameError(401, 'Not signed in.', 'unauthenticated');
  if (!session.characterId) throw new GameError(409, 'No character on this account yet.', 'no_character');
  return session as Session & { characterId: string };
}

export async function touchAccount(accountId: string): Promise<void> {
  await pool
    .query(`UPDATE accounts SET last_seen_at = now() WHERE id = $1`, [accountId])
    .catch(() => {});
}
