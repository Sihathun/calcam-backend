import type { Prisma } from '@prisma/client';
import type { AppDeps } from '../../deps';
import { toProfileDto } from '../../lib/dto';
import type { Accomplishment, Diet, GoalType, HeightUnit, ReferralSource, Sex, WeightUnit, WorkoutsPerWeek } from '../../lib/enums';
import { conflict, notFound } from '../../lib/errors';
import { latestWeightKg, loadMe } from '../../lib/me';
import { workoutsToDb } from '../../lib/mappers';
import { calculatePlan } from '../../lib/plan-engine';
import type { GoalsService } from '../goals/goals.service';
import { profileToPlanInput } from '../goals/goals.service';

export interface ProfilePatch {
  sex?: Sex;
  birthDate?: string;
  heightCm?: number;
  heightUnitPref?: HeightUnit;
  weightUnitPref?: WeightUnit;
  workoutsPerWeek?: WorkoutsPerWeek;
  goal?: GoalType;
  targetWeightKg?: number | null;
  diet?: Diet;
  accomplishment?: Accomplishment | null;
  referralSource?: ReferralSource | null;
  triedOtherApps?: boolean | null;
  worksWithProfessional?: boolean | null;
  /** Logs a new weight entry. Weight lives in the weight log, not on the profile. */
  weightKg?: number;
}

export interface PreferencesPatch {
  locale?: string;
  timezone?: string;
  heightUnitPref?: HeightUnit;
  weightUnitPref?: WeightUnit;
  notificationsEnabled?: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function createProfileService(deps: AppDeps, goals: GoalsService) {
  const { prisma, config, clock } = deps;

  return {
    getMe: (userId: string) => loadMe(prisma, userId),

    /**
     * Changing a field that feeds the plan formula validates the resulting plan (so it can answer 422
     * GOAL_NOT_SUPPORTED) and returns a recalculation offer. Applying the offer is a separate, explicit call.
     */
    async updateProfile(userId: string, patch: ProfilePatch) {
      const current = await prisma.profile.findUnique({ where: { userId } });
      if (!current) throw conflict('ONBOARDING_REQUIRED', 'Complete onboarding first');

      const weightNow = patch.weightKg !== undefined ? round1(patch.weightKg) : await latestWeightKg(prisma, userId);
      const { weightKg: _w, ...profilePatch } = patch;

      const planFieldsChanged =
        patch.weightKg !== undefined ||
        (['sex', 'birthDate', 'heightCm', 'workoutsPerWeek', 'goal', 'targetWeightKg', 'diet'] as const).some(
          (k) => patch[k] !== undefined,
        );

      const data: Prisma.ProfileUpdateInput = {
        ...profilePatch,
        birthDate: patch.birthDate ? new Date(`${patch.birthDate}T00:00:00.000Z`) : undefined,
        workoutsPerWeek: patch.workoutsPerWeek ? workoutsToDb(patch.workoutsPerWeek) : undefined,
      };
      if (patch.goal === 'maintain') data.targetWeightKg = null;

      if (planFieldsChanged && weightNow !== null) {
        // Throws 422 before anything is saved if the combination is not supported.
        const merged = {
          ...current,
          ...profilePatch,
          birthDate: patch.birthDate ? new Date(`${patch.birthDate}T00:00:00.000Z`) : current.birthDate,
          workoutsPerWeek: patch.workoutsPerWeek ? workoutsToDb(patch.workoutsPerWeek) : current.workoutsPerWeek,
          targetWeightKg: patch.goal === 'maintain' ? null : (patch.targetWeightKg ?? current.targetWeightKg),
        };
        const plan = calculatePlan(profileToPlanInput(merged, weightNow), config.plan, clock());
        data.activityLevel = plan.activityLevel;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.profile.update({ where: { userId }, data });
        if (patch.weightKg !== undefined) {
          await tx.weightLog.create({ data: { userId, weightKg: round1(patch.weightKg), loggedAt: clock() } });
        }
        return row;
      });

      return {
        profile: toProfileDto(updated, await latestWeightKg(prisma, userId)),
        recalculation: await goals.suggestRecalculation(userId),
      };
    },

    async updatePreferences(userId: string, patch: PreferencesPatch) {
      const { heightUnitPref, weightUnitPref, ...userPatch } = patch;
      if (heightUnitPref || weightUnitPref) {
        const res = await prisma.profile.updateMany({ where: { userId }, data: { heightUnitPref, weightUnitPref } });
        if (res.count === 0) throw conflict('ONBOARDING_REQUIRED', 'Complete onboarding first');
      }
      if (Object.values(userPatch).some((v) => v !== undefined)) {
        await prisma.user.update({ where: { id: userId }, data: userPatch });
      }
      return loadMe(prisma, userId);
    },

    /**
     * Account deletion (app-store requirement). The account is disabled immediately; the hard delete of every row
     * and stored image happens in a background job.
     */
    async requestDeletion(userId: string): Promise<void> {
      const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
      if (!user) throw notFound('USER_NOT_FOUND', 'User not found');
      const now = clock();
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { deletedAt: now } }),
        prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
        prisma.deviceToken.deleteMany({ where: { userId } }),
      ]);
      await deps.queue.enqueueAccountDeletion(userId);
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
