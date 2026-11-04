// Public booking pages: /tickets (calendar), /tickets/:id (how many + who), checkout, confirmation,
// manage link, and the Stripe webhook. Until cutover these pages work but are not linked or indexed.
import {
  bookingByRef, bookingMode, getTour, handleStripeEvent, listTours, manageToken, manageUrl, MAX_SEATS_PER_BOOKING,
  memphisDay, money, sendConfirmation, startCheckout, takeSeats, type Tour, tourWhen,
} from "./booking";
import type { Page } from "./content";
import { esc, type Env, html, ipHash, now, redirect, sameOrigin, text } from "./http";
import { layout, type RenderCtx } from "./render";
import { stripeApi, stripeReady, verifyWebhook } from "./stripe";

export const POLICY_PLACEHOLDER = "Refund and cancellation policy coming soon. Questions before you book? Email team@memphisraptour.com.";
const CHECKOUTS_PER_HOUR = 10;

function page(title: string, h1: string, path = "/tickets"): Page {
  return { slug: "tickets", path, nav_label: "Tickets", in_nav: false, title: `${title} | Memphis Rap Tour`, description: "Book a seat on the Memphis Rap Tour: pick a date, choose your tickets and pay online.", h1, intro: "", sections: [] };
}

async function respond(ctx: RenderCtx, env: Env, title: string, body: string, status = 200): Promise<Response> {
  const own = (await bookingMode(env.DB)) === "own";
  const c = { ...ctx, indexable: ctx.indexable && own };
  const out = layout(c, page(title, title), `<section class="page-head"><h1>${esc(title)}</h1></section>${body}`, { noSchema: true, noSticky: true });
  return html(out, { status, headers: { "Cache-Control": "no-store", ...(c.indexable ? {} : { "X-Robots-Tag": "noindex, nofollow" }) } });
}

function policy(ctx: RenderCtx): string {
  const p = (ctx.c.ticket as any).policy_text || POLICY_PLACEHOLDER;
  return `<p class="sub policy">${esc(p)}</p>`;
}

function seatsLine(t: Tour): string {
  if (t.left === 0) return "Sold out";
  return t.left <= 5 ? `Only ${t.left} left` : `${t.left} seats left`;
}

function dayCard(t: Tour): string {
  const sold = t.left === 0;
  const when = tourWhen(t.starts_at);
  const inner = `<span class="cal-day">${esc(when.split(",")[0])}</span><span class="cal-time">${esc(when.split(", ")[1])}</span><span class="cal-seats${sold ? " sold" : ""}">${seatsLine(t)}</span>`;
  return sold
    ? `<li class="cal-card is-sold" aria-label="${esc(when)}: sold out">${inner}</li>`
    : `<li class="cal-card"><a href="/tickets/${t.id}" aria-label="${esc(when)}: ${seatsLine(t)}">${inner}</a></li>`;
}

