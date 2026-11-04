// Email list and private tour requests: valid, duplicate, honeypot, rate limit, consent, unsubscribe, CSV.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { unsubToken } from "../src/subscribe";
import { BASE, get, ip, ORIGIN, owner, post, publicPage } from "./helpers";

function form(path: string, fields: Record<string, string>, from = ip()) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...ORIGIN, "CF-Connecting-IP": from, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}
const count = async (email: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE email = ?").bind(email).first<{ n: number }>())!.n;

describe("email sign-up", () => {
  it("saves a valid sign-up with the consent words, time and page", async () => {
    await publicPage("/");
    const res = await form("/subscribe", { email: "rider1@example.org", first_name: "Ana", consent: "yes", source: "home", website: "" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toMatch(/^\/subscribe\/thanks\?id=\d+&t=/);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = 'rider1@example.org'").first<any>();
    expect(row.first_name).toBe("Ana");
    expect(row.source).toBe("home");
    expect(row.consent_text).toContain("email me tour dates");
    expect(row.created_at).toBeGreaterThan(0);
    const thanks = await publicPage(res.headers.get("Location")!);
    expect(thanks.body).toContain("You&#39;re on the list");
    expect(thanks.body).toContain("Unsubscribe ›");
  });

  it("a duplicate sign-up keeps one row", async () => {
    await form("/subscribe", { email: "dup@example.org", consent: "yes", source: "home" });
    const again = await form("/subscribe", { email: "DUP@example.org", consent: "yes", source: "faq" });
    expect(again.status).toBe(303);
    expect(await count("dup@example.org")).toBe(1);
  });

  it("the honeypot field saves nothing but looks like success", async () => {
    const res = await form("/subscribe", { email: "bot@example.org", consent: "yes", website: "http://spam.example" });
    expect(res.status).toBe(303);
    expect(await count("bot@example.org")).toBe(0);
  });

  it("refuses without the consent box ticked, and refuses a bad address", async () => {
    expect((await form("/subscribe", { email: "noconsent@example.org" })).status).toBe(400);
    expect(await count("noconsent@example.org")).toBe(0);
    expect((await form("/subscribe", { email: "not-an-email", consent: "yes" })).status).toBe(400);
  });

  it("limits sign-ups per connection", async () => {
    const from = ip();
    for (let i = 0; i < 5; i++) expect((await form("/subscribe", { email: `burst${i}@example.org`, consent: "yes" }, from)).status).toBe(303);
    expect((await form("/subscribe", { email: "burst6@example.org", consent: "yes" }, from)).status).toBe(429);
    expect(await count("burst6@example.org")).toBe(0);
  });

  it("unsubscribe: a forged link fails; the real one works in one tap", async () => {
    await form("/subscribe", { email: "leaver@example.org", consent: "yes" });
    const row = await env.DB.prepare("SELECT id FROM subscribers WHERE email = 'leaver@example.org'").first<{ id: number }>();
    const bad = await SELF.fetch(`${BASE}/unsubscribe?id=${row!.id}&t=forged`);
    expect(bad.status).toBe(400);
    const t = await unsubToken(env as any, row!.id);
    const page = await SELF.fetch(`${BASE}/unsubscribe?id=${row!.id}&t=${t}`);
    expect(page.status).toBe(200);
    expect((await env.DB.prepare("SELECT unsubscribed_at FROM subscribers WHERE id = ?").bind(row!.id).first<any>()).unsubscribed_at).toBeNull(); // opening the link alone changes nothing
    const done = await form("/unsubscribe", { id: String(row!.id), t });
    expect(done.status).toBe(200);
    expect((await env.DB.prepare("SELECT unsubscribed_at FROM subscribers WHERE id = ?").bind(row!.id).first<any>()).unsubscribed_at).not.toBeNull();
  });

  it("the owner sees the list and downloads a CSV that can't run spreadsheet formulas", async () => {
    await form("/subscribe", { email: "csv@example.org", first_name: "=HYPERLINK(\"x\")", consent: "yes" });
    const { cookie } = await owner();
    expect(await (await get(cookie, "/admin/subscribers")).text()).toContain("csv@example.org");
    const csv = await (await get(cookie, "/admin/subscribers.csv")).text();
    expect(csv.split("\r\n")[0]).toBe("email,first_name,signed_up,source,consent_text,unsubscribed,unsubscribe_link");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toMatch(/\/unsubscribe\?id=\d+&t=/);
  });

  it("the owner can delete someone from the list", async () => {
    await form("/subscribe", { email: "remove-me@example.org", consent: "yes" });
    const { cookie } = await owner();
    const id = (await env.DB.prepare("SELECT id FROM subscribers WHERE email = 'remove-me@example.org'").first<{ id: number }>())!.id;
    await post(cookie, `/admin/subscribers/${id}/delete`, {});
    expect(await count("remove-me@example.org")).toBe(0);
  });
});

describe("private tour requests", () => {
  it("saves a request, shows it in the admin and marks it handled", async () => {
    const res = await form("/private-tours/request", { name: "Jo", email: "jo@example.org", date_wanted: "Sat 12 Dec", group_size: "14", occasion: "Birthday", message: "Hi" });
    expect(res.headers.get("Location")).toBe("/private-tours/thanks");
    const { cookie } = await owner();
    const list = await (await get(cookie, "/admin/requests")).text();
    expect(list).toContain("Jo · 14 riding · Sat 12 Dec");
    const id = (await env.DB.prepare("SELECT id FROM tour_requests WHERE email = 'jo@example.org'").first<{ id: number }>())!.id;
    await post(cookie, `/admin/requests/${id}/handled`, {});
    expect((await env.DB.prepare("SELECT handled_at FROM tour_requests WHERE id = ?").bind(id).first<any>()).handled_at).not.toBeNull();
  });
  it("the honeypot saves nothing", async () => {
    await form("/private-tours/request", { name: "Bot", email: "bot2@example.org", group_size: "5", website: "x" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tour_requests WHERE email = 'bot2@example.org'").first<{ n: number }>())!.n).toBe(0);
  });
});
