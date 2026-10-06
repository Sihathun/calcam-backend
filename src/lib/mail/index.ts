import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { Config } from '../../config/env';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Development mailer. It logs the message body, which for password resets contains the reset link. */
export class LogMailer implements Mailer {
  readonly sent: Mail[] = [];

  constructor(private readonly logger?: Logger) {}

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    this.logger?.info({ subject: mail.subject, text: mail.text }, 'mail (log driver)');
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(private readonly config: Config) {
    this.transport = nodemailer.createTransport(config.mail.smtpUrl);
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.config.mail.from, ...mail });
  }
}

export function createMailer(config: Config, logger: Logger): Mailer {
  return config.mail.driver === 'smtp' ? new SmtpMailer(config) : new LogMailer(logger);
}
