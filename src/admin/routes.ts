// Every /admin route. Each one checks who is asking; every POST checks CSRF; owner-only actions check the role.
import {
  attemptLogin, type Auth, createSession, csrfOk, endAllSessions, endSession, getAuth, hashPassword, LOGIN_CSRF_COOKIE,
  loginBlocked, loginCsrfOk, makeRecoveryCodes, passwordProblem, recordFail, recoverWithCode, recoveryCodesLeft, SESSION_COOKIE,
  SESSION_DAYS, sessionCookie, verifyPassword,
} from "../auth";
import {
  bookingMode, cancelBooking, DEFAULT_CAPACITY, getTour, listTours, memphisDay, memphisTime, money, setSetting, SOURCE_NAMES,
  SOURCES, takeSeats, type Booking, tourWhen,
} from "../booking";
import { mailer } from "../email";
import { ipHash, sha256Hex } from "../http";
import { stripeReady } from "../stripe";
import {
  BLOCK_TYPES, BLOCKS, type BlockType, type Content, defaultBlockData, findPage, findSection, loadDraft, loadVersion,
  newId, pointers, publishDraft, restoreVersion, saveDraft,
} from "../content";
import { adminDate, esc, type Env, html, now, randomToken, redirect, text } from "../http";
import { checkUpload, dropBytes, listImages, newImageId, storeImage, usage } from "../images";
import { plain, safeHref, tokens } from "../markup";
import { imageUrl, type RenderCtx } from "../render";
import { csvCell, dayKey, unsubUrl } from "../subscribe";
import { check, confirmRemove, csrf, field, frame, postButton, row } from "./ui";

type Ctx = { req: Request; env: Env; url: URL; auth: Auth };
type Handler = (c: Ctx, m: RegExpMatchArray) => Promise<Response>;


export async function audit(db: D1Database, userId: number | null, action: string, detail = ""): Promise<void> {
  await db.prepare("INSERT INTO audit (at, user_id, action, detail) VALUES (?, ?, ?, ?)").bind(now(), userId, action, detail.slice(0, 300)).run();
}

async function unpublishedCount(db: D1Database): Promise<number> {
  const p = await pointers(db);
  if (p.draft === p.published) return 0;
  const r = await db.prepare("SELECT COUNT(*) AS n FROM versions WHERE id > ? AND id <= ?").bind(p.published, p.draft).first<{ n: number }>();
  return Math.max(1, r?.n ?? 1);
}

async function page(c: Ctx, f: Omit<Parameters<typeof frame>[0], "auth" | "unpublished">, body: string): Promise<Response> {
  return frame({ ...f, auth: c.auth, unpublished: await unpublishedCount(c.env.DB) }, body);
}

function flashFrom(url: URL): { kind: "ok" | "err"; text: string } | null {
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  if (ok) return { kind: "ok", text: ok.slice(0, 200) };
  if (err) return { kind: "err", text: err.slice(0, 200) };
  return null;
}

const back = (to: string, msg: string, kind: "ok" | "err" = "ok", hash = "") =>
  redirect(`${to}${to.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}${hash ? "#" + hash : ""}`);

function forbidden(): Response {
  return html("<!doctype html><title>Not allowed</title><p>Only the owner can do that.</p><p><a href=\"/admin\">← Back to the admin</a></p>", { status: 403, admin: true });
}

function ownerOnly(c: Ctx): Response | null {
  return c.auth.user.role === "owner" ? null : forbidden();
}

/** Link fields may be a web or email address, a page on this site, or a {token} that fills one in. */
function cleanLink(v: string, content: Content): string | null {
  const t = v.trim();
  if (!t) return "";
  return safeHref(plain(t, tokens(content))) ? t : null;
}

// ---------------- sign in / out ----------------

export async function loginPage(req: Request, env: Env, message = "", status = 200, email = ""): Promise<Response> {
  const lc = randomToken(18);
  const url = new URL(req.url);
  const done = url.searchParams.get("ok");
  return frame(
    { auth: null, title: "Sign in", status, headers: { "Set-Cookie": `${LOGIN_CSRF_COOKIE}=${lc}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600` } },
    `<h1>Memphis Rap Tour admin</h1>
${done ? `<p class="flash flash-ok" role="status">${esc(done)}</p>` : ""}
${message ? `<p class="flash flash-err" role="alert">${esc(message)}</p>` : ""}
<form method="post" action="/admin/login" class="card stack">
<input type="hidden" name="lc" value="${lc}">
${field("email", "Email", email || "team@memphisraptour.com", { type: "email", required: true, autocomplete: "username" })}
${field("password", "Password", "", { type: "password", required: true, autocomplete: "current-password" })}
<button class="btn btn-green btn-wide" type="submit">Sign in ›</button>
</form>
<p class="sub">Forgot the password? <a href="/admin/forgot">Email a reset link ›</a> or <a href="/admin/recover">use a recovery code ›</a></p>`,
  );
}

async function recoverPage(req: Request, env: Env, message = "", status = 200): Promise<Response> {
  const lc = randomToken(18);
  return frame(
    { auth: null, title: "Use a recovery code", status, back: { href: "/admin/login", label: "Back to sign in" }, headers: { "Set-Cookie": `${LOGIN_CSRF_COOKIE}=${lc}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600` } },
    `<h1>Use a recovery code</h1>
<p>Type one of the 10 codes you saved when you first signed in, and choose a new password. Each code works once.</p>
${message ? `<p class="flash flash-err" role="alert">${esc(message)}</p>` : ""}
<form method="post" action="/admin/recover" class="card stack">
<input type="hidden" name="lc" value="${lc}">
${field("email", "Email", "", { type: "email", required: true, autocomplete: "username" })}
${field("code", "Recovery code", "", { required: true, autocomplete: "one-time-code", hint: "Looks like abcde-12345" })}
${field("new_password", "New password", "", { type: "password", required: true, autocomplete: "new-password", hint: "At least 12 characters." })}
<button class="btn btn-green btn-wide" type="submit">Set password and sign in ›</button>
</form>`,
  );
}

function lcCookie(lc: string) {
  return { "Set-Cookie": `${LOGIN_CSRF_COOKIE}=${lc}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600` };
}

/** Forgot password: a single-use link, valid 30 minutes, emailed to the account's own address. */
async function forgot(req: Request, env: Env, url: URL): Promise<Response> {
  const lc = randomToken(18);
  const shell = (msg: string, status = 200) =>
    frame({ auth: null, title: "Forgot the password", status, back: { href: "/admin/login", label: "Back to sign in" }, headers: lcCookie(lc) }, `
<h1>Forgot the password</h1>
${msg}
<form method="post" action="/admin/forgot" class="card stack"><input type="hidden" name="lc" value="${lc}">
${field("email", "Email", "team@memphisraptour.com", { type: "email", required: true, autocomplete: "username" })}
<button class="btn btn-green btn-wide" type="submit">Email me a reset link ›</button></form>
<p class="sub">No email? <a href="/admin/recover">Use a recovery code ›</a></p>`);
  if (req.method !== "POST") return shell("<p>We email a link to the account's address. It works once, for 30 minutes.</p>");
  const form = await req.formData();
  if (!loginCsrfOk(req, form)) return shell('<p class="flash flash-err">The form expired. Try again.</p>', 403);
  const email = String(form.get("email") || "").trim().toLowerCase();
  const ip = await ipHash(req, env);
  const blocked = await loginBlocked(env, ip, email);
  if (blocked) return shell(`<p class="flash flash-err">${esc(blocked)}</p>`, 429);
  await recordFail(env, ip, email); // each request counts toward the limit, so this can't be used to flood the inbox
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ? AND disabled = 0").bind(email).first<{ id: number; email: string }>();
  if (!env.EMAIL) return shell('<p class="flash flash-gap">Email isn\'t set up for this site yet, so no link can be sent. Use a recovery code instead.</p>');
  if (user) {
    const token = randomToken(32);
    await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), user.id, now() + 30 * 60).run();
    const r = await mailer.send(env, { to: user.email, subject: "Reset the Memphis Rap Tour admin password", text: `Someone asked to reset the admin password.\n\nSet a new one here (works once, for 30 minutes):\n${url.origin}/admin/reset?t=${token}\n\nIf it wasn't you, ignore this email; nothing changes.` });
    await audit(env.DB, user.id, "Asked for a password reset link", r.sent ? "emailed" : r.reason);
  }
  return shell('<p class="flash flash-ok">If that email has an account, a reset link is on its way. Check the inbox in a minute.</p>');
}

async function resetPw(req: Request, env: Env, url: URL): Promise<Response> {
  const token = String(url.searchParams.get("t") || "");
  const row = token ? await env.DB.prepare("SELECT * FROM password_resets WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ token_hash: string; user_id: number; expires_at: number; used_at: number | null }>() : null;
  const dead = !row || row.used_at || row.expires_at < now();
  const lc = randomToken(18);
  const shell = (msg: string, status = 200) =>
    frame({ auth: null, title: "Set a new password", status, headers: lcCookie(lc) }, `<h1>Set a new password</h1>${msg}
${dead ? '<p><a class="btn" href="/admin/forgot">Ask for a new link ›</a></p>' : `<form method="post" action="/admin/reset?t=${esc(token)}" class="card stack"><input type="hidden" name="lc" value="${lc}">
${field("new_password", "New password", "", { type: "password", required: true, autocomplete: "new-password", hint: "At least 12 characters." })}
<button class="btn btn-green btn-wide" type="submit">Save and sign in ›</button></form>`}`);
  if (dead) return shell('<p class="flash flash-err">This link has expired or was already used.</p>', 400);
  if (req.method !== "POST") return shell("");
  const form = await req.formData();
  if (!loginCsrfOk(req, form)) return shell('<p class="flash flash-err">The form expired. Try again.</p>', 403);
  const pw = String(form.get("new_password") || "");
  const problem = passwordProblem(pw);
  if (problem) return shell(`<p class="flash flash-err">${esc(problem)}</p>`, 400);
  const used = await env.DB.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now(), row!.token_hash).run();
  if (used.meta.changes !== 1) return shell('<p class="flash flash-err">This link was already used.</p>', 400);
  await env.DB.prepare("UPDATE users SET pw_hash = ?, must_change = 0, updated_at = ? WHERE id = ?").bind(await hashPassword(pw), now(), row!.user_id).run();
  await endAllSessions(env.DB, row!.user_id);
  await audit(env.DB, row!.user_id, "Set a new password from an emailed link");
  const { token: st } = await createSession(env.DB, row!.user_id, req);
  return redirect("/admin?ok=" + encodeURIComponent("New password saved. You are signed in."), 303, { "Set-Cookie": sessionCookie(st, SESSION_DAYS * 86400) });
}

