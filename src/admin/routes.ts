// Every /admin route. Each one checks who is asking; every POST checks CSRF; owner-only actions check the role.
import {
  attemptLogin, type Auth, createSession, csrfOk, endAllSessions, endSession, getAuth, hashPassword, LOGIN_CSRF_COOKIE,
  loginCsrfOk, makeRecoveryCodes, passwordProblem, recoverWithCode, recoveryCodesLeft, SESSION_COOKIE, SESSION_DAYS,
  sessionCookie, tempPassword, verifyPassword,
} from "../auth";
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

const roleName = (r: string) => (r === "owner" ? "Owner" : "Editor");

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
${field("email", "Email", email, { type: "email", required: true, autocomplete: "username" })}
${field("password", "Password", "", { type: "password", required: true, autocomplete: "current-password" })}
<button class="btn btn-green btn-wide" type="submit">Sign in ›</button>
</form>
<p class="sub">Forgot your password? <a href="/admin/recover">Use a recovery code ›</a> or ask Carlos to reset it.</p>`,
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
  const waiting = (await db.prepare("SELECT COUNT(*) AS n FROM tour_requests WHERE handled_at IS NULL").first<{ n: number }>())?.n ?? 0;
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short" });
  const needs = (n ? 1 : 0) + (waiting ? 1 : 0);
  const line1 = needs
    ? `${today} · ${needs} need${needs === 1 ? "s" : ""} you${n ? ` · changes not live yet` : ""}${waiting ? ` · ${waiting} tour request${waiting === 1 ? "" : "s"} waiting` : ""}`
    : `${today} · All clear: the site is live and up to date`;
  return page(c, { title: "Home", tab: "home", flash: flashFrom(c.url) }, `
<p class="line1">${esc(line1)}</p>
<h1>Hi ${esc(c.auth.user.name.split(" ")[0])}</h1>
${codes === 0 ? `<p class="flash flash-gap">You have no recovery codes left. <a href="/admin/account">Make new ones ›</a></p>` : ""}
<section class="card">
<h2>Last 7 days</h2>
<p class="big">${cm.view || 0} visits · ${cm.book || 0} Book taps</p>
<p class="sub">Counted on this site, without cookies. Book taps send people on to the booking page.${
    top.results.length ? ` Most Book taps from: ${top.results.map((r) => `${esc(r.path)} (${r.n})`).join(", ")}.` : ""
  }</p>
</section>
<ul class="rows">
${waiting ? row(`${waiting} private tour request${waiting === 1 ? "" : "s"} waiting`, "Reply by email, then mark handled", '<a href="/admin/requests">Open ›</a>') : ""}
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
${row("Private tour requests", "Groups asking for a private tour", '<a href="/admin/requests">Open ›</a>')}
${row("Questions (FAQ)", "Add, edit and order the questions", '<a href="/admin/faq">Open ›</a>')}
${row("Reviews", "Short quotes from Tripadvisor", '<a href="/admin/reviews">Open ›</a>')}
${row("Photos", "Upload, describe and remove photos", '<a href="/admin/images">Open ›</a>')}
${row("History", "Every save, who made it, and one-tap restore", '<a href="/admin/history">Open ›</a>')}
${owner ? row("Email list", "Everyone who signed up, and a spreadsheet download", '<a href="/admin/subscribers">Open ›</a>') : ""}
${owner ? row("Team", "Add Taylor or anyone else, reset a password", '<a href="/admin/team">Open ›</a>') : ""}
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
${owner ? "" : `<p class="sub">Only Carlos can remove a section for good. You can hide one instead.</p>`}`);
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
${owner ? "" : ""}`);
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
<p class="sub">${esc(c.auth.user.name)} · ${esc(c.auth.user.email)} · ${roleName(c.auth.user.role)}</p>
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

// ---------------- team (owner only) ----------------

function tempShown(auth: Auth, who: string, email: string, pw: string, what: string): Response {
  return frame({ auth, title: "Temporary password", tab: "more", back: { href: "/admin/team", label: "Team" } }, `
<h1>${esc(what)}</h1>
<p>Give ${esc(who)} this temporary password in person or by text. They choose their own the first time they sign in. <b>It is shown only once.</b></p>
<div class="card stack"><span class="label">Sign in at</span><code>/admin</code><span class="label">Email</span><code>${esc(email)}</code><span class="label">Temporary password</span><code class="big">${esc(pw)}</code></div>
<p><a class="btn btn-green btn-wide" href="/admin/team">Done ✓</a></p>`);
}

