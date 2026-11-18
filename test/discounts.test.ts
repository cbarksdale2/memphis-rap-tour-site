import { describe, expect, it } from "vitest";
import { type Booking, checkoutParams, memphisTime, type Tour } from "../src/booking";
import { decideCode, planCode, type PromoCode } from "../src/discounts";

// Discount codes are real money off live tickets: the form must refuse a bad code and build exactly the
// Stripe coupon + promotion code the owner asked for (codes and prices are the owner's, risk.md).
describe("discount codes", () => {
  it("refuses bad input and builds the Stripe coupon and promotion code the owner asked for", () => {
    const nowSec = memphisTime("2026-11-18", "12:00")!;
    const opts = { maxAmountCents: 7000, nowSec };
    const base = { code: " summer15 ", kind: "amount", value: "15", maxUses: "", lastDay: "" };
    const err = (over: Partial<typeof base>) => {
      const r = planCode({ ...base, ...over }, opts);
      return r.ok ? "" : r.error;
    };

    // Refused, each with words the owner can act on.
    expect(err({ code: "AB" })).toMatch(/3 to 20 letters or numbers/);
    expect(err({ code: "SUMMER 15" })).toMatch(/letters or numbers/);
    expect(err({ code: "SUMMER-15" })).toMatch(/letters or numbers/);
    expect(err({ value: "70.01" })).toMatch(/more than the ticket price \(\$70\)/);
    expect(err({ value: "0" })).toMatch(/amount like/);
    expect(err({ kind: "percent", value: "0" })).toMatch(/1 to 100/);
    expect(err({ kind: "percent", value: "101" })).toMatch(/1 to 100/);
    expect(err({ kind: "free" })).toMatch(/Pick \$ off or % off/);
    expect(err({ maxUses: "0" })).toMatch(/Most uses/);
    expect(err({ lastDay: "2026-11-17" })).toMatch(/today or later/);

    // $ off, no limits: once per order, in cents, USD, capitals; the edge (the full ticket price) is allowed.
    const a = planCode(base, opts);
    expect(a).toEqual({
      ok: true,
      code: "SUMMER15",
      coupon: { duration: "once", name: "SUMMER15", "metadata[made_by]": "site admin", amount_off: 1500, currency: "usd" },
      promo: { code: "SUMMER15", "metadata[made_by]": "site admin" },
      words: "SUMMER15: $15 off each order",
    });
    expect(planCode({ ...base, value: "$70" }, opts).ok).toBe(true);

    // % off with a use limit and a last day: the code works until 11:59:59 pm Central on that day.
    const p = planCode({ ...base, code: "memphis20", kind: "percent", value: "20", maxUses: "25", lastDay: "2027-01-31" }, opts);
    if (!p.ok) throw new Error(p.error);
    expect(p.coupon).toEqual({ duration: "once", name: "MEMPHIS20", "metadata[made_by]": "site admin", percent_off: 20 });
    expect(p.promo).toEqual({ code: "MEMPHIS20", "metadata[made_by]": "site admin", max_redemptions: 25, expires_at: memphisTime("2027-02-01", "00:00")! - 1 });
    expect(p.words).toBe("MEMPHIS20: 20% off each order, up to 25 uses, works until Sun 31 Jan 2027, Central");
    // Today is still allowed: it ends tonight.
    expect(planCode({ ...base, lastDay: "2026-11-18" }, opts).ok).toBe(true);
  });

  it("a code works only on its chosen dates, and checkout gets it as a discount with Stripe's own code box off", () => {
    const nowSec = memphisTime("2026-11-18", "12:00")!;
    const fri = { id: 1, starts_at: memphisTime("2026-11-20", "14:00")! };
    const sat = { id: 2, starts_at: memphisTime("2026-11-21", "14:00")! };
    const sat2 = { id: 3, starts_at: memphisTime("2026-11-28", "14:00")! };
    const past = { id: 4, starts_at: memphisTime("2026-11-14", "14:00")! };
    const promo: PromoCode = { id: "promo_X", code: "SPRING10", active: true, times_redeemed: 0, max_redemptions: null, expires_at: null, coupon: { amount_off: 1000, percent_off: null, valid: true } };
    const say = (p: PromoCode | null, tourId: number, rule: typeof fri[]) => { const d = decideCode(p, tourId, rule, nowSec); return d.ok ? `ok ${d.promoId}` : d.message; };

    // No rule = every date; a rule = only those dates, and the rider is told which (future ones only).
    expect(say(promo, fri.id, [])).toBe("ok promo_X");
    expect(say(promo, sat.id, [sat, sat2])).toBe("ok promo_X");
    expect(say(promo, fri.id, [past, sat, sat2])).toBe("This code works only on Sat 21 Nov and Sat 28 Nov. Pick one of those dates, or clear the code box to pay full price.");
    expect(say(promo, fri.id, [past])).toMatch(/doesn't work on any date that's still open/);
    // The code's own state, from Stripe.
    expect(say(null, fri.id, [])).toMatch(/We don't know that code/);
    expect(say({ ...promo, active: false }, fri.id, [])).toMatch(/isn't working right now/);
    expect(say({ ...promo, coupon: { ...promo.coupon, valid: false } }, fri.id, [])).toMatch(/isn't working right now/);
    expect(say({ ...promo, expires_at: nowSec - 1 }, fri.id, [])).toMatch(/has ended/);
    expect(say({ ...promo, max_redemptions: 3, times_redeemed: 3 }, fri.id, [])).toMatch(/used up/);
    expect(say({ ...promo, max_redemptions: 3, times_redeemed: 2 }, fri.id, [])).toBe("ok promo_X");

    // The Checkout session: the checked code goes in as discounts[0]; Stripe's code box is never on
    // (a code typed there would skip the date check). No code = no discount at all.
    const b = { id: 9, ref: "ABC123", email: "rider@example.org", seats: 2 } as Booking;
    const tour = { id: fri.id, starts_at: fri.starts_at, price_cents: 7000 } as Tour;
    const withCode = checkoutParams("https://x", "ref=ABC123&k=k", b, tour, "promo_X");
    expect(withCode["discounts[0][promotion_code]"]).toBe("promo_X");
    expect(withCode).not.toHaveProperty("allow_promotion_codes");
    const without = checkoutParams("https://x", "ref=ABC123&k=k", b, tour);
    expect(without["discounts[0][promotion_code]"]).toBeUndefined();
    expect(without).not.toHaveProperty("allow_promotion_codes");
    expect(without["line_items[0][price_data][unit_amount]"]).toBe(7000);
  });
});
