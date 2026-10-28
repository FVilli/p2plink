import { Injectable } from "@nestjs/common";
import { createTransport } from "nodemailer";
import { config } from "../config.js";

@Injectable()
export class MailService {
  private readonly transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
  });

  async sendVerification(email: string, token: string) {
    return this.send(email, "Verify your email", "verify-email", token);
  }
  async sendPasswordReset(email: string, token: string) {
    return this.send(email, "Reset your password", "reset-password", token);
  }
  private async send(email: string, subject: string, action: string, token: string) {
    const url = new URL(config.publicAppUrl);
    url.searchParams.set("auth", action);
    url.searchParams.set("email", email);
    url.searchParams.set("token", token);
    const link = url.toString();
    await this.transport.sendMail({
      from: config.mailFrom,
      to: email,
      subject,
      text: `Continue by opening: ${link}`,
      html: `<p>Continue by <a href="${link}">opening this link</a>.</p>`,
    });
  }
}
