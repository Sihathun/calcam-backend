import type { PrismaClient } from '@prisma/client';
import { toMeDto, type MeDto } from './dto';
import { notFound } from './errors';

type Db = Pick<PrismaClient, 'user' | 'profile' | 'nutritionGoal' | 'weightLog'>;

export async function latestWeightKg(db: Pick<PrismaClient, 'weightLog'>, userId: string): Promise<number | null> {
  const w = await db.weightLog.findFirst({ where: { userId }, orderBy: { loggedAt: 'desc' }, select: { weightKg: true } });
  return w?.weightKg ?? null;
}

/** Active goal = the row with the greatest effectiveFrom that is not in the future. */
export async function activeGoal(db: Pick<PrismaClient, 'nutritionGoal'>, userId: string, at = new Date()) {
  return db.nutritionGoal.findFirst({
    where: { userId, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function loadMe(db: Db, userId: string): Promise<MeDto> {
  const user = await db.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw notFound('USER_NOT_FOUND', 'User not found');
  const [profile, goal, weight] = await Promise.all([
    db.profile.findUnique({ where: { userId } }),
    activeGoal(db, userId),
    latestWeightKg(db, userId),
  ]);
  return toMeDto(user, profile, goal, weight);
}