export async function handleAdmin(req: Request, env: Env, url: URL, renderPreview: (ctx: Partial<RenderCtx>, path: string) => Promise<Response>): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/admin";
  const method = req.method;

  // --- open routes ---
  if (path === "/admin/login") {
    if (method === "GET") return (await getAuth(req, env)) ? redirect("/admin") : loginPage(req, env);
    if (method === "POST") {
      const form = await req.formData();
      if (!loginCsrfOk(req, form)) return loginPage(req, env, "The sign-in form expired. Try again.", 403);
      const email = String(form.get("email") || "");
      const r = await attemptLogin(req, env, email, String(form.get("password") || ""));
      if (!r.ok) return loginPage(req, env, r.message, r.status, email);
      await audit(env.DB, r.user.id, "Signed in");
      return redirect(r.user.must_change ? "/admin/password" : "/admin", 303, { "Set-Cookie": sessionCookie(r.token, SESSION_DAYS * 86400) });
    }
  }
  if (path === "/admin/recover") {
    if (method === "GET") return recoverPage(req, env);
    if (method === "POST") {
      const form = await req.formData();
      if (!loginCsrfOk(req, form)) return recoverPage(req, env, "The form expired. Try again.", 403);
      const r = await recoverWithCode(req, env, String(form.get("email") || ""), String(form.get("code") || ""), String(form.get("new_password") || ""));
      if (!r.ok) return recoverPage(req, env, r.message, r.status);
      await audit(env.DB, r.user.id, "Used a recovery code and set a new password");
      return redirect("/admin/account?ok=" + encodeURIComponent("New password set. You are signed in."), 303, { "Set-Cookie": sessionCookie(r.token, SESSION_DAYS * 86400) });
    }
  }

  if (path === "/admin/forgot") return forgot(req, env, url);
  if (path === "/admin/reset") return resetPw(req, env, url);

  // --- everything else needs a session ---
  const auth = await getAuth(req, env);
  if (!auth) {
    if (method === "GET") return redirect("/admin/login");
    return html("<!doctype html><title>Signed out</title><p>You are signed out. <a href=\"/admin/login\">Sign in ›</a></p>", { status: 401, admin: true });
  }
  const c: Ctx = { req, env, url, auth };

  let form: FormData | null = null;
  if (method === "POST") {
    form = await req.formData();
    if (!csrfOk(req, auth, form)) {
      return html("<!doctype html><title>Expired</title><p>That form expired or came from another site, so nothing was changed. <a href=\"/admin\">Go back and try again ›</a></p>", { status: 403, admin: true });
    }
  }

  if (path === "/admin/logout" && method === "POST") {
    await endSession(env.DB, auth.session.id);
    await audit(env.DB, auth.user.id, "Signed out");
    return redirect("/admin/login?ok=" + encodeURIComponent("You are signed out."), 303, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  // A temporary password must be changed before anything else.
  if (auth.user.must_change && path !== "/admin/password") return redirect("/admin/password");

  if (path.startsWith("/admin/preview")) {
    if (method !== "GET") return text("Method not allowed", undefined, 405);
    return renderPreview({}, path.slice("/admin/preview".length) || "/");
  }

  for (const [re, m, h] of ROUTES) {
    if (m !== method) continue;
    const match = path.match(re);
    if (match) return h({ ...c, form } as Ctx & { form: FormData }, match);
  }
  return frame({ auth, title: "Not found", status: 404, back: { href: "/admin", label: "Home" } }, "<h1>That admin page doesn't exist</h1>");
}

type FCtx = Ctx & { form: FormData };
const F = (c: Ctx) => (c as FCtx).form;
const S = (c: Ctx, k: string) => String(F(c).get(k) ?? "").replace(/\r\n?/g, "\n");

// ---------------- screens ----------------

const home: Handler = async (c) => {
  const db = c.env.DB;
  const p = await pointers(db);
  const n = await unpublishedCount(db);
  const draft = await loadVersion(db, p.draft);
  const live = await loadVersion(db, p.published);
  const since = dayKey(now() - 6 * 86400);
  const counts = await db.prepare("SELECT kind, SUM(n) AS n FROM counts WHERE day >= ? GROUP BY kind").bind(since).all<{ kind: string; n: number }>();
  const cm = Object.fromEntries(counts.results.map((r) => [r.kind, r.n]));
  const top = await db.prepare("SELECT path, SUM(n) AS n FROM counts WHERE day >= ? AND kind = 'book' GROUP BY path ORDER BY n DESC LIMIT 3").bind(since).all<{ path: string; n: number }>();
  const subs = await db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE unsubscribed_at IS NULL").first<{ n: number }>();
  const codes = await recoveryCodesLeft(db, c.auth.user.id);
  const next = (await listTours(db, now(), now() + 60 * 86400))[0];
  const waiting = (await db.prepare("SELECT COUNT(*) AS n FROM tour_requests WHERE handled_at IS NULL").first<{ n: number }>())?.n ?? 0;
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short" });
  const needs = (n ? 1 : 0) + (waiting ? 1 : 0);
  const line1 = needs
    ? `${today} · ${needs} need${needs === 1 ? "s" : ""} you${n ? ` · changes not live yet` : ""}${waiting ? ` · ${waiting} tour request${waiting === 1 ? "" : "s"} waiting` : ""}`
    : `${today} · All clear: the site is live and up to date`;
  return page(c, { title: "Home", tab: "home", flash: flashFrom(c.url) }, `
<p class="line1">${esc(line1)}</p>
<h1>Hi ${esc(c.auth.user.name.split(" ")[0])}</h1>
${codes === 0 ? `<p class="flash flash-gap">No recovery codes saved. They let you in if the password is lost. <a href="/admin/account">Make them ›</a></p>` : ""}
<section class="card">
<h2>Last 7 days</h2>
<p class="big">${cm.view || 0} visit${cm.view === 1 ? "" : "s"} · ${cm.book || 0} Book tap${cm.book === 1 ? "" : "s"}</p>
<p class="sub">Counted on this site, without cookies. Book taps send people on to the booking page.${
    top.results.length ? ` Most Book taps from: ${top.results.map((r) => `${esc(r.path)} (${r.n})`).join(", ")}.` : ""
  }</p>
</section>
<ul class="rows">
${waiting ? row(`${waiting} private tour request${waiting === 1 ? "" : "s"} waiting`, "Reply by email, then mark handled", '<a href="/admin/requests">Open ›</a>') : ""}
${next ? row(`Next tour: ${esc(tourWhen(next.starts_at))}`, `${next.taken} of ${next.capacity} seats taken`, `<a href="/admin/tours/${next.id}">Open ›</a>`) : row("Tours", "No tour dates on this site yet", '<a href="/admin/tours">Open ›</a>')}
${row("Edit a page", "Text, sections and photos on each page", '<a href="/admin/pages">Open ›</a>')}
${row("Tour info", `${esc(draft?.content.ticket.price_text || "")} · ${esc(draft?.content.ticket.duration_text || "")} · ${esc(draft?.content.ticket.schedule_text || "")}`, '<a href="/admin/tour">Open ›</a>')}
${row("See the site as it will go live", n ? "Includes the changes not live yet" : "Same as the live site", '<a href="/admin/preview/">Preview ›</a>')}
${c.auth.user.role === "owner" ? row("Email list", `${subs?.n ?? 0} people`, '<a href="/admin/subscribers">Open ›</a>') : ""}
${row("Live site", `Published ${live ? esc(adminDate(live.created_at)) : "not yet"}`, '<a href="/">Open ›</a>')}
</ul>`);
};

const more: Handler = async (c) => {
  const owner = c.auth.user.role === "owner";
  return page(c, { title: "More", tab: "more" }, `
<h1>More</h1>
<ul class="rows">
${row("Tour info", "Price, length, times, meeting point and stops shown on the site", '<a href="/admin/tour">Open ›</a>')}
${row("Private tour requests", "Groups asking for a private tour", '<a href="/admin/requests">Open ›</a>')}
${row("Questions (FAQ)", "Add, edit and order the questions", '<a href="/admin/faq">Open ›</a>')}
${row("Reviews", "Short quotes from Tripadvisor", '<a href="/admin/reviews">Open ›</a>')}
${row("Photos", "Upload, describe and remove photos", '<a href="/admin/images">Open ›</a>')}
${row("History", "Every save, who made it, and one-tap restore", '<a href="/admin/history">Open ›</a>')}
${owner ? row("Email list", "Everyone who signed up, and a spreadsheet download", '<a href="/admin/subscribers">Open ›</a>') : ""}
${row("Your account", "Password, recovery codes, where you are signed in", '<a href="/admin/account">Open ›</a>')}
</ul>
<div class="apart">${postButton(c.auth, "/admin/logout", "Sign out", "btn btn-quiet btn-wide")}</div>`);
};

const publish: Handler = async (c) => {
  const id = await publishDraft(c.env.DB);
  await audit(c.env.DB, c.auth.user.id, "Published the site", `save #${id}`);
  return back("/admin", "Published. The live site now shows your changes.");
};

// ---------------- pages and sections ----------------

const pagesList: Handler = async (c) => {
  const { content } = await loadDraft(c.env.DB);
  return page(c, { title: "Pages", tab: "pages", flash: flashFrom(c.url) }, `
<h1>Pages</h1>
<ul class="rows">${content.pages
    .map((p) => row(esc(p.nav_label), `${esc(p.path)} · ${p.sections.filter((s) => !s.hidden).length} sections showing`, `<a href="/admin/pages/${esc(p.slug)}">Edit ✎</a>`, `p-${p.slug}`))
    .join("")}</ul>`);
};

function sectionSummary(s: { type: BlockType; data: Record<string, string> }): string {
  return esc((s.data.heading || s.data.label || BLOCKS[s.type].about).slice(0, 80));
}

const pageEdit: Handler = async (c, m) => {
  const { content } = await loadDraft(c.env.DB);
  const p = findPage(content, m[1]);
  if (!p) return back("/admin/pages", "That page doesn't exist.", "err");
  const owner = c.auth.user.role === "owner";
  const secs = p.sections
    .map((s, i) => {
      const moves = `${i > 0 ? postButton(c.auth, `/admin/sections/${s.id}/move`, "↑ <span class=\"sr\">Move up</span>", "btn btn-icon", '<input type="hidden" name="dir" value="up">') : ""}${
        i < p.sections.length - 1 ? postButton(c.auth, `/admin/sections/${s.id}/move`, "↓ <span class=\"sr\">Move down</span>", "btn btn-icon", '<input type="hidden" name="dir" value="down">') : ""
      }`;
      return `<li class="row${s.hidden ? " is-hidden" : ""}" id="sec-${esc(s.id)}"><div class="row-main"><b>${esc(BLOCKS[s.type].label)}${s.hidden ? " · hidden" : ""}</b><span class="sub">${sectionSummary(s)}</span></div>
<div class="row-act"><a class="btn" href="/admin/sections/${esc(s.id)}">Edit ✎</a>${moves}${postButton(c.auth, `/admin/sections/${s.id}/toggle`, s.hidden ? "Show" : "Hide", "btn btn-quiet")}</div></li>`;
    })
    .join("");
  return page(c, { title: p.nav_label, tab: "pages", back: { href: "/admin/pages", label: "Pages" }, flash: flashFrom(c.url) }, `
<h1>${esc(p.nav_label)}</h1>
<p class="sub">${esc(p.path)} · <a href="/admin/preview${esc(p.path)}">Preview this page ›</a></p>
<h2>Sections, top to bottom</h2>
<ul class="rows">${secs}</ul>
<form method="post" action="/admin/pages/${esc(p.slug)}/add" class="card stack" id="add">${csrf(c.auth)}
<label class="field"><span class="flabel">Add a section</span><select name="type">${BLOCK_TYPES.map((t) => `<option value="${t}">${esc(BLOCKS[t].label)}: ${esc(BLOCKS[t].about)}</option>`).join("")}</select></label>
<button class="btn" type="submit">+ Add a section</button><span class="hint">It goes at the bottom; move it with ↑.</span>
</form>
<h2>Page words for Google</h2>
<form method="post" action="/admin/pages/${esc(p.slug)}" class="card stack" id="words">${csrf(c.auth)}
${field("h1", "Main heading", p.h1, { required: true, hint: "Put *stars* around a word to colour it." })}
${field("intro", "Opening lines (Google often quotes these)", p.intro, { textarea: true, rows: 4, required: true })}
${field("title", "Browser tab and Google title", p.title, { required: true, hint: "About 30 to 65 characters." })}
${field("description", "Google description", p.description, { textarea: true, rows: 3, hint: "About 120 to 160 characters." })}
${p.slug !== "home" ? field("nav_label", "Name in menus", p.nav_label, { required: true }) : ""}
<p class="hint">Tip: {price}, {duration}, {schedule_long}, {private_price} and {email} fill in from Tour info.</p>
<div class="savebar"><button class="btn btn-green" type="submit">Save ✓</button><a class="btn btn-quiet" href="/admin/preview${esc(p.path)}">Preview ›</a></div>
</form>
${owner && p.slug !== "home" ? `<div class="apart">${confirmRemove(c.auth, `/admin/pages/${p.slug}/remove`, "this page", `Its address ${p.path} will send visitors to the home page.`)}</div>` : ""}
`);
};

const pageSave: Handler = async (c, m) => {
  const slug = m[1];
  const r = await saveDraft(c.env.DB, c.auth.user.id, `Edited the words on ${slug}`, (ct) => {
    const p = findPage(ct, slug);
    if (!p) return "That page doesn't exist.";
    const h1 = S(c, "h1").trim(), intro = S(c, "intro").trim(), title = S(c, "title").trim();
    if (!h1 || !intro || !title) return "The heading, opening lines and title can't be empty.";
    Object.assign(p, { h1, intro, title, description: S(c, "description").trim() });
    if (slug !== "home" && S(c, "nav_label").trim()) p.nav_label = S(c, "nav_label").trim().slice(0, 40);
  });
  if (!r.ok) return back(`/admin/pages/${slug}`, r.error, "err", "words");
  await audit(c.env.DB, c.auth.user.id, "Edited page words", slug);
  return back(`/admin/pages/${slug}`, "Saved. Not live until you publish.", "ok", "words");
};

const pageRemove: Handler = async (c, m) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const slug = m[1];
  let path = "", name = "";
  const r = await saveDraft(c.env.DB, c.auth.user.id, `Removed the ${slug} page`, (ct) => {
    if (slug === "home") return "The home page can't be removed.";
    const i = ct.pages.findIndex((p) => p.slug === slug);
    if (i < 0) return "That page doesn't exist.";
    path = ct.pages[i].path; name = ct.pages[i].nav_label;
    ct.pages.splice(i, 1);
    ct.redirects = { ...(ct.redirects || {}), [path]: "/" };
    // Links to the removed page inside other sections go to the home page instead.
    for (const p of ct.pages) for (const sec of p.sections) for (const k of Object.keys(sec.data)) if (sec.data[k] === path) sec.data[k] = "/";
  });
  if (!r.ok) return back(`/admin/pages/${slug}`, r.error, "err");
  await audit(c.env.DB, c.auth.user.id, "Removed a page", `${name} (${path} now goes to the home page)`);
  return back("/admin/pages", `Removed ${name}. ${path} now sends visitors to the home page. Not live until you publish.`);
};

