// Reminder emails: every paid rider with an email gets one email the day before the tour and one an hour
// before. Runs on the frequent cron (every 10 minutes). Timing rules (also in RUNBOOK.md › Reminder emails):
//
//   24h  goes out from 24 h before the start until 2 h before it. Skipped if the booking was made less than
//        27 h before the start (inside the window or less than 3 h before it opened: the confirmation just
//        went out).
//   1h   goes out from 1 h before the start until the start. Skipped if the booking was made inside that
//        last hour (the confirmation is the reminder).
//
// The two windows never overlap (24h closes 2 h before, 1h opens 1 h before), so nobody gets both at once,
// and nothing is ever sent once the tour has started. Each reminder is claimed in ONE statement before it is
// sent (a new row, or a retry of a 'failed' row), so overlapping runs cannot both send it. A failed send is
// retried on the next run while its window is still open. A claim whose result was never written (the
// Worker died mid-send) stays 'sending' and is NOT retried: once-only wins over a possible miss, and the
// admin shows it.
import { type Booking, manageToken, manageUrl, memphisDay, TZ, tourWhen } from "./booking";
import { type Content, loadVersion, pointers } from "./content";
import { mailer } from "./email";
import { type Env, now } from "./http";

export type Kind = "24h" | "1h";
export const KINDS: Kind[] = ["24h", "1h"];
const H = 3600;
/** opens/closes: seconds before the start. bookedBy: a booking made later than this before the start is skipped. */
export const WINDOWS: Record<Kind, { opens: number; closes: number; bookedBy: number }> = {
  "24h": { opens: 24 * H, closes: 2 * H, bookedBy: 27 * H },
  "1h": { opens: 1 * H, closes: 0, bookedBy: 1 * H },
};

export type Decision = "send" | "skip" | "wait";

/** What to do with one reminder for one booking right now. Pure: the whole timing rule lives here. */
export function decide(kind: Kind, startsAt: number, bookedAt: number, t: number): Decision {
  const w = WINDOWS[kind];
  if (t < startsAt - w.opens || t >= startsAt - w.closes || t >= startsAt) return "wait";
  return bookedAt > startsAt - w.bookedBy ? "skip" : "send";
}

const team = (c: Content) => c.ticket.email || "team@memphisraptour.com";

function tourTime(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).toLowerCase();
}

