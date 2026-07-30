import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { authenticate } from './auth.js';
import { GameError, pool } from './db.js';
import { env } from './env.js';
import authRoutes from './routes/auth.js';
import characterRoutes from './routes/character.js';
import combatRoutes from './routes/combat.js';
import expeditionRoutes from './routes/expedition.js';
import shopRoutes from './routes/shop.js';

const app = Fastify({
  logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
  trustProxy: true,
});

await app.register(cookie);
await app.register(cors, { origin: env.corsOrigins, credentials: true });
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

// Serve the client from the same origin so the session cookie is first-party.
await app.register(fastifyStatic, {
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui'),
  prefix: '/',
  setHeaders(res, filePath) {
    // The shell must always be revalidated. A cached index.html from an
    // earlier build looks exactly like a broken login, and costs an hour
    // to diagnose every single time.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
});

/**
 * Everything under /api except auth requires a session. Registering it as a
 * global hook rather than per-route means a new endpoint is protected by
 * default — forgetting to add a guard should not be possible.
 */
app.addHook('onRequest', async (request) => {
  const url = request.url.split('?')[0];
  if (!url.startsWith('/api/')) return;
  if (url.startsWith('/api/auth/') || url === '/api/content') return;
  await authenticate(request);
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof GameError) {
    return reply.status(error.status).send({ error: error.message, code: error.code });
  }
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: error.issues[0]?.message ?? 'Invalid request.',
      code: 'validation',
    });
  }
  if ((error as { statusCode?: number }).statusCode === 429) {
    return reply.status(429).send({ error: 'Too many attempts. Wait a moment.', code: 'rate_limited' });
  }
  // Anything unrecognised is a bug on our side; log it in full and tell the
  // player nothing about our stack trace.
  request.log.error({ err: error }, 'unhandled');
  return reply.status(500).send({ error: 'The system is having a moment.', code: 'internal' });
});

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

await app.register(authRoutes);
await app.register(characterRoutes);
await app.register(combatRoutes);
await app.register(expeditionRoutes);
await app.register(shopRoutes);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info('shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
