// Booking: tour dates, one shared seat count, holds during checkout, payment confirmation from Stripe.
// Overselling is prevented in the database itself: a hold or an outside booking is ONE INSERT that only
// writes when enough seats are left at that instant (D1 runs each statement atomically).
import { mailer, statusText } from "./email";
import { type Env, hmac, need, now, safeEqual } from "./http";
import { stripeApi } from "./stripe";

export const HOLD_MINUTES = 15;
export const MAX_SEATS_PER_BOOKING = 10;
export const DEFAULT_CAPACITY = 30;
export const TZ = "America/Chicago";
export const SOURCES = ["site", "viator", "eventnoire", "airbnb", "acuity", "other"] as const;
export const SOURCE_NAMES: Record<string, string> = { site: "This site", viator: "Viator", eventnoire: "Eventnoire", airbnb: "Airbnb", acuity: "Acuity", other: "Other" };

export interface Tour { id: number; starts_at: number; capacity: number; price_cents: number; status: "open" | "closed"; taken: number; left: number }
export interface Booking {
  id: number; tour_id: number; ref: string; manage_hash: string; name: string; email: string; phone: string; seats: number;
  amount_cents: number; currency: string; source: string; status: string; hold_expires_at: number | null;
  stripe_session_id: string | null; stripe_payment_intent: string | null; email_status: string; note: string;
  created_at: number; paid_at: number | null; cancelled_at: number | null; checked_in_at: number | null;
}

// ---------- time ----------

function tzOffsetMinutes(utcMs: number, tz = TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return (asUtc - utcMs) / 60000;
}

/** "2026-11-06" + "14:00" in Memphis → Unix seconds. Correct across daylight-saving changes. */
export function memphisTime(date: string, time: string): number | null {
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!d || !t) return null;
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  let ms = guess - tzOffsetMinutes(guess) * 60000;
  ms = guess - tzOffsetMinutes(ms) * 60000;
  return Math.round(ms / 1000);
}

export function tourWhen(sec: number, opts: { year?: boolean } = {}): string {
  const d = new Date(sec * 1000);
  const day = d.toLocaleDateString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", ...(opts.year ? { year: "numeric" } : {}) });
  const time = d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", " ");
  return `${day}, ${time}`;
}

export function memphisDay(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: TZ });
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}

// ---------- seats ----------

const TAKEN = `(SELECT COALESCE(SUM(b.seats), 0) FROM bookings b WHERE b.tour_id = t.id AND (b.status = 'paid' OR (b.status = 'held' AND b.hold_expires_at > ?)))`;

export async function listTours(db: D1Database, from: number, to: number, opts: { includeClosed?: boolean } = {}): Promise<Tour[]> {
  const r = await db
    .prepare(`SELECT t.*, ${TAKEN} AS taken FROM tours t WHERE t.starts_at >= ? AND t.starts_at < ? ${opts.includeClosed ? "" : "AND t.status = 'open'"} ORDER BY t.starts_at`)
    .bind(now(), from, to)
    .all<Tour>();
  return r.results.map((t) => ({ ...t, left: Math.max(0, t.capacity - t.taken) }));
}

export async function getTour(db: D1Database, id: number): Promise<Tour | null> {
  const t = await db.prepare(`SELECT t.*, ${TAKEN} AS taken FROM tours t WHERE t.id = ?`).bind(now(), id).first<Tour>();
  return t ? { ...t, left: Math.max(0, t.capacity - t.taken) } : null;
}

export function newRef(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => a[b % a.length]).join("");
}

export type HoldResult = { ok: true; booking: Booking } | { ok: false; reason: string };

/** The secret part of a booking's own link, derived from its reference so any email can carry it. */
export async function manageToken(env: Env, ref: string): Promise<string> {
  return (await hmac(need(env.UNSUB_SECRET, "UNSUB_SECRET"), `manage:${ref}`)).slice(0, 24);
}

