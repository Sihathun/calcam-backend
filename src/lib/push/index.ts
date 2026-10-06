import type { Logger } from 'pino';
import type { Config } from '../../config/env';

export interface PushMessage {
  title: string;
  body: string;
  /** FCM data payloads must be string -> string. */
  data: Record<string, string>;
}

export interface PushSender {
  /** Returns the tokens the provider reported as no longer valid, so the caller can delete them. */
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

/** Development sender: writes to the log instead of contacting FCM. */
export class LogPushSender implements PushSender {
  readonly sent: { tokens: string[]; message: PushMessage }[] = [];

  constructor(private readonly logger?: Logger) {}

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    this.sent.push({ tokens, message });
    this.logger?.info({ tokenCount: tokens.length, title: message.title, data: message.data }, 'push (log driver)');
    return { invalidTokens: [] };
  }
}

/** Firebase Cloud Messaging. APNs delivery for iOS is configured inside the Firebase project. */
export class FcmPushSender implements PushSender {
  private messaging?: import('firebase-admin/messaging').Messaging;

  constructor(private readonly config: Config) {}

  private async init() {
    if (this.messaging) return this.messaging;
    const { initializeApp, cert, applicationDefault, getApps } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    const json = this.config.push.firebaseServiceAccountJson;
    const app = getApps()[0] ?? initializeApp({ credential: json ? cert(JSON.parse(json)) : applicationDefault() });
    this.messaging = getMessaging(app);
    return this.messaging;
  }

  async send(tokens: string[], message: PushMessage) {
    if (!tokens.length) return { invalidTokens: [] };
    const messaging = await this.init();
    const invalidTokens: string[] = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const res = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title: message.title, body: message.body },
        data: message.data,
      });
      res.responses.forEach((r, idx) => {
        const code = r.error?.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          invalidTokens.push(chunk[idx]!);
        }
      });
    }
    return { invalidTokens };
  }
}

export function createPushSender(config: Config, logger: Logger): PushSender {
  return config.push.driver === 'fcm' ? new FcmPushSender(config) : new LogPushSender(logger);
}
