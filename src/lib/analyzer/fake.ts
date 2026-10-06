import { TransientError } from '../errors';
import { ProviderError, type AnalyzerInput, type AnalyzerOutput, type MealAnalyzer } from './types';

/**
 * Deterministic analyzer for tests and local development (AI_PROVIDER=fake). It needs no API key.
 * The hint (or description) text can steer the result:
 *   "notfood"     -> isFood=false
 *   "lowconf"     -> confidence 0.1
 *   "transient"   -> TransientError on every call (exercises queue retries)
 *   "permanent"   -> ProviderError
 *   "badjson"     -> schema-invalid output on the first call only (exercises the validation retry)
 *   "badjsonalways" -> schema-invalid output on every call
 *   "huge"        -> implausible 90000 kcal (exercises clamping)
 * Corrections that mention "chicken" turn the dish into a chicken sandwich.
 */
export class FakeAnalyzer implements MealAnalyzer {
  calls: AnalyzerInput[] = [];
  private badJsonServed = false;

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    this.calls.push(input);
    const steer = `${input.hint ?? ''} ${input.description ?? ''}`.toLowerCase();
    const out = (raw: unknown): AnalyzerOutput => ({ raw, provider: 'fake', model: 'fake-analyzer' });

    if (steer.includes('transient')) throw new TransientError('fake transient failure');
    if (steer.includes('permanent')) throw new ProviderError('fake permanent failure');
    if (steer.includes('badjsonalways')) return out({ nope: true });
    if (steer.includes('badjson') && !this.badJsonServed) {
      this.badJsonServed = true;
      return out({ nope: true });
    }
    if (steer.includes('notfood')) {
      return out({ name: 'Not food', items: [], calories: 0, proteinG: 0, carbsG: 0, fatG: 0, healthScore: 0, isFood: false, confidence: 0.95 });
    }

    if (input.description && !input.image) {
      const text = input.description.trim();
      return out({
        name: text.charAt(0).toUpperCase() + text.slice(1, 80),
        items: [{ name: text.slice(0, 80), portion: '1 serving', calories: 300, proteinG: 15, carbsG: 30, fatG: 12 }],
        calories: 300,
        proteinG: 15,
        carbsG: 30,
        fatG: 12,
        healthScore: 6,
        isFood: true,
        confidence: 0.7,
      });
    }

    const chicken = input.corrections.some((c) => c.toLowerCase().includes('chicken'));
    const noChips = input.corrections.some((c) => c.toLowerCase().includes('no chips'));
    const name = chicken ? 'Chicken Sandwich' : 'Turkey Sandwich With Potato Chips';
    const sandwich = { name: chicken ? 'chicken sandwich' : 'turkey sandwich', portion: '1 sandwich', calories: 340, proteinG: 22, carbsG: 35, fatG: 12 };
    const chips = { name: 'potato chips', portion: '1 handful', calories: 120, proteinG: 3, carbsG: 10, fatG: 8 };
    const items = noChips ? [sandwich] : [sandwich, chips];
    const sum = (k: 'calories' | 'proteinG' | 'carbsG' | 'fatG') => items.reduce((s, i) => s + i[k], 0);

    return out({
      name,
      items,
      // Mirrors the "Turkey Sandwich With Potato Chips" mock-up: 460 kcal, 25 / 45 / 20 g.
      calories: steer.includes('huge') ? 90000 : sum('calories'),
      proteinG: sum('proteinG'),
      carbsG: sum('carbsG'),
      fatG: sum('fatG'),
      healthScore: noChips ? 8 : 7,
      isFood: true,
      confidence: steer.includes('lowconf') ? 0.1 : 0.82,
    });
  }
}
