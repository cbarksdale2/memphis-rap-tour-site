// Stripe Checkout, test mode unless STRIPE_MODE is "live". Webhooks are signature-checked by hand
// (HMAC-SHA256 over "<timestamp>.<body>", 5-minute tolerance), the way Stripe documents it.
import { type Env, safeEqual } from "./http";

export type Ready = { ok: true; live: boolean } | { ok: false; reason: string };

export function stripeReady(env: Env): Ready {
  const key = env.STRIPE_SECRET_KEY || "";
  const live = env.STRIPE_MODE === "live";
  if (!key) return { ok: false, reason: "Stripe keys are not saved yet" };
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) {
    if (!live) return { ok: false, reason: "a live Stripe key is saved but live mode is off, so nothing can be charged" };
    return { ok: true, live: true };
  }
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) {
    if (live) return { ok: false, reason: "live mode is on but the saved key is a test key" };
    return { ok: true, live: false };
  }
  return { ok: false, reason: "the saved Stripe key doesn't look like a Stripe key" };
}

function form(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.append(k, String(v));
  return p.toString();
}

/** Replaceable in tests; the real one calls api.stripe.com. */
export const stripeApi = {
  async call(env: Env, method: "GET" | "POST", path: string, params: Record<string, string | number | undefined> = {}, idempotencyKey?: string): Promise<{ status: number; body: any }> {
    const ready = stripeReady(env);
    if (!ready.ok) return { status: 0, body: { error: { message: ready.reason } } };
    const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers, body: method === "POST" ? form(params) : undefined });
    let body: any = null;
    try { body = await res.json(); } catch { body = { error: { message: `Stripe answered ${res.status}` } }; }
    return { status: res.status, body };
  },
};

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signPayload(secret: string, payload: string, t: number): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${payload}`)}`;
}

export async function verifyWebhook(payload: string, header: string | null, secret: string | undefined, nowSec: number, tolerance = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((x) => x.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v || "");
  if (!t || !sigs.length || Math.abs(nowSec - t) > tolerance) return false;
  const want = await hmacHex(secret, `${t}.${payload}`);
  return sigs.some((s) => safeEqual(s, want));
}
