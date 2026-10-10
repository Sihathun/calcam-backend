import 'dotenv/config';
import { loadConfig } from './config/env';
import { createPrisma } from './deps';
import { seedCatalog } from './lib/catalog';

/**
 * Loads the Khmer food catalog (prisma/data/khmer-dishes.json) into FoodDish. Run after every migration:
 *   npm run catalog:seed            (development, from source)
 *   node dist/seed-catalog.js       (the built image; docker compose runs it after `prisma migrate deploy`)
 * Safe to run repeatedly: dishes are upserted by slug.
 */
async function main() {
  // Seeding only needs the database, so it does not insist on the other secrets.
  const config = loadConfig({ JWT_ACCESS_SECRET: 'catalog-seed-does-not-sign-tokens', ...process.env });
  const prisma = createPrisma(config);
  try {
    const count = await seedCatalog(prisma);
    console.log(`Food catalog: ${count} dishes upserted`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