export function manageUrl(origin: string, ref: string, token: string): string {
  return `${origin}/tickets/manage?ref=${ref}&k=${encodeURIComponent(token)}`;
}

/** Take seats: a 15-minute hold for a site checkout, or a paid outside booking. Never more than are left. */
export async function takeSeats(db: D1Database, p: { tourId: number; seats: number; name: string; email: string; phone: string; source: string; status: "held" | "paid"; amountCents?: number; allowOver?: boolean; note?: string }): Promise<HoldResult> {
  if (!Number.isInteger(p.seats) || p.seats < 1) return { ok: false, reason: "Choose how many tickets." };
  if (p.source === "site" && p.seats > MAX_SEATS_PER_BOOKING) return { ok: false, reason: `Book up to ${MAX_SEATS_PER_BOOKING} tickets at once. For a bigger group, ask about a private tour.` };
  const t = now();
  const ref = newRef();
  const hold = p.status === "held" ? t + HOLD_MINUTES * 60 : null;
  const tour = await getTour(db, p.tourId);
  if (!tour) return { ok: false, reason: "That tour date doesn't exist." };
  const amount = p.amountCents ?? tour.price_cents * p.seats;
  const res = await db
    .prepare(
      `INSERT INTO bookings (tour_id, ref, manage_hash, name, email, phone, seats, amount_cents, source, status, hold_expires_at, note, created_at, paid_at)
       SELECT t.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM tours t
        WHERE t.id = ? AND (? = 1 OR (t.status = 'open' AND t.starts_at > ?))
          AND (? = 1 OR t.capacity - ${TAKEN} >= ?)`,
    )
    .bind(ref, "", p.name, p.email, p.phone, p.seats, amount, p.source, p.status, hold, p.note || "", t, p.status === "paid" ? t : null,
      p.tourId, p.source === "site" ? 0 : 1, t, p.allowOver ? 1 : 0, t, p.seats)
    .run();
  if (res.meta.changes !== 1) {
    if (tour.status !== "open") return { ok: false, reason: "This tour date is closed." };
    if (tour.starts_at <= t) return { ok: false, reason: "This tour has already started." };
    return { ok: false, reason: tour.left === 0 ? "Sorry, this tour is sold out." : `Only ${tour.left} ${tour.left === 1 ? "seat is" : "seats are"} left on this tour.` };
  }
  const booking = await db.prepare("SELECT * FROM bookings WHERE ref = ?").bind(ref).first<Booking>();
  return { ok: true, booking: booking! };
}

export async function bookingByRef(env: Env, ref: string, token: string): Promise<Booking | null> {
  const r = ref.toUpperCase().slice(0, 12);
  if (!token || !safeEqual(token, await manageToken(env, r))) return null;
  return env.DB.prepare("SELECT * FROM bookings WHERE ref = ?").bind(r).first<Booking>();
}

// ---------- Stripe ----------

export async function startCheckout(env: Env, origin: string, b: Booking, tour: Tour): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const q = `ref=${b.ref}&k=${encodeURIComponent(await manageToken(env, b.ref))}`;
  const r = await stripeApi.call(env, "POST", "/checkout/sessions", {
    mode: "payment",
    success_url: `${origin}/tickets/done?${q}`,
    cancel_url: `${origin}/tickets/cancelled?${q}`,
    customer_email: b.email || undefined,
    client_reference_id: b.ref,
    "metadata[booking_id]": b.id,
    "metadata[ref]": b.ref,
    "payment_intent_data[metadata][booking_id]": b.id,
    "payment_intent_data[metadata][ref]": b.ref,
    "line_items[0][quantity]": b.seats,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": tour.price_cents,
    "line_items[0][price_data][product_data][name]": `Memphis Rap Tour: ${tourWhen(tour.starts_at, { year: true })} Central`,
    expires_at: now() + 30 * 60, // Stripe's shortest; a late payment after our 15-minute hold is re-checked in the webhook
  }, `checkout-${b.ref}`);
  if (r.status !== 200 || !r.body?.url) {
    await env.DB.prepare("UPDATE bookings SET status = 'expired', note = ? WHERE id = ? AND status = 'held'").bind(`checkout not started: ${r.body?.error?.message || r.status}`.slice(0, 200), b.id).run();
    return { ok: false, reason: "Online payment isn't available right now. Please try again shortly." };
  }
  await env.DB.prepare("UPDATE bookings SET stripe_session_id = ? WHERE id = ?").bind(r.body.id, b.id).run();
  return { ok: true, url: r.body.url };
}

