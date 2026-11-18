// Discount codes. Stripe is the source of truth: a code is a Stripe coupon plus its promotion code, so
// checkout (allow_promotion_codes) keeps working unchanged. The site only makes, lists and switches them.
import { memphisTime, money, tourWhen } from "./booking";
import type { Env } from "./http";
import { stripeApi } from "./stripe";

export const CODE_RE = /^[A-Z0-9]{3,20}$/;

export interface CodeInput {
  code: string;
  kind: string; // "amount" ($ off each order) | "percent"
  value: string;
  maxUses: string; // blank = no limit
  lastDay: string; // YYYY-MM-DD, Central; blank = no last day
}

export type CodePlan =
  | { ok: true; code: string; coupon: Record<string, string | number>; promo: Record<string, string | number>; words: string }
  | { ok: false; error: string };

/** Checks the form and builds the two Stripe requests. Pure: no Stripe call, no database. */
export function planCode(input: CodeInput, opts: { maxAmountCents: number; nowSec: number }): CodePlan {
  const code = input.code.trim().toUpperCase();
  if (!CODE_RE.test(code)) return { ok: false, error: "The code must be 3 to 20 letters or numbers, with no spaces." };

  const coupon: Record<string, string | number> = { duration: "once", name: code, "metadata[made_by]": "site admin" };
  let off: string;
  const v = input.value.trim().replace(/^\$/, "").replace(/%$/, "");
  if (input.kind === "percent") {
    if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 100) return { ok: false, error: "% off must be a whole number from 1 to 100." };
    coupon.percent_off = Number(v);
    off = `${Number(v)}% off`;
  } else if (input.kind === "amount") {
    const m = v.match(/^\d{1,5}(\.\d{1,2})?$/);
    const cents = m ? Math.round(Number(v) * 100) : 0;
    if (!cents) return { ok: false, error: "$ off must be an amount like 10 or 12.50." };
    if (cents > opts.maxAmountCents) return { ok: false, error: `$ off can't be more than the ticket price (${money(opts.maxAmountCents)}).` };
    coupon.amount_off = cents;
    coupon.currency = "usd";
    off = `${money(cents)} off`;
  } else {
    return { ok: false, error: "Pick $ off or % off." };
  }

  const promo: Record<string, string | number> = { code, "metadata[made_by]": "site admin" };
  const extra: string[] = [];
  const uses = input.maxUses.trim();
  if (uses) {
    if (!/^\d{1,6}$/.test(uses) || Number(uses) < 1) return { ok: false, error: "Most uses must be a whole number, 1 or more (or blank for no limit)." };
    promo.max_redemptions = Number(uses);
    extra.push(`up to ${Number(uses)} use${uses === "1" ? "" : "s"}`);
  }
  const day = input.lastDay.trim();
  if (day) {
    const end = memphisTime(day, "23:59");
    if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: "The last day must be a date." };
    const expires = end + 59; // the end of that day, Central
    if (expires <= opts.nowSec) return { ok: false, error: "The last day must be today or later." };
    if (expires > opts.nowSec + 5 * 365 * 86400) return { ok: false, error: "The last day must be within 5 years." };
    promo.expires_at = expires;
    extra.push(`works until ${lastDayWords(expires)}`);
  }
  return { ok: true, code, coupon, promo, words: `${code}: ${off} each order${extra.length ? ", " + extra.join(", ") : ""}` };
}

export function lastDayWords(sec: number): string {
  return `${tourWhen(sec).split(",")[0]} ${new Date(sec * 1000).toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric" })}, Central`;
}

/** Stripe refused because the restricted key lacks the permission (never echo that error: it names the key). */
export function noPermission(r: { status: number; body: any }): boolean {
  return r.status === 401 || r.status === 403 || /permission/i.test(String(r.body?.error?.message || ""));
}

export const NEEDS_PERMISSION = "Can't make or switch codes yet: the Stripe key needs permission (Coupons: Write and Promotion codes: Write).";

function stripeWords(r: { status: number; body: any }): string {
  if (noPermission(r)) return NEEDS_PERMISSION;
  return String(r.body?.error?.message || `Stripe answered ${r.status || "nothing"}`).slice(0, 300);
}

export interface PromoCode {
  id: string;
  code: string;
  active: boolean;
  times_redeemed: number;
  max_redemptions: number | null;
  expires_at: number | null;
  coupon: { percent_off: number | null; amount_off: number | null; valid: boolean };
}

/** Every promotion code in Stripe, newest first. */
export async function listCodes(env: Env): Promise<{ ok: true; codes: PromoCode[] } | { ok: false; error: string; permission: boolean }> {
  const codes: PromoCode[] = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const r = await stripeApi.call(env, "GET", `/promotion_codes?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
    if (r.status !== 200) return { ok: false, error: stripeWords(r), permission: noPermission(r) };
    const data: PromoCode[] = r.body?.data || [];
    codes.push(...data);
    if (!r.body?.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return { ok: true, codes };
}

export async function createCode(env: Env, plan: Extract<CodePlan, { ok: true }>, nonce: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // Stripe only refuses a repeat among active codes; the brief is "unique", so check turned-off ones too.
  const same = await stripeApi.call(env, "GET", `/promotion_codes?code=${encodeURIComponent(plan.code)}&limit=1`);
  if (same.status !== 200) return { ok: false, error: stripeWords(same) };
  if ((same.body?.data || []).length) return { ok: false, error: `${plan.code} already exists. Pick another code, or turn that one back on.` };
  const c = await stripeApi.call(env, "POST", "/coupons", plan.coupon, `mrt-code-${nonce}-coupon`);
  if (c.status !== 200 || !c.body?.id) return { ok: false, error: stripeWords(c) };
  const p = await stripeApi.call(env, "POST", "/promotion_codes", { ...plan.promo, coupon: String(c.body.id) }, `mrt-code-${nonce}-promo`);
  if (p.status !== 200 || !p.body?.id) return { ok: false, error: stripeWords(p) };
  return { ok: true, id: String(p.body.id) };
}

export async function setCodeActive(env: Env, id: string, active: boolean): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  if (!/^promo_[A-Za-z0-9]{1,64}$/.test(id)) return { ok: false, error: "That code doesn't exist." };
  const r = await stripeApi.call(env, "POST", `/promotion_codes/${id}`, { active: active ? "true" : "false" });
  if (r.status !== 200) return { ok: false, error: stripeWords(r) };
  return { ok: true, code: String(r.body?.code || id) };
}

export function ended(p: PromoCode, nowSec: number): string {
  if (p.expires_at && p.expires_at <= nowSec) return "ended: its last day has passed";
  if (p.max_redemptions && p.times_redeemed >= p.max_redemptions) return "ended: all its uses are taken";
  if (p.coupon && p.coupon.valid === false) return "ended in Stripe";
  return "";
}

export function offWords(p: PromoCode): string {
  if (p.coupon?.percent_off) return `${p.coupon.percent_off}% off each order`;
  if (p.coupon?.amount_off) return `${money(p.coupon.amount_off)} off each order`;
  return "discount set in Stripe";
}
