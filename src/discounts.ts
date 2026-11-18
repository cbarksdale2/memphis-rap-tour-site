// Discount codes. Stripe is the source of truth for the code itself (a coupon plus its promotion code); the
// site keeps only which tour dates a code works on (D1 code_dates, no rows = every date). Riders type the code
// on the site's ticket form; the site checks it (decideCode) and opens Stripe Checkout with it applied.
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

// ---------------- which tour dates a code works on ----------------

export interface DateOnly { id: number; starts_at: number }

export async function codeDates(db: D1Database): Promise<Map<string, DateOnly[]>> {
  const r = await db.prepare("SELECT d.promotion_code_id AS pid, t.id, t.starts_at FROM code_dates d JOIN tours t ON t.id = d.tour_id ORDER BY t.starts_at").all<{ pid: string; id: number; starts_at: number }>();
  const m = new Map<string, DateOnly[]>();
  for (const x of r.results) (m.get(x.pid) || m.set(x.pid, []).get(x.pid)!).push({ id: x.id, starts_at: x.starts_at });
  return m;
}

export async function datesFor(db: D1Database, promoId: string): Promise<DateOnly[]> {
  const r = await db.prepare("SELECT t.id, t.starts_at FROM code_dates d JOIN tours t ON t.id = d.tour_id WHERE d.promotion_code_id = ? ORDER BY t.starts_at").bind(promoId).all<DateOnly>();
  return r.results;
}

/** Replaces a code's date rule. An empty list = every date. */
export async function setDates(db: D1Database, promoId: string, tourIds: number[], at: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM code_dates WHERE promotion_code_id = ?").bind(promoId),
    ...tourIds.map((id) => db.prepare("INSERT OR IGNORE INTO code_dates (promotion_code_id, tour_id, created_at) VALUES (?, ?, ?)").bind(promoId, id, at)),
  ]);
}

const dayWords = (sec: number) => tourWhen(sec).split(",")[0];

/** "Sat 21 Nov and Sat 28 Nov"; only dates still to come; long lists are shortened. */
export function datesWords(dates: DateOnly[], nowSec: number, max = 6): string {
  const days = [...new Set(dates.filter((d) => d.starts_at > nowSec).map((d) => dayWords(d.starts_at)))];
  if (!days.length) return "";
  if (days.length > max) return `${days.slice(0, max).join(", ")} and ${days.length - max} more date${days.length - max === 1 ? "" : "s"}`;
  return days.length === 1 ? days[0] : `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
}

export function ruleWords(dates: DateOnly[], nowSec: number): string {
  if (!dates.length) return "Every date";
  const w = datesWords(dates, nowSec);
  return w ? `Only ${w}` : "Only dates that have passed (works on no date now)";
}

export type CodeDecision = { ok: true; promoId: string; code: string } | { ok: false; message: string };

/**
 * May this code be used on this tour date? Pure: the promotion code comes from Stripe, the date rule from D1.
 * The date rule is checked before the code's state so a rider on the wrong date learns which dates it fits.
 */
export function decideCode(promo: PromoCode | null, tourId: number, rule: DateOnly[], nowSec: number): CodeDecision {
  if (!promo) return { ok: false, message: "We don't know that code. Check the spelling, or clear the code box to pay full price." };
  if (rule.length && !rule.some((d) => d.id === tourId)) {
    const w = datesWords(rule, nowSec);
    return { ok: false, message: w ? `This code works only on ${w}. Pick one of those dates, or clear the code box to pay full price.` : "This code doesn't work on any date that's still open. Clear the code box to pay full price." };
  }
  if (promo.expires_at && promo.expires_at <= nowSec) return { ok: false, message: "That code has ended. Clear the code box to pay full price." };
  if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) return { ok: false, message: "That code has been used up. Clear the code box to pay full price." };
  if (!promo.active || promo.coupon?.valid === false) return { ok: false, message: "That code isn't working right now. Clear the code box to pay full price." };
  return { ok: true, promoId: promo.id, code: promo.code };
}

/** Looks the typed code up in Stripe (an active one first) and decides with the date rule. */
export async function checkCode(env: Env, typed: string, tourId: number, nowSec: number): Promise<CodeDecision> {
  const code = typed.replace(/\s+/g, "").toUpperCase();
  if (!CODE_RE.test(code)) return decideCode(null, tourId, [], nowSec);
  const r = await stripeApi.call(env, "GET", `/promotion_codes?code=${encodeURIComponent(code)}&limit=10`);
  if (r.status !== 200) return { ok: false, message: "We couldn't check codes just now. Try again in a minute, or clear the code box to pay full price." };
  const found: PromoCode[] = (r.body?.data || []).filter((p: PromoCode) => String(p.code).toUpperCase() === code);
  const promo = found.find((p) => p.active) || found[0] || null;
  return decideCode(promo, tourId, promo ? await datesFor(env.DB, promo.id) : [], nowSec);
}
