import { describe, expect, it } from "vitest";
import { memphisTime } from "../src/booking";
import { planCode } from "../src/discounts";

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
});
