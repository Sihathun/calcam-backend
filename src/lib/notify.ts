import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { PushSender } from './push';

type Locale = string;

const MESSAGES: Record<string, Record<'ready' | 'failed', { title: string; body: string }>> = {
  en: {
    ready: { title: 'Your meal is ready', body: 'Tap to see the calories and macros.' },
    failed: { title: "We couldn't analyze your meal", body: 'Tap to try again or enter it manually.' },
  },
  es: {
    ready: { title: 'Tu comida está lista', body: 'Toca para ver las calorías y los macros.' },
    failed: { title: 'No pudimos analizar tu comida', body: 'Toca para intentarlo de nuevo o ingrésala manualmente.' },
  },
};

export interface NotifyDeps {
  prisma: PrismaClient;
  push: PushSender;
  logger: Logger;
}

/** Sends a meal notification to every device of the user. Failures are logged and never fail the job. */
export async function notifyMeal(
  deps: NotifyDeps,
  userId: string,
  locale: Locale,
  kind: 'ready' | 'failed',
  data: { mealId: string; status: string; errorCode?: string | null },
): Promise<void> {
  try {
    const user = await deps.prisma.user.findUnique({ where: { id: userId }, select: { notificationsEnabled: true } });
    if (!user?.notificationsEnabled) return;
    const devices = await deps.prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
    if (!devices.length) return;

    const text = (MESSAGES[locale.split('-')[0] ?? 'en'] ?? MESSAGES['en']!)[kind];
    const payload: Record<string, string> = { mealId: data.mealId, status: data.status };
    if (data.errorCode) payload['errorCode'] = data.errorCode;

    const { invalidTokens } = await deps.push.send(
      devices.map((d) => d.token),
      { title: text.title, body: text.body, data: payload },
    );
    if (invalidTokens.length) await deps.prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
  } catch (err) {
    deps.logger.warn({ err, userId }, 'push notification failed');
  }
}
