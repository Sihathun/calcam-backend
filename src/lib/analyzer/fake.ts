import { TransientError } from '../errors';
import { ProviderError, type AnalyzerInput, type AnalyzerOutput, type MealAnalyzer } from './types';

/**
 * Deterministic analyzer for tests and local development (AI_PROVIDER=fake). It needs no API key and answers in
 * the meal-analysis.v2 shape (dishes + portion steps). The hint (or description) text can steer the result:
 *   "notfood"     -> isFood=false
 *   "lowconf"     -> confidence 0.1
 *   "transient"   -> TransientError on every call (exercises queue retries)
 *   "permanent"   -> ProviderError
 *   "badjson"     -> schema-invalid output on the first call only (exercises the validation retry)
 *   "badjsonalways" -> schema-invalid output on every call
 *   "huge"        -> a new dish with an implausible 90000 kcal serving (exercises clamping)
 *   "catalog:<slug>@<portion>" -> one listed dish, e.g. "catalog:kuy-teav@1.5" (several, comma separated)
 * Otherwise a photo is two new dishes that add up to the "Turkey Sandwich With Potato Chips" mock-up
 * (460 kcal, 25 / 45 / 20 g). Corrections that mention "chicken" turn it into a chicken sandwich, and
 * "no chips" drops the chips.
 */
export class FakeAnalyzer implements MealAnalyzer {
  calls: AnalyzerInput[] = [];
  private badJsonServed = false;

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    this.calls.push(input);
    const steer = `${input.hint ?? ''} ${input.description ?? ''}`.toLowerCase();
    const out = (raw: unknown): AnalyzerOutput => ({ raw, provider: 'fake', model: 'fake-analyzer' });
    const answer = (dishes: unknown[], confidence = 0.82) => out({ isFood: true, confidence, dishes });
    const newDish = (nameEn: string, nameKm: string, serving: [number, number, number, number, number], portion = '1') => ({
      match: 'new',
      nameEn,
      nameKm,
      portion,
      standardServing: {
        description: '1 serving',
        calories: serving[0],
        proteinG: serving[1],
        carbsG: serving[2],
        fatG: serving[3],
        healthScore: serving[4],
      },
    });

    if (steer.includes('transient')) throw new TransientError('fake transient failure');
    if (steer.includes('permanent')) throw new ProviderError('fake permanent failure');
    if (steer.includes('badjsonalways')) return out({ nope: true });
    if (steer.includes('badjson') && !this.badJsonServed) {
      this.badJsonServed = true;
      return out({ nope: true });
    }
    if (steer.includes('notfood')) return out({ isFood: false, confidence: 0.95, dishes: [] });

    const catalog = /catalog:([a-z0-9,@.\-]+)/.exec(steer);
    if (catalog) {
      return answer(
        catalog[1]!.split(',').map((pick) => {
          const [slug, portion = '1'] = pick.split('@');
          return { ...newDish(slug!, '', [0, 0, 0, 0, 0], portion), match: slug };
        }),
      );
    }
    if (steer.includes('huge')) return answer([newDish('Giant Platter', 'ចានធំ', [90000, 10, 10, 10, 2])]);

    if (input.description && !input.image) {
      const text = input.description.trim();
      return answer([newDish(text.charAt(0).toUpperCase() + text.slice(1, 80), '', [300, 15, 30, 12, 6])], 0.7);
    }

    const chicken = input.corrections.some((c) => c.toLowerCase().includes('chicken'));
    const noChips = input.corrections.some((c) => c.toLowerCase().includes('no chips'));
    const sandwich = chicken
      ? newDish('Chicken Sandwich', 'នំបុ័ងសាច់មាន់', [340, 22, 35, 12, 8])
      : newDish('Turkey Sandwich', 'នំបុ័ងសាច់មាន់បារាំង', [340, 22, 35, 12, 7]);
    const chips = newDish('Potato Chips', 'ដំឡូងបារាំងចៀន', [120, 3, 10, 8, 7]);
    return answer(noChips || chicken ? [sandwich] : [sandwich, chips], steer.includes('lowconf') ? 0.1 : 0.82);
  }
}