const sectionAdd: Handler = async (c, m) => {
  const slug = m[1];
  const type = S(c, "type") as BlockType;
  if (!BLOCK_TYPES.includes(type)) return back(`/admin/pages/${slug}`, "Pick a section type.", "err");
  const id = newId("s");
  const r = await saveDraft(c.env.DB, c.auth.user.id, `Added a ${BLOCKS[type].label} section on ${slug}`, (ct) => {
    const p = findPage(ct, slug);
    if (!p) return "That page doesn't exist.";
    p.sections.push({ id, type, hidden: false, data: defaultBlockData(type) });
  });
  if (!r.ok) return back(`/admin/pages/${slug}`, r.error, "err");
  await audit(c.env.DB, c.auth.user.id, "Added a section", `${BLOCKS[type].label} on ${slug}`);
  return redirect(`/admin/sections/${id}?ok=${encodeURIComponent("Section added. Fill it in and save.")}`);
};

const sectionMove: Handler = async (c, m) => {
  const id = m[1];
  const dir = S(c, "dir") === "up" ? -1 : 1;
  let slug = "";
  const r = await saveDraft(c.env.DB, c.auth.user.id, "Moved a section", (ct) => {
    const f = findSection(ct, id);
    if (!f) return "That section doesn't exist.";
    slug = f.page.slug;
    const j = f.index + dir;
    if (j < 0 || j >= f.page.sections.length) return;
    const arr = f.page.sections;
    [arr[f.index], arr[j]] = [arr[j], arr[f.index]];
  });
  if (!r.ok) return back("/admin/pages", r.error, "err");
  await audit(c.env.DB, c.auth.user.id, "Moved a section", `${dir < 0 ? "up" : "down"} on ${slug}`);
  return redirect(`/admin/pages/${slug}#sec-${id}`);
};

const sectionToggle: Handler = async (c, m) => {
  const id = m[1];
  let slug = "", hidden = false;
  const r = await saveDraft(c.env.DB, c.auth.user.id, "Showed or hid a section", (ct) => {
    const f = findSection(ct, id);
    if (!f) return "That section doesn't exist.";
    slug = f.page.slug;
    f.section.hidden = !f.section.hidden;
    hidden = f.section.hidden;
  });
  if (!r.ok) return back("/admin/pages", r.error, "err");
  await audit(c.env.DB, c.auth.user.id, hidden ? "Hid a section" : "Showed a section", slug);
  return redirect(`/admin/pages/${slug}#sec-${id}`);
};

const sectionDelete: Handler = async (c, m) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const id = m[1];
  let slug = "", label = "";
  const r = await saveDraft(c.env.DB, c.auth.user.id, "Removed a section", (ct) => {
    const f = findSection(ct, id);
    if (!f) return "That section doesn't exist.";
    slug = f.page.slug;
    label = BLOCKS[f.section.type].label;
    f.page.sections.splice(f.index, 1);
  });
  if (!r.ok) return back("/admin/pages", r.error, "err");
  await audit(c.env.DB, c.auth.user.id, "Removed a section", `${label} on ${slug}`);
  return back(`/admin/pages/${slug}`, "Section removed. Bring it back from History if you need it.");
};

async function imageOptions(db: D1Database) {
  return (await listImages(db)).map((im) => ({ id: im.id, alt: im.alt, url: imageUrl(im) }));
}

const sectionEdit: Handler = async (c, m) => {
  const { content } = await loadDraft(c.env.DB);
  const f = findSection(content, m[1]);
  if (!f) return back("/admin/pages", "That section doesn't exist.", "err");
  const { section: s, page: p } = f;
  const imgs = await imageOptions(c.env.DB);
  const fields = BLOCKS[s.type].fields
    .map((fd) => {
      const v = s.data[fd.k] ?? "";
      switch (fd.t) {
        case "text": return field(fd.k, fd.l, v, { textarea: true, rows: 6, hint: "Blank line = new paragraph. Start lines with - for a list. [words](link) makes a link." });
        case "check": return check(fd.k, fd.l, v === "1");
        case "number": return field(fd.k, fd.l, v || "0", { type: "number" });
        case "link": return field(fd.k, fd.l, v, { hint: "A web address, mailto:email, or a page like /faq." });
        case "select": return `<label class="field"><span class="flabel">${esc(fd.l)}</span><select name="${fd.k}">${(fd.options || []).map((o) => `<option${o === v ? " selected" : ""}>${o}</option>`).join("")}</select></label>`;
        case "image": {
          const cur = imgs.find((i) => i.id === v);
          return `<label class="field"><span class="flabel">${esc(fd.l)}</span>${cur ? `<img class="thumb" src="${esc(cur.url)}" alt="">` : ""}<select name="${fd.k}"><option value="">No photo</option>${imgs
            .map((i) => `<option value="${esc(i.id)}"${i.id === v ? " selected" : ""}>${esc(i.alt.slice(0, 60))}</option>`)
            .join("")}</select><span class="hint"><a href="/admin/images">Upload a new photo ›</a></span></label>`;
        }
        case "images": {
          const on = new Set(v.split(",").map((x) => x.trim()));
          return `<fieldset class="field"><legend class="flabel">${esc(fd.l)}</legend><div class="pickgrid">${imgs
            .map((i) => `<label class="pick"><input type="checkbox" name="${fd.k}" value="${esc(i.id)}"${on.has(i.id) ? " checked" : ""}><img src="${esc(i.url)}" alt=""><span class="sub">${esc(i.alt.slice(0, 40))}</span></label>`)
            .join("")}</div></fieldset>`;
        }
        default: return field(fd.k, fd.l, v);
      }
    })
    .join("");
  return page(c, { title: BLOCKS[s.type].label, tab: "pages", back: { href: `/admin/pages/${p.slug}#sec-${s.id}`, label: p.nav_label }, flash: flashFrom(c.url) }, `
<h1>${esc(BLOCKS[s.type].label)}</h1>
<p class="sub">On ${esc(p.nav_label)}. ${esc(BLOCKS[s.type].about)}${s.hidden ? " This section is hidden." : ""}</p>
<form method="post" action="/admin/sections/${esc(s.id)}" class="card stack">${csrf(c.auth)}
${fields}
<p class="hint">Tip: {price}, {duration}, {schedule_long}, {private_price} and {email} fill in from Tour info.</p>
<div class="savebar"><button class="btn btn-green" type="submit">Save ✓</button><a class="btn btn-quiet" href="/admin/preview${esc(p.path)}#s-${esc(s.id)}">Preview ›</a></div>
</form>
${c.auth.user.role === "owner" ? `<div class="apart">${confirmRemove(c.auth, `/admin/sections/${s.id}/delete`, "this section")}</div>` : ""}`);
};

