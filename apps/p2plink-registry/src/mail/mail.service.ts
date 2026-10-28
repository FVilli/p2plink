import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { createTransport } from "nodemailer";
import { config } from "../config.js";

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly transport = createTransport({
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
  });

  async onModuleInit(): Promise<void> {
    try {
      await this.transport.verify();
      this.logger.log("SMTP connection verified");
    } catch (error) {
      this.logger.warn(
        `SMTP connection verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sendVerification(email: string, token: string) {
    return this.send(email, "Verify your email", "verify-email", token);
  }
  async sendPasswordReset(email: string, token: string) {
    return this.send(email, "Reset your password", "reset-password", token);
  }
  private maskEmail(email: string): string {
    const [local, domain] = email.split("@");
    return `${local?.slice(0, 1) ?? "*"}***@${
      domain
        ?.split(".")
        .map((part) => `${part.slice(0, 1)}***`)
        .join(".") ?? "***"
    }`;
  }

  private async send(email: string, subject: string, action: string, token: string) {
    const url = new URL(config.publicAppUrl);
    url.searchParams.set("auth", action);
    url.searchParams.set("email", email);
    url.searchParams.set("token", token);
    const link = url.toString();
    await this.transport
      .sendMail({
        from: config.mailFrom,
        to: email,
        subject,
        text: `Continue by opening: ${link}\n\nOr paste this code: ${token}`,
        html: `<p>Continue by <a href="${link}">opening this link</a>.</p><p>Or paste this code: <code>${token}</code></p>`,
      })
      .then((result) => {
        this.logger.log(
          `Email sent to ${this.maskEmail(email)}; messageId=${result.messageId}; response=${result.response}`,
        );
        return result;
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Email delivery failed for ${this.maskEmail(email)}`,
          error instanceof Error ? error.stack : undefined,
        );
        throw error;
      });
  }
}
