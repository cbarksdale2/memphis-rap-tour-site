// Our own booking tool. Stripe and email are replaced by fakes here (no network, no money).
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTour, memphisTime, takeSeats } from "../src/booking";
import { mailer } from "../src/email";
import { signPayload, stripeApi, stripeReady } from "../src/stripe";
import { BASE, csrfOf, flash, get, ip, ORIGIN, owner, post, publicPage } from "./helpers";

const E = env as any;
let calls: { method: string; path: string; params: any }[] = [];
let mails: any[] = [];
let refundFails = false;
const realCall = stripeApi.call, realSend = mailer.send;

beforeEach(() => {
  calls = []; mails = []; refundFails = false;
  E.STRIPE_SECRET_KEY = "sk_test_fake"; E.STRIPE_WEBHOOK_SECRET = "whsec_test_secret"; E.STRIPE_MODE = "test";
  stripeApi.call = async (_e, method, path, params = {}) => {
    calls.push({ method, path, params });
    if (path === "/checkout/sessions") return { status: 200, body: { id: `cs_test_${params["metadata[ref]"]}`, url: `https://checkout.stripe.com/c/pay/cs_test_${params["metadata[ref]"]}` } };
    if (path === "/refunds") return refundFails ? { status: 400, body: { error: { message: "card declined refund" } } } : { status: 200, body: { id: "re_1" } };
    if (path.startsWith("/checkout/sessions/")) return { status: 200, body: { payment_status: "unpaid" } };
    return { status: 404, body: {} };
  };
  mailer.send = async (_e, m) => { mails.push(m); return { sent: true }; };
});
afterEach(() => { stripeApi.call = realCall; mailer.send = realSend; delete E.STRIPE_SECRET_KEY; delete E.STRIPE_WEBHOOK_SECRET; });