const sectionSave: Handler = async (c, m) => {
  const id = m[1];
  let slug = "";
  const imgs = new Set((await listImages(c.env.DB)).map((i) => i.id));
  const r = await saveDraft(c.env.DB, c.auth.user.id, "Edited a section", (ct) => {
    const f = findSection(ct, id);
    if (!f) return "That section doesn't exist.";
    slug = f.page.slug;
    const data: Record<string, string> = {};
    for (const fd of BLOCKS[f.section.type].fields) {
      if (fd.t === "check") data[fd.k] = F(c).get(fd.k) ? "1" : "";
      else if (fd.t === "images") data[fd.k] = F(c).getAll(fd.k).map(String).filter((x) => imgs.has(x)).join(",");
      else if (fd.t === "image") { const v = S(c, fd.k); if (v && !imgs.has(v)) return "Pick a photo from the list."; data[fd.k] = v; }
      else if (fd.t === "link") { const v = cleanLink(S(c, fd.k), ct); if (v === null) return `"${fd.l}" must be a web address, mailto: email or a page like /faq.`; data[fd.k] = v; }
      else if (fd.t === "number") data[fd.k] = String(Math.max(0, Math.min(50, Number(S(c, fd.k)) || 0)));
      else if (fd.t === "select") data[fd.k] = (fd.options || []).includes(S(c, fd.k)) ? S(c, fd.k) : (fd.options || [""])[0];
      else data[fd.k] = S(c, fd.k).slice(0, 5000);
    }
    f.section.data = data;
  });
  if (!r.ok) return back(`/admin/sections/${id}`, r.error, "err");
  await audit(c.env.DB, c.auth.user.id, "Edited a section", slug);
  return back(`/admin/sections/${id}`, "Saved. Not live until you publish.");
};

// ---------------- tour info ----------------

const TICKET_FIELDS: [string, string, string?][] = [
  ["price_text", "Ticket price, as shown", "For example: $70 per person"],
  ["price_amount", "Ticket price, number only (for Google)", "For example: 70"],
  ["duration_text", "How long", "For example: 3 hours"],
  ["duration_iso", "How long, for Google", "PT3H means 3 hours"],
  ["schedule_text", "When, short", "For example: Fri & Sat · 2:00 pm Central"],
  ["schedule_long", "When, in a sentence", "For example: Fridays and Saturdays at 2:00 pm Central"],
  ["private_price_text", "Private tour price, as shown", "For example: From $600"],
  ["private_price_amount", "Private tour price, number only", "For example: 600"],
  ["meeting_point", "Meeting point", ""],
  ["street", "Meeting point street (for Google)", ""],
  ["postal_code", "ZIP code", ""],
  ["email", "Team email", ""],
  ["policy_text", "Refund and cancellation policy (shown on ticket pages)", "Placeholder until Carlos writes the policy."],
];

const tour: Handler = async (c) => {
  const { content } = await loadDraft(c.env.DB);
  const t = content.ticket as unknown as Record<string, string>;
  const owner = c.auth.user.role === "owner";
  return page(c, { title: "Tour info", tab: "tour", flash: flashFrom(c.url) }, `
<h1>Tour info</h1>
<p class="sub">These fill in everywhere on the site. Keep them the same as the booking page.</p>
<form method="post" action="/admin/tour" class="card stack">${csrf(c.auth)}
${field("book_url", "Book link (the booking page)", t.book_url, { type: "url", required: true, disabled: !owner, hint: owner ? "Every Book button goes here." : "Only Carlos can change the Book link." })}
${TICKET_FIELDS.map(([k, l, h]) => field(k, l, t[k] || "", { hint: h })).join("")}
${field("stops", "Tour stops, in order (one per line)", content.stops.map((s) => s.name).join("\n"), { textarea: true, rows: 9, required: true })}
<div class="savebar"><button class="btn btn-green" type="submit">Save ✓</button><a class="btn btn-quiet" href="/admin/preview/">Preview ›</a></div>
</form>`);
};

const tourSave: Handler = async (c) => {
  const owner = c.auth.user.role === "owner";
  const r = await saveDraft(c.env.DB, c.auth.user.id, "Edited tour info", (ct) => {
    const t = ct.ticket as unknown as Record<string, string>;
    for (const [k] of TICKET_FIELDS) t[k] = S(c, k).trim().slice(0, 200);
    if (owner) {
      const u = S(c, "book_url").trim();
      if (!/^https:\/\/[^\s"<>]+$/.test(u)) return "The Book link must start with https://";
      t.book_url = u;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(t.price_amount) || !/^\d+(\.\d{1,2})?$/.test(t.private_price_amount)) return "The number-only prices must be numbers, like 70.";
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(t.email)) return "The team email doesn't look right.";
    const stops = S(c, "stops").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 30);
    if (!stops.length) return "Add at least one stop.";
    ct.stops = stops.map((name) => ({ name: name.slice(0, 80) }));
  });
  if (!r.ok) return back("/admin/tour", r.error, "err");
  await audit(c.env.DB, c.auth.user.id, "Edited tour info");
  return back("/admin/tour", "Saved. Not live until you publish.");
};

// ---------------- FAQ and reviews (one pattern) ----------------

type ListKind = "faq" | "reviews";
const LISTS: Record<ListKind, { title: string; one: string; fields: [string, string, boolean][] }> = {
  faq: { title: "Questions (FAQ)", one: "question", fields: [["q", "Question", false], ["a", "Answer (about 40 to 60 words)", true]] },
  reviews: { title: "Reviews", one: "review", fields: [["quote", "Short quote (under 25 words)", true], ["author", "Name, like Amy A.", false], ["date", "Month, like Jan 2026", false], ["url", "Link to the full review", false]] },
};
const listOf = (ct: Content, k: ListKind) => (k === "faq" ? ct.faqs : ct.reviews) as unknown as Array<Record<string, any>>;

const listPage: Handler = async (c, m) => {
  const kind = m[1] as ListKind;
  const L = LISTS[kind];
  const { content } = await loadDraft(c.env.DB);
  const items = listOf(content, kind);
  const owner = c.auth.user.role === "owner";
  const rows = items
    .map((it, i) => {
      const title = esc(String(kind === "faq" ? it.q : `"${it.quote}"`).slice(0, 90));
      const sub = kind === "faq" ? (it.hidden ? "Hidden" : "Showing") : `${esc(it.author)}${it.date ? ", " + esc(it.date) : ""}${it.hidden ? " · hidden" : ""}`;
      return `<li class="row${it.hidden ? " is-hidden" : ""}" id="i-${esc(it.id)}"><div class="row-main"><b>${title}</b><span class="sub">${sub}</span></div>
<div class="row-act">${i > 0 ? postButton(c.auth, `/admin/${kind}/${it.id}/move`, "↑ <span class=\"sr\">Move up</span>", "btn btn-icon", '<input type="hidden" name="dir" value="up">') : ""}${
        i < items.length - 1 ? postButton(c.auth, `/admin/${kind}/${it.id}/move`, "↓ <span class=\"sr\">Move down</span>", "btn btn-icon", '<input type="hidden" name="dir" value="down">') : ""
      }</div>
<details class="edit"><summary>Edit ✎</summary><form method="post" action="/admin/${kind}/${esc(it.id)}" class="stack">${csrf(c.auth)}
${L.fields.map(([k, l, ta]) => field(k, l, String(it[k] ?? ""), { textarea: ta, rows: 4 })).join("")}
${check("hidden", "Hide it on the site", !!it.hidden)}
<div class="row-actions"><button class="btn btn-green" type="submit">Save ✓</button></div></form>
${confirmRemove(c.auth, `/admin/${kind}/${it.id}/delete`, `this ${L.one}`)}</details></li>`;
    })
    .join("");
  return page(c, { title: L.title, tab: "more", back: { href: "/admin/more", label: "More" }, flash: flashFrom(c.url) }, `
<h1>${esc(L.title)}</h1>
${kind === "reviews" ? '<p class="sub">Keep quotes short and credited, with a link to the full review. No Tripadvisor photos.</p>' : ""}
<ul class="rows">${rows}</ul>
<details class="card"><summary>+ Add a ${esc(L.one)}</summary><form method="post" action="/admin/${kind}/add" class="stack">${csrf(c.auth)}
${L.fields.map(([k, l, ta]) => field(k, l, kind === "reviews" && k === "url" ? content.site.rating_url : "", { textarea: ta, rows: 4 })).join("")}
<div class="row-actions"><button class="btn btn-green" type="submit">+ Add</button></div></form></details>
`);
};

