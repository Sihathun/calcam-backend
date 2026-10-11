import type { NutritionGoal, Profile } from '@prisma/client';
import type { AppDeps } from '../../deps';
import { toGoalDto, toPlanPreview, type GoalDto, type RecalculationDto } from '../../lib/dto';
import { AppError, conflict, notFound } from '../../lib/errors';
import { activeGoal, latestWeightKg } from '../../lib/me';
import { calculatePlan, clampGoal, type PlanInput } from '../../lib/plan-engine';
import { goalSnapshot } from '../onboarding/onboarding.service';

export function profileToPlanInput(p: Profile, weightKg: number): PlanInput {
  return {
    sex: p.sex,
    birthDate: p.birthDate.toISOString().slice(0, 10),
    heightCm: p.heightCm,
    weightKg,
    workoutsPerWeek: p.workoutsPerWeek,
    goal: p.goal,
    diet: p.diet,
    targetWeightKg: p.targetWeightKg,
  };
}

/** The goal in force at `instant`: the latest one that started on or before it, else the earliest ever. */
export function goalAt<T extends { effectiveFrom: Date }>(goalsAscending: T[], instant: Date): T | undefined {
  let found: T | undefined;
  for (const g of goalsAscending) {
    if (g.effectiveFrom.getTime() <= instant.getTime()) found = g;
    else break;
  }
  return found ?? goalsAscending[0];
}

export function createGoalsService(deps: AppDeps) {
  const { config, prisma, clock } = deps;

  async function requireProfileAndWeight(userId: string) {
    const [profile, weightKg] = await Promise.all([
      prisma.profile.findUnique({ where: { userId } }),
      latestWeightKg(prisma, userId),
    ]);
    if (!profile) throw conflict('ONBOARDING_REQUIRED', 'Complete onboarding first');
    if (weightKg === null) throw conflict('WEIGHT_REQUIRED', 'Log your weight first');
    return { profile, weightKg };
  }

  const snapshotDiffers = (snap: any, input: PlanInput): boolean => {
    if (!snap || typeof snap !== 'object') return true;
    return (
      snap.sex !== input.sex ||
      snap.birthDate !== input.birthDate ||
      snap.heightCm !== input.heightCm ||
      snap.workoutsPerWeek !== input.workoutsPerWeek ||
      snap.goal !== input.goal ||
      snap.diet !== input.diet ||
      (snap.targetWeightKg ?? null) !== (input.targetWeightKg ?? null) ||
      Math.abs((snap.weightKg ?? 0) - input.weightKg) >= config.recalcWeightDeltaKg
    );
  };

  return {
    async getActive(userId: string): Promise<GoalDto> {
      const goal = await activeGoal(prisma, userId, clock());
      if (!goal) throw notFound('NO_ACTIVE_GOAL', 'No nutrition goal yet. Complete onboarding first.');
      return toGoalDto(goal);
    },

    /** Every goal version, oldest first. Used by the dashboard and analytics. */
    async history(userId: string): Promise<NutritionGoal[]> {
      return prisma.nutritionGoal.findMany({ where: { userId }, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] });
    },

    /** Manual edit from the pencil icons. Creates a new user_edited version; history is never rewritten. */
    async edit(
      userId: string,
      values: { calories?: number; proteinG?: number; carbsG?: number; fatG?: number },
    ): Promise<GoalDto> {
      const current = await activeGoal(prisma, userId, clock());
      if (!current) throw conflict('ONBOARDING_REQUIRED', 'Complete onboarding first');
      const next = clampGoal(values, current, config.plan.limits);
      const created = await prisma.nutritionGoal.create({
        data: {
          userId,
          ...next,
          source: 'user_edited',
          bmr: current.bmr,
          tdee: current.tdee,
          inputsSnapshot: current.inputsSnapshot ?? undefined,
          effectiveFrom: clock(),
        },
      });
      return toGoalDto(created);
    },

    /** Re-runs the engine from the current profile and latest weight. */
    async recalculate(userId: string): Promise<GoalDto> {
      const { profile, weightKg } = await requireProfileAndWeight(userId);
      const input = profileToPlanInput(profile, weightKg);
      const plan = calculatePlan(input, config.plan, clock());
      const created = await prisma.nutritionGoal.create({
        data: {
          userId,
          calories: plan.calories,
          proteinG: plan.proteinG,
          carbsG: plan.carbsG,
          fatG: plan.fatG,
          source: 'calculated',
          bmr: plan.bmr,
          tdee: plan.tdee,
          inputsSnapshot: goalSnapshot(input, weightKg),
          effectiveFrom: clock(),
        },
      });
      return toGoalDto(created);
    },

    /**
     * Offered after profile or weight changes. Never throws for plan problems: a goal that is no longer
     * supported (for example "lose" after weight dropped below BMI 18.5) is reported through `reason`.
     */
    async suggestRecalculation(userId: string): Promise<RecalculationDto> {
      const [profile, weightKg, goal] = await Promise.all([
        prisma.profile.findUnique({ where: { userId } }),
        latestWeightKg(prisma, userId),
        activeGoal(prisma, userId, clock()),
      ]);
      if (!profile || weightKg === null) return { suggested: false, reason: null, plan: null };
      const input = profileToPlanInput(profile, weightKg);
      try {
        const plan = calculatePlan(input, config.plan, clock());
        return {
          suggested: !goal || snapshotDiffers(goal.inputsSnapshot, input),
          reason: null,
          plan: toPlanPreview(plan, config.plan.limits),
        };
      } catch (err) {
        if (err instanceof AppError) return { suggested: false, reason: err.code, plan: null };
        throw err;
      }
    },
  };
}

export type GoalsService = ReturnType<typeof createGoalsService>;
