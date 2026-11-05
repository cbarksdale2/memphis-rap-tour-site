// Structured data and the crawl files. Only what the visible page supports; no phone number, no ratings
// markup (the rating belongs to Tripadvisor, so it is shown as a plain-text line, not claimed as ours).
import type { Content, Page } from "./content";
import { isoDate } from "./http";
import { plain, safeHref, tokens } from "./markup";
import type { RenderCtx } from "./render";
import { visibleFaqs } from "./render";

function pageUrl(origin: string, p: Page): string {
  return origin + (p.path === "/" ? "/" : p.path);
}

export function business(c: Content, origin: string) {
  const t = c.ticket;
  return {
    "@type": "TravelAgency",
    "@id": `${origin}/#business`,
    name: c.site.name,
    url: `${origin}/`,
    email: t.email,
    logo: `${origin}/assets/logo.png`,
    image: `${origin}/og/home.png`,
    description: plain(c.pages.find((p) => p.slug === "home")?.intro || "", tokens(c)),
    founder: { "@type": "Person", name: c.site.owner },
    address: {
      "@type": "PostalAddress",
      streetAddress: t.street,
      addressLocality: t.locality,
      addressRegion: t.region,
      postalCode: t.postal_code,
      addressCountry: "US",
    },
    areaServed: { "@type": "City", name: "Memphis, Tennessee" },
    sameAs: [c.site.instagram, c.site.tiktok].filter(Boolean),
  };
}

export function tourTrip(c: Content, origin: string, privateTour = false, bookUrl = c.ticket.book_url) {
  const t = c.ticket;
  const tok = tokens(c);
  const route = c.pages.find((p) => p.slug === "route");
  return {
    "@type": "TouristTrip",
    "@id": `${origin}/memphis-hip-hop-tour#${privateTour ? "private-trip" : "trip"}`,
    name: privateTour ? "Private Memphis Rap & Hip Hop Bus Tour" : "Memphis Rap & Hip Hop Bus Tour",
    description: plain(route?.intro || "", tok),
    url: privateTour ? `${origin}/private-tours` : `${origin}/memphis-hip-hop-tour`,
    touristType: ["Hip hop fans", "Music lovers", "Visitors to Memphis"],
    provider: { "@id": `${origin}/#business` },
    itinerary: {
      "@type": "ItemList",
      numberOfItems: c.stops.length,
      itemListOrder: "https://schema.org/ItemListOrderAscending",
      itemListElement: c.stops.map((s, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "TouristAttraction", name: s.name } })),
    },
    offers: privateTour
      ? {
          "@type": "Offer",
          url: `${origin}/private-tours`,
          priceCurrency: t.currency,
          priceSpecification: { "@type": "PriceSpecification", minPrice: Number(t.private_price_amount) || undefined, priceCurrency: t.currency },
          description: plain(t.private_price_text, tok) + " for a private buy-out of the bus",
        }
      : { "@type": "Offer", url: safeHref(bookUrl) || undefined, price: t.price_amount, priceCurrency: t.currency, description: plain(t.price_text, tok) },
  };
}

export function jsonLd(ctx: RenderCtx, page: Page): string {
  const { c, origin } = ctx;
  const tok = tokens(c);
  const url = pageUrl(origin, page);
  const graph: unknown[] = [business(c, origin)];
  graph.push({ "@type": "WebSite", "@id": `${origin}/#website`, url: `${origin}/`, name: c.site.name, publisher: { "@id": `${origin}/#business` } });
  const webPage: Record<string, unknown> = {
    "@type": page.slug === "faq" ? "FAQPage" : "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: plain(page.title, tok),
    description: plain(page.description, tok),
    isPartOf: { "@id": `${origin}/#website` },
    about: { "@id": `${origin}/#business` },
    dateModified: isoDate(ctx.updated),
    speakable: { "@type": "SpeakableSpecification", cssSelector: [".definition", ".faq-a"] },
  };
  if (page.slug !== "home") {
    webPage.breadcrumb = { "@id": `${url}#breadcrumb` };
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: page.nav_label, item: url },
      ],
    });
  }
  // FAQPage: the questions actually shown on this page, once.
  const faqSec = page.sections.find((s) => s.type === "faq" && !s.hidden);
  if (faqSec) {
    const qs = visibleFaqs(c, faqSec.data.limit);
    if (qs.length) {
      const faq = {
        mainEntity: qs.map((f) => ({ "@type": "Question", name: plain(f.q, tok), acceptedAnswer: { "@type": "Answer", text: plain(f.a, tok) } })),
      };
      if (page.slug === "faq") Object.assign(webPage, faq);
      else graph.push({ "@type": "FAQPage", "@id": `${url}#faq`, ...faq });
    }
  }
  graph.push(webPage);
  if (["home", "route", "book", "reviews"].includes(page.slug)) graph.push(tourTrip(c, origin, false, ctx.bookUrl));
  if (page.slug === "private") graph.push(tourTrip(c, origin, true));
  // "</" inside JSON would end the script tag early.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

export function sitemap(c: Content, origin: string, updated: number): string {
  const lm = isoDate(updated);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${c.pages.map((p) => `<url><loc>${pageUrl(origin, p)}</loc><lastmod>${lm}</lastmod></url>`).join("\n")}
</urlset>
`;
}

export function robots(origin: string, indexable: boolean): string {
  if (!indexable) {
    return `# Preview address: not for search engines. The real site is www.memphisraptour.com.
User-agent: *
Disallow: /
`;
  }
  return `# Every crawler, including AI answer tools, is welcome on the public pages.
User-agent: *
Allow: /
Disallow: /admin

Sitemap: ${origin}/sitemap.xml
`;
}

export function llms(c: Content, origin: string): string {
  const t = c.ticket;
  const tok = tokens(c);
  const home = c.pages.find((p) => p.slug === "home");
  return `# ${c.site.name}

> ${plain(home?.intro || "", tok)}

## Key facts
- Tour length: ${t.duration_text}
- When: ${t.schedule_long}
- Ticket: ${t.price_text}, booked online at ${t.book_url}
- Meeting point: ${t.meeting_point}, ${t.locality}, ${t.region} ${t.postal_code}. The tour ends at the same spot.
- Stops, in order: ${c.stops.map((s) => s.name).join("; ")}
- Private tours: ${t.private_price_text} for a private buy-out; email ${t.email}
- Contact: ${t.email} (email only)
- Owner: ${c.site.owner}

## Pages
${c.pages.map((p) => `- [${plain(p.title, tok)}](${pageUrl(origin, p)}): ${plain(p.description, tok)}`).join("\n")}
`;
}
