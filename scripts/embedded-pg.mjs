// Starts a local PostgreSQL (no Docker needed) and keeps it running until Ctrl+C.
//   npm run db:embedded
// Connection string: postgresql://calcam:calcam@localhost:54329/calcam
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const port = Number(process.env.EMBEDDED_PG_PORT ?? 54329);
const databaseDir = resolve(process.env.EMBEDDED_PG_DIR ?? '.local/pgdata');
const fresh = !existsSync(databaseDir);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'calcam',
  password: 'calcam',
  port,
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error(String(e)),
});

if (fresh) await pg.initialise();
await pg.start();
if (fresh) {
  await pg.createDatabase('calcam');
  await pg.createDatabase('calcam_shadow');
}
console.log(`Embedded PostgreSQL ready: postgresql://calcam:calcam@localhost:${port}/calcam`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
