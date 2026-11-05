// End-to-end check of a running site (live preview or local). Run under the vault so passwords are
// never typed or printed:
//   vault run -- node scripts/verify-live.mjs <site url> [--local] [--booking]
// 1. Every sitemap page answers 200, has one H1, parseable JSON-LD, no phone number; Book reaches Acuity.
// 2. The shared login accepts the temporary password (MRT_ADMIN_TEMP_PASSWORD_CARLOS) and asks for a new
//    one. It is NOT changed, so Carlos's first sign-in (and his recovery codes) stay his.
// 3. With a short-lived verification account (removed at the end): a section edit shows on the site after
//    publish, then History › Restore puts it back; a test sign-up appears in the admin, then is deleted.
// 4. --booking: a test tour date, a real Stripe TEST-mode checkout start, the hold, then cancel; removed.
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";

const SITE = (process.argv[2] || "").replace(/\/+$/, "");
const LOCAL = process.argv.includes("--local");
const BOOKING = process.argv.includes("--booking");
if (!SITE) { console.error("NAMED STOP [NO_SITE] give the site address"); process.exit(2); }
const results = [];
const ok = (name, cond, detail = "") => { results.push([cond ? "CONFIRMED" : "FAILED", name, detail]); return cond; };
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "mrt-site", LOCAL ? "--local" : "--remote", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const UA = { "User-Agent": "MemphisRapTourSiteCheck/verify" };
const PHONE = /(\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

class Jar {
  constructor() { this.c = new Map(); }
  take(res) { for (const s of res.headers.getSetCookie?.() || []) { const [kv] = s.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/i.test(s)) this.c.delete(k); else this.c.set(k, v); } }
  get header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}
async function req(jar, path, init = {}) {
  const res = await fetch(SITE + path, { redirect: "manual", ...init, headers: { ...UA, Origin: SITE, ...(jar ? { Cookie: jar.header } : {}), ...(init.headers || {}) } });
  jar?.take(res);
  return res;
}
const form = (o) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
async function csrf(jar, path) { const t = await (await req(jar, path)).text(); return (t.match(/name="csrf" value="([^"]+)"/) || [])[1]; }
async function signIn(email, password) {
  const jar = new Jar();
  const page = await (await req(jar, "/admin/login")).text();
  const lc = page.match(/name="lc" value="([^"]+)"/)[1];
  const res = await req(jar, "/admin/login", form({ lc, email, password }));
  return { jar, res };
}

