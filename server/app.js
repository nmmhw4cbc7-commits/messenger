import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import config from './config.js';
import { cleanup } from './db.js';
import { securityHeaders, isAllowedOrigin, HttpError } from './security.js';
import { authRoutes } from './auth.js';
import { apiRoutes } from './api.js';
import { realtimeRoutes } from './realtime.js';
import { staticRoutes } from './static.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildApp({ logger = true } = {}) {
  const app = Fastify({
    logger: logger && {
      level: config.isProduction ? 'info' : 'debug',
      // Never log cookies or request bodies.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split('?')[0], ip: req.ip }),
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    disableRequestLogging: config.isProduction,
    ajv: { customOptions: { removeAdditional: false, allErrors: false } },
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 } });

  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 300 * 1024 }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', (request, reply, done) => {
    securityHeaders(reply);
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      // State-changing requests must come from our own pages (CSRF protection
      // on top of SameSite=Strict cookies).
      if (request.method !== 'GET' && request.method !== 'HEAD' && !isAllowedOrigin(request.headers.origin)) {
        return done(new HttpError(403, 'bad_origin', 'Request blocked.'));
      }
    }
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.extra?.retryAfter) reply.header('Retry-After', String(error.extra.retryAfter));
      return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...error.extra });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Something in this request was not valid.' });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'bad_request', message: 'This request could not be processed.' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'server_error', message: 'Something went wrong on our side. Please try again.' });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'Not found.' });
  });

  await app.register(authRoutes);
  await app.register(realtimeRoutes);
  await app.register(apiRoutes);
  app.get('/healthz', async () => ({ ok: true }));
  const served = staticRoutes(app, join(root, 'dist', 'client'));
  if (!served) app.log.warn('dist/client is empty. Run "npm run build" to build the app.');

  const timer = setInterval(cleanup, 10 * 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  cleanup();

  return app;
}
