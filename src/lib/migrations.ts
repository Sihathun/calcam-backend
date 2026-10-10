import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/** prisma/migrations, from src/lib (development) or dist/lib (the built image, which copies prisma/). */
export const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');

/** Migration folders shipped with this build (each holds a migration.sql). */
export function shippedMigrations(dir = MIGRATIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort();
}

/**
 * Migrations this build ships that the database has not applied. The code expects every one of them, so a
 * non-empty list means queries will fail (Prisma P2022, "column does not exist") until `npm run migrate` runs.
 */
export async function pendingMigrations(prisma: PrismaClient, dir = MIGRATIONS_DIR): Promise<string[]> {
  const shipped = shippedMigrations(dir);
  if (!shipped.length) return [];
  const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const applied = new Set(rows.map((r) => r.migration_name));
  return shipped.filter((name) => !applied.has(name));
}
