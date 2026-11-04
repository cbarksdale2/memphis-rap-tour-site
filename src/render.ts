// Public pages, rendered from the content document. No scripts; FAQ and "show more" use <details>.
import type { Content, Page, Section } from "./content";
import { esc, isoDate, publicDate } from "./http";
import { line, plain, rich, safeHref, tokens } from "./markup";
import { jsonLd } from "./seo";

export interface ImageRow { id: string; storage: string; width: number; height: number; alt: string }

export interface RenderCtx {
  c: Content;
  images: Map<string, ImageRow>;
  origin: string;
  prefix: string; // "" on the live site, "/admin/preview" in preview
  updated: number;
  indexable: boolean;
  preview: boolean;
}

export const CSS_VERSION = "3";

export function imageUrl(im: ImageRow): string {
  if (im.storage.startsWith("asset:")) return im.storage.slice(6);
  return `/img/${encodeURIComponent(im.storage.slice(3))}`;
}

/** Book buttons go through /go/book, which counts the click and sends the visitor on to the booking page. */
export function bookLink(from: string): string {
  return `/go/book?from=${encodeURIComponent(from)}`;
}

function link(ctx: RenderCtx, href: string, from = ""): string {
  const tok = tokens(ctx.c);
  const v = safeHref(plain(href, tok)) || "/";
  if (v === ctx.c.ticket.book_url) return bookLink(from);
  if (v.startsWith("/") && ctx.prefix) return ctx.prefix + v;
  return v;
}

function img(ctx: RenderCtx, id: string | undefined, opts: { eager?: boolean; cls?: string; sizes?: string } = {}): string {
  if (!id) return "";
  const im = ctx.images.get(id);
  if (!im) return "";
  const w = im.width || 1200;
  const h = im.height || 900;
  return `<img class="${opts.cls || ""}" src="${esc(imageUrl(im))}" alt="${esc(im.alt)}" width="${w}" height="${h}" ${
    opts.eager ? 'fetchpriority="high"' : 'loading="lazy"'
  } decoding="async">`;
}

function facts(ctx: RenderCtx): string {
  const t = ctx.c.ticket;
  return `<dl class="facts">
<div><dt class="label">When</dt><dd>${esc(t.schedule_text)}</dd></div>
<div><dt class="label">How long</dt><dd>${esc(t.duration_text)}</dd></div>
<div class="wide"><dt class="label">Meet</dt><dd>${esc(t.meeting_point)}</dd></div>
<div class="wide"><dt class="label">Ticket</dt><dd>${esc(t.price_text)}</dd></div>
</dl>`;
}

function rating(ctx: RenderCtx): string {
  const s = ctx.c.site;
  if (!s.rating_text) return "";
  return `<p class="rating"><span class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><a href="${esc(safeHref(s.rating_url) || "#")}">${esc(s.rating_text)} ›</a></p>`;
}

function heading(tag: string, text: string, tok: Record<string, string>): string {
  return text ? `<${tag}>${line(text, tok)}</${tag}>` : "";
}