async function tour(capacity = 5, cents = 7000, daysAhead = 10): Promise<number> {
  const at = Math.floor(Date.now() / 1000) + daysAhead * 86400 + Math.floor(Math.random() * 3600);
  const r = await env.DB.prepare("INSERT INTO tours (starts_at, capacity, price_cents, status, created_at) VALUES (?, ?, ?, 'open', unixepoch()) RETURNING id").bind(at, capacity, cents).first<{ id: number }>();
  return r!.id;
}
function checkout(id: number, seats: number, email = "rider@example.org", from = ip()) {
  return SELF.fetch(`${BASE}/tickets/${id}`, {
    method: "POST", redirect: "manual",
    headers: { ...ORIGIN, "CF-Connecting-IP": from, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ seats: String(seats), name: "Rider", email, phone: "" }),
  });
}
async function webhook(event: any, secret = "whsec_test_secret", t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  return SELF.fetch(`${BASE}/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": await signPayload(secret, body, t), "Content-Type": "application/json" }, body });
}
const paidEvent = (id: string, sessionId: string, pi = "pi_test_1", amount = 7000) => ({ id, type: "checkout.session.completed", livemode: false, data: { object: { id: sessionId, livemode: false, payment_status: "paid", payment_intent: pi, amount_total: amount, metadata: {} } } });

describe("seats", () => {
  it("never oversells: 12 people checking out at once for 5 seats get exactly 5", async () => {
    const id = await tour(5);
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => checkout(id, 1, `r${i}@example.org`)));
    expect(res.filter((r) => r.status === 303).length).toBe(5);
    expect(res.filter((r) => r.status === 400).length).toBe(7);
    const t = await getTour(env.DB, id);
    expect(t!.taken).toBe(5);
    expect(t!.left).toBe(0);
  });

  it("never oversells at the database level either (20 parallel holds of 2 on 7 seats)", async () => {
    const id = await tour(7);
    const r = await Promise.all(Array.from({ length: 20 }, () => takeSeats(env.DB, { tourId: id, seats: 2, name: "x", email: "x@example.org", phone: "", source: "site", status: "held" })));
    expect(r.filter((x) => x.ok).length).toBe(3);
    expect((await getTour(env.DB, id))!.taken).toBe(6);
  });

  it("a hold lasts 15 minutes, then the seats come back", async () => {
    const id = await tour(2);
    expect((await checkout(id, 2)).status).toBe(303);
    expect((await getTour(env.DB, id))!.left).toBe(0);
    await env.DB.prepare("UPDATE bookings SET hold_expires_at = unixepoch() - 1 WHERE tour_id = ?").bind(id).run();
    expect((await getTour(env.DB, id))!.left).toBe(2);
    expect((await checkout(id, 2)).status).toBe(303);
  });

  it("outside bookings (Viator, Eventnoire, Airbnb) share the same seat count", async () => {
    const id = await tour(5);
    const { cookie } = await owner();
    const r = await post(cookie, `/admin/tours/${id}/outside`, { source: "viator", name: "Viator group", seats: "4", note: "BR-123" }, { csrf: await csrfOf(cookie, `/admin/tours/${id}`) });
    expect(flash(r)).toContain("Seats left went down by 4");
    expect((await getTour(env.DB, id))!.left).toBe(1);
    expect((await checkout(id, 2)).status).toBe(400);
    const over = await post(cookie, `/admin/tours/${id}/outside`, { source: "airbnb", name: "Airbnb pair", seats: "2" }, { csrf: await csrfOf(cookie, `/admin/tours/${id}`) });
    expect(flash(over)).toContain("Only 1 seat is left");
    const forced = await post(cookie, `/admin/tours/${id}/outside`, { source: "airbnb", name: "Airbnb pair", seats: "2", allow_over: "1" }, { csrf: await csrfOf(cookie, `/admin/tours/${id}`) });
    expect(flash(forced)).toContain("Added Airbnb pair");
  });

  it("shows sold-out dates clearly, with no way to book them", async () => {
    const id = await tour(1);
    await takeSeats(env.DB, { tourId: id, seats: 1, name: "x", email: "", phone: "", source: "eventnoire", status: "paid" });
    const cal = await publicPage("/tickets");
    expect(cal.body).toContain("Sold out");
    expect(cal.body).not.toContain(`href="/tickets/${id}"`);
    const pg = await publicPage(`/tickets/${id}`);
    expect(pg.body).toContain("this tour is sold out");
    expect(pg.body).not.toContain('name="seats"');
  });

  it("the price comes from the tour, not the code", async () => {
    const id = await tour(5, 8500);
    expect((await publicPage(`/tickets/${id}`)).body).toContain("$85 each");
    await checkout(id, 2);
    const c = calls.find((x) => x.path === "/checkout/sessions")!;
    expect(c.params["line_items[0][price_data][unit_amount]"]).toBe(8500);
    expect(c.params["line_items[0][quantity]"]).toBe(2);
  });
});

describe("Stripe webhook", () => {
  async function paidBooking(capacity = 5) {
    const id = await tour(capacity);
    const res = await checkout(id, 2, "buyer@example.org");
    const sid = new URL(res.headers.get("Location")!).pathname.split("/").pop()!;
    return { id, sid };
  }

  it("refuses a bad signature, a wrong secret and an old timestamp", async () => {
    const { sid } = await paidBooking();
    expect((await SELF.fetch(`${BASE}/stripe/webhook`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await webhook(paidEvent("evt_bad", sid), "whsec_wrong")).status).toBe(400);
    expect((await webhook(paidEvent("evt_old", sid), undefined, Math.floor(Date.now() / 1000) - 3600)).status).toBe(400);
    const b = await env.DB.prepare("SELECT status FROM bookings WHERE stripe_session_id = ?").bind(sid).first<any>();
    expect(b.status).toBe("held");
  });

  it("confirms the booking once, emails once, and ignores repeats", async () => {
    const { sid } = await paidBooking();
    const r1 = await webhook(paidEvent("evt_1", sid));
    expect((await r1.json<any>()).outcome).toBe("paid");
    const b = await env.DB.prepare("SELECT * FROM bookings WHERE stripe_session_id = ?").bind(sid).first<any>();
    expect(b.status).toBe("paid");
    expect(b.stripe_payment_intent).toBe("pi_test_1");
    expect(b.note).toContain("TEST PAYMENT");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("buyer@example.org");
    expect(mails[0].text).toContain("Beale St & S B.B. King Blvd, outside Patio Bar");
    expect(mails[0].text).toContain("3 hours");
    expect(mails[0].text).toMatch(/\/tickets\/manage\?ref=[A-Z0-9]{6}&k=/);
    expect((await (await webhook(paidEvent("evt_1", sid))).json<any>()).outcome).toBe("duplicate");
    expect((await (await webhook(paidEvent("evt_1b", sid))).json<any>()).outcome).toBe("duplicate");
    expect(mails).toHaveLength(1);
    // the manage link in the email opens the booking
    const link = mails[0].text.match(/https:\/\/example\.com(\/tickets\/manage\?\S+)/)[1];
    expect((await publicPage(link)).body).toContain("You&#39;re booked.");
  });

  it("a payment after the hold ran out keeps the seats if they're still free", async () => {
    const { sid } = await paidBooking();
    await env.DB.prepare("UPDATE bookings SET hold_expires_at = unixepoch() - 60 WHERE stripe_session_id = ?").bind(sid).run();
    expect((await (await webhook(paidEvent("evt_late_ok", sid))).json<any>()).outcome).toBe("paid-late");
  });

  it("a payment after the hold ran out and the seats were sold is refunded automatically", async () => {
    const { id, sid } = await paidBooking(2);
    await env.DB.prepare("UPDATE bookings SET hold_expires_at = unixepoch() - 60 WHERE stripe_session_id = ?").bind(sid).run();
    await takeSeats(env.DB, { tourId: id, seats: 2, name: "walk-up", email: "", phone: "", source: "other", status: "paid" });
    const out = await (await webhook(paidEvent("evt_late_full", sid, "pi_late"))).json<any>();
    expect(out.outcome).toBe("refunded-oversold");
    expect(calls.find((c) => c.path === "/refunds")!.params.payment_intent).toBe("pi_late");
    expect((await getTour(env.DB, id))!.taken).toBe(2);
    // Stripe resends the same event: no second refund request.
    expect((await (await webhook(paidEvent("evt_late_full", sid, "pi_late"))).json<any>()).outcome).toBe("duplicate");
    expect(calls.filter((c) => c.path === "/refunds")).toHaveLength(1);
  });
});

describe("refunds from the admin", () => {
  it("cancel and refund: Stripe refunds the payment and the seats come back", async () => {
    const id = await tour(3);
    const res = await checkout(id, 2);
    const sid = new URL(res.headers.get("Location")!).pathname.split("/").pop()!;
    await webhook(paidEvent("evt_r1", sid, "pi_refund_me", 14000));
    const b = await env.DB.prepare("SELECT id FROM bookings WHERE stripe_session_id = ?").bind(sid).first<any>();
    const { cookie } = await owner();
    const r = await post(cookie, `/admin/bookings/${b.id}/cancel`, {}, { csrf: await csrfOf(cookie, `/admin/tours/${id}`) });
    expect(flash(r)).toContain("Refunded $140");
    expect(calls.filter((c) => c.path === "/refunds").at(-1)!.params.payment_intent).toBe("pi_refund_me");
    expect((await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(b.id).first<any>()).status).toBe("refunded");
    expect((await getTour(env.DB, id))!.left).toBe(3);
  });

  it("if Stripe refuses the refund, nothing changes", async () => {
    const id = await tour(3);
    const res = await checkout(id, 1);
    const sid = new URL(res.headers.get("Location")!).pathname.split("/").pop()!;
    await webhook(paidEvent("evt_r2", sid, "pi_no"));
    const b = await env.DB.prepare("SELECT id FROM bookings WHERE stripe_session_id = ?").bind(sid).first<any>();
    refundFails = true;
    const { cookie } = await owner();
    const r = await post(cookie, `/admin/bookings/${b.id}/cancel`, {}, { csrf: await csrfOf(cookie, `/admin/tours/${id}`) });
    expect(flash(r)).toContain("Nothing was changed");
    expect((await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(b.id).first<any>()).status).toBe("paid");
  });
});

describe("modes and money safety", () => {
  it("a live key is refused while live mode is off; no keys means no checkout", async () => {
    expect(stripeReady({ ...E, STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_MODE: "test" }).ok).toBe(false);
    expect(stripeReady({ ...E, STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_MODE: "test" })).toEqual({ ok: true, live: false });
    delete E.STRIPE_SECRET_KEY;
    const id = await tour(5);
    expect((await publicPage(`/tickets/${id}`)).body).toContain("Online booking opens soon");
    expect((await checkout(id, 1)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("Book goes to Acuity until cutover, and cutover refuses test mode", async () => {
    const r = await SELF.fetch(`${BASE}/go/book?from=home`, { redirect: "manual" });
    expect(r.headers.get("Location")).toBe("https://app.acuityscheduling.com/schedule.php?owner=35599844");
    const { cookie } = await owner();
    const page = await (await get(cookie, "/admin/booking-setup")).text();
    expect(page).toContain("Stripe is in test mode");
    const s = await post(cookie, "/admin/booking-setup", { mode: "own" }, { csrf: await csrfOf(cookie, "/admin/booking-setup") });
    expect(flash(s)).toContain("Not switched");
    expect((await SELF.fetch(`${BASE}/go/book`, { redirect: "manual" })).headers.get("Location")).toContain("acuityscheduling.com");
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('booking_mode', 'own')").run();
    expect((await SELF.fetch(`${BASE}/go/book`, { redirect: "manual" })).headers.get("Location")).toBe(`${BASE}/tickets`);
    await env.DB.prepare("UPDATE settings SET value = 'acuity' WHERE key = 'booking_mode'").run();
  });
});

describe("tour dates", () => {
  it("Memphis time is right on both sides of daylight saving", () => {
    expect(new Date(memphisTime("2026-11-06", "14:00")! * 1000).toISOString()).toBe("2026-11-06T20:00:00.000Z");
    expect(new Date(memphisTime("2027-07-02", "14:00")! * 1000).toISOString()).toBe("2027-07-02T19:00:00.000Z");
  });
  it("repeating dates: every Fri and Sat at 2:00 pm for 2 weeks makes 4 tours of 30 seats", async () => {
    const { cookie } = await owner();
    const start = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const r = await post(cookie, "/admin/tours/repeat", { days: ["5", "6"], time: "14:00", from: start, weeks: "2", capacity: "30", price: "70" }, { csrf: await csrfOf(cookie, "/admin/tours") });
    expect(flash(r)).toContain("Added 4 tour dates");
    const again = await post(cookie, "/admin/tours/repeat", { days: ["5", "6"], time: "14:00", from: start, weeks: "2", capacity: "30", price: "70" }, { csrf: await csrfOf(cookie, "/admin/tours") });
    expect(flash(again)).toContain("Added 0 tour dates");
    const rows = await env.DB.prepare("SELECT starts_at, capacity, price_cents FROM tours WHERE starts_at > ? ORDER BY starts_at").bind(Math.floor(Date.parse(start) / 1000)).all<any>();
    const mine = rows.results.filter((x) => x.capacity === 30);
    expect(mine.length).toBe(4);
    for (const t of mine) {
      const d = new Date(t.starts_at * 1000);
      expect(d.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" })).toMatch(/^(Fri|Sat) 2:00 PM$/);
      expect(t.price_cents).toBe(7000);
    }
  });
  it("the check-in list and spreadsheet show the riders", async () => {
    const id = await tour(5);
    await takeSeats(env.DB, { tourId: id, seats: 3, name: "Viator crew", email: "", phone: "", source: "viator", status: "paid" });
    const { cookie } = await owner();
    expect(await (await get(cookie, `/admin/tours/${id}/print`)).text()).toContain("0 of 3 riders checked in");
    const csv = await (await get(cookie, `/admin/tours/${id}.csv`)).text();
    expect(csv).toContain("Viator crew");
    expect(csv).toContain("Viator");
  });
});
