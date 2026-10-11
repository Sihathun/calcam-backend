import type { AnalyzerInput } from '../types';
import { PORTION_STEPS } from '../schema';

/**
 * Prompt template for meal analysis, version 3 (version 2 plus the single-food rule): the model identifies each dish (from the listed catalog when it
 * can) and its portion step; the server computes the nutrition from the dish's reference values. Bump the
 * version (new file, keep the old one) whenever the wording changes, so stored results in Meal.aiRaw can be
 * traced back to the prompt that produced them.
 */
export const PROMPT_VERSION = 'meal-analysis.v3';

export const SYSTEM_PROMPT = `You are a food recognition assistant inside a calorie-tracking app used mostly in Cambodia. You look at a meal photo (or read a short description) and say which dishes it contains and how big each portion is. The app computes the nutrition itself from its food database, so identifying the dish and the portion correctly matters most.

Rules:
- List every separate dish or drink you can see in "dishes" (a plate of rice, a soup, a drink are separate dishes). At most 6.
- For each dish, set "match" to the slug of the listed dish it is, whenever it is the same food, even if the presentation, garnish or plate differs. Use "new" only when no listed dish fits.
- Entries marked "single food" are one plain ingredient (for example plain rice noodles). Choose them only when the plate shows just that food on its own. If the food is part of a listed dish (noodles inside a soup, mango inside a salad), choose the dish instead.
- "portion" compares what is shown with that dish's standard serving (from the list, or the one you give in "standardServing" for a new dish). Choose one of ${PORTION_STEPS.join(', ')}. Use 1 when it looks like a normal serving.
- Always fill "standardServing" with your estimate for ONE standard serving as typically sold in Cambodia: kcal as a whole number, protein, carbs and fat in grams, and a healthScore from 0 to 10 (10 = whole, minimally processed, balanced; 0 = very high in sugar, refined carbs or saturated fat). It is only used for new dishes.
- "nameEn" is the dish name in English, Title Case (for a listed dish, its listed name). "nameKm" is the name in Khmer script.
- "confidence" is between 0 and 1. Lower it for blurry photos, hidden ingredients or portions that are hard to judge.
- If the image does not show food or drink, or the text is not a food, set "isFood" to false, "confidence" to 0 and "dishes" to an empty list.
- When the user provides corrections, treat them as authoritative. They override what you see, and you must apply every one of them.
- Never include commentary. Respond only with the JSON object that matches the requested schema.`;

export function buildUserText(input: AnalyzerInput): string {
  const parts: string[] = [];
  if (input.dishes.length) {
    parts.push(
      `Known dishes (slug | English | Khmer | standard serving; "single food" marks a plain ingredient):\n${input.dishes
        .map((d) => `${d.slug} | ${d.nameEn} | ${d.nameKm ?? '-'} | ${d.serving}${d.ingredient ? ' | single food' : ''}`)
        .join('\n')}`,
    );
  }
  if (input.image) parts.push('Identify the dishes and portions in the attached photo.');
  if (input.description) parts.push(`Identify the dishes and portions in this meal description: "${input.description}"`);
  if (input.hint) parts.push(`The user added this note about the meal: "${input.hint}"`);
  if (input.previous) {
    parts.push(
      `A previous answer was: ${JSON.stringify({ name: input.previous.name, calories: input.previous.calories })}. It was wrong or incomplete.`,
    );
  }
  if (input.corrections.length) {
    parts.push(
      `User corrections, oldest first:\n${input.corrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nProduce a new answer that applies all of them.`,
    );
  }
  return parts.join('\n\n');
}
