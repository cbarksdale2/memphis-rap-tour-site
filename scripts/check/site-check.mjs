// Daily site check (GitHub Actions). Protects: the ticket facts on the site match the booking page,
// every page answers, and Book still lands on a working booking page.
// Why: price, length and days are typed on the site by hand and could drift from Acuity.
//   node scripts/check/site-check.mjs <site url>     exit 0 all match · 1 problems found · 75 could not read
//   node scripts/check/site-check.mjs --self-test
// "Could not read" is never "all clear": it exits 75 and the workflow opens an issue saying so.

export function readAcuity(html) {
  const m = html.match(/var BUSINESS = (\{[\s\S]*?\});\s*\n/);
  if (!m) return { error: "the booking page no longer carries its tour data where this check looks" };
  let b;
  try { b = JSON.parse(m[1]); } catch { return { error: "the booking page's tour data could not be parsed" }; }
  const types = Object.values(b.appointmentTypes || {}).flat().filter((t) => t && t.active !== false && !t.private);
  if (!types.length) return { error: "the booking page lists no public tour" };
  const t = types[0];
  const desc = String(b.description || "").replace(/<[^>]+>/g, " ");
  return { name: String(t.name).trim(), price: Number(t.price), minutes: Number(t.duration), days: desc, expired: !!b.isExpired };
}

export function readSite(html) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return { error: "the site's home page has no structured data" };
  const g = JSON.parse(m[1])["@graph"] || [];
  const trip = g.find((n) => n["@type"] === "TouristTrip");
  if (!trip) return { error: "the site's home page has no TouristTrip" };
  const durText = (html.match(/<dt class="label">How long<\/dt><dd>([^<]+)<\/dd>/) || [])[1] || "";
  const whenText = (html.match(/<dt class="label">When<\/dt><dd>([^<]+)<\/dd>/) || [])[1] || "";
  return { price: Number(trip.offers?.price), book: trip.offers?.url, duration: durText.replace(/&amp;/g, "&"), when: whenText.replace(/&amp;/g, "&") };
}

export function compare(site, acuity) {
  const problems = [];
  if (acuity.expired) problems.push("Acuity says the booking account is expired.");
  if (site.price !== acuity.price) problems.push(`Price: the site says $${site.price}, the booking page says $${acuity.price}.`);
  const hours = acuity.minutes / 60;
  const siteHours = Number((site.duration.match(/(\d+(?:\.\d+)?)\s*hour/) || [])[1]);
  if (siteHours !== hours) problems.push(`Length: the site says "${site.duration}", the booking page says ${acuity.minutes} minutes.`);
  const days = (s) => ["fri", "sat", "sun", "mon", "tue", "wed", "thu"].filter((d) => new RegExp(`\\b${d}`, "i").test(s)).sort().join(",");
  if (days(site.when) !== days(acuity.days)) problems.push(`Days: the site says "${site.when}", the booking page says "${acuity.days.trim()}".`);
  return problems;
}

async function get(url, opts = {}) {
  const r = await fetch(url, { headers: { "User-Agent": "MemphisRapTourSiteCheck/1.0 (+github actions)" }, ...opts });
  return r;
}

async function main(site) {
  const unread = [];
  const problems = [];
  let home = "";
  try {
    const r = await get(site + "/");
    if (r.status !== 200) problems.push(`Home page answered ${r.status}.`);
    home = await r.text();
  } catch (e) { unread.push(`the site did not answer (${e.message})`); }

  let pages = [];
  try {
    const sm = await (await get(site + "/sitemap.xml")).text();
    pages = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    if (pages.length < 5) problems.push(`The sitemap lists only ${pages.length} pages.`);
  } catch (e) { unread.push(`the sitemap could not be read (${e.message})`); }
  for (const p of pages) {
    try { const r = await get(site + p); if (r.status !== 200) problems.push(`${p} answered ${r.status}.`); }
    catch (e) { unread.push(`${p} could not be read (${e.message})`); }
  }

  try {
    const r = await get(site + "/go/book?from=check", { redirect: "manual" });
    const to = r.headers.get("location") || "";
    if (r.status !== 302 || !/^https:\/\/app\.acuityscheduling\.com\//.test(to)) problems.push(`Book does not go to the booking page (answered ${r.status}, to "${to}").`);
    else {
      const a = await get(to);
      if (a.status !== 200) problems.push(`The booking page answered ${a.status}.`);
      const acuity = readAcuity(await a.text());
      const s = home ? readSite(home) : { error: "home page not read" };
      if (acuity.error) unread.push(acuity.error);
      else if (s.error) unread.push(s.error);
      else problems.push(...compare(s, acuity));
    }
  } catch (e) { unread.push(`the booking page could not be read (${e.message})`); }

  const lines = [];
  if (problems.length) lines.push("Problems found:", ...problems.map((p) => `- ${p}`));
  if (unread.length) lines.push("Not read (so not checked):", ...unread.map((p) => `- ${p}`));
  if (!problems.length && !unread.length) {
    console.log(`site check OK: ${pages.length} pages answered 200; Book reaches the booking page; price, length and days match it.`);
    return 0;
  }
  console.log(lines.join("\n"));
  return problems.length ? 1 : 75;
}

if (process.argv.includes("--self-test")) {
  const acuityHtml = `<script> var BUSINESS = {"description":"<p>We offer the tour on Friday and Saturdays at 2pm CST</p>","isExpired":false,"appointmentTypes":{"":[{"name":"Tour","active":true,"private":false,"duration":180,"price":"70.00"}]}};\n</script>`;
  const site = { price: 70, duration: "3 hours", when: "Fri & Sat · 2:00 pm Central" };
  const a = readAcuity(acuityHtml);
  const BROKEN = [
    ["price changed on Acuity", () => compare(site, { ...a, price: 75 })],
    ["length changed on Acuity", () => compare(site, { ...a, minutes: 150 })],
    ["days changed on Acuity", () => compare(site, { ...a, days: "We offer the tour on Sundays" })],
    ["site price edited", () => compare({ ...site, price: 60 }, a)],
    ["Acuity page reshaped", () => (readAcuity("<html></html>").error ? ["unread"] : [])],
  ];
  const missed = BROKEN.filter(([, f]) => f().length === 0).map(([n]) => n);
  const clean = compare(site, a);
  if (clean.length) { console.error(`NAMED STOP [SELF_TEST_FALSE_ALARM] matching facts reported as drift: ${clean.join(" ")}`); process.exit(1); }
  if (missed.length) { console.error(`NAMED STOP [SELF_TEST_BLIND] not caught: ${missed.join(", ")}`); process.exit(1); }
  console.log(`SELF-TEST OK — ${BROKEN.length} broken shapes caught, matching facts pass`);
} else {
  const site = (process.argv[2] || process.env.SITE_URL || "").replace(/\/+$/, "");
  if (!site) { console.error("NAMED STOP [NO_SITE] give the site address"); process.exit(2); }
  main(site).then((c) => process.exit(c)).catch((e) => { console.error(`NAMED STOP [CHECK_CRASHED] ${e.message}`); process.exit(75); });
}
