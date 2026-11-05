import config from './config.js';
import { buildApp } from './app.js';
import { db } from './db.js';

const app = await buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`${config.appName} is running at ${config.publicOrigin} (SMS provider: ${config.smsProvider})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
