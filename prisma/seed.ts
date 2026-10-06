import 'dotenv/config';
import argon2 from 'argon2';
import { loadConfig } from '../src/config/env';
import { createPrisma } from '../src/deps';
import { workoutsToDb } from '../src/lib/mappers';
import { calculatePlan } from '../src/lib/plan-engine';
import { DateTime } from 'luxon';

/**
 * Creates (or resets) a demo account with a week of history, so the dashboard and analytics have data.
 *   email: demo@example.com   password: Password123!
 * Run with `npm run seed`. Safe to run repeatedly: the demo account is rebuilt each time.
 */
async function main() {
  // The seed only needs the database and plan settings, so it does not insist on the other secrets.
  const config = loadConfig({ JWT_ACCESS_SECRET: 'seed-does-not-sign-tokens', ...process.env });
  const prisma = createPrisma(config);
  const email = 'demo@example.com';
  const zone = 'Asia/Phnom_Penh';
  const now = DateTime.now().setZone(zone);

  await prisma.user.deleteMany({ where: { email } });

  const input = {
    sex: 'female' as const,
    birthDate: '1998-04-12',
    heightCm: 167.6,
    weightKg: 56.4,
    workoutsPerWeek: '3-5' as const,
    goal: 'maintain' as const,
    diet: 'balanced' as const,
  };
  const plan = calculatePlan(input, config.plan);

  const user = await prisma.user.create({
    data: { email, passwordHash: await argon2.hash('Password123!'), locale: 'en', timezone: zone },
  });
  await prisma.profile.create({
    data: {
      userId: user.id,
      sex: input.sex,
      birthDate: new Date(`${input.birthDate}T00:00:00Z`),
      heightCm: input.heightCm,
      heightUnitPref: 'ft_in',
      weightUnitPref: 'kg',
      workoutsPerWeek: workoutsToDb(input.workoutsPerWeek),
      activityLevel: plan.activityLevel,
      goal: input.goal,
      diet: input.diet,
      accomplishment: 'eat_healthier',
      referralSource: 'tiktok',
      triedOtherApps: true,
      worksWithProfessional: false,
      commitmentAt: now.minus({ days: 7 }).toJSDate(),
    },
  });
  await prisma.nutritionGoal.create({
    data: {
      userId: user.id,
      calories: plan.calories,
      proteinG: plan.proteinG,
      carbsG: plan.carbsG,
      fatG: plan.fatG,
      source: 'calculated',
      bmr: plan.bmr,
      tdee: plan.tdee,
      effectiveFrom: now.minus({ days: 7 }).toJSDate(),
    },
  });

  for (let i = 6; i >= 0; i--) {
    await prisma.weightLog.create({
      data: { userId: user.id, weightKg: Math.round((56.4 - i * 0.05) * 10) / 10, loggedAt: now.minus({ days: i }).set({ hour: 7 }).toJSDate() },
    });
  }

  const meals: [number, number, string, number, number, number, number, number][] = [
    // daysAgo, hour, name, kcal, protein, carbs, fat, healthScore
    [0, 8, 'Oatmeal With Banana', 320, 9, 58, 6, 8],
    [0, 12, 'Chicken Rice Bowl', 640, 38, 72, 18, 7],
    [1, 8, 'Greek Yogurt With Berries', 210, 15, 24, 5, 9],
    [1, 13, 'Turkey Sandwich With Potato Chips', 460, 25, 45, 20, 7],
    [1, 19, 'Salmon With Vegetables', 580, 42, 30, 28, 9],
    [2, 12, 'Pad Thai', 720, 28, 95, 24, 5],
    [3, 9, 'Avocado Toast', 340, 10, 38, 17, 8],
    [3, 18, 'Beef Noodle Soup', 520, 32, 62, 14, 7],
  ];
  for (const [daysAgo, hour, name, calories, proteinG, carbsG, fatG, healthScore] of meals) {
    await prisma.meal.create({
      data: {
        userId: user.id,
        name,
        source: 'manual',
        status: 'completed',
        progress: 100,
        calories,
        proteinG,
        carbsG,
        fatG,
        healthScore,
        analyzedAt: new Date(),
        loggedAt: now.minus({ days: daysAgo }).set({ hour, minute: 10 }).toJSDate(),
      },
    });
  }

  console.log(`Seeded ${email} / Password123! with ${meals.length} meals and a ${plan.calories} kcal goal.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
