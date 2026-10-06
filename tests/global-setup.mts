import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Provides a PostgreSQL for the integration tests and applies the committed migrations to it.
 *   - TEST_DATABASE_URL set: use it as is (CI, or `docker compose up postgres`).
 *   - otherwise: start a throwaway embedded PostgreSQL, so `npm test` works without Docker.
 */
export default async function setup() {
  let stop: (() => Promise<void>) | undefined;
  let url = process.env['TEST_DATABASE_URL'];

  if (!url) {
    const dir = mkdtempSync(join(tmpdir(), 'calcam-pg-'));
    const port = 54000 + Math.floor(Math.random() * 900);
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'calcam',
      password: 'calcam',
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('calcam_test');
    url = `postgresql://calcam:calcam@localhost:${port}/calcam_test`;
    stop = async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  // Worker processes started after this point inherit the variable.
  process.env['TEST_DB_URL'] = url;

  return async () => {
    await stop?.();
  };
}
