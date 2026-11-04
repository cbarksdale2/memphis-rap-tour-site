// Sections: add, edit, reorder, hide, remove; drafts stay off the live site until Publish; preview shows
// the draft; every save is a version; restore brings the live site back exactly.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { csrfOf, flash, get, owner, post, publicPage } from "./helpers";

async function draft() {
  const r = await env.DB.prepare("SELECT content FROM versions WHERE id = (SELECT value FROM settings WHERE key = 'draft_version')").first<{ content: string }>();
  return JSON.parse(r!.content);
}
const homeIds = async () => (await draft()).pages.find((p: any) => p.slug === "home").sections.map((s: any) => s.id);

describe("sections", () => {
  it("add → edit → shows in preview, not live → publish → live", async () => {
    const { cookie } = await owner();
    await publicPage("/"); // seeds content
    const add = await post(cookie, "/admin/pages/home/add", { type: "text" });
    expect(add.status).toBe(303);
    const id = add.headers.get("Location")!.match(/\/admin\/sections\/([\w-]+)/)![1];
    const form = await (await get(cookie, `/admin/sections/${id}`)).text();
    expect(form).toContain('name="heading"');
    const save = await post(cookie, `/admin/sections/${id}`, { heading: "Test heading zebra", body: "Hello **there** [faq](/faq)" }, { csrf: await csrfOf(cookie, `/admin/sections/${id}`) });
    expect(flash(save)).toContain("Saved");

    expect((await publicPage("/")).body).not.toContain("Test heading zebra");
    const preview = await (await get(cookie, "/admin/preview/")).text();
    expect(preview).toContain("Test heading zebra");
    expect(preview).toContain("<strong>there</strong>");
    expect(preview).toContain("Preview: not live yet");

    await post(cookie, "/admin/publish", {});
    const live = (await publicPage("/")).body;
    expect(live).toContain("Test heading zebra");
    expect(live).not.toContain("Preview: not live yet");
  });

  it("reorders with up and down", async () => {
    const { cookie } = await owner();
    await publicPage("/");
    const before = await homeIds();
    await post(cookie, `/admin/sections/${before[1]}/move`, { dir: "up" });
    const after = await homeIds();
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    await post(cookie, `/admin/sections/${before[1]}/move`, { dir: "down" });
    expect(await homeIds()).toEqual(before);
  });

  it("hides and shows a section on the site", async () => {
    const { cookie } = await owner();
    await post(cookie, "/admin/sections/home-stops/toggle", {});
    await post(cookie, "/admin/publish", {});
    expect((await publicPage("/")).body).not.toContain("Side A · The route");
    await post(cookie, "/admin/sections/home-stops/toggle", {});
    await post(cookie, "/admin/publish", {});
    expect((await publicPage("/")).body).toContain("Side A · The route");
  });

  it("removes a section, and restore from History brings the live site back", async () => {
    const { cookie } = await owner();
    await post(cookie, "/admin/publish", {});
    const liveBefore = (await publicPage("/")).body;
    expect(liveBefore).toContain("What do riders say?");
    const goodVersion = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'published_version'").first<{ value: string }>())!.value;

    await post(cookie, "/admin/sections/home-reviews/delete", {});
    await post(cookie, "/admin/publish", {});
    expect((await publicPage("/")).body).not.toContain("What do riders say?");

    const res = await post(cookie, `/admin/history/${goodVersion}/restore`, {}, { csrf: await csrfOf(cookie, "/admin/history") });
    expect(flash(res)).toContain("Restored");
    expect((await publicPage("/")).body).toContain("What do riders say?");
    expect((await homeIds())).toContain("home-reviews");
  });

  it("every save is a version and is in the audit log with who did it", async () => {
    const { cookie } = await owner();
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())!.n;
    await post(cookie, "/admin/sections/home-stops/toggle", {});
    await post(cookie, "/admin/sections/home-stops/toggle", {});
    const after = (await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())!.n;
    expect(after - before).toBe(2);
    const hist = await (await get(cookie, "/admin/history")).text();
    expect(hist).toContain("Showed a section");
    expect(hist).toContain("Test Person");
  });

  it("refuses an unsafe link in a section", async () => {
    const { cookie } = await owner();
    const res = await post(cookie, "/admin/sections/home-about", { heading: "x", body: "y", image: "", link_text: "Go", link_href: "javascript:alert(1)" }, { csrf: await csrfOf(cookie, "/admin/sections/home-about") });
    expect(flash(res)).toContain("must be a web address");
  });

  it("escapes HTML typed into a section", async () => {
    const { cookie } = await owner();
    await post(cookie, "/admin/sections/home-expect", { heading: "<script>alert(1)</script>", body: "<img src=x onerror=alert(1)>" }, { csrf: await csrfOf(cookie, "/admin/sections/home-expect") });
    const preview = await (await get(cookie, "/admin/preview/")).text();
    expect(preview).not.toContain("<script>alert(1)</script>");
    expect(preview).not.toContain("<img src=x");
    expect(preview).toContain("&lt;script&gt;");
  });
});

describe("tour info", () => {
  it("a price typed once shows on every page that uses it", async () => {
    const { cookie } = await owner();
    const tour = await (await get(cookie, "/admin/tour")).text();
    const fields: Record<string, string> = {};
    for (const m of tour.matchAll(/name="([a-z_]+)"[^>]*value="([^"]*)"/g)) fields[m[1]] = m[2].replace(/&amp;/g, "&");
    fields.stops = (await draft()).stops.map((s: any) => s.name).join("\n");
    fields.price_text = "$71 per person";
    await post(cookie, "/admin/tour", fields);
    await post(cookie, "/admin/publish", {});
    expect((await publicPage("/")).body).toContain("$71 per person");
    expect((await publicPage("/faq")).body).toContain("$71 per person");
    // put it back the way it was
    fields.price_text = "$70 per person";
    await post(cookie, "/admin/tour", fields);
    await post(cookie, "/admin/publish", {});
  });
});
