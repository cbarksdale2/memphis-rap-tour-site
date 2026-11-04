// Email list sign-up. Stored in D1 with the consent words the person ticked. Nothing is emailed from here.
import type { Env } from "./http";
import { hmac, ipHash, need, now, safeEqual, sameOrigin } from "./http";

export const SIGNUPS_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]+\.[a-z]{2,}$/i;

export type SignupResult =
  | { kind: "added" | "already"; id: number }
  | { kind: "honeypot" }
  | { kind: "limited" }
  | { kind: "invalid"; error: string; email: string; first_name: string };

export async function unsubToken(env: Env, id: number): Promise<string> {
  return (await hmac(need(env.UNSUB_SECRET, "UNSUB_SECRET"), `unsub:${id}`)).slice(0, 32);
}

export async function unsubUrl(env: Env, origin: string, id: number): Promise<string> {
  return `${origin}/unsubscribe?id=${id}&t=${await unsubToken(env, id)}`;
}

export async function signup(req: Request, env: Env, form: FormData, consentText: string): Promise<SignupResult> {
  const email = String(form.get("email") || "").trim().slice(0, 254);
  const first = String(form.get("first_name") || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const source = String(form.get("source") || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  // Bots fill every field; people never see this one.
  if (String(form.get("website") || "").length > 0) return { kind: "honeypot" };
  if (!sameOrigin(req)) return { kind: "invalid", error: "Please sign up from the form on this site.", email, first_name: first };

  const t = now();
  const ip = await ipHash(req, env);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'signup' AND ip_hash = ? AND at > ?").bind(ip, t - 3600).first<{ n: number }>();
  if ((recent?.n ?? 0) >= SIGNUPS_PER_HOUR) return { kind: "limited" };
  await env.DB.prepare("INSERT INTO attempts (kind, ip_hash, at) VALUES ('signup', ?, ?)").bind(ip, t).run();

  if (!EMAIL_RE.test(email)) return { kind: "invalid", error: "That email address doesn't look right. Check it and try again.", email, first_name: first };
  if (form.get("consent") !== "yes") return { kind: "invalid", error: "Tick the box to say yes to tour emails.", email, first_name: first };

  const existing = await env.DB.prepare("SELECT id, unsubscribed_at FROM subscribers WHERE email = ?").bind(email).first<{ id: number; unsubscribed_at: number | null }>();
  if (existing) {
    // Same answer either way, so the form never reveals who is on the list.
    await env.DB.prepare("UPDATE subscribers SET unsubscribed_at = NULL, consent_text = ?, updated_at = ?, first_name = CASE WHEN ? != '' THEN ? ELSE first_name END WHERE id = ?")
      .bind(consentText, t, first, first, existing.id)
      .run();
    return { kind: "already", id: existing.id };
  }
  const row = await env.DB.prepare("INSERT INTO subscribers (email, first_name, source, consent_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(email, first, source, consentText, t, t)
    .first<{ id: number }>();
  return { kind: "added", id: row!.id };
}

export async function checkUnsub(env: Env, idRaw: string | null, tRaw: string | null): Promise<number | null> {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0 || !tRaw) return null;
  return safeEqual(tRaw, await unsubToken(env, id)) ? id : null;
}

export async function unsubscribe(env: Env, id: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, ?), updated_at = ? WHERE id = ?").bind(now(), now(), id).run();
  return r.meta.changes === 1;
}

/** CSV with spreadsheet-formula protection: a cell starting = + - @ is prefixed with '. */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- visit and Book-click counts (no cookies, no IPs) ----------

const BOT_RE = /bot|crawl|spider|slurp|preview|monitor|sitecheck|curl|wget|python|node-fetch|headless|lighthouse/i;

export function countable(req: Request): boolean {
  const ua = req.headers.get("User-Agent") || "";
  return ua.length > 0 && !BOT_RE.test(ua);
}

export function dayKey(sec = now()): string {
  return new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export async function bump(db: D1Database, path: string, kind: "view" | "book"): Promise<void> {
  await db
    .prepare("INSERT INTO counts (day, path, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, path, kind) DO UPDATE SET n = n + 1")
    .bind(dayKey(), path.slice(0, 80), kind)
    .run();
}

// ---------- private tour requests ----------

export const REQUESTS_PER_HOUR = 5;
export type RequestResult =
  | { kind: "saved"; id: number }
  | { kind: "honeypot" }
  | { kind: "limited" }
  | { kind: "invalid"; error: string; values: Record<string, string> };

export async function tourRequest(req: Request, env: Env, form: FormData): Promise<RequestResult> {
  const g = (k: string, n: number) => String(form.get(k) || "").trim().slice(0, n);
  const values = { name: g("name", 80), email: g("email", 254), date_wanted: g("date_wanted", 60), group_size: g("group_size", 20), occasion: g("occasion", 80), message: g("message", 2000) };
  if (String(form.get("website") || "").length > 0) return { kind: "honeypot" };
  if (!sameOrigin(req)) return { kind: "invalid", error: "Please send the form from this site.", values };
  const t = now();
  const ip = await ipHash(req, env);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'request' AND ip_hash = ? AND at > ?").bind(ip, t - 3600).first<{ n: number }>();
  if ((recent?.n ?? 0) >= REQUESTS_PER_HOUR) return { kind: "limited" };
  await env.DB.prepare("INSERT INTO attempts (kind, ip_hash, at) VALUES ('request', ?, ?)").bind(ip, t).run();
  if (!values.name) return { kind: "invalid", error: "Add your name.", values };
  if (!EMAIL_RE.test(values.email)) return { kind: "invalid", error: "That email address doesn't look right. Check it and try again.", values };
  if (!values.date_wanted && !values.group_size) return { kind: "invalid", error: "Tell us the date you'd like or how many are riding.", values };
  const row = await env.DB.prepare("INSERT INTO tour_requests (name, email, date_wanted, group_size, occasion, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(values.name, values.email, values.date_wanted, values.group_size, values.occasion, values.message, t)
    .first<{ id: number }>();
  return { kind: "saved", id: row!.id };
}
