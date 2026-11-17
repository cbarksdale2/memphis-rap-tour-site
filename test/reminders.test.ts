// Reminder emails: who gets which reminder when, and never twice (src/reminders.ts).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { type Mail, mailer } from "../src/email";
import { reminderJob } from "../src/reminders";

const realSend = mailer.send;
afterEach(() => { mailer.send = realSend; });

const T = Math.floor(Date.UTC(2026, 10, 20, 19, 0) / 1000); // "now" for the job
const H = 3600, D = 86400;
let n = 0;

async function rider(startOffset: number, bookedOffset: number, opts: { status?: string; email?: string } = {}): Promise<string> {
  n++;
  const tour = await env.DB.prepare("INSERT INTO tours (starts_at, capacity, price_cents, status, created_at) VALUES (?, 30, 7000, 'closed', ?) ON CONFLICT(starts_at) DO UPDATE SET capacity = 30 RETURNING id")
    .bind(T + startOffset, T - 30 * D).first<{ id: number }>();
  const email = opts.email ?? `rider${n}@example.org`;
  await env.DB.prepare("INSERT INTO bookings (tour_id, ref, name, email, seats, source, status, created_at, paid_at) VALUES (?, ?, ?, ?, 2, 'site', ?, ?, ?)")
    .bind(tour!.id, `R${n}X`, `Rider ${n}`, email, opts.status ?? "paid", T + bookedOffset, T + bookedOffset).run();
  return email;
}

describe("reminder emails", () => {
  it("send each reminder only inside its window, skip late bookers, and never send one twice", async () => {
    const sent: Mail[] = [];
    let failFor = "";
    mailer.send = async (_e, m) => {
      await new Promise((r) => setTimeout(r, 5)); // let overlapping runs interleave
      if (m.to === failFor) return { sent: false, reason: "send failed: test" };
      sent.push(m);
      return { sent: true };
    };
    const dayBefore = await rider(23 * H, -5 * D);           // 24h window, booked long ago → 24h
    await rider(23 * H + 60, -2 * H);                          // booked 25 h before the start → 24h skipped
    const hourBefore = await rider(50 * 60, -5 * D);          // 1h window → 1h only (24h window is closed)
    await rider(50 * 60 + 60, -5 * 60);                        // booked 56 min before the start → 1h skipped
    await rider(90 * 60, -5 * D);                              // between the windows → nothing yet
    await rider(-10 * 60, -5 * D);                             // already started → never
    await rider(40 * 60, -5 * D, { status: "cancelled" });   // cancelled → never
    await rider(40 * 60 + 60, -5 * D, { email: "" });         // no email → never
    failFor = await rider(30 * 60, -5 * D);                   // first send fails, retried next run

    // Two overlapping runs at the same moment: each reminder goes out once.
    const [a, b] = await Promise.all([reminderJob(env as any, T), reminderJob(env as any, T)]);
    expect(sent.map((m) => m.to).sort()).toEqual([dayBefore, hourBefore].sort());
    expect(sent.find((m) => m.to === dayBefore)!.subject).toMatch(/^Tomorrow: /);
    expect(sent.find((m) => m.to === hourBefore)!.subject).toMatch(/^In one hour: /);
    expect(sent[0].replyTo).toBe("team@memphisraptour.com");
    expect(sent[0].text).toContain("/tickets/manage?ref=");
    expect(a.sent + b.sent).toBe(2);
    expect(a.failed + b.failed).toBe(1);
    expect(a.skipped + b.skipped).toBe(2);
    expect(a.line).toMatch(/^reminders: \d+ sent, \d+ failed, \d+ skipped; \d+ paid riders?/);

    // Next run, 10 minutes later: only the failed one is retried, and now it goes.
    failFor = "";
    const c = await reminderJob(env as any, T + 600);
    expect(c.sent).toBe(1);
    expect(sent.filter((m) => m.to === dayBefore || m.to === hourBefore)).toHaveLength(2);
    const retried = await env.DB.prepare("SELECT r.state, r.attempts FROM reminder_sends r JOIN bookings b ON b.id = r.booking_id WHERE b.ref = 'R9X'").first();
    expect(retried).toEqual({ state: "sent", attempts: 2 });

    // 23 hours later the day-before rider is inside the hour: the 1h reminder goes, still nothing twice.
    const d = await reminderJob(env as any, T + 22 * H + 10 * 60);
    expect(sent.filter((m) => m.to === dayBefore).map((m) => m.subject.split(":")[0])).toEqual(["Tomorrow", "In one hour"]);
    expect(d.sent).toBe(2); // day-before rider's 1h, and the 25h booker's 1h
    expect((await reminderJob(env as any, T + 22 * H + 20 * 60)).sent).toBe(0);
  });
});