function listItemFromForm(c: Ctx, kind: ListKind): Record<string, any> | string {
  const out: Record<string, any> = {};
  for (const [k] of LISTS[kind].fields) out[k] = S(c, k).trim().slice(0, 1500);
  out.hidden = !!F(c).get("hidden");
  if (kind === "faq" && (!out.q || !out.a)) return "A question needs both the question and the answer.";
  if (kind === "reviews") {
    if (!out.quote || !out.author) return "A review needs the quote and the name.";
    if (!/^https:\/\/[^\s"<>]+$/.test(out.url)) return "The review link must start with https://";
    out.quote = out.quote.replace(/^["“]|["”]$/g, "");
  }
  return out;
}

const listAdd: Handler = async (c, m) => {
  const kind = m[1] as ListKind;
  const item = listItemFromForm(c, kind);
  if (typeof item === "string") return back(`/admin/${kind}`, item, "err");
  item.id = newId(kind === "faq" ? "f" : "r");
  const r = await saveDraft(c.env.DB, c.auth.user.id, `Added a ${LISTS[kind].one}`, (ct) => void listOf(ct, kind).push(item));
  if (!r.ok) return back(`/admin/${kind}`, r.error, "err");
  await audit(c.env.DB, c.auth.user.id, `Added a ${LISTS[kind].one}`);
  return back(`/admin/${kind}`, "Added. Not live until you publish.", "ok", `i-${item.id}`);
};

const listSave: Handler = async (c, m) => {
  const kind = m[1] as ListKind, id = m[2];
  const item = listItemFromForm(c, kind);
  if (typeof item === "string") return back(`/admin/${kind}`, item, "err", `i-${id}`);
  const r = await saveDraft(c.env.DB, c.auth.user.id, `Edited a ${LISTS[kind].one}`, (ct) => {
    const it = listOf(ct, kind).find((x) => x.id === id);
    if (!it) return "That item doesn't exist.";
    Object.assign(it, item, { id });
  });
  if (!r.ok) return back(`/admin/${kind}`, r.error, "err");
  await audit(c.env.DB, c.auth.user.id, `Edited a ${LISTS[kind].one}`);
  return back(`/admin/${kind}`, "Saved. Not live until you publish.", "ok", `i-${id}`);
};

const listMove: Handler = async (c, m) => {
  const kind = m[1] as ListKind, id = m[2];
  const dir = S(c, "dir") === "up" ? -1 : 1;
  const r = await saveDraft(c.env.DB, c.auth.user.id, `Moved a ${LISTS[kind].one}`, (ct) => {
    const arr = listOf(ct, kind);
    const i = arr.findIndex((x) => x.id === id), j = i + dir;
    if (i < 0) return "That item doesn't exist.";
    if (j >= 0 && j < arr.length) [arr[i], arr[j]] = [arr[j], arr[i]];
  });
  if (!r.ok) return back(`/admin/${kind}`, r.error, "err");
  return redirect(`/admin/${kind}#i-${id}`);
};

const listDelete: Handler = async (c, m) => {
  const kind = m[1] as ListKind, id = m[2];
  const r = await saveDraft(c.env.DB, c.auth.user.id, `Removed a ${LISTS[kind].one}`, (ct) => {
    const arr = listOf(ct, kind);
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return "That item doesn't exist.";
    arr.splice(i, 1);
  });
  if (!r.ok) return back(`/admin/${kind}`, r.error, "err");
  await audit(c.env.DB, c.auth.user.id, `Removed a ${LISTS[kind].one}`);
  return back(`/admin/${kind}`, "Removed. Bring it back from History if you need it.");
};

// ---------------- photos ----------------

const imagesPage: Handler = async (c) => {
  const db = c.env.DB;
  const all = await listImages(db, true);
  const p = await pointers(db);
  const draft = (await loadVersion(db, p.draft))!.content;
  const live = (await loadVersion(db, p.published))!.content;
  const items = all.filter((i) => !i.deleted_at).map((im) => {
    const used = [...new Set([...usage(draft, im.id), ...usage(live, im.id)])];
    return `<li class="photo-row" id="im-${esc(im.id)}"><img src="${esc(imageUrl(im))}" alt="" class="thumb">
<div class="stack"><span class="sub">${used.length ? `Used on: ${esc(used.join("; "))}` : "Not used on any page"}</span>
<details class="edit"><summary>Edit ✎</summary>
<form method="post" action="/admin/images/${esc(im.id)}" enctype="multipart/form-data" class="stack">${csrf(c.auth)}
${field("alt", "What's in the photo (required)", im.alt, { textarea: true, rows: 2, required: true })}
<label class="field"><span class="flabel">Replace the photo (optional)</span><input type="file" name="file" accept="image/*,.heic,.heif" data-resize></label>
<div class="row-actions"><button class="btn btn-green" type="submit">Save ✓</button></div></form>
${used.length ? `<p class="sub">To remove this photo, take it off ${esc(used.join("; "))} first.</p>` : confirmRemove(c.auth, `/admin/images/${im.id}/delete`, "this photo", "It comes off the site.")}
</details></div></li>`;
  });
  const removed = all.filter((i) => i.deleted_at);
  return page(c, { title: "Photos", tab: "more", back: { href: "/admin/more", label: "More" }, flash: flashFrom(c.url) }, `
<h1>Photos</h1>
<form method="post" action="/admin/images" enctype="multipart/form-data" class="card stack" id="upload">${csrf(c.auth)}
<label class="field"><span class="flabel">Choose a photo</span><input type="file" name="file" accept="image/*,.heic,.heif" required data-resize data-alt-target="f-alt"><span class="hint">iPhone photos are shrunk to 2000 pixels and converted before they upload.</span></label>
${field("alt", "What's in the photo (required)", "", { textarea: true, rows: 2, required: true, hint: "For example: Riders in front of the Young Dolph mural. Say what someone would see." })}
<p class="resize-status sub" aria-live="polite"></p>
<div class="row-actions"><button class="btn btn-green" type="submit">Upload ›</button></div>
</form>
<ul class="photos">${items.join("")}</ul>
${removed.length ? `<h2>Removed photos</h2><ul class="rows">${removed
    .map((im) => row(esc(im.alt.slice(0, 60)), `Removed ${esc(adminDate(im.deleted_at!))}`, postButton(c.auth, `/admin/images/${im.id}/restore`, "Bring back", "btn btn-quiet")))
    .join("")}</ul>` : ""}`);
};

const imageUpload: Handler = async (c) => {
  const chk = await checkUpload(F(c).get("file"), F(c).get("alt"));
  if (!chk.ok) return back("/admin/images", chk.error, "err", "upload");
  const id = newImageId();
  const storage = await storeImage(c.env.IMAGES, id, chk);
  const t = now();
  await c.env.DB.prepare("INSERT INTO images (id, storage, content_type, bytes, width, height, alt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, storage, chk.type, chk.bytes.length, chk.width, chk.height, S(c, "alt").trim(), t, t)
    .run();
  await audit(c.env.DB, c.auth.user.id, "Uploaded a photo", S(c, "alt").trim().slice(0, 80));
  return back("/admin/images", "Uploaded. Pick it in a section to show it on the site.", "ok", `im-${id}`);
};

const imageSave: Handler = async (c, m) => {
  const id = m[1];
  const im = await c.env.DB.prepare("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL").bind(id).first<{ storage: string }>();
  if (!im) return back("/admin/images", "That photo doesn't exist.", "err");
  const alt = S(c, "alt").trim();
  if (!alt) return back("/admin/images", "Describe the photo in a few words first.", "err", `im-${id}`);
  const file = F(c).get("file");
  if (file && typeof file !== "string" && (file as File).size) {
    const chk = await checkUpload(file, alt);
    if (!chk.ok) return back("/admin/images", chk.error, "err", `im-${id}`);
    const storage = await storeImage(c.env.IMAGES, id, chk);
    await c.env.DB.prepare("UPDATE images SET storage = ?, content_type = ?, bytes = ?, width = ?, height = ?, alt = ?, updated_at = ? WHERE id = ?")
      .bind(storage, chk.type, chk.bytes.length, chk.width, chk.height, alt.slice(0, 300), now(), id)
      .run();
    await dropBytes(c.env.IMAGES, im.storage);
    await audit(c.env.DB, c.auth.user.id, "Replaced a photo", alt.slice(0, 80));
  } else {
    await c.env.DB.prepare("UPDATE images SET alt = ?, updated_at = ? WHERE id = ?").bind(alt.slice(0, 300), now(), id).run();
    await audit(c.env.DB, c.auth.user.id, "Edited a photo description", alt.slice(0, 80));
  }
  return back("/admin/images", "Saved. Photos change on the site straight away.", "ok", `im-${id}`);
};

const imageDelete: Handler = async (c, m) => {
  const id = m[1];
  const db = c.env.DB;
  const p = await pointers(db);
  const used = [...usage((await loadVersion(db, p.draft))!.content, id), ...usage((await loadVersion(db, p.published))!.content, id)];
  if (used.length) return back("/admin/images", `That photo is still used on: ${[...new Set(used)].join("; ")}. Take it off there first.`, "err", `im-${id}`);
  // Kept for 30 days so it can be brought back; the daily job removes the bytes after that.
  const r = await db.prepare("UPDATE images SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now(), id).run();
  if (r.meta.changes !== 1) return back("/admin/images", "That photo doesn't exist.", "err");
  await audit(db, c.auth.user.id, "Removed a photo", id);
  return back("/admin/images", "Photo removed. You can bring it back for 30 days.");
};

const imageRestore: Handler = async (c, m) => {
  await c.env.DB.prepare("UPDATE images SET deleted_at = NULL WHERE id = ?").bind(m[1]).run();
  await audit(c.env.DB, c.auth.user.id, "Brought back a photo", m[1]);
  return back("/admin/images", "Photo is back.", "ok", `im-${m[1]}`);
};

// ---------------- email list (owner only) ----------------

const subscribers: Handler = async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const rows = await c.env.DB.prepare("SELECT * FROM subscribers ORDER BY created_at DESC LIMIT 500").all<Record<string, any>>();
  const active = rows.results.filter((r) => !r.unsubscribed_at);
  const gone = rows.results.length - active.length;
  return page(c, { title: "Email list", tab: "more", back: { href: "/admin/more", label: "More" }, flash: flashFrom(c.url) }, `
<h1>Email list</h1>
<p class="line1">${active.length} ${active.length === 1 ? "person" : "people"} on the list${gone ? ` · ${gone} unsubscribed` : ""}</p>
<p class="sub">Nothing is emailed from this site yet. Sending (for example with MailerLite's free plan) is a later step that needs Carlos's yes.</p>
<p><a class="btn" href="/admin/subscribers.csv">Download as a spreadsheet ›</a></p>
<ul class="rows">${rows.results
    .map((s) => `<li class="row" id="sub-${s.id}"><div class="row-main"><b>${esc(s.email)}</b><span class="sub">${esc(s.first_name || "No name")} · ${esc(adminDate(s.created_at))} · from ${esc(s.source || "the site")}${s.unsubscribed_at ? " · unsubscribed" : ""}</span></div>
<div class="row-act">${confirmRemove(c.auth, `/admin/subscribers/${s.id}/delete`, "this person", "This deletes their email for good.").replace("You can bring it back from History.", "This can't be undone.")}</div></li>`)
    .join("") || '<li class="row"><div class="row-main"><b>No one has signed up yet.</b></div></li>'}</ul>`);
};

const subscribersCsv: Handler = async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const rows = await c.env.DB.prepare("SELECT * FROM subscribers ORDER BY created_at").all<Record<string, any>>();
  const origin = new URL(c.req.url).origin;
  const head = ["email", "first_name", "signed_up", "source", "consent_text", "unsubscribed", "unsubscribe_link"];
  const lines = [head.join(",")];
  for (const s of rows.results) {
    lines.push([s.email, s.first_name, new Date(s.created_at * 1000).toISOString(), s.source, s.consent_text, s.unsubscribed_at ? new Date(s.unsubscribed_at * 1000).toISOString() : "", await unsubUrl(c.env, origin, s.id)].map(csvCell).join(","));
  }
  await audit(c.env.DB, c.auth.user.id, "Downloaded the email list", `${rows.results.length} rows`);
  return text(lines.join("\r\n") + "\r\n", "text/csv; charset=utf-8", 200, {
    "Content-Disposition": `attachment; filename="memphis-rap-tour-email-list-${dayKey()}.csv"`,
    "Cache-Control": "no-store",
  });
};

const subscriberDelete: Handler = async (c, m) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const r = await c.env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(Number(m[1])).run();
  if (r.meta.changes) await audit(c.env.DB, c.auth.user.id, "Deleted someone from the email list", `#${m[1]}`);
  return back("/admin/subscribers", r.meta.changes ? "Deleted." : "That person wasn't on the list.");
};

// ---------------- private tour requests (owner and editor) ----------------

const requests: Handler = async (c) => {
  const rows = await c.env.DB.prepare("SELECT r.*, u.name AS by_name FROM tour_requests r LEFT JOIN users u ON u.id = r.handled_by ORDER BY (r.handled_at IS NOT NULL), r.created_at DESC LIMIT 200").all<Record<string, any>>();
  const open = rows.results.filter((r) => !r.handled_at).length;
  return page(c, { title: "Tour requests", tab: "more", back: { href: "/admin/more", label: "More" }, flash: flashFrom(c.url) }, `
<h1>Private tour requests</h1>
<p class="line1">${open ? `${open} waiting for a reply` : "All clear: nothing is waiting on you."}</p>
<p class="sub">Reply from your own email. Nothing is sent from this site.</p>
<ul class="rows">${rows.results
    .map((r) => `<li class="row${r.handled_at ? " is-hidden" : ""}" id="rq-${r.id}"><div class="row-main"><b>${esc(r.name)} · ${esc(r.group_size || "?")} riding · ${esc(r.date_wanted || "date not given")}</b>
<span class="sub">${r.occasion ? esc(r.occasion) + " · " : ""}<a href="mailto:${esc(r.email)}">${esc(r.email)}</a> · sent ${esc(adminDate(r.created_at))}${r.handled_at ? ` · handled by ${esc(r.by_name || "someone")} ${esc(adminDate(r.handled_at))}` : `, waiting ${Math.max(0, Math.floor((now() - r.created_at) / 86400))} days`}</span>
${r.message ? `<p class="msg">${esc(r.message)}</p>` : ""}</div>
<div class="row-act">${postButton(c.auth, `/admin/requests/${r.id}/handled`, r.handled_at ? "Mark not handled" : "Mark handled ✓", r.handled_at ? "btn btn-quiet" : "btn btn-green")}</div></li>`)
    .join("") || '<li class="row"><div class="row-main"><b>No requests yet.</b></div></li>'}</ul>`);
};

const requestHandled: Handler = async (c, m) => {
  const id = Number(m[1]);
  await c.env.DB.prepare("UPDATE tour_requests SET handled_at = CASE WHEN handled_at IS NULL THEN ? ELSE NULL END, handled_by = ? WHERE id = ?").bind(now(), c.auth.user.id, id).run();
  await audit(c.env.DB, c.auth.user.id, "Marked a tour request", `#${id}`);
  return redirect(`/admin/requests#rq-${id}`);
};

// ---------------- history ----------------

const history: Handler = async (c) => {
  const db = c.env.DB;
  const p = await pointers(db);
  const vs = await db.prepare("SELECT v.id, v.created_at, v.kind, v.note, u.name FROM versions v LEFT JOIN users u ON u.id = v.user_id ORDER BY v.id DESC LIMIT 60").all<Record<string, any>>();
  const log = await db.prepare("SELECT a.at, a.action, a.detail, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 40").all<Record<string, any>>();
  return page(c, { title: "History", tab: "more", back: { href: "/admin/more", label: "More" }, flash: flashFrom(c.url) }, `
<h1>History</h1>
<p class="sub">Every save is kept. "Restore" puts the site back exactly as it was after that save, and makes it live.</p>
<ul class="rows">${vs.results
    .map((v) => {
      const tag = v.id === p.published ? " · live now" : v.id === p.draft ? " · your draft" : "";
      return row(`${esc(v.note || v.kind)}${tag}`, `${esc(v.name || "Set-up")} · ${esc(adminDate(v.created_at))}`, v.id === p.published ? '<span class="ok">Live ✓</span>' : postButton(c.auth, `/admin/history/${v.id}/restore`, "Restore", "btn btn-quiet"), `v-${v.id}`);
    })
    .join("")}</ul>
<h2>Who did what</h2>
<ul class="rows">${log.results.map((a) => row(esc(a.action), `${esc(a.name || "System")} · ${esc(adminDate(a.at))}${a.detail ? " · " + esc(a.detail) : ""}`, "")).join("")}</ul>`);
};

const historyRestore: Handler = async (c, m) => {
  const id = await restoreVersion(c.env.DB, c.auth.user.id, Number(m[1]));
  if (!id) return back("/admin/history", "That save doesn't exist.", "err");
  await audit(c.env.DB, c.auth.user.id, "Restored an earlier version", `save #${m[1]}`);
  return back("/admin/history", `Restored save #${m[1]}. The live site shows it now.`);
};

// ---------------- account ----------------

const password: Handler = async (c) => {
  const forced = !!c.auth.user.must_change;
  return frame({ auth: c.auth, title: "Change password", tab: "more", back: forced ? undefined : { href: "/admin/account", label: "Your account" }, flash: flashFrom(c.url) }, `
<h1>${forced ? "Choose your own password" : "Change password"}</h1>
${forced ? "<p>You signed in with a temporary password. Choose your own to carry on.</p>" : ""}
<form method="post" action="/admin/password" class="card stack">${csrf(c.auth)}
${field("current", forced ? "Temporary password" : "Current password", "", { type: "password", required: true, autocomplete: "current-password" })}
${field("new_password", "New password", "", { type: "password", required: true, autocomplete: "new-password", hint: "At least 12 characters. A short sentence works well." })}
${field("repeat", "New password again", "", { type: "password", required: true, autocomplete: "new-password" })}
<button class="btn btn-green btn-wide" type="submit">Save new password ✓</button>
</form>
${forced ? `<div class="apart">${postButton(c.auth, "/admin/logout", "Sign out", "btn btn-quiet")}</div>` : ""}`);
};

function codesScreen(auth: Auth, codes: string[], intro: string): Response {
  return frame({ auth, title: "Recovery codes", tab: "more" }, `
<h1>Save your recovery codes</h1>
<p>${esc(intro)} If you ever forget your password, one of these signs you in. Each works once. <b>This is the only time they are shown.</b></p>
<ol class="codes">${codes.map((x) => `<li><code>${esc(x)}</code></li>`).join("")}</ol>
<p class="sub">Save them in your password manager or Notes, or take a screenshot and keep it somewhere safe.</p>
<p><a class="btn btn-green btn-wide" href="/admin">I've saved them ›</a></p>`);
}

const passwordSave: Handler = async (c) => {
  const u = c.auth.user;
  const cur = S(c, "current"), np = S(c, "new_password"), rep = S(c, "repeat");
  if (!(await verifyPassword(cur, u.pw_hash))) return back("/admin/password", "The current password isn't right.", "err");
  if (np !== rep) return back("/admin/password", "The two new passwords don't match.", "err");
  if (np === cur) return back("/admin/password", "Choose a password different from the current one.", "err");
  const problem = passwordProblem(np, u.email);
  if (problem) return back("/admin/password", problem, "err");
  const wasForced = !!u.must_change;
  await c.env.DB.prepare("UPDATE users SET pw_hash = ?, must_change = 0, updated_at = ? WHERE id = ?").bind(await hashPassword(np), now(), u.id).run();
  await endAllSessions(c.env.DB, u.id, c.auth.session.id);
  await audit(c.env.DB, u.id, "Changed their password");
  if (wasForced && (await recoveryCodesLeft(c.env.DB, u.id)) === 0) {
    const codes = await makeRecoveryCodes(c.env.DB, u.id);
    await audit(c.env.DB, u.id, "Made recovery codes");
    return codesScreen(c.auth, codes, "Your password is saved.");
  }
  return back("/admin/account", "Password changed. You were signed out everywhere else.");
};

function deviceName(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "A device";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "a browser";
  return `${os}, ${br}`;
}

const account: Handler = async (c) => {
  const db = c.env.DB;
  const ss = await db.prepare("SELECT id, created_at, last_seen, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC").bind(c.auth.user.id, now()).all<Record<string, any>>();
  const left = await recoveryCodesLeft(db, c.auth.user.id);
  return page(c, { title: "Your account", tab: "more", back: { href: "/admin/more", label: "More" }, flash: flashFrom(c.url) }, `
<h1>Your account</h1>
<p class="sub">${esc(c.auth.user.email)} · the shared team login</p>
<ul class="rows">
${row("Password", "Change it any time", '<a href="/admin/password">Change ›</a>')}
${row("Recovery codes", `${left} of 10 left`, postButton(c.auth, "/admin/account/recovery", "Make new codes", "btn btn-quiet"))}
</ul>
<h2>Where you're signed in</h2>
<ul class="rows">${ss.results
    .map((s) => row(esc(deviceName(s.user_agent || "")) + (s.id === c.auth.session.id ? " · this one" : ""), `Signed in ${esc(adminDate(s.created_at))} · last used ${esc(adminDate(s.last_seen || s.created_at))}`,
      s.id === c.auth.session.id ? "" : postButton(c.auth, "/admin/account/end", "Sign out", "btn btn-quiet", `<input type="hidden" name="sid" value="${esc(s.id)}">`)))
    .join("")}</ul>
<div class="apart">${postButton(c.auth, "/admin/account/logout-all", "Sign out everywhere", "btn btn-quiet btn-wide")}</div>`);
};

const accountRecovery: Handler = async (c) => {
  const codes = await makeRecoveryCodes(c.env.DB, c.auth.user.id);
  await audit(c.env.DB, c.auth.user.id, "Made new recovery codes");
  return codesScreen(c.auth, codes, "Your old codes no longer work.");
};

const accountEnd: Handler = async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").bind(S(c, "sid"), c.auth.user.id).run();
  await audit(c.env.DB, c.auth.user.id, "Signed out one device");
  return back("/admin/account", "That device is signed out.");
};