function block(sec: Section, page: Page, ctx: RenderCtx, isFirstHero: boolean): string {
  const d = sec.data;
  const tok = tokens(ctx.c);
  const t = ctx.c.ticket;
  const id = `s-${esc(sec.id)}`;
  switch (sec.type) {
    case "hero": {
      const photo = img(ctx, d.image, { eager: true, cls: "hero-photo" });
      const head = isFirstHero
        ? `<h1>${line(page.h1, tok)}</h1><p class="definition">${line(page.intro, tok)}</p>`
        : "";
      return `<section class="hero${photo ? " has-photo" : ""}" id="${id}">
<div class="hero-text">${d.label ? `<span class="label">${line(d.label, tok)}</span>` : ""}${head}
${d.show_facts ? facts(ctx) : ""}
<div class="ctas"><a class="btn btn-gold" rel="nofollow" href="${esc(bookLink(page.slug))}">${line(d.primary_text || "Book a seat ›", tok)}</a>${
        d.secondary_text ? `<a class="btn btn-line" href="${esc(link(ctx, d.secondary_href || "/private-tours"))}">${line(d.secondary_text, tok)}</a>` : ""
      }</div></div>
${photo ? `<figure class="hero-fig">${photo}</figure>` : ""}
${d.show_rating ? rating(ctx) : ""}
</section>`;
    }
    case "text":
      return `<section class="sec" id="${id}">${heading("h2", d.heading, tok)}<div class="prose">${rich(d.body, tok)}</div></section>`;
    case "image_text": {
      const photo = img(ctx, d.image);
      return `<section class="sec split" id="${id}"><div>${heading("h2", d.heading, tok)}<div class="prose">${rich(d.body, tok)}</div>${
        d.link_text ? `<p><a href="${esc(link(ctx, d.link_href || "/"))}">${line(d.link_text, tok)}</a></p>` : ""
      }</div>${photo ? `<figure class="split-fig">${photo}</figure>` : ""}</section>`;
    }
    case "stops": {
      const stops = ctx.c.stops;
      return `<section class="sec" id="${id}">${heading("h2", d.heading, tok)}${d.body ? `<div class="prose">${rich(d.body, tok)}</div>` : ""}
<div class="tape"><div class="tape-head" aria-hidden="true"><span>Side A · The route</span><span>${stops.length} stops</span></div>
<ol class="tracks" aria-label="Tour stops in order">${stops
        .map((x, i) => `<li class="track"><span class="n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><span class="t">${esc(x.name)}</span></li>`)
        .join("")}</ol></div>
${d.note ? `<p class="sub">${line(d.note, tok)}</p>` : ""}</section>`;
    }
    case "reviews": {
      const list = ctx.c.reviews.filter((r) => !r.hidden);
      const limit = Number(d.limit) || 0;
      const q = (r: (typeof list)[number]) =>
        `<blockquote class="q"><p>"${esc(r.quote)}"</p><cite>${esc(r.author)}${r.date ? `, ${esc(r.date)}` : ""}, on <a href="${esc(safeHref(r.url) || "#")}">Tripadvisor</a></cite></blockquote>`;
      const first = limit ? list.slice(0, limit) : list;
      const rest = limit ? list.slice(limit) : [];
      return `<section class="sec" id="${id}">${heading("h2", d.heading, tok)}${d.body ? `<div class="prose">${rich(d.body, tok)}</div>` : ""}
<div class="quotes">${first.map(q).join("")}</div>${
        rest.length ? `<details class="more"><summary>Show ${rest.length} more ▾</summary><div class="quotes">${rest.map(q).join("")}</div></details>` : ""
      }</section>`;
    }
    case "faq": {
      const list = visibleFaqs(ctx.c, d.limit);
      if (!list.length) return "";
      return `<section class="sec faq" id="${id}">${heading("h2", d.heading || "Questions people ask", tok)}<div class="faq-list">${list
        .map((f) => `<details><summary>${esc(plain(f.q, tok))}</summary><div class="faq-a">${rich(f.a, tok)}</div></details>`)
        .join("")}</div></section>`;
    }
    case "cta": {
      const dark = d.style !== "gold";
      const href = link(ctx, d.button_href || "{book_url}", page.slug);
      return `<section class="sec cta ${dark ? "cta-dark" : "cta-gold"}" id="${id}"><div class="cta-in">
${d.label ? `<span class="label">${line(d.label, tok)}</span>` : ""}${heading("h2", d.heading, tok)}
${d.body ? `<div class="prose">${rich(d.body, tok)}</div>` : ""}
${d.price ? `<p class="price">${line(d.price, tok)}</p>` : ""}${d.subtext ? `<p class="sub">${line(d.subtext, tok)}</p>` : ""}
${d.button_text ? `<p><a class="btn ${dark ? "btn-gold" : "btn-ink"}" href="${esc(href)}">${line(d.button_text, tok)}</a></p>` : ""}
</div></section>`;
    }
    case "gallery": {
      const ids = (d.images || "").split(",").map((x) => x.trim()).filter(Boolean);
      const pics = ids.map((x) => img(ctx, x)).filter(Boolean);
      if (!pics.length) return "";
      return `<section class="sec" id="${id}">${heading("h2", d.heading, tok)}<div class="gallery">${pics.map((p) => `<figure>${p}</figure>`).join("")}</div></section>`;
    }
    case "signup":
      return signupForm(ctx, page.slug, d.heading, d.body, id);
    case "request":
      return requestForm(ctx, d.heading, d.body, id);
  }
  return "";
}