async function main() {
  // 1. public pages
  const sm = await (await req(null, "/sitemap.xml")).text();
  const pages = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  ok("sitemap lists the pages", pages.length >= 7, `${pages.length} pages`);
  for (const p of pages) {
    const r = await req(null, p);
    const body = await r.text();
    const ld = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let parsed = false, types = [];
    try { types = JSON.parse(ld[1])["@graph"].map((n) => n["@type"]); parsed = true; } catch {}
    ok(`${p} answers 200 with one H1, schema that parses, no phone number`, r.status === 200 && (body.match(/<h1[\s>]/g) || []).length === 1 && parsed && !PHONE.test(body), `${r.status}; ${types.join(", ")}`);
  }
  const home = await (await req(null, "/")).text();
  const books = [...new Set([...home.matchAll(/href="(\/go\/book\?from=[a-z-]+)"/g)].map((m) => m[1]))];
  const go = await req(null, books[0] || "/go/book");
  ok("Book buttons go to Acuity", go.status === 302 && go.headers.get("location") === "https://app.acuityscheduling.com/schedule.php?owner=35599844", `${books.length} distinct Book links; → ${go.headers.get("location")}`);
  for (const f of ["/robots.txt", "/llms.txt", "/og/home.png", "/photos/mural.jpg", "/assets/site.css"]) ok(`${f} answers 200`, (await req(null, f)).status === 200);

  // 2. the shared login with the temporary password (not changed)
  const temp = process.env.MRT_ADMIN_TEMP_PASSWORD_CARLOS;
  if (!temp) throw Object.assign(new Error("NAMED STOP [NO_TEMP_PASSWORD] run under `vault run --`"), { code: 3 });
  const t = await signIn("team@memphisraptour.com", temp);
  ok("the shared login works with the temporary password and asks for a new one", t.res.status === 303 && t.res.headers.get("location") === "/admin/password");
  const tc = await csrf(t.jar, "/admin/password");
  await req(t.jar, "/admin/logout", form({ csrf: tc }));

  // 3. verification account
  const vEmail = `verify-${Date.now()}@example.org`;
  const vPw = randomBytes(18).toString("base64url");
  const salt = randomBytes(16);
  const hash = `pbkdf2-sha256$100000$${salt.toString("base64")}$${pbkdf2Sync(vPw, salt, 100000, 32, "sha256").toString("base64")}`;
  d1(`INSERT INTO users (email, name, role, pw_hash, must_change) VALUES (${q(vEmail)}, 'Site check (removed after)', 'owner', ${q(hash)}, 0)`);
  try {
    const v = await signIn(vEmail, vPw);
    ok("a signed-in session opens the admin", v.res.status === 303 && (await req(v.jar, "/admin")).status === 200);
    const marker = `Site check ${Date.now()}`;
    const live0 = Number(d1("SELECT value FROM settings WHERE key = 'published_version'").results[0].value);
    let c = await csrf(v.jar, "/admin/sections/home-expect");
    const sec = await (await req(v.jar, "/admin/sections/home-expect")).text();
    const body = (sec.match(/<textarea id="f-body" name="body"[^>]*>([\s\S]*?)<\/textarea>/) || [])[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    await req(v.jar, "/admin/sections/home-expect", form({ csrf: c, heading: marker, body: body || "" }));
    ok("the edit is not live before Publish", !(await (await req(null, "/")).text()).includes(marker));
    ok("Preview shows the edit", (await (await req(v.jar, "/admin/preview/")).text()).includes(marker));
    c = await csrf(v.jar, "/admin");
    await req(v.jar, "/admin/publish", form({ csrf: c }));
    ok("after Publish the edit shows on the site", (await (await req(null, "/")).text()).includes(marker));
    c = await csrf(v.jar, "/admin/history");
    await req(v.jar, `/admin/history/${live0}/restore`, form({ csrf: c }));
    const after = await (await req(null, "/")).text();
    ok("History › Restore puts the site back", !after.includes(marker) && after.includes("What happens on the tour?"));

    const sEmail = `signup-check-${Date.now()}@example.org`;
    const s = await req(null, "/subscribe", form({ email: sEmail, first_name: "Check", consent: "yes", source: "verify", website: "" }));
    ok("a test sign-up is accepted", s.status === 303);
    const list = await (await req(v.jar, "/admin/subscribers")).text();
    ok("the sign-up appears in the admin", list.includes(sEmail));
    const sid = d1(`SELECT id FROM subscribers WHERE email = ${q(sEmail)}`).results[0]?.id;
    c = await csrf(v.jar, "/admin/subscribers");
    await req(v.jar, `/admin/subscribers/${sid}/delete`, form({ csrf: c }));
    ok("the test sign-up is deleted", d1(`SELECT COUNT(*) AS n FROM subscribers WHERE email = ${q(sEmail)}`).results[0].n === 0);

    if (BOOKING) {
      const at = Math.floor(Date.now() / 1000) + 400 * 86400;
      d1(`INSERT INTO tours (starts_at, capacity, price_cents, status, created_at) VALUES (${at}, 3, 7000, 'open', unixepoch())`);
      const tid = d1(`SELECT id FROM tours WHERE starts_at = ${at}`).results[0].id;
      try {
        const b = await req(null, `/tickets/${tid}`, form({ seats: "2", name: "Site check", email: "rider-check@example.org", phone: "" }));
        const loc = b.headers.get("location") || "";
        ok("checkout starts a real Stripe TEST-mode session", b.status === 303 && loc.startsWith("https://checkout.stripe.com/"), loc.slice(0, 48));
        const row = d1(`SELECT * FROM bookings WHERE tour_id = ${tid}`).results[0];
        ok("the seats are held for 15 minutes", row?.status === "held" && row.hold_expires_at - row.created_at === 900);
        ok("the tour shows 1 seat left", (await (await req(null, `/tickets/${tid}`)).text()).includes("Only 1 left"));
      } finally {
        d1(`DELETE FROM bookings WHERE tour_id = ${tid}`);
        d1(`DELETE FROM tours WHERE id = ${tid}`);
      }
    }
  } finally {
    d1(`DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${q(vEmail)})`);
    d1(`DELETE FROM users WHERE email = ${q(vEmail)}`);
  }
  ok("the verification account is gone", d1(`SELECT COUNT(*) AS n FROM users WHERE email = ${q(vEmail)}`).results[0].n === 0);

  for (const [s, n, d] of results) console.log(`${s.padEnd(9)} ${n}${d ? ` (${d})` : ""}`);
  const failed = results.filter(([s]) => s !== "CONFIRMED").length;
  console.log(`${results.length - failed} of ${results.length} checks confirmed on ${SITE}`);
  return failed ? 1 : 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(e.code ?? 9); });
