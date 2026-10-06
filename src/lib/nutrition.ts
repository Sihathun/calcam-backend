export const round1 = (n: number) => Math.round(n * 10) / 10;

export interface Nutrition {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

interface MealValues {
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  quantity: number;
  /** Null until the first analysis (or manual entry) produced values. */
  analyzedAt: Date | null;
}

/**
 * Totals = per-serving x quantity, with calories as whole numbers and macros at one decimal.
 * Null while the meal has no values yet, which is also how daily sums know to skip it.
 */
export function mealTotals(m: MealValues): Nutrition | null {
  if (!m.analyzedAt || m.calories === null || m.proteinG === null || m.carbsG === null || m.fatG === null) return null;
  return {
    calories: Math.round(m.calories * m.quantity),
    proteinG: round1(m.proteinG * m.quantity),
    carbsG: round1(m.carbsG * m.quantity),
    fatG: round1(m.fatG * m.quantity),
  };
}

export function sumNutrition(items: (Nutrition | null)[]): Nutrition {
  const sum = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const t of items) {
    if (!t) continue;
    sum.calories += t.calories;
    sum.proteinG += t.proteinG;
    sum.carbsG += t.carbsG;
    sum.fatG += t.fatG;
  }
  return { calories: sum.calories, proteinG: round1(sum.proteinG), carbsG: round1(sum.carbsG), fatG: round1(sum.fatG) };
}

export function subtractNutrition(goal: Nutrition, consumed: Nutrition): Nutrition {
  return {
    calories: goal.calories - consumed.calories,
    proteinG: round1(goal.proteinG - consumed.proteinG),
    carbsG: round1(goal.carbsG - consumed.carbsG),
    fatG: round1(goal.fatG - consumed.fatG),
  };
}