export function visibleFaqs(c: Content, limitRaw?: string) {
  const list = c.faqs.filter((f) => !f.hidden);
  const limit = Number(limitRaw) || 0;
  return limit ? list.slice(0, limit) : list;
}

export function signupForm(ctx: RenderCtx, source: string, head: string, body: string, id = "signup", error = "", values: { email?: string; first_name?: string } = {}): string {
  const tok = tokens(ctx.c);
  return `<section class="sec signup" id="${id}">${heading("h2", head || "Get new tour dates by email", tok)}${body ? `<div class="prose">${rich(body, tok)}</div>` : ""}
${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/subscribe" class="signup-form">
<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email" inputmode="email" value="${esc(values.email || "")}"></label>
<label>First name <span class="sub">(optional)</span><input name="first_name" maxlength="60" autocomplete="given-name" value="${esc(values.first_name || "")}"></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<label class="consent"><input type="checkbox" name="consent" value="yes" required><span>${esc(ctx.c.site.consent_text)}</span></label>
<input type="hidden" name="source" value="${esc(source)}">
<button class="btn btn-gold" type="submit">Join the email list ›</button>
<p class="sub">We keep your email and first name to send Memphis Rap Tour news. No other use.</p>
</form></section>`;
}

export function requestForm(ctx: RenderCtx, head: string, body: string, id = "request", error = "", v: Record<string, string> = {}): string {
  const tok = tokens(ctx.c);
  return `<section class="sec signup" id="${id}">${heading("h2", head || "Ask for a private tour", tok)}${body ? `<div class="prose">${rich(body, tok)}</div>` : ""}
${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/private-tours/request" class="signup-form">
<label>Your name<input name="name" required maxlength="80" autocomplete="name" value="${esc(v.name || "")}"></label>
<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email" inputmode="email" value="${esc(v.email || "")}"></label>
<label>Date you'd like<input name="date_wanted" maxlength="60" placeholder="For example: Sat 12 Dec, afternoon" value="${esc(v.date_wanted || "")}"></label>
<label>How many are riding<input name="group_size" maxlength="20" inputmode="numeric" value="${esc(v.group_size || "")}"></label>
<label>Occasion <span class="sub">(optional)</span><input name="occasion" maxlength="80" placeholder="Birthday, reunion, work trip…" value="${esc(v.occasion || "")}"></label>
<label>Anything else <span class="sub">(optional)</span><textarea name="message" rows="4" maxlength="2000">${esc(v.message || "")}</textarea></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button class="btn btn-gold" type="submit">Send my request ›</button>
<p class="sub">We use these details only to reply about your tour.</p>
</form></section>`;
}

function nav(ctx: RenderCtx, cls: string): string {
  return `<nav class="${cls}" aria-label="Site">${ctx.c.pages
    .filter((p) => p.in_nav)
    .map((p) => `<a href="${esc(link(ctx, p.path))}">${esc(p.nav_label)}</a>`)
    .join("")}</nav>`;
}

