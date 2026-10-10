import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, pendingMigrations, shippedMigrations } from '../src/lib/migrations';
import { createTestContext } from './helpers';

// The readiness probe and the startup warning: a database missing a migration the code needs must not look healthy.

const ctx = createTestContext();
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A copy of the real migrations folder plus extra (never applied) migrations. */
function migrationsDir(extra: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'calcam-migrations-'));
  dirs.push(dir);
  for (const name of [...shippedMigrations(), ...extra]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'migration.sql'), '-- test');
  }
  return dir;
}

describe('pendingMigrations', () => {
  it('finds the shipped migrations', () => {
    expect(shippedMigrations(MIGRATIONS_DIR)).toEqual(expect.arrayContaining(['20261010030843_food_catalog']));
  });

  it('is empty when the database has every shipped migration', async () => {
    expect(await pendingMigrations(ctx.deps.prisma)).toEqual([]);
  });

  it('names the migrations the database has not applied', async () => {
    const dir = migrationsDir(['29991231000000_not_applied']);
    expect(await pendingMigrations(ctx.deps.prisma, dir)).toEqual(['29991231000000_not_applied']);
  });

  it('ignores folders without a migration.sql (e.g. a stray editor folder)', async () => {
    const dir = migrationsDir([]);
    mkdirSync(join(dir, 'notes'));
    expect(await pendingMigrations(ctx.deps.prisma, dir)).toEqual([]);
  });
});