const team: Handler = async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const us = await c.env.DB.prepare("SELECT id, name, email, role, must_change, disabled FROM users ORDER BY id").all<Record<string, any>>();
  return page(c, { title: "Team", tab: "more", back: { href: "/admin/more", label: "More" }, flash: flashFrom(c.url) }, `
<h1>Team</h1>
<p class="sub">Editors can change words, photos, questions and reviews. Only the owner can manage the team, download the email list, remove sections for good and change the Book link.</p>
<ul class="rows">${us.results
    .map((u) => `<li class="row" id="u-${u.id}"><div class="row-main"><b>${esc(u.name)} · ${roleName(u.role)}</b><span class="sub">${esc(u.email)}${u.must_change ? " · hasn't chosen a password yet" : ""}${u.disabled ? " · access turned off" : ""}</span></div>
<div class="row-act">${u.id === c.auth.user.id ? "" : `${postButton(c.auth, `/admin/team/${u.id}/reset`, "Reset password", "btn btn-quiet")}${postButton(c.auth, `/admin/team/${u.id}/access`, u.disabled ? "Turn access on" : "Turn access off", "btn btn-quiet")}`}</div></li>`)
    .join("")}</ul>
<details class="card"><summary>+ Add a person</summary>
<form method="post" action="/admin/team/add" class="stack">${csrf(c.auth)}
${field("name", "Name", "", { required: true })}
${field("email", "Email", "", { type: "email", required: true })}
<label class="field"><span class="flabel">Role</span><select name="role"><option value="editor" selected>Editor (Default)</option><option value="owner">Owner</option></select></label>
<div class="row-actions"><button class="btn btn-green" type="submit">+ Add and show a temporary password</button></div>
</form></details>`);
};

const teamAdd: Handler = async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const name = S(c, "name").trim().slice(0, 80), email = S(c, "email").trim().toLowerCase().slice(0, 254);
  const role = S(c, "role") === "owner" ? "owner" : "editor";
  if (!name || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return back("/admin/team", "Add a name and a real email address.", "err");
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (exists) return back("/admin/team", "That email is already on the team. Use Reset password instead.", "err");
  const pw = tempPassword();
  await c.env.DB.prepare("INSERT INTO users (email, name, role, pw_hash, must_change, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .bind(email, name, role, await hashPassword(pw), now(), now())
    .run();
  await audit(c.env.DB, c.auth.user.id, "Added a person to the team", `${name} (${roleName(role)})`);
  return tempShown(c.auth, name, email, pw, `${name} is on the team`);
};

const teamReset: Handler = async (c, m) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const id = Number(m[1]);
  if (id === c.auth.user.id) return back("/admin/team", "Change your own password on Your account.", "err");
  const u = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?").bind(id).first<{ id: number; name: string; email: string }>();
  if (!u) return back("/admin/team", "That person isn't on the team.", "err");
  const pw = tempPassword();
  await c.env.DB.prepare("UPDATE users SET pw_hash = ?, must_change = 1, updated_at = ? WHERE id = ?").bind(await hashPassword(pw), now(), id).run();
  await endAllSessions(c.env.DB, id);
  await c.env.DB.prepare("DELETE FROM attempts WHERE kind = 'login_acct'").run(); // clears any wait on their sign-in
  await audit(c.env.DB, c.auth.user.id, "Reset a password", u.name);
  return tempShown(c.auth, u.name, u.email, pw, `New temporary password for ${u.name}`);
};

const teamAccess: Handler = async (c, m) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const id = Number(m[1]);
  if (id === c.auth.user.id) return back("/admin/team", "You can't turn off your own access.", "err");
  await c.env.DB.prepare("UPDATE users SET disabled = 1 - disabled, updated_at = ? WHERE id = ?").bind(now(), id).run();
  await endAllSessions(c.env.DB, id);
  await audit(c.env.DB, c.auth.user.id, "Turned someone's access on or off", `#${id}`);
  return back("/admin/team", "Done.", "ok", `u-${id}`);
};

const ROUTES: [RegExp, string, Handler][] = [
  [/^\/admin$/, "GET", home],
  [/^\/admin\/more$/, "GET", more],
  [/^\/admin\/publish$/, "POST", publish],
  [/^\/admin\/pages$/, "GET", pagesList],
  [/^\/admin\/pages\/([a-z-]+)$/, "GET", pageEdit],
  [/^\/admin\/pages\/([a-z-]+)$/, "POST", pageSave],
  [/^\/admin\/pages\/([a-z-]+)\/add$/, "POST", sectionAdd],
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
  [/^\/admin\/team$/, "GET", team],
  [/^\/admin\/team\/add$/, "POST", teamAdd],
  [/^\/admin\/team\/(\d+)\/reset$/, "POST", teamReset],
  [/^\/admin\/team\/(\d+)\/access$/, "POST", teamAccess],
];

export { createSession };
