import 'dotenv/config';
import { createApp } from './app';
import { loadConfig } from './config/env';
import { buildApiDeps } from './deps';
import { buildProcessors } from './modules';

/** API process entry point. The BullMQ worker is a separate process (src/worker.ts). */
async function main() {
  const config = loadConfig();
  const deps = await buildApiDeps(config, buildProcessors);
  const app = createApp(deps);

  const server = app.listen(config.port, () => {
    deps.logger.info(
      { port: config.port, queue: config.queue.driver, storage: config.storage.driver, ai: config.ai.provider },
      `${config.appName} API listening`,
    );
    if (config.queue.driver === 'memory') {
      deps.logger.warn('QUEUE_DRIVER=memory: the analysis worker runs inside this process (development only)');
    }
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    deps.logger.info({ signal }, 'shutting down');
    // Stop accepting connections, let in-flight requests finish, then close pools.
    server.close(async () => {
      await deps.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
