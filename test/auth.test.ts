// Sign-in behaviour: wrong password, lockout that never blocks other connections, session expiry,
// CSRF, sign out everywhere, temporary passwords, recovery codes, roles.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, PBKDF2_ITER } from "../src/auth";
import { BASE, cookiesFrom, csrfOf, get, ip, login, makeUser, ORIGIN, owner, post, tryLogin } from "./helpers";

describe("passwords", () => {
  it("are PBKDF2-SHA256 with at least 100k iterations and a per-user salt", async () => {
    const a = await hashPassword("same password here");
    const b = await hashPassword("same password here");
    expect(a.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(Number(a.split("$")[1])).toBeGreaterThanOrEqual(100_000);
    expect(PBKDF2_ITER).toBeGreaterThanOrEqual(100_000);
    expect(a).not.toBe(b); // different salts
    expect(await verifyPassword("same password here", a)).toBe(true);
    expect(await verifyPassword("same password herE", a)).toBe(false);
  });
});

describe("sign in", () => {
  it("rejects a wrong password and sets no session", async () => {
    const u = await makeUser();
    const res = await tryLogin(u.email, "not the password at all");
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie") || "").not.toContain("__Host-mrt_session=");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?").bind(u.email).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("signs in with the right password: HttpOnly, Secure, SameSite=Lax, 30 days", async () => {
    const u = await makeUser();
    const res = await tryLogin(u.email, u.password);
    expect(res.status).toBe(303);
    const sc = res.headers.get("Set-Cookie") || "";
    expect(sc).toMatch(/__Host-mrt_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
    const home = await get(cookiesFrom(res), "/admin");
    expect(home.status).toBe(200);
  });

  it("locks out after 5 wrong tries from one connection, but not from another", async () => {
    const u = await makeUser();
    const attacker = ip();
    for (let i = 0; i < 5; i++) expect((await tryLogin(u.email, "wrong password " + i, attacker)).status).toBe(401);
    const blocked = await tryLogin(u.email, u.password, attacker);
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("Wait 15 minutes");
    // The owner on a different connection is never locked out by someone else's tries.
    expect((await tryLogin(u.email, u.password, ip())).status).toBe(303);
  });

  it("the lock is a sliding window, never permanent", async () => {
    const u = await makeUser();
    const from = ip();
    for (let i = 0; i < 5; i++) await tryLogin(u.email, "wrong " + i, from);
    expect((await tryLogin(u.email, u.password, from)).status).toBe(429);
    await env.DB.prepare("UPDATE attempts SET at = at - 16 * 60").run(); // 16 minutes pass
    expect((await tryLogin(u.email, u.password, from)).status).toBe(303);
  });

  it("refuses a sign-in form without its CSRF token", async () => {
    const u = await makeUser();
    const from = ip();
    const res = await SELF.fetch(`${BASE}/admin/login`, {
      method: "POST", redirect: "manual",
      headers: { ...ORIGIN, "CF-Connecting-IP": from, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: u.email, password: u.password }),
    });
    expect(res.status).toBe(403);
  });
});

describe("sessions", () => {
  it("expire: an expired session is sent back to sign in and removed", async () => {
    const { cookie } = await owner();
    expect((await get(cookie, "/admin")).status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET expires_at = unixepoch() - 1").run();
    const res = await get(cookie, "/admin");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("sign out ends the session", async () => {
    const { cookie } = await owner();
    expect((await post(cookie, "/admin/logout", {})).status).toBe(303);
    expect((await get(cookie, "/admin")).headers.get("Location")).toBe("/admin/login");
  });

  it("sign out everywhere ends every session for that person", async () => {
    const u = await makeUser();
    const a = await login(u.email, u.password);
    const b = await login(u.email, u.password);
    expect((await post(a, "/admin/account/logout-all", {})).status).toBe(303);
    expect((await get(b, "/admin")).status).toBe(303);
    expect((await get(a, "/admin")).status).toBe(303);
  });

  it("lists where you are signed in", async () => {
    const { cookie } = await owner();
    const body = await (await get(cookie, "/admin/account")).text();
    expect(body).toContain("Where you're signed in");
    expect(body).toContain("this one");
  });
});

describe("CSRF on admin POSTs", () => {
  it("refuses a POST without the token", async () => {
    const { cookie } = await owner();
    const res = await post(cookie, "/admin/publish", {}, { csrf: null });
    expect(res.status).toBe(403);
  });
  it("refuses a POST with a wrong token", async () => {
    const { cookie } = await owner();
    const res = await post(cookie, "/admin/publish", {}, { csrf: "x".repeat(32) });
    expect(res.status).toBe(403);
  });
  it("refuses a POST from another site even with the token", async () => {
    const { cookie } = await owner();
    const token = await csrfOf(cookie);
    const res = await post(cookie, "/admin/publish", {}, { csrf: token, headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
  it("accepts a POST with the right token", async () => {
    const { cookie } = await owner();
    expect((await post(cookie, "/admin/publish", {})).status).toBe(303);
  });
});

describe("temporary passwords and recovery codes", () => {
  it("a temporary password must be changed first; then 10 recovery codes are shown once and each works once", async () => {
    const u = await makeUser({ mustChange: true });
    const cookie = await login(u.email, u.password);
    expect((await get(cookie, "/admin")).headers.get("Location")).toBe("/admin/password");
    const res = await post(cookie, "/admin/password", { current: u.password, new_password: "a brand new long password", repeat: "a brand new long password" }, { csrf: await csrfOf(cookie, "/admin/password") });
    expect(res.status).toBe(200);
    const codes = [...(await res.text()).matchAll(/<code>([a-z0-9]{5}-[a-z0-9]{5})<\/code>/g)].map((m) => m[1]);
    expect(codes).toHaveLength(10);
    expect((await get(cookie, "/admin")).status).toBe(200);

    const recover = async (code: string, pw: string) => {
      const from = ip();
      const page = await SELF.fetch(`${BASE}/admin/recover`, { headers: { "CF-Connecting-IP": from } });
      const lc = (await page.text()).match(/name="lc" value="([^"]+)"/)![1];
      return SELF.fetch(`${BASE}/admin/recover`, {
        method: "POST", redirect: "manual",
        headers: { ...ORIGIN, Cookie: cookiesFrom(page), "CF-Connecting-IP": from, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ lc, email: u.email, code, new_password: pw }),
      });
    };
    expect((await recover(codes[0], "recovered password one")).status).toBe(303);
    expect((await tryLogin(u.email, "recovered password one")).status).toBe(303);
    expect((await recover(codes[0], "recovered password two")).status).toBe(401); // used up
    expect((await recover("zzzzz-zzzzz", "recovered password two")).status).toBe(401);
  });
});

describe("roles", () => {
  it("an editor cannot manage the team, see the email list, remove sections or change the Book link", async () => {
    const e = await makeUser({ role: "editor" });
    const cookie = await login(e.email, e.password);
    expect((await get(cookie, "/admin/team")).status).toBe(403);
    expect((await get(cookie, "/admin/subscribers")).status).toBe(403);
    expect((await get(cookie, "/admin/subscribers.csv")).status).toBe(403);
    expect((await post(cookie, "/admin/sections/home-faq/delete", {})).status).toBe(403);
    expect((await get(cookie, "/admin/requests")).status).toBe(200);
    const tour = await (await get(cookie, "/admin/tour")).text();
    const fields: Record<string, string> = {};
    for (const m of tour.matchAll(/name="([a-z_]+)"[^>]*value="([^"]*)"/g)) fields[m[1]] = m[2].replace(/&amp;/g, "&");
    fields.stops = "Beale Street";
    fields.book_url = "https://evil.example/book";
    expect((await post(cookie, "/admin/tour", fields)).status).toBe(303);
    const draft = await env.DB.prepare("SELECT content FROM versions WHERE id = (SELECT value FROM settings WHERE key = 'draft_version')").first<{ content: string }>();
    expect(JSON.parse(draft!.content).ticket.book_url).toBe("https://app.acuityscheduling.com/schedule.php?owner=35599844");
  });

  it("the owner adds Taylor and resets her password; the old one stops working", async () => {
    const { cookie } = await owner();
    const email = `taylor${Date.now()}@example.org`;
    const added = await post(cookie, "/admin/team/add", { name: "Taylor", email, role: "editor" }, { csrf: await csrfOf(cookie, "/admin/team") });
    const temp1 = (await added.text()).match(/<code class="big">([^<]+)<\/code>/)![1];
    expect((await tryLogin(email, temp1)).status).toBe(303);
    const id = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: number }>())!.id;
    const reset = await post(cookie, `/admin/team/${id}/reset`, {}, { csrf: await csrfOf(cookie, "/admin/team") });
    const temp2 = (await reset.text()).match(/<code class="big">([^<]+)<\/code>/)![1];
    expect(temp2).not.toBe(temp1);
    expect((await tryLogin(email, temp1)).status).toBe(401);
    expect((await tryLogin(email, temp2)).status).toBe(303);
  });
});
