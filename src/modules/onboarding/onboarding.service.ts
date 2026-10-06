import { Prisma } from '@prisma/client';
import type { AppDeps } from '../../deps';
import { toPlanPreview } from '../../lib/dto';
import {
  ACCOMPLISHMENTS,
  DIETS,
  GOALS,
  REFERRAL_SOURCES,
  SEX,
  WORKOUTS_PER_WEEK,
  type Accomplishment,
  type Diet,
  type GoalType,
  type ReferralSource,
  type Sex,
  type WorkoutsPerWeek,
} from '../../lib/enums';
import { loadMe } from '../../lib/me';
import { workoutsToDb } from '../../lib/mappers';
import { calculatePlan, clampGoal, type PlanInput, type PlanResult } from '../../lib/plan-engine';
import type { GoalSourceType } from '../../lib/enums';
import type { OnboardingPayload, PlanInputPayload } from './onboarding.schemas';

// English display labels copied from the design mock-ups. The client localises them by code.
const SEX_LABELS: Record<Sex, string> = { male: 'Male', female: 'Female', other: 'Other' };
const WORKOUT_LABELS: Record<WorkoutsPerWeek, { label: string; description: string }> = {
  '0-2': { label: '0 - 2', description: 'Workouts now and then' },
  '3-5': { label: '3 - 5', description: 'A few workouts per week' },
  '6+': { label: '6+', description: 'Dedicated athlete' },
};
const REFERRAL_LABELS: Record<ReferralSource, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'Tik Tok',
  youtube: 'YouTube',
  google: 'Google',
  x: 'X',
  friend_or_family: 'Friend or family',
  play_store: 'Play Store',
};
const DIET_LABELS: Record<Diet, string> = {
  balanced: 'Balanced',
  whole_food: 'Whole-food focus',
  mediterranean: 'Mediterranean',
  flexitarian: 'Flexitarian',
  pescatarian: 'Pescatarian',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  low_carb: 'Low-carb',
  keto: 'Keto',
  paleo: 'Paleo',
};
const GOAL_LABELS: Record<GoalType, string> = { lose: 'Lose Weight', maintain: 'Maintain', gain: 'Gain Weight' };
const ACCOMPLISHMENT_LABELS: Record<Accomplishment, string> = {
  eat_healthier: 'Eat and live healthier',
  boost_energy_mood: 'Boost my energy and mood',
  stay_motivated: 'Stay motivated and consistent',
  feel_better_body: 'Feel better about my body',
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Result of the pure validation + calculation step, computed before any write happens. */
export interface PreparedOnboarding {
  payload: OnboardingPayload;
  plan: PlanResult;
  goal: { calories: number; proteinG: number; carbsG: number; fatG: number };
  goalSource: GoalSourceType;
  committedAt: Date | null;
  weightKg: number;
}

export function createOnboardingService(deps: AppDeps) {
  const { config, prisma, clock } = deps;

  function toPlanInput(p: PlanInputPayload): PlanInput {
    return {
      sex: p.sex,
      birthDate: p.birthDate,
      heightCm: p.heightCm,
      weightKg: round1(p.weightKg),
      workoutsPerWeek: p.workoutsPerWeek,
      goal: p.goal,
      diet: p.diet,
      targetWeightKg: p.targetWeightKg == null ? null : round1(p.targetWeightKg),
    };
  }

  return {
    options() {
      const named = <T extends string>(codes: readonly T[], labels: Record<T, string>) =>
        codes.map((code) => ({ code, label: labels[code] }));
      return {
        sex: named(SEX, SEX_LABELS),
        workoutsPerWeek: WORKOUTS_PER_WEEK.map((code) => ({ code, ...WORKOUT_LABELS[code] })),
        referralSources: named(REFERRAL_SOURCES, REFERRAL_LABELS),
        diets: named(DIETS, DIET_LABELS),
        goals: named(GOALS, GOAL_LABELS),
        accomplishments: named(ACCOMPLISHMENTS, ACCOMPLISHMENT_LABELS),
        locales: config.supportedLocales.map((code) => ({
          code,
          label: new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code,
        })),
        goalLimits: config.plan.limits,
      };
    },

    /** Stateless plan calculation for screens 12, 15 and 16. Nothing is stored. */
    preview(input: PlanInputPayload) {
      const plan = calculatePlan(toPlanInput(input), config.plan, clock());
      return toPlanPreview(plan, config.plan.limits);
    },

    /** Validates and calculates. Throws 422 (GOAL_NOT_SUPPORTED, UNDER_MINIMUM_AGE...) before anything is written. */
    prepare(payload: OnboardingPayload): PreparedOnboarding {
      const now = clock();
      const plan = calculatePlan(toPlanInput(payload), config.plan, now);
      const edited = payload.acceptedGoal;
      const hasEdits = !!edited && Object.values(edited).some((v) => v !== undefined);
      const goal = hasEdits ? clampGoal(edited, plan, config.plan.limits) : {
        calories: plan.calories,
        proteinG: plan.proteinG,
        carbsG: plan.carbsG,
        fatG: plan.fatG,
      };

      let committedAt: Date | null = null;
      if (payload.commitment) {
        const claimed = new Date(payload.commitment.committedAt);
        // Never trust a timestamp from the future (device clock skew); fall back to server time.
        committedAt = claimed.getTime() > now.getTime() + 5 * 60_000 ? now : claimed;
      }

      return {
        payload,
        plan,
        goal,
        goalSource: hasEdits ? 'user_edited' : 'calculated',
        committedAt,
        weightKg: round1(payload.weightKg),
      };
    },

    /** Writes profile, first goal, first weight log and user preferences. Call inside a transaction. */
    async apply(tx: Prisma.TransactionClient, userId: string, prep: PreparedOnboarding): Promise<void> {
      const { payload: p, plan } = prep;
      const now = clock();

      if (p.locale || p.timezone) {
        await tx.user.update({ where: { id: userId }, data: { locale: p.locale, timezone: p.timezone } });
      }
      await tx.profile.create({
        data: {
          userId,
          sex: p.sex,
          birthDate: new Date(`${p.birthDate}T00:00:00.000Z`),
          heightCm: p.heightCm,
          heightUnitPref: p.heightUnitPref,
          weightUnitPref: p.weightUnitPref,
          workoutsPerWeek: workoutsToDb(p.workoutsPerWeek),
          activityLevel: plan.activityLevel,
          goal: p.goal,
          targetWeightKg: p.goal === 'maintain' ? null : (p.targetWeightKg ?? null),
          diet: p.diet,
          accomplishment: p.accomplishment ?? null,
          referralSource: p.referralSource ?? null,
          triedOtherApps: p.triedOtherApps ?? null,
          worksWithProfessional: p.worksWithProfessional ?? null,
          commitmentAt: prep.committedAt,
        },
      });
      await tx.nutritionGoal.create({
        data: {
          userId,
          ...prep.goal,
          source: prep.goalSource,
          bmr: plan.bmr,
          tdee: plan.tdee,
          inputsSnapshot: goalSnapshot(p, prep.weightKg),
          effectiveFrom: now,
        },
      });
      await tx.weightLog.create({ data: { userId, weightKg: prep.weightKg, loggedAt: now } });
    },

    /** POST /onboarding/complete. Idempotent: a second call returns the stored state without changing it. */
    async complete(userId: string, payload: OnboardingPayload) {
      const existing = await prisma.profile.findUnique({ where: { userId }, select: { userId: true } });
      if (existing) return loadMe(prisma, userId);

      const prep = this.prepare(payload);
      try {
        await prisma.$transaction((tx) => this.apply(tx, userId, prep));
      } catch (err) {
        // A concurrent duplicate request won the race: treat it as the same, already completed, call.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
      return loadMe(prisma, userId);
    },
  };
}

/** Profile values a goal was calculated from. Compared later to decide whether to offer a recalculation. */
export function goalSnapshot(
  p: Pick<OnboardingPayload, 'sex' | 'birthDate' | 'heightCm' | 'workoutsPerWeek' | 'goal' | 'diet' | 'targetWeightKg'>,
  weightKg: number,
) {
  return {
    sex: p.sex,
    birthDate: p.birthDate,
    heightCm: p.heightCm,
    workoutsPerWeek: p.workoutsPerWeek,
    goal: p.goal,
    diet: p.diet,
    targetWeightKg: p.targetWeightKg ?? null,
    weightKg,
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