export function confirmationText(b: Booking, tour: Tour, meeting: string, manageLink: string, teamEmail: string): string {
  return [
    `Hi ${b.name},`,
    "",
    `You're booked on the Memphis Rap Tour.`,
    "",
    `Booking: ${b.ref}`,
    `When: ${tourWhen(tour.starts_at, { year: true })} Central`,
    `How long: 3 hours`,
    `Tickets: ${b.seats}`,
    `Paid: ${money(b.amount_cents)}`,
    `Meet: ${meeting}, Memphis, TN 38103. The tour ends at the same spot.`,
    "",
    `Your booking: ${manageLink}`,
    "",
    `Questions? Reply to this email or write to ${teamEmail}.`,
    "",
    "Memphis Rap Tour",
  ].join("\n");
}

export type WebhookOutcome = "duplicate" | "ignored" | "paid" | "paid-late" | "refunded-oversold" | "expired" | "refunded" | "unknown-booking";

/**
 * Handle one verified Stripe event. Idempotent: the event id is recorded first, so a repeat does nothing.
 * `onPaid` sends the confirmation email (kept outside so the event is recorded before any email).
 */
export async function handleStripeEvent(env: Env, ev: any, onPaid: (b: Booking, tour: Tour) => Promise<void>): Promise<WebhookOutcome> {
  const db = env.DB;
  const first = await db.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").bind(String(ev.id), String(ev.type), now()).run();
  if (first.meta.changes !== 1) return "duplicate";
  const obj = ev.data?.object || {};
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    if (obj.payment_status !== "paid") return "ignored";
    const b = await db.prepare("SELECT * FROM bookings WHERE stripe_session_id = ? OR id = ?").bind(String(obj.id), Number(obj.metadata?.booking_id) || -1).first<Booking>();
    if (!b) return "unknown-booking";
    if (b.status === "paid") return "duplicate";
    const t = now();
    // Normal case: the hold is still ours. Late case: the hold ran out, so the seats are taken back only if still free.
    const upd = await db
      .prepare(
        `UPDATE bookings SET status = 'paid', paid_at = ?, stripe_payment_intent = ?, amount_cents = COALESCE(?, amount_cents)
          WHERE id = ? AND (status = 'held' AND hold_expires_at > ?
             OR status IN ('held','expired') AND (SELECT t.capacity - ${TAKEN.replace("b.tour_id = t.id", "b.tour_id = t.id AND b.id != bookings.id")} FROM tours t WHERE t.id = bookings.tour_id) >= bookings.seats)`,
      )
      .bind(t, obj.payment_intent || null, obj.amount_total ?? null, b.id, t, t)
      .run();
    const tour = (await getTour(db, b.tour_id))!;
    if (upd.meta.changes === 1) {
      if (obj.livemode === false) await db.prepare("UPDATE bookings SET note = TRIM(note || ' TEST PAYMENT: no real money') WHERE id = ?").bind(b.id).run();
      const paid = (await db.prepare("SELECT * FROM bookings WHERE id = ?").bind(b.id).first<Booking>())!;
      await onPaid(paid, tour);
      return b.status === "held" && (b.hold_expires_at ?? 0) > t ? "paid" : "paid-late";
    }
    // The seats went to someone else while this person was paying: give the money back at once.
    const r = await stripeApi.call(env, "POST", "/refunds", { payment_intent: obj.payment_intent, "metadata[reason]": "seats no longer available" }, `oversold-${b.id}`);
    await db.prepare("UPDATE bookings SET status = 'refunded', stripe_payment_intent = ?, cancelled_at = ?, note = ? WHERE id = ?")
      .bind(obj.payment_intent || null, t, r.status === 200 ? "paid after the hold ran out and the tour had filled; refunded automatically" : `NEEDS A REFUND BY HAND: automatic refund failed (${r.body?.error?.message || r.status})`, b.id)
      .run();
    return "refunded-oversold";
  }
  if (ev.type === "checkout.session.expired") {
    await db.prepare("UPDATE bookings SET status = 'expired' WHERE stripe_session_id = ? AND status = 'held'").bind(String(obj.id)).run();
    return "expired";
  }
  if (ev.type === "charge.refunded") {
    const pi = String(obj.payment_intent || "");
    if (!pi) return "ignored";
    await db.prepare("UPDATE bookings SET status = 'refunded', cancelled_at = COALESCE(cancelled_at, ?) WHERE stripe_payment_intent = ? AND status = 'paid'").bind(now(), pi).run();
    return "refunded";
  }
  return "ignored";
}