export function layout(ctx: RenderCtx, page: Page, mainHtml: string, opts: { status?: number; noSchema?: boolean } = {}): string {
  const c = ctx.c;
  const tok = tokens(c);
  const t = c.ticket;
  const url = ctx.origin + (page.path === "/" ? "/" : page.path);
  const title = plain(page.title, tok);
  const desc = plain(page.description, tok);
  const og = `${ctx.origin}/og/${page.slug === "home" || !["route", "book", "reviews", "private", "faq", "about"].includes(page.slug) ? "home" : page.slug}.png`;
  const book = esc(bookLink(page.slug));
  const inner = page.slug !== "home";
  const crumbs = inner && page.path.startsWith("/")
    ? `<nav class="crumbs" aria-label="Breadcrumb"><a href="${esc(link(ctx, "/"))}">Home</a> <span aria-hidden="true">›</span> <span>${esc(page.nav_label)}</span></nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
${ctx.indexable && !ctx.preview ? "" : '<meta name="robots" content="noindex, nofollow">'}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(c.site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(c.site.name)}: ${esc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(og)}">
<meta name="theme-color" content="#1C1730">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
<link rel="preload" href="/fonts/alfa-slab-one-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/archivo-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css?v=${CSS_VERSION}">
${opts.noSchema ? "" : `<script type="application/ld+json">${jsonLd(ctx, page)}</script>`}
</head>
<body>
${ctx.preview ? `<div class="preview-bar" role="status">Preview: not live yet. <a href="/admin">← Back to the admin</a></div>` : ""}
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
<a class="wordmark" href="${esc(link(ctx, "/"))}">MEMPHIS RAP TOUR</a>
${nav(ctx, "desk-nav")}
<details class="menu"><summary>Menu ▾</summary>${nav(ctx, "menu-nav")}</details>
<a class="btn btn-gold btn-sm" rel="nofollow" href="${book}">Book ›</a>
</header>
<main id="main">
${crumbs}
${mainHtml}
</main>
<footer class="foot">
<div><b>${esc(c.site.name)}</b><br>${esc(c.site.footer_location)}</div>
<div class="contact"><a href="mailto:${esc(t.email)}">${esc(t.email)}</a></div>
<div><a href="${esc(c.site.instagram)}">Instagram @memphisraptour ›</a><br><a href="${esc(c.site.tiktok)}">TikTok @memphis.rap.tour ›</a></div>
<nav class="foot-nav" aria-label="Footer">${c.pages.map((p) => `<a href="${esc(link(ctx, p.path))}">${esc(p.nav_label)}</a>`).join("")}</nav>
<p>Disclaimer: ${esc(c.site.disclaimer)}</p>
<p class="trust">By ${esc(c.site.name)}, owned by ${esc(c.site.owner)} · Updated <time datetime="${isoDate(ctx.updated)}">${esc(publicDate(ctx.updated))}</time></p>
</footer>
<div class="sticky"><span class="sub"><b>${esc(t.schedule_text.split("·")[0].trim())}${t.schedule_text.includes("·") ? `, ${esc(t.schedule_text.split("·")[1].trim())}` : ""}</b><br>Beale Street</span><a class="btn btn-gold btn-sm" rel="nofollow" href="${book}">Book a seat ›</a></div>
</body>
</html>`;
}

export function renderPage(page: Page, ctx: RenderCtx): string {
  const visible = page.sections.filter((x) => !x.hidden);
  const tok = tokens(ctx.c);
  let heroDone = false;
  const parts: string[] = [];
  const firstIsHero = visible[0]?.type === "hero";
  if (!firstIsHero) {
    parts.push(`<section class="page-head"><h1>${line(page.h1, tok)}</h1><p class="definition">${line(page.intro, tok)}</p></section>`);
    heroDone = true;
  }
  for (const sec of visible) {
    const isFirstHero = sec.type === "hero" && !heroDone;
    if (isFirstHero) heroDone = true;
    parts.push(block(sec, page, ctx, isFirstHero));
  }
  return layout(ctx, page, parts.join("\n"));
}

/** A simple page outside the content pages (thanks, unsubscribe, 404). */
export function simplePage(ctx: RenderCtx, title: string, bodyHtml: string, status = 200): string {
  const page: Page = { slug: "notice", path: "", nav_label: title, in_nav: false, title: `${title} | Memphis Rap Tour`, description: title, h1: title, intro: "", sections: [] };
  return layout({ ...ctx, indexable: false }, page, `<section class="page-head"><h1>${esc(title)}</h1></section><section class="sec">${bodyHtml}</section>`, { status, noSchema: true });
}
