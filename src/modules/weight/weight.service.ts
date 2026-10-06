import type { WeightLog } from '@prisma/client';
import type { AppDeps } from '../../deps';
import { badRequest, notFound } from '../../lib/errors';
import type { GoalsService } from '../goals/goals.service';

const round1 = (n: number) => Math.round(n * 10) / 10;

export const toWeightLogDto = (w: WeightLog) => ({
  id: w.id,
  weightKg: w.weightKg,
  loggedAt: w.loggedAt.toISOString(),
});

export function createWeightService(deps: AppDeps, goals: GoalsService) {
  const { prisma, clock } = deps;
  return {
    async add(userId: string, input: { weightKg: number; loggedAt?: string }) {
      const loggedAt = input.loggedAt ? new Date(input.loggedAt) : clock();
      if (loggedAt.getTime() > clock().getTime() + 5 * 60_000) {
        throw badRequest('VALIDATION_ERROR', 'loggedAt cannot be in the future', [
          { path: 'loggedAt', issue: 'Cannot be in the future' },
        ]);
      }
      const row = await prisma.weightLog.create({
        data: { userId, weightKg: round1(input.weightKg), loggedAt },
      });
      return { weightLog: toWeightLogDto(row), recalculation: await goals.suggestRecalculation(userId) };
    },

    /** Oldest first, ready for a chart. */
    async list(userId: string, q: { from?: string; to?: string; limit: number }) {
      const rows = await prisma.weightLog.findMany({
        where: {
          userId,
          loggedAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          },
        },
        orderBy: { loggedAt: 'asc' },
        take: q.limit,
      });
      return { items: rows.map(toWeightLogDto) };
    },

    async remove(userId: string, id: string): Promise<void> {
      // Scoped by userId: another user's id looks exactly like a missing one.
      const res = await prisma.weightLog.deleteMany({ where: { id, userId } });
      if (res.count === 0) throw notFound('WEIGHT_LOG_NOT_FOUND', 'Weight entry not found');
    },
  };
}

export type WeightService = ReturnType<typeof createWeightService>;