const accountLogoutAll: Handler = async (c) => {
  await endAllSessions(c.env.DB, c.auth.user.id);
  await audit(c.env.DB, c.auth.user.id, "Signed out everywhere");
  return redirect("/admin/login?ok=" + encodeURIComponent("You are signed out on every device."), 303, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
};

// ---------------- tours and bookings ----------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function centralAndNy(sec: number): string {
  const ny = new Date(sec * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).toLowerCase();
  return `${tourWhen(sec)} Central (${ny} New York)`;
}

const statusWords: Record<string, string> = { paid: "Paid", held: "Paying now", expired: "Not paid", cancelled: "Cancelled", refunded: "Refunded" };

const tours: Handler = async (c) => {
  const { content } = await loadDraft(c.env.DB);
  const list = await listTours(c.env.DB, now() - 6 * 3600, now() + 180 * 86400, { includeClosed: true });
  const mode = await bookingMode(c.env.DB);
  const price = content.ticket.price_amount || "70";
  const today = memphisDay(now());
  return page(c, { title: "Tours", tab: "tours", flash: flashFrom(c.url) }, `
<h1>Tours</h1>
<p class="sub">Book buttons on the site go to ${mode === "own" ? "this site's own booking pages" : "Acuity"}. <a href="/admin/booking-setup">Online booking set-up ›</a></p>
<ul class="rows">${list
    .map((t) => row(`${esc(centralAndNy(t.starts_at))}${t.status === "closed" ? " · closed" : ""}`, `${t.taken} of ${t.capacity} seats taken · ${t.left === 0 ? "sold out" : `${t.left} left`} · ${money(t.price_cents)} each`, `<a href="/admin/tours/${t.id}">Open ›</a>`, `t-${t.id}`))
    .join("") || '<li class="row"><div class="row-main"><b>No tour dates yet.</b><span class="sub">Add them below.</span></div></li>'}</ul>
<details class="card" open><summary>+ Add repeating dates</summary>
<form method="post" action="/admin/tours/repeat" class="stack">${csrf(c.auth)}
<fieldset class="field"><legend class="flabel">Days</legend><div class="row-actions">${DAYS.map((d, i) => `<label class="checkline"><input type="checkbox" name="days" value="${i}"${i === 5 || i === 6 ? " checked" : ""}><span>${d}</span></label>`).join("")}</div></fieldset>
${field("time", "Start time (Memphis)", "14:00", { type: "time", required: true })}
${field("from", "First day", today, { type: "date", required: true })}
${field("weeks", "For how many weeks", "8", { type: "number", required: true })}
${field("capacity", "Seats per tour", String(DEFAULT_CAPACITY), { type: "number", required: true, hint: "Default 30." })}
${field("price", "Price per ticket, dollars", price, { required: true, hint: "Default: the price on Tour info." })}
<div class="row-actions"><button class="btn btn-green" type="submit">+ Add these dates</button></div>
</form></details>
<details class="card"><summary>+ Add one date</summary>
<form method="post" action="/admin/tours" class="stack">${csrf(c.auth)}
${field("date", "Day", today, { type: "date", required: true })}
${field("time", "Start time (Memphis)", "14:00", { type: "time", required: true })}
${field("capacity", "Seats", String(DEFAULT_CAPACITY), { type: "number", required: true })}
${field("price", "Price per ticket, dollars", price, { required: true })}
<div class="row-actions"><button class="btn btn-green" type="submit">+ Add this date</button></div>
</form></details>
<p><a class="btn btn-quiet" href="/admin/bookings.csv">Download all bookings as a spreadsheet ›</a></p>`);
};