/** Cancel a booking from the admin. A paid site booking is refunded through Stripe first. */
export async function cancelBooking(env: Env, id: number): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first<Booking>();
  if (!b) return { ok: false, text: "That booking doesn't exist." };
  if (b.status === "cancelled" || b.status === "refunded") return { ok: false, text: "That booking is already cancelled." };
  if (b.source === "site" && b.status === "paid") {
    if (!b.stripe_payment_intent) return { ok: false, text: "This booking has no Stripe payment on record, so it can't be refunded here. Check Stripe." };
    const r = await stripeApi.call(env, "POST", "/refunds", { payment_intent: b.stripe_payment_intent, "metadata[booking_id]": b.id }, `refund-${b.id}`);
    if (r.status !== 200) return { ok: false, text: `Stripe didn't make the refund (${r.body?.error?.message || r.status}). Nothing was changed.` };
    await env.DB.prepare("UPDATE bookings SET status = 'refunded', cancelled_at = ? WHERE id = ?").bind(now(), id).run();
    return { ok: true, text: `Refunded ${money(b.amount_cents)} to ${b.name} and freed ${b.seats} seat${b.seats === 1 ? "" : "s"}.` };
  }
  await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(now(), id).run();
  return { ok: true, text: b.source === "site" ? `Released ${b.name}'s unpaid hold.` : `Cancelled ${b.name}'s ${SOURCE_NAMES[b.source] || b.source} booking and freed ${b.seats} seat${b.seats === 1 ? "" : "s"}. Refund them on ${SOURCE_NAMES[b.source] || "that site"} if needed.` };
}

export async function sendConfirmation(env: Env, origin: string, b: Booking, tour: Tour, meeting: string, teamEmail: string): Promise<void> {
  if (!b.email) return;
  const manage = manageUrl(origin, b.ref, await manageToken(env, b.ref));
  const r = await mailer.send(env, { to: b.email, replyTo: teamEmail, subject: `You're booked: Memphis Rap Tour, ${tourWhen(tour.starts_at)}`, text: confirmationText(b, tour, meeting, manage, teamEmail) });
  await env.DB.prepare("UPDATE bookings SET email_status = ? WHERE id = ?").bind(statusText(r), b.id).run();
}

// ---------- settings ----------

export async function getSetting(db: D1Database, key: string, dflt = ""): Promise<string> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? dflt;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** "acuity" until cutover, then "own". */
export async function bookingMode(db: D1Database): Promise<"acuity" | "own"> {
  return (await getSetting(db, "booking_mode", "acuity")) === "own" ? "own" : "acuity";
}