export function reminderMail(kind: Kind, b: Pick<Booking, "name" | "ref" | "seats">, startsAt: number, c: Content, manageLink: string, t: number): { subject: string; text: string } {
  const k = c.ticket;
  const place = [k.locality, [k.region, k.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const meet = `${k.meeting_point}${place ? `, ${place}` : ""}.`;
  const tickets = `Tickets: ${b.seats}`;
  const help = (what: string) => `${what} Reply to this email or write to ${team(c)} with your booking reference, ${b.ref}.`;
  if (kind === "24h") {
    return {
      subject: `Tomorrow: Memphis Rap Tour, ${tourWhen(startsAt)}`,
      text: [
        `Hi ${b.name},`, "",
        "See you tomorrow on the Memphis Rap Tour.", "",
        `When: ${tourWhen(startsAt, { year: true })} Central`,
        `How long: ${k.duration_text}`,
        tickets,
        `Meet: ${meet} The tour ends at the same spot.`, "",
        "You get on and off the bus at each stop, so wear comfortable shoes.", "",
        `Your booking: ${manageLink}`, "",
        help("Running late, or need to change or cancel?"), "",
        "Memphis Rap Tour",
      ].join("\n"),
    };
  }
  const today = memphisDay(t) === memphisDay(startsAt) ? " today" : "";
  return {
    subject: `In one hour: Memphis Rap Tour at ${tourTime(startsAt)}`,
    text: [
      `Hi ${b.name},`, "",
      `Your Memphis Rap Tour starts in about an hour, at ${tourTime(startsAt)}${today}.`, "",
      `Meet: ${meet}`,
      tickets,
      `How long: ${k.duration_text}. The tour ends at the same spot.`, "",
      `Your booking: ${manageLink}`, "",
      help("Running late, or can't make it?"), "",
      "See you there.",
      "Memphis Rap Tour",
    ].join("\n"),
  };
}

export interface Census { checked: number; sent: number; failed: number; skipped: number; reasons: string[]; line: string }

type Row = Booking & { starts_at: number; s24: string | null; s1: string | null };

/** One run of the reminder job. Returns (and logs) a one-line census, so a run that did nothing still shows. */
export async function reminderJob(env: Env, t = now()): Promise<Census> {
  const rows = (await env.DB.prepare(
    `SELECT b.*, t.starts_at, r24.state AS s24, r1.state AS s1
       FROM bookings b JOIN tours t ON t.id = b.tour_id
       LEFT JOIN reminder_sends r24 ON r24.booking_id = b.id AND r24.kind = '24h'
       LEFT JOIN reminder_sends r1 ON r1.booking_id = b.id AND r1.kind = '1h'
      WHERE b.status = 'paid' AND b.email <> '' AND t.starts_at > ? AND t.starts_at <= ?
      ORDER BY t.starts_at, b.id`,
  ).bind(t, t + WINDOWS["24h"].opens).all<Row>()).results;

  const c = { checked: rows.length, sent: 0, failed: 0, skipped: 0, reasons: [] as string[] };
  let content: Content | null = null;
  for (const b of rows) {
    for (const kind of KINDS) {
      const state = kind === "24h" ? b.s24 : b.s1;
      if (state && state !== "failed") continue;
      const d = decide(kind, b.starts_at, b.paid_at ?? b.created_at, t);
      if (d === "wait") continue;
      if (d === "skip") {
        const r = await env.DB.prepare("INSERT OR IGNORE INTO reminder_sends (booking_id, kind, state, detail, claimed_at, done_at) VALUES (?, ?, 'skipped', 'booked too close to the tour', ?, ?)").bind(b.id, kind, t, t).run();
        if (r.meta.changes === 1) c.skipped++;
        continue;
      }
      const claim = await env.DB.prepare(
        `INSERT INTO reminder_sends (booking_id, kind, state, attempts, claimed_at) VALUES (?, ?, 'sending', 1, ?)
         ON CONFLICT(booking_id, kind) DO UPDATE SET state = 'sending', attempts = attempts + 1, claimed_at = excluded.claimed_at, detail = ''
         WHERE reminder_sends.state = 'failed'`,
      ).bind(b.id, kind, t).run();
      if (claim.meta.changes !== 1) continue; // another run has it
      let result: { sent: true } | { sent: false; reason: string };
      try {
        if (!content) content = (await loadVersion(env.DB, (await pointers(env.DB)).published))!.content;
        if (!content.ticket.meeting_point || !content.ticket.duration_text) throw new Error("Tour info has no meeting point or length");
        const link = manageUrl(`https://${env.CANONICAL_HOST}`, b.ref, await manageToken(env, b.ref));
        const m = reminderMail(kind, b, b.starts_at, content, link, t);
        result = await mailer.send(env, { to: b.email, replyTo: team(content), subject: m.subject, text: m.text });
      } catch (e) {
        result = { sent: false, reason: String((e as Error)?.message || e).slice(0, 160) };
      }
      await env.DB.prepare("UPDATE reminder_sends SET state = ?, detail = ?, done_at = ? WHERE booking_id = ? AND kind = ?")
        .bind(result.sent ? "sent" : "failed", result.sent ? "" : result.reason, now(), b.id, kind).run();
      if (result.sent) c.sent++;
      else { c.failed++; if (!c.reasons.includes(result.reason)) c.reasons.push(result.reason); }
    }
  }
  const line = `reminders: ${c.sent} sent, ${c.failed} failed, ${c.skipped} skipped; ${c.checked} paid rider${c.checked === 1 ? "" : "s"} with an email on tours in the next 24 h${c.reasons.length ? `; failed because: ${c.reasons.join("; ")} (retried next run while the window is open)` : ""}`;
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('reminders_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`${new Date(t * 1000).toISOString()} ${line}`).run();
  (c.failed ? console.error : console.log)(line);
  return { ...c, line };
}

/** Admin words for one reminder's row. */
export function reminderWords(kind: Kind, state: string | null, detail: string | null): string {
  const name = kind === "24h" ? "day-before email" : "hour-before email";
  switch (state) {
    case "sent": return `${name} sent`;
    case "failed": return `${name} not sent: ${detail || "reason not recorded"}`;
    case "skipped": return `${name} skipped (booked close to the tour)`;
    case "sending": return `${name} started, result not recorded`;
    default: return `${name} not yet`;
  }
}