function priceCents(v: string): number | null {
  const m = v.trim().replace(/^\$/, "").match(/^(\d{1,5})(\.\d{1,2})?$/);
  return m ? Math.round(Number(m[0]) * 100) : null;
}

async function insertTour(db: D1Database, starts: number, capacity: number, cents: number): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO tours (starts_at, capacity, price_cents, status, created_at) VALUES (?, ?, ?, 'open', ?)").bind(starts, capacity, cents, now()).run();
  return r.meta.changes === 1;
}

const tourAdd: Handler = async (c) => {
  const starts = memphisTime(S(c, "date"), S(c, "time"));
  const cap = Number(S(c, "capacity")), cents = priceCents(S(c, "price"));
  if (!starts || starts <= now()) return back("/admin/tours", "Pick a day and time in the future.", "err");
  if (!Number.isInteger(cap) || cap < 1 || cap > 200 || cents === null) return back("/admin/tours", "Seats must be 1 to 200 and the price a number like 70.", "err");
  const ok = await insertTour(c.env.DB, starts, cap, cents);
  await audit(c.env.DB, c.auth.user.id, "Added a tour date", tourWhen(starts));
  return back("/admin/tours", ok ? `Added ${tourWhen(starts)}.` : `${tourWhen(starts)} already exists.`, ok ? "ok" : "err");
};

const tourRepeat: Handler = async (c) => {
  const days = F(c).getAll("days").map(Number).filter((d) => d >= 0 && d <= 6);
  const weeks = Math.min(52, Math.max(1, Number(S(c, "weeks")) || 0));
  const cap = Number(S(c, "capacity")), cents = priceCents(S(c, "price"));
  const from = S(c, "from"), time = S(c, "time");
  if (!days.length || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !memphisTime(from, time)) return back("/admin/tours", "Pick at least one day, a first day and a time.", "err");
  if (!Number.isInteger(cap) || cap < 1 || cap > 200 || cents === null) return back("/admin/tours", "Seats must be 1 to 200 and the price a number like 70.", "err");
  let added = 0, skipped = 0;
  const start = new Date(from + "T12:00:00Z");
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    if (!days.includes(d.getUTCDay())) continue;
    const at = memphisTime(d.toISOString().slice(0, 10), time)!;
    if (at <= now()) { skipped++; continue; }
    (await insertTour(c.env.DB, at, cap, cents)) ? added++ : skipped++;
  }
  await audit(c.env.DB, c.auth.user.id, "Added repeating tour dates", `${added} added`);
  return back("/admin/tours", `Added ${added} tour date${added === 1 ? "" : "s"}${skipped ? `; skipped ${skipped} already there or in the past` : ""}.`);
};

const tourPage: Handler = async (c, m) => {
  const t = await getTour(c.env.DB, Number(m[1]));
  if (!t) return back("/admin/tours", "That tour doesn't exist.", "err");
  const bs = await c.env.DB.prepare("SELECT * FROM bookings WHERE tour_id = ? ORDER BY (status = 'paid') DESC, created_at").bind(t.id).all<Booking>();
  const live = bs.results.filter((b) => b.status === "paid" || (b.status === "held" && (b.hold_expires_at ?? 0) > now()));
  const other = bs.results.filter((b) => !live.includes(b));
  const bRow = (b: Booking) => `<li class="row${b.status === "paid" || b.status === "held" ? "" : " is-hidden"}" id="b-${b.id}"><div class="row-main"><b>${esc(b.name)} · ${b.seats} ticket${b.seats === 1 ? "" : "s"}</b>
<span class="sub">${esc(SOURCE_NAMES[b.source] || b.source)} · ${statusWords[b.status] || esc(b.status)}${b.amount_cents ? " · " + money(b.amount_cents) : ""} · ${esc(b.ref)}${b.email ? ` · <a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ""}${b.phone ? ` · ${esc(b.phone)}` : ""}${b.email_status ? ` · email ${esc(b.email_status)}` : ""}${b.note ? ` · ${esc(b.note)}` : ""}</span></div>
<div class="row-act">${b.status === "paid" ? postButton(c.auth, `/admin/bookings/${b.id}/checkin`, b.checked_in_at ? "✓ Here" : "Check in", b.checked_in_at ? "btn btn-green" : "btn") : ""}</div>
${b.status === "paid" || b.status === "held" ? `<details class="danger"><summary>${b.source === "site" && b.status === "paid" ? "Cancel and refund ▾" : "Cancel ▾"}</summary><div class="danger-in"><p>${b.source === "site" && b.status === "paid" ? `Refunds ${money(b.amount_cents)} to their card through Stripe and frees ${b.seats} seat${b.seats === 1 ? "" : "s"}. This can't be undone.` : `Frees ${b.seats} seat${b.seats === 1 ? "" : "s"}.${b.source !== "site" ? ` Refund them on ${esc(SOURCE_NAMES[b.source] || "that site")} yourself if needed.` : ""}`}</p>
<div class="row-actions">${postButton(c.auth, `/admin/bookings/${b.id}/cancel`, "Yes, cancel" + (b.source === "site" && b.status === "paid" ? " and refund" : ""), "btn btn-red")}</div></div></details>` : ""}</li>`;
  return page(c, { title: tourWhen(t.starts_at), tab: "tours", back: { href: "/admin/tours", label: "Tours" }, flash: flashFrom(c.url) }, `
<h1>${esc(tourWhen(t.starts_at, { year: true }))}</h1>
<p class="line1">${t.taken} of ${t.capacity} seats taken · ${t.left === 0 ? "sold out" : `${t.left} left`}${t.status === "closed" ? " · closed to new bookings" : ""}</p>
<p class="row-actions"><a class="btn" href="/admin/tours/${t.id}/print">Check-in list ›</a><a class="btn btn-quiet" href="/admin/tours/${t.id}.csv">Spreadsheet ›</a></p>
<h2>Riders</h2>
<ul class="rows">${live.map(bRow).join("") || '<li class="row"><div class="row-main"><b>No bookings yet.</b></div></li>'}</ul>
<details class="card"><summary>+ Add outside booking</summary>
<form method="post" action="/admin/tours/${t.id}/outside" class="stack">${csrf(c.auth)}
<label class="field"><span class="flabel">Sold on</span><select name="source">${SOURCES.filter((x) => x !== "site").map((x) => `<option value="${x}">${esc(SOURCE_NAMES[x])}</option>`).join("")}</select></label>
${field("name", "Name", "", { required: true })}
${field("seats", "Tickets", "1", { type: "number", required: true })}
${field("note", "Note (optional)", "", { hint: "For example the Viator booking number." })}
${check("allow_over", "Allow it even if it goes over the seat limit", false)}
<div class="row-actions"><button class="btn btn-green" type="submit">+ Add</button></div>
</form></details>
<details class="card"><summary>Change seats, price or close this date</summary>
<form method="post" action="/admin/tours/${t.id}" class="stack">${csrf(c.auth)}
${field("capacity", "Seats", String(t.capacity), { type: "number", required: true })}
${field("price", "Price per ticket, dollars", String(t.price_cents / 100), { required: true, hint: "Changes the price for new bookings only." })}
${check("closed", "Closed to new bookings", t.status === "closed")}
<div class="row-actions"><button class="btn btn-green" type="submit">Save ✓</button></div>
</form></details>
${other.length ? `<details><summary>Show ${other.length} cancelled or unpaid ▾</summary><ul class="rows">${other.map(bRow).join("")}</ul></details>` : ""}`);
};

const tourSave2: Handler = async (c, m) => {
  const id = Number(m[1]);
  const cap = Number(S(c, "capacity")), cents = priceCents(S(c, "price"));
  if (!Number.isInteger(cap) || cap < 0 || cap > 200 || cents === null) return back(`/admin/tours/${id}`, "Seats must be 0 to 200 and the price a number like 70.", "err");
  await c.env.DB.prepare("UPDATE tours SET capacity = ?, price_cents = ?, status = ? WHERE id = ?").bind(cap, cents, F(c).get("closed") ? "closed" : "open", id).run();
  await audit(c.env.DB, c.auth.user.id, "Changed a tour date", `#${id}: ${cap} seats, ${money(cents)}${F(c).get("closed") ? ", closed" : ""}`);
  return back(`/admin/tours/${id}`, "Saved.");
};

const tourOutside: Handler = async (c, m) => {
  const id = Number(m[1]);
  const source = SOURCES.includes(S(c, "source") as any) && S(c, "source") !== "site" ? S(c, "source") : "other";
  const name = S(c, "name").trim().slice(0, 80);
  if (!name) return back(`/admin/tours/${id}`, "Add the rider's name.", "err");
  const r = await takeSeats(c.env.DB, { tourId: id, seats: Number(S(c, "seats")), name, email: "", phone: "", source, status: "paid", amountCents: 0, allowOver: !!F(c).get("allow_over"), note: S(c, "note").trim().slice(0, 200) });
  if (!r.ok) return back(`/admin/tours/${id}`, `${r.reason} Tick "Allow it" to add it anyway.`, "err");
  await audit(c.env.DB, c.auth.user.id, "Added an outside booking", `${SOURCE_NAMES[source]}: ${name}, ${r.booking.seats} seats`);
  return back(`/admin/tours/${id}`, `Added ${name} (${SOURCE_NAMES[source]}). Seats left went down by ${r.booking.seats}.`, "ok", `b-${r.booking.id}`);
};

const bookingCancel: Handler = async (c, m) => {
  const id = Number(m[1]);
  const b = await c.env.DB.prepare("SELECT tour_id, name FROM bookings WHERE id = ?").bind(id).first<{ tour_id: number; name: string }>();
  if (!b) return back("/admin/tours", "That booking doesn't exist.", "err");
  const r = await cancelBooking(c.env, id);
  if (r.ok) await audit(c.env.DB, c.auth.user.id, "Cancelled a booking", `${b.name}: ${r.text}`);
  return back(`/admin/tours/${b.tour_id}`, r.text, r.ok ? "ok" : "err", `b-${id}`);
};

