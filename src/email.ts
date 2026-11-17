// Email out. Owner ruling 17 Nov 2026: the site sends as team@memphisraptour.com through Google Workspace
// (Gmail API, users.messages.send, scope gmail.send only), with an OAuth refresh token saved once by
// scripts/google-auth.mjs. Without the three GOOGLE_* secrets, the older Cloudflare send_email binding is
// used if present; with neither, nothing is sent and the caller records "not sent: email not set up yet",
// which the admin shows. Never a silent success.
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

export const DEFAULT_FROM = "team@memphisraptour.com";

/** Outbound HTTP to Google; replaceable in tests. */
export const googleHttp = { fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init) };

let cachedToken: { value: string; until: number; key: string } | null = null;

function b64url(s: string): string {
  return b64utf8(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function googleAccessToken(env: Env): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const key = env.GOOGLE_REFRESH_TOKEN!.slice(-12);
  if (cachedToken && cachedToken.key === key && cachedToken.until > Date.now() + 60_000) return { ok: true, token: cachedToken.value };
  const res = await googleHttp.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: env.GOOGLE_REFRESH_TOKEN!, grant_type: "refresh_token" }).toString(),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status !== 200 || !body?.access_token) {
    const why = body?.error ? `${body.error}${body.error_description ? ": " + body.error_description : ""}` : `HTTP ${res.status}`;
    return { ok: false, reason: `Google refused the saved sign-in (${why}); run scripts/google-auth.mjs again` };
  }
  cachedToken = { value: body.access_token, until: Date.now() + Number(body.expires_in || 3000) * 1000, key };
  return { ok: true, token: body.access_token };
}

async function sendViaGmail(env: Env, m: Mail): Promise<MailResult> {
  const t = await googleAccessToken(env);
  if (!t.ok) return { sent: false, reason: t.reason };
  const res = await googleHttp.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64url(mime(env.EMAIL_FROM || DEFAULT_FROM, m)) }),
  });
  if (res.status === 200) return { sent: true };
  if (res.status === 401) cachedToken = null;
  let msg = "";
  try { msg = (await res.json() as any)?.error?.message || ""; } catch { /* not JSON */ }
  return { sent: false, reason: `send failed: Gmail answered ${res.status}${msg ? " " + msg.slice(0, 100) : ""}` };
}

/** Replaceable in tests; the real one sends through Gmail (or the Cloudflare binding if that's all there is). */
export const mailer = {
  async send(env: Env, m: Mail): Promise<MailResult> {
    try {
      if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) return await sendViaGmail(env, m);
    } catch (e) {
      return { sent: false, reason: `send failed: ${String((e as Error)?.message || e).slice(0, 120)}` };
    }
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
