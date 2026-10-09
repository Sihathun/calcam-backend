/**
 * Copies every stored meal photo and thumbnail from one storage driver to another (typically fs or s3 -> cloudinary).
 * Object keys do not change, so the database needs no update: switch STORAGE_DRIVER afterwards.
 *
 *   # configure the destination as normal (STORAGE_DRIVER=cloudinary + credentials), then:
 *   npm run storage:migrate -- --from fs --dry-run
 *   npm run storage:migrate -- --from fs
 *   npm run storage:migrate -- --from s3 --limit 50
 *
 * The source driver is configured by the usual variables (STORAGE_FS_DIR, or S3_*). Re-running is safe: existing
 * destination files are overwritten with the same bytes. Soft-deleted meals are copied too, because their photos still
 * exist until the account is erased.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/env';
import { createPrisma } from '../src/deps';
import { createStorage } from '../src/lib/storage';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string' },
  },
});

async function main() {
  const from = values.from;
  if (!from || !['fs', 's3'].includes(from)) {
    console.error('Usage: npm run storage:migrate -- --from fs|s3 [--dry-run] [--limit N]');
    process.exit(2);
  }

  const toConfig = loadConfig(process.env);
  if (toConfig.storage.driver === from) {
    console.error(`The destination STORAGE_DRIVER is already "${from}". Set STORAGE_DRIVER to the new driver (e.g. cloudinary) first.`);
    process.exit(2);
  }
  const fromConfig = loadConfig({ ...process.env, STORAGE_DRIVER: from });
  const source = createStorage(fromConfig);
  const destination = createStorage(toConfig);
  const prisma = createPrisma(toConfig);
  const dryRun = Boolean(values['dry-run']);
  const limit = values.limit ? Number(values.limit) : Infinity;

  console.log(`${dryRun ? '[dry run] ' : ''}Copying photos from "${from}" to "${toConfig.storage.driver}"`);
  let copied = 0;
  let missing = 0;
  let failed = 0;
  let meals = 0;
  let cursor: string | undefined;

  try {
    outer: for (;;) {
      const batch = await prisma.meal.findMany({
        where: { OR: [{ imageKey: { not: null } }, { thumbKey: { not: null } }] },
        select: { id: true, imageKey: true, thumbKey: true },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1]!.id;

      for (const meal of batch) {
        if (meals >= limit) break outer;
        meals++;
        for (const key of [meal.imageKey, meal.thumbKey]) {
          if (!key) continue;
          let bytes: Buffer;
          try {
            bytes = await source.get(key);
          } catch {
            missing++;
            console.warn(`  missing in source: ${key}`);
            continue;
          }
          if (dryRun) {
            copied++;
            continue;
          }
          try {
            await destination.put(key, bytes, 'image/jpeg');
            copied++;
          } catch (err) {
            failed++;
            console.error(`  FAILED ${key}: ${(err as Error).message}`);
          }
        }
        if (meals % 25 === 0) console.log(`  … ${meals} meals processed`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`${dryRun ? 'Would copy' : 'Copied'} ${copied} file(s) from ${meals} meal(s); ${missing} missing in the source; ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
