import type { AnalyzerInput } from '../types';

/**
 * Prompt template for meal analysis. Bump the version (new file, keep the old one) whenever the wording changes,
 * so stored results in Meal.aiRaw can be traced back to the prompt that produced them.
 */
export const PROMPT_VERSION = 'meal-analysis.v1';

export const SYSTEM_PROMPT = `You are a nutrition analyst inside a calorie-tracking app. You estimate the nutrition of a meal from a photo or a short text description.

Rules:
- Estimate the whole serving shown or described, not per 100 g.
- Break the meal into its main components in "items", each with an estimated portion and its own nutrition. The meal totals must be the sum of the items.
- "name" is a short dish name in Title Case, for example "Turkey Sandwich With Potato Chips".
- Calories are kcal as a whole number. Protein, carbs and fat are grams with at most one decimal.
- "healthScore" is an integer from 0 to 10 for overall nutritional quality (10 = whole, minimally processed, balanced; 0 = very high in sugar, refined carbs or saturated fat).
- "confidence" is between 0 and 1. Lower it for blurry photos, hidden ingredients or ambiguous portions.
- If the image does not show food or drink, or the text is not a food, set "isFood" to false, "name" to "Not food", and every number to 0.
- When the user provides corrections, treat them as authoritative. They override what you see, and you must apply every one of them.
- Never include commentary. Respond only with the JSON object that matches the requested schema.`;

export function buildUserText(input: AnalyzerInput): string {
  const parts: string[] = [];
  if (input.image) parts.push('Analyze the meal in the attached photo.');
  if (input.description) parts.push(`Analyze this meal description: "${input.description}"`);
  if (input.hint) parts.push(`The user added this note about the meal: "${input.hint}"`);
  if (input.previous) {
    parts.push(
      `A previous estimate was: ${JSON.stringify({
        name: input.previous.name,
        calories: input.previous.calories,
        proteinG: input.previous.proteinG,
        carbsG: input.previous.carbsG,
        fatG: input.previous.fatG,
      })}. It was wrong or incomplete.`,
    );
  }
  if (input.corrections.length) {
    parts.push(
      `User corrections, oldest first:\n${input.corrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nProduce a new estimate that applies all of them.`,
    );
  }
  parts.push(`Write names in the language with code "${input.locale}", falling back to English.`);
  return parts.join('\n\n');
}