const bookingCheckin: Handler = async (c, m) => {
  const id = Number(m[1]);
  const b = await c.env.DB.prepare("SELECT tour_id FROM bookings WHERE id = ?").bind(id).first<{ tour_id: number }>();
  if (!b) return back("/admin/tours", "That booking doesn't exist.", "err");
  await c.env.DB.prepare("UPDATE bookings SET checked_in_at = CASE WHEN checked_in_at IS NULL THEN ? ELSE NULL END WHERE id = ?").bind(now(), id).run();
  const back2 = c.url.searchParams.get("from") === "print" ? `/admin/tours/${b.tour_id}/print` : `/admin/tours/${b.tour_id}`;
  return redirect(`${back2}#b-${id}`);
};

const tourPrint: Handler = async (c, m) => {
  const t = await getTour(c.env.DB, Number(m[1]));
  if (!t) return back("/admin/tours", "That tour doesn't exist.", "err");
  const bs = await c.env.DB.prepare("SELECT * FROM bookings WHERE tour_id = ? AND status = 'paid' ORDER BY name COLLATE NOCASE").bind(t.id).all<Booking>();
  const seats = bs.results.reduce((n, b) => n + b.seats, 0);
  const here = bs.results.filter((b) => b.checked_in_at).reduce((n, b) => n + b.seats, 0);
  return frame({ auth: c.auth, title: "Check-in list", tab: "tours", back: { href: `/admin/tours/${t.id}`, label: "Back to the tour" } }, `
<h1>Check-in: ${esc(tourWhen(t.starts_at))}</h1>
<p class="line1">${here} of ${seats} riders checked in</p>
<ol class="checkin">${bs.results.map((b) => `<li id="b-${b.id}"><form method="post" action="/admin/bookings/${b.id}/checkin?from=print">${csrf(c.auth)}<button class="tick${b.checked_in_at ? " done" : ""}" type="submit" aria-label="${b.checked_in_at ? "Checked in" : "Check in"} ${esc(b.name)}">${b.checked_in_at ? "✓" : ""}</button></form>
<span><b>${esc(b.name)}</b> · ${b.seats} · ${esc(SOURCE_NAMES[b.source] || b.source)}<br><span class="sub">${esc(b.ref)}${b.phone ? " · " + esc(b.phone) : ""}</span></span></li>`).join("") || "<li>No paid bookings yet.</li>"}</ol>
<p class="sub">Print from your browser's Share or Print menu.</p>`);
};

async function bookingsCsv(c: Ctx, where: string, binds: unknown[], name: string): Promise<Response> {
  const rows = await c.env.DB.prepare(`SELECT b.*, t.starts_at FROM bookings b JOIN tours t ON t.id = b.tour_id ${where} ORDER BY t.starts_at, b.created_at`).bind(...binds).all<Record<string, any>>();
  const head = ["tour", "ref", "name", "email", "phone", "tickets", "source", "status", "paid_usd", "checked_in", "booked_at", "note"];
  const lines = [head.join(",")];
  for (const b of rows.results) {
    lines.push([tourWhen(b.starts_at, { year: true }) + " Central", b.ref, b.name, b.email, b.phone, b.seats, SOURCE_NAMES[b.source] || b.source, statusWords[b.status] || b.status, (b.amount_cents / 100).toFixed(2), b.checked_in_at ? "yes" : "", new Date(b.created_at * 1000).toISOString(), b.note].map(csvCell).join(","));
  }
  await audit(c.env.DB, c.auth.user.id, "Downloaded bookings", `${rows.results.length} rows`);
  return text(lines.join("\r\n") + "\r\n", "text/csv; charset=utf-8", 200, { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
}

const tourCsv: Handler = async (c, m) => bookingsCsv(c, "WHERE b.tour_id = ?", [Number(m[1])], `memphis-rap-tour-riders-${m[1]}.csv`);
const allCsv: Handler = async (c) => bookingsCsv(c, "", [], `memphis-rap-tour-bookings-${dayKey()}.csv`);

const bookingSetup: Handler = async (c) => {
  const ready = stripeReady(c.env);
  const mode = await bookingMode(c.env.DB);
  const tested = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE source = 'site' AND status = 'refunded' AND stripe_payment_intent IS NOT NULL AND note NOT LIKE '%TEST PAYMENT%'").first<{ n: number }>();
  const canSwitch = ready.ok && ready.live && (tested?.n ?? 0) > 0;
  const why = !ready.ok ? ready.reason : !ready.live ? "Stripe is in test mode, so real customers can't pay yet" : !(tested?.n) ? "make one real (live-mode) booking on this site and refund it first" : "";
  return page(c, { title: "Online booking", tab: "tours", back: { href: "/admin/tours", label: "Tours" }, flash: flashFrom(c.url) }, `
<h1>Online booking set-up</h1>
<ul class="rows">
${row("Payments (Stripe)", ready.ok ? (ready.live ? "Live: real cards are charged" : "Test mode: no real money moves") : esc(ready.reason), ready.ok ? '<span class="ok">✓</span>' : "")}
${row("Payment confirmations from Stripe", c.env.STRIPE_WEBHOOK_SECRET ? "Webhook secret saved" : "Webhook secret not saved yet", c.env.STRIPE_WEBHOOK_SECRET ? '<span class="ok">✓</span>' : "")}
${row("Emails (confirmations, requests, reset links)", c.env.EMAIL ? "Set up" : "Not set up yet: nothing is emailed; everything still shows in the admin", c.env.EMAIL ? '<span class="ok">✓</span>' : "")}
${row("Book buttons go to", mode === "own" ? "This site's booking pages" : "Acuity (the current booking page)", `<a href="/tickets">See the booking pages ›</a>`)}
</ul>
<form method="post" action="/admin/booking-setup" class="card stack">${csrf(c.auth)}
${mode === "own"
    ? `<p>Book buttons go to this site. Switching back sends them to Acuity again straight away.</p><input type="hidden" name="mode" value="acuity"><button class="btn btn-quiet" type="submit">Send Book buttons back to Acuity</button>`
    : `<p>When everything above is ✓ and a real test booking and refund worked, switch the Book buttons to this site.</p><input type="hidden" name="mode" value="own">${canSwitch ? '<button class="btn btn-green" type="submit">Switch Book buttons to this site ›</button>' : `<p class="flash flash-gap">Not yet: ${esc(why)}.</p>`}`}
</form>`);
};

const bookingSetupSave: Handler = async (c) => {
  const want = S(c, "mode") === "own" ? "own" : "acuity";
  if (want === "own") {
    const ready = stripeReady(c.env);
    const tested = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE source = 'site' AND status = 'refunded' AND stripe_payment_intent IS NOT NULL AND note NOT LIKE '%TEST PAYMENT%'").first<{ n: number }>();
    if (!ready.ok || !ready.live || !(tested?.n)) return back("/admin/booking-setup", "Not switched: live payments and one refunded test booking are needed first.", "err");
  }
  await setSetting(c.env.DB, "booking_mode", want);
  await audit(c.env.DB, c.auth.user.id, want === "own" ? "Switched Book buttons to this site" : "Switched Book buttons back to Acuity");
  return back("/admin/booking-setup", want === "own" ? "Done. Book buttons now go to this site." : "Done. Book buttons go to Acuity again.");
};

const ROUTES: [RegExp, string, Handler][] = [
  [/^\/admin$/, "GET", home],
  [/^\/admin\/more$/, "GET", more],
  [/^\/admin\/tours$/, "GET", tours],
  [/^\/admin\/tours$/, "POST", tourAdd],
  [/^\/admin\/tours\/repeat$/, "POST", tourRepeat],
  [/^\/admin\/tours\/(\d+)$/, "GET", tourPage],
  [/^\/admin\/tours\/(\d+)$/, "POST", tourSave2],
  [/^\/admin\/tours\/(\d+)\/outside$/, "POST", tourOutside],
  [/^\/admin\/tours\/(\d+)\/print$/, "GET", tourPrint],
  [/^\/admin\/tours\/(\d+)\.csv$/, "GET", tourCsv],
  [/^\/admin\/bookings\.csv$/, "GET", allCsv],
  [/^\/admin\/bookings\/(\d+)\/cancel$/, "POST", bookingCancel],
  [/^\/admin\/bookings\/(\d+)\/checkin$/, "POST", bookingCheckin],
  [/^\/admin\/booking-setup$/, "GET", bookingSetup],
  [/^\/admin\/booking-setup$/, "POST", bookingSetupSave],
  [/^\/admin\/publish$/, "POST", publish],
  [/^\/admin\/pages$/, "GET", pagesList],
  [/^\/admin\/pages\/([a-z-]+)$/, "GET", pageEdit],
  [/^\/admin\/pages\/([a-z-]+)$/, "POST", pageSave],
  [/^\/admin\/pages\/([a-z-]+)\/add$/, "POST", sectionAdd],
  [/^\/admin\/pages\/([a-z-]+)\/remove$/, "POST", pageRemove],
  [/^\/admin\/sections\/([\w-]+)$/, "GET", sectionEdit],
  [/^\/admin\/sections\/([\w-]+)$/, "POST", sectionSave],
  [/^\/admin\/sections\/([\w-]+)\/move$/, "POST", sectionMove],
  [/^\/admin\/sections\/([\w-]+)\/toggle$/, "POST", sectionToggle],
  [/^\/admin\/sections\/([\w-]+)\/delete$/, "POST", sectionDelete],
  [/^\/admin\/tour$/, "GET", tour],
  [/^\/admin\/tour$/, "POST", tourSave],
  [/^\/admin\/(faq|reviews)$/, "GET", listPage],
  [/^\/admin\/(faq|reviews)\/add$/, "POST", listAdd],
  [/^\/admin\/(faq|reviews)\/([\w-]+)$/, "POST", listSave],
  [/^\/admin\/(faq|reviews)\/([\w-]+)\/move$/, "POST", listMove],
  [/^\/admin\/(faq|reviews)\/([\w-]+)\/delete$/, "POST", listDelete],
  [/^\/admin\/images$/, "GET", imagesPage],
  [/^\/admin\/images$/, "POST", imageUpload],
  [/^\/admin\/images\/([\w-]+)$/, "POST", imageSave],
  [/^\/admin\/images\/([\w-]+)\/delete$/, "POST", imageDelete],
  [/^\/admin\/images\/([\w-]+)\/restore$/, "POST", imageRestore],
  [/^\/admin\/subscribers$/, "GET", subscribers],
  [/^\/admin\/subscribers\.csv$/, "GET", subscribersCsv],
  [/^\/admin\/subscribers\/(\d+)\/delete$/, "POST", subscriberDelete],
  [/^\/admin\/requests$/, "GET", requests],
  [/^\/admin\/requests\/(\d+)\/handled$/, "POST", requestHandled],
  [/^\/admin\/history$/, "GET", history],
  [/^\/admin\/history\/(\d+)\/restore$/, "POST", historyRestore],
  [/^\/admin\/password$/, "GET", password],
  [/^\/admin\/password$/, "POST", passwordSave],
  [/^\/admin\/account$/, "GET", account],
  [/^\/admin\/account\/recovery$/, "POST", accountRecovery],
  [/^\/admin\/account\/end$/, "POST", accountEnd],
  [/^\/admin\/account\/logout-all$/, "POST", accountLogoutAll],
];

export { createSession };
