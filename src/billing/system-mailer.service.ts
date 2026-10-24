import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Sends platform e-mails (billing notices). Optional: without SYSTEM_SMTP_* the app still works, in-app banners remain. */
@Injectable()
export class SystemMailerService {
  private readonly logger = new Logger(SystemMailerService.name);
  private transporter: any;

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return !!this.config.get<string>('SYSTEM_SMTP_HOST');
  }

  async send(to: string, subject: string, html: string): Promise<boolean> {
    if (!this.isConfigured) return false;
    try {
      if (!this.transporter) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nodemailer = require('nodemailer');
        const port = Number(this.config.get('SYSTEM_SMTP_PORT') || 587);
        this.transporter = nodemailer.createTransport({
          host: this.config.get('SYSTEM_SMTP_HOST'),
          port,
          secure: this.config.get('SYSTEM_SMTP_SECURE') === 'true' || port === 465,
          auth: this.config.get('SYSTEM_SMTP_USER')
            ? { user: this.config.get('SYSTEM_SMTP_USER'), pass: this.config.get('SYSTEM_SMTP_PASS') }
            : undefined,
        });
      }
      await this.transporter.sendMail({
        from: this.config.get('SYSTEM_SMTP_FROM') || this.config.get('SYSTEM_SMTP_USER'),
        to,
        subject,
        html,
      });
      return true;
    } catch (e: any) {
      this.logger.error(`Could not send billing e-mail to ${to}: ${e?.message || e}`);
      return false;
    }
  }
}
