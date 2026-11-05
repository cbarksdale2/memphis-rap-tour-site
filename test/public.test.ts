// The public site: every page answers 200 with one H1, title, description, canonical and share image;
// schema parses and holds the right types; Book goes to Acuity; no phone number; crawl files; preview
// hosts are noindex.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, publicPage } from "./helpers";

const PAGES = ["/", "/memphis-hip-hop-tour", "/book", "/reviews", "/private-tours", "/faq", "/privacy"];
const ACUITY = "https://app.acuityscheduling.com/schedule.php?owner=35599844";
const PHONE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

function ld(body: string): any {
  const m = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m, "JSON-LD present").toBeTruthy();
  return JSON.parse(m![1]);
}
const types = (g: any) => g["@graph"].flatMap((n: any) => [n["@type"]].flat());

describe("public pages", () => {
  for (const p of PAGES) {
    it(`${p} answers 200 with the page shape`, async () => {
      const { status, body } = await publicPage(p);
      expect(status).toBe(200);
      expect(body.match(/<h1[\s>]/g)).toHaveLength(1);
      expect(body).toMatch(/<title>[^<]{10,}<\/title>/);
      expect(body).toMatch(/<meta name="description" content="[^"]{40,}">/);
      expect(body).toMatch(/<link rel="canonical" href="https:\/\/example\.com/);
      expect(body).toMatch(/<meta property="og:image" content="https:\/\/example\.com\/og\/[a-z]+\.png">/);
      expect(body).toContain('class="definition"');
      expect(body).not.toMatch(PHONE);
      expect(body).not.toMatch(/fair use/i);
      expect(body).not.toMatch(/\[MISSING\]/);
      expect(body).not.toMatch(/<script(?! type="application\/ld\+json")/); // no scripts on the public site
      const g = ld(body);
      expect(types(g)).toContain("TravelAgency");
      if (p !== "/") expect(types(g)).toContain("BreadcrumbList");
    });
  }

  it("home and the route page carry the tour as a TouristTrip with 8 stops in order and the $70 offer", async () => {
    for (const p of ["/", "/memphis-hip-hop-tour"]) {
      const g = ld((await publicPage(p)).body);
      const trip = g["@graph"].find((n: any) => n["@type"] === "TouristTrip");
      expect(trip.itinerary.numberOfItems).toBe(8);
      expect(trip.itinerary.itemListElement.map((x: any) => x.item.name)).toEqual([
        "Beale Street", "Orpheum Theatre", "Young Dolph Mural", "Makeda's Cookies",
        "Orange Mound Neighborhood", "Gangsta Boo Mural", "North Memphis", "Downtown Rapper Mural",
      ]);
      expect(trip.offers.price).toBe("70");
      expect(trip.offers.url).toBe(ACUITY);
    }
  });

  it("the business has the meeting point and no phone number", async () => {
    const g = ld((await publicPage("/")).body);
    const biz = g["@graph"].find((n: any) => n["@type"] === "TravelAgency");
    expect(biz.address.streetAddress).toBe("Beale St & S B.B. King Blvd");
    expect(biz.address.postalCode).toBe("38103");
    expect(biz.telephone).toBeUndefined();
    expect(biz.email).toBe("team@memphisraptour.com");
  });

  it("the FAQ page is an FAQPage whose questions match the visible ones", async () => {
    const { body } = await publicPage("/faq");
    const g = ld(body);
    const faq = g["@graph"].find((n: any) => n["@type"] === "FAQPage");
    const visible = [...body.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
    expect(faq.mainEntity.map((q: any) => q.name)).toEqual(visible.filter((v) => !/▾/.test(v)));
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(3);
  });

  it("every Book button goes through the counter to Acuity", async () => {
    const { body } = await publicPage("/");
    const books = [...body.matchAll(/href="(\/go\/book\?from=[a-z-]+)"/g)].map((m) => m[1]);
    expect(books.length).toBeGreaterThanOrEqual(3);
    const res = await SELF.fetch(`${BASE}${books[0]}`, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 Safari" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ACUITY);
  });

  it("sitemap lists every page, llms.txt states the facts, robots keeps a preview host out", async () => {
    const sm = await (await SELF.fetch(`${BASE}/sitemap.xml`)).text();
    for (const p of PAGES) expect(sm).toContain(`<loc>https://example.com${p}</loc>`);
    expect(sm).not.toContain("/admin");
    const llms = await (await SELF.fetch(`${BASE}/llms.txt`)).text();
    expect(llms).toContain("Tour length: 3 hours");
    expect(llms).toContain("$70 per person");
    const robots = await (await SELF.fetch(`${BASE}/robots.txt`)).text();
    expect(robots).toContain("Disallow: /");
    const home = await publicPage("/");
    expect(home.res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("the real domain is indexable, robots blocks /admin and names the sitemap; the bare domain redirects to www", async () => {
    const robots = await (await SELF.fetch("https://www.memphisraptour.com/robots.txt")).text();
    expect(robots).toContain("Disallow: /admin");
    expect(robots).toContain("Sitemap: https://www.memphisraptour.com/sitemap.xml");
    const home = await SELF.fetch("https://www.memphisraptour.com/", { headers: { "User-Agent": "Mozilla/5.0" } });
    expect(home.headers.get("X-Robots-Tag")).toBeNull();
    expect(await home.text()).not.toContain('name="robots"');
    const bare = await SELF.fetch("https://memphisraptour.com/faq", { redirect: "manual" });
    expect(bare.status).toBe(301);
    expect(bare.headers.get("Location")).toBe("https://www.memphisraptour.com/faq");
  });

  it("sends security headers; admin pages are noindex and uncached", async () => {
    const res = (await publicPage("/")).res;
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    const admin = await SELF.fetch(`${BASE}/admin/login`);
    expect(admin.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(admin.headers.get("Cache-Control")).toBe("no-store");
  });

  it("the removed About page sends visitors to the home page, and no page links to it or says who runs the tour", async () => {
    const r = await publicPage("/about");
    expect(r.status).toBe(301);
    expect(r.res.headers.get("Location")).toBe("/");
    for (const p of PAGES) {
      const { body } = await publicPage(p);
      expect(body).not.toContain('href="/about"');
      expect(body).not.toContain("Who runs the tour");
    }
    expect(await (await SELF.fetch(`${BASE}/sitemap.xml`)).text()).not.toContain("/about");
  });

  it("never links out to Tripadvisor or Viator; quotes and the rating stay as plain text (owner, 4 Nov 2026)", async () => {
    for (const p of PAGES) {
      const { body } = await publicPage(p);
      expect(body, p).not.toMatch(/href="[^"]*(tripadvisor|viator)/i);
    }
    const home = (await publicPage("/")).body;
    expect(home).toContain("5.0 · 20 reviews on Tripadvisor");
    expect(home).toContain("— Requill P., Tripadvisor review, Dec 2025");
    const { rich } = await import("../src/markup");
    expect(rich("See [our reviews](https://www.tripadvisor.com/x) and [Viator](https://viator.com/y)", {})).not.toContain("<a ");
  });

  it("an unknown page is a 404, not a soft 200", async () => {
    expect((await publicPage("/no-such-page")).status).toBe(404);
  });

  it("counts a visit and a Book tap, but not a bot's", async () => {
    const { env } = await import("cloudflare:workers");
    const sum = async (kind: string) => (await env.DB.prepare("SELECT COALESCE(SUM(n),0) AS n FROM counts WHERE kind = ?").bind(kind).first<{ n: number }>())!.n;
    const v0 = await sum("view"), b0 = await sum("book");
    await publicPage("/reviews");
    await SELF.fetch(`${BASE}/go/book?from=reviews`, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 Safari" } });
    await SELF.fetch(`${BASE}/reviews`, { headers: { "User-Agent": "Googlebot/2.1" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(await sum("view")).toBe(v0 + 1);
    expect(await sum("book")).toBe(b0 + 1);
  });
});