/** Phone: weeks you swipe through. Desktop: a month grid. Both from the same list of tours. */
export function calendar(tours: Tour[]): string {
  if (!tours.length) return `<p>No tour dates are open right now. Email <a href="mailto:team@memphisraptour.com">team@memphisraptour.com</a> and we'll tell you the next ones.</p>`;
  const weeks = new Map<string, Tour[]>();
  for (const t of tours) {
    const d = new Date(memphisDay(t.starts_at) + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // week starts Sunday
    const k = d.toISOString().slice(0, 10);
    (weeks.get(k) || weeks.set(k, []).get(k)!).push(t);
  }
  const weekHtml = [...weeks.entries()].map(([k, ts]) => {
    const label = new Date(k + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    return `<section class="cal-week" aria-label="Week of ${label}"><h3 class="label">Week of ${label}</h3><ul>${ts.map(dayCard).join("")}</ul></section>`;
  }).join("");

  const months = new Map<string, Tour[]>();
  for (const t of tours) {
    const k = memphisDay(t.starts_at).slice(0, 7);
    (months.get(k) || months.set(k, []).get(k)!).push(t);
  }
  const monthHtml = [...months.entries()].map(([k, ts]) => {
    const [y, m] = k.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells: string[] = [];
    for (let i = 0; i < first.getUTCDay(); i++) cells.push('<div class="cell empty"></div>');
    for (let d = 1; d <= days; d++) {
      const key = `${k}-${String(d).padStart(2, "0")}`;
      const here = ts.filter((t) => memphisDay(t.starts_at) === key);
      cells.push(`<div class="cell${here.length ? " has" : ""}"><span class="num">${d}</span>${here
        .map((t) => (t.left === 0 ? `<span class="slot sold">${esc(tourWhen(t.starts_at).split(", ")[1])} · Sold out</span>` : `<a class="slot" href="/tickets/${t.id}">${esc(tourWhen(t.starts_at).split(", ")[1])} · ${seatsLine(t)}</a>`))
        .join("")}</div>`);
    }
    const name = first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    return `<section class="cal-month"><h3>${name}</h3><div class="grid">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="dow">${d}</div>`).join("")}${cells.join("")}</div></section>`;
  }).join("");
  return `<div class="cal-weeks">${weekHtml}</div><div class="cal-months">${monthHtml}</div>`;
}

export async function handleTickets(req: Request, env: Env, url: URL, ctx: RenderCtx): Promise<Response | null> {
  const path = url.pathname;
  const t = ctx.c.ticket;
  const ready = stripeReady(env);

  if (path === "/tickets" && req.method === "GET") {
    const tours = await listTours(env.DB, now(), now() + 120 * 86400);
    const closedNote = ready.ok ? "" : `<p class="form-error" role="status">Online booking opens soon. Until then, <a href="${esc(t.book_url)}">book on our current booking page ›</a></p>`;
    return respond(ctx, env, "Pick a tour date", `<section class="sec">${closedNote}
<p>Every tour is ${esc(t.duration_text)} and leaves from ${esc(t.meeting_point)}. Tap a date to choose your tickets.</p>
${calendar(tours)}${policy(ctx)}</section>`);
  }

  const m = path.match(/^\/tickets\/(\d+)$/);
  if (m) {
    const tour = await getTour(env.DB, Number(m[1]));
    if (!tour || tour.status !== "open" || tour.starts_at <= now()) return respond(ctx, env, "That date isn't available", `<section class="sec"><p><a href="/tickets">See the open dates ›</a></p></section>`, 404);
    const facts = `<dl class="facts"><div class="wide"><dt class="label">When</dt><dd>${esc(tourWhen(tour.starts_at, { year: true }))} Central</dd></div>
<div><dt class="label">How long</dt><dd>${esc(t.duration_text)}</dd></div><div><dt class="label">Ticket</dt><dd>${money(tour.price_cents)} each</dd></div>
<div class="wide"><dt class="label">Meet</dt><dd>${esc(t.meeting_point)}</dd></div><div class="wide"><dt class="label">Seats</dt><dd>${seatsLine(tour)}</dd></div></dl>`;
    let error = "";
    let v: Record<string, string> = {};
    if (req.method === "POST") {
      const form = await req.formData();
      v = { seats: String(form.get("seats") || ""), name: String(form.get("name") || "").trim().slice(0, 80), email: String(form.get("email") || "").trim().slice(0, 254), phone: String(form.get("phone") || "").trim().slice(0, 30) };
      if (String(form.get("website") || "")) return redirect("/tickets");
      if (!sameOrigin(req)) error = "Please book from the form on this site.";
      else if (!ready.ok) error = "Online booking isn't switched on yet.";
      else if (!v.name) error = "Add the name the booking is under.";
      else if (!/^[^\s@<>"]{1,64}@[^\s@<>"]+\.[a-z]{2,}$/i.test(v.email)) error = "That email address doesn't look right. Your confirmation goes there.";
      else {
        const ip = await ipHash(req, env);
        const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'checkout' AND ip_hash = ? AND at > ?").bind(ip, now() - 3600).first<{ n: number }>();
        if ((n?.n ?? 0) >= CHECKOUTS_PER_HOUR) error = "Too many tries from this connection. Wait an hour, or email team@memphisraptour.com.";
        else {
          await env.DB.prepare("INSERT INTO attempts (kind, ip_hash, at) VALUES ('checkout', ?, ?)").bind(ip, now()).run();
          const hold = await takeSeats(env.DB, { tourId: tour.id, seats: Number(v.seats), name: v.name, email: v.email, phone: v.phone, source: "site", status: "held" });
          if (!hold.ok) error = hold.reason;
          else {
            const go = await startCheckout(env, url.origin, hold.booking, tour);
            if (go.ok) return redirect(go.url, 303);
            error = go.reason;
          }
        }
      }
    }
    const max = Math.min(MAX_SEATS_PER_BOOKING, tour.left);
    const form = tour.left === 0
      ? `<p class="sold-out">Sorry, this tour is sold out. <a href="/tickets">Pick another date ›</a></p>`
      : !ready.ok
        ? `<p class="form-error" role="status">Online booking opens soon. Until then, <a href="${esc(t.book_url)}">book on our current booking page ›</a></p>`
        : `${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/tickets/${tour.id}" class="signup-form">
<label>How many tickets<select name="seats">${Array.from({ length: max }, (_, i) => `<option value="${i + 1}"${String(i + 1) === (v.seats || "1") ? " selected" : ""}>${i + 1} × ${money(tour.price_cents)} = ${money(tour.price_cents * (i + 1))}</option>`).join("")}</select></label>
<label>Name for the booking<input name="name" required maxlength="80" autocomplete="name" value="${esc(v.name || "")}"></label>
<label>Email<span class="sub">Your confirmation goes here.</span><input type="email" name="email" required maxlength="254" autocomplete="email" inputmode="email" value="${esc(v.email || "")}"></label>
<label>Mobile <span class="sub">(optional, only if we need to reach you on the day)</span><input type="tel" name="phone" maxlength="30" autocomplete="tel" value="${esc(v.phone || "")}"></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button class="btn btn-gold" type="submit">Go to payment ›</button>
<p class="sub">Pay by card, Apple Pay or Google Pay on Stripe's secure page. Your seats are held for ${15} minutes while you pay.</p>
</form>`;
    return respond(ctx, env, `Tickets: ${tourWhen(tour.starts_at)}`, `<section class="sec">${facts}${form}${policy(ctx)}<p><a href="/tickets">← All dates</a></p></section>`, error ? 400 : 200);
  }

  if (path === "/tickets/done" || path === "/tickets/manage" || path === "/tickets/cancelled") {
    const ref = url.searchParams.get("ref") || "", k = url.searchParams.get("k") || "";
    let b = await bookingByRef(env, ref, k);
    if (!b) return respond(ctx, env, "We can't find that booking", `<section class="sec"><p>Check the link in your email, or write to <a href="mailto:${esc(t.email)}">${esc(t.email)}</a> with your booking reference.</p></section>`, 404);
    if (path === "/tickets/cancelled" && b.status === "held") {
      await env.DB.prepare("UPDATE bookings SET status = 'expired', note = 'left the payment page' WHERE id = ? AND status = 'held'").bind(b.id).run();
      return respond(ctx, env, "No payment taken", `<section class="sec"><p>You left the payment page, so nothing was charged and your seats were released.</p><p><a class="btn btn-gold" href="/tickets">Pick a date ›</a></p></section>`);
    }
    // If Stripe's message hasn't arrived yet, ask Stripe directly once.
    if (path === "/tickets/done" && b.status === "held" && b.stripe_session_id && ready.ok) {
      const s = await stripeApi.call(env, "GET", `/checkout/sessions/${encodeURIComponent(b.stripe_session_id)}`);
      if (s.status === 200 && s.body?.payment_status === "paid") {
        await handleStripeEvent(env, { id: `poll_${b.stripe_session_id}`, type: "checkout.session.completed", data: { object: s.body } }, (pb, pt) => sendConfirmation(env, url.origin, pb, pt, t.meeting_point, t.email));
        b = (await bookingByRef(env, ref, k))!;
      }
    }
    const tour = (await getTour(env.DB, b.tour_id))!;
    const state: Record<string, string> = {
      paid: "You're booked.",
      held: "We're confirming your payment. Refresh this page in a minute.",
      expired: "This booking wasn't paid, so the seats were released.",
      cancelled: "This booking was cancelled.",
      refunded: "This booking was cancelled and refunded.",
    };
    const title = path === "/tickets/done" && b.status === "paid" ? "You're booked" : "Your booking";
    return respond(ctx, env, title, `<section class="sec">
<p class="line1">${esc(state[b.status] || b.status)}</p>
<dl class="facts"><div class="wide"><dt class="label">Booking</dt><dd>${esc(b.ref)} · ${esc(b.name)}</dd></div>
<div class="wide"><dt class="label">When</dt><dd>${esc(tourWhen(tour.starts_at, { year: true }))} Central</dd></div>
<div><dt class="label">How long</dt><dd>${esc(t.duration_text)}</dd></div><div><dt class="label">Tickets</dt><dd>${b.seats}</dd></div>
<div class="wide"><dt class="label">Meet</dt><dd>${esc(t.meeting_point)}, Memphis, TN 38103</dd></div>
${b.status === "paid" ? `<div class="wide"><dt class="label">Paid</dt><dd>${money(b.amount_cents)}</dd></div>` : ""}</dl>
${b.status === "paid" ? `<p>Keep this page: <a href="${esc(manageUrl(url.origin, b.ref, await manageToken(env, b.ref)))}">your booking link ›</a>. ${b.email_status.startsWith("sent") ? "We also emailed it to you." : ""}</p>` : ""}
<p>To change or cancel, email <a href="mailto:${esc(t.email)}">${esc(t.email)}</a> with your booking reference.</p>
${policy(ctx)}</section>`);
  }

  if (path === "/stripe/webhook" && req.method === "POST") {
    const body = await req.text();
    if (body.length > 200_000) return text("too large", undefined, 413);
    const ok = await verifyWebhook(body, req.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET, now());
    if (!ok) return text("bad signature", undefined, 400);
    let ev: any;
    try { ev = JSON.parse(body); } catch { return text("bad json", undefined, 400); }
    const outcome = await handleStripeEvent(env, ev, (b, tour) => sendConfirmation(env, url.origin, b, tour, t.meeting_point, t.email));
    return text(JSON.stringify({ received: true, outcome }), "application/json");
  }

  return null;
}
