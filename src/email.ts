// Email out, through Cloudflare's send_email binding. Until the domain is on Cloudflare with Email
// Routing (and team@memphisraptour.com verified), there is no binding: nothing is sent and the caller
// records "not sent: email not set up yet", which the admin shows. Never a silent success.
import type { Env } from "./http";

export interface Mail { to: string; subject: string; text: string; replyTo?: string }
export type MailResult = { sent: true } | { sent: false; reason: string };

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function mime(from: string, m: Mail, now = new Date()): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const lines = [
    `From: Memphis Rap Tour <${clean(from)}>`,
    `To: ${clean(m.to)}`,
    ...(m.replyTo ? [`Reply-To: ${clean(m.replyTo)}`] : []),
    `Subject: =?utf-8?B?${b64utf8(clean(m.subject))}?=`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${clean(from).split("@")[1] || "memphisraptour.com"}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    (b64utf8(m.text).match(/.{1,76}/g) || []).join("\r\n"),
  ];
  return lines.join("\r\n");
}

/** Replaceable in tests; the real one uses the send_email binding. */
export const mailer = {
  async send(env: Env, m: Mail): Promise<MailResult> {
    if (!env.EMAIL || !env.EMAIL_FROM) return { sent: false, reason: "email not set up yet" };
    try {
      const { EmailMessage } = await import("cloudflare:email");
      await env.EMAIL.send(new EmailMessage(env.EMAIL_FROM, m.to, mime(env.EMAIL_FROM, m)));
      return { sent: true };
    } catch (e) {
      return { sent: false, reason: `send failed: ${String((e as Error)?.message || e).slice(0, 120)}` };
    }
  },
};

export function statusText(r: MailResult): string {
  return r.sent ? "sent" : `not sent: ${r.reason}`;
}
