// Memphis Rap Tour website: one Worker. Static files (CSS, fonts, photos, share images) are served by
// Workers static assets before this code runs; everything else is here.
import { handleAdmin } from "./admin/routes";
import { dailyJob, type FullEnv } from "./jobs";
import { type Content, loadVersion, pointers } from "./content";
import { esc, type Env, html, now, redirect, text } from "./http";
import { readImage } from "./images";
import { type ImageRow, type RenderCtx, renderPage, requestForm, signupForm, simplePage } from "./render";
import { llms, robots, sitemap } from "./seo";
import { bump, checkUnsub, countable, signup, tourRequest, unsubscribe, unsubToken } from "./subscribe";
import { bookingMode } from "./booking";
import { mailer, statusText } from "./email";
import { handleTickets } from "./tickets";

// The main module may export ONLY the handler: the Workers runtime refuses any other named export.

async function context(env: Env, url: URL, which: "published" | "draft", preview = false): Promise<RenderCtx> {
  const p = await pointers(env.DB);
  const id = which === "draft" ? p.draft : p.published;
  const [v, imgs, mode] = await Promise.all([
    loadVersion(env.DB, id),
    env.DB.prepare("SELECT id, storage, width, height, alt FROM images WHERE deleted_at IS NULL").all<ImageRow>(),
    bookingMode(env.DB),
  ]);
  const content = v!.content as Content;
  return {
    bookUrl: mode === "own" ? `${url.origin}/tickets` : content.ticket.book_url,
    c: content,
    images: new Map(imgs.results.map((i) => [i.id, i])),
    origin: url.origin,
    prefix: preview ? "/admin/preview" : "",
    updated: v!.created_at,
    indexable: url.hostname === env.CANONICAL_HOST,
    preview,
  };
}

function publicHtml(body: string, ctx: RenderCtx, status = 200, etag?: string): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-cache" };
  if (!ctx.indexable) headers["X-Robots-Tag"] = "noindex, nofollow";
  if (etag) headers.ETag = etag;
  return html(body, { status, headers });
}

async function renderPath(env: Env, url: URL, path: string, which: "published" | "draft", preview: boolean): Promise<Response> {
  const ctx = await context(env, url, which, preview);
  const page = ctx.c.pages.find((p) => p.path === path);
  const moved = !page ? ctx.c.redirects?.[path] : undefined;
  if (moved && /^\/(?!\/)/.test(moved)) return redirect((preview ? "/admin/preview" : "") + moved, 301);
  if (!page) return publicHtml(simplePage(ctx, "Page not found", `<p>That page isn't here. <a href="/">Go to the home page ›</a></p>`), ctx, 404);
  const out = publicHtml(renderPage(page, ctx), ctx);
  if (preview) {
    out.headers.set("Cache-Control", "no-store");
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return out;
}

async function handle(req: Request, env: FullEnv, ectx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // The bare domain sends visitors to the one canonical host.
  if (env.CANONICAL_HOST && url.hostname === env.CANONICAL_HOST.replace(/^www\./, "") && url.hostname !== env.CANONICAL_HOST) {
    return redirect(`https://${env.CANONICAL_HOST}${path}${url.search}`, 301);
  }

  if (path === "/admin" || path.startsWith("/admin/")) {
    return handleAdmin(req, env, url, async (_o, p) => renderPath(env, url, p, "draft", true));
  }

  if (path.startsWith("/img/") && req.method === "GET") {
    const key = decodeURIComponent(path.slice(5));
    if (!/^img[0-9a-f]{12}-[0-9a-z]+\.(jpg|png|webp)$/.test(key)) return text("Not found", undefined, 404);
    const im = await readImage(env.IMAGES, key);
    if (!im) return text("Not found", undefined, 404);
    return new Response(im.body, { headers: { "Content-Type": im.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  }

  if (path === "/go/book") {
    const ctx = await context(env, url, "published");
    const from = (url.searchParams.get("from") || "").replace(/[^a-z-]/g, "").slice(0, 30) || "site";
    if (countable(req)) ectx.waitUntil(bump(env.DB, from, "book"));
    return redirect(ctx.bookUrl, 302, { "X-Robots-Tag": "noindex" });
  }

  if (path === "/subscribe" && req.method === "POST") {
    const ctx = await context(env, url, "published");
    const form = await req.formData();
    const r = await signup(req, env, form, ctx.c.site.consent_text);
    if (r.kind === "invalid") {
      return publicHtml(simplePage(ctx, "Check the form", signupForm(ctx, String(form.get("source") || "retry"), "Join the email list", "", "signup", r.error, { email: r.email, first_name: r.first_name })), ctx, 400);
    }
    if (r.kind === "limited") return publicHtml(simplePage(ctx, "Too many sign-ups", "<p>Too many sign-ups from this connection. Try again in an hour.</p>"), ctx, 429);
    if (r.kind === "honeypot") return redirect("/subscribe/thanks");
    return redirect(`/subscribe/thanks?id=${r.id}&t=${await unsubToken(env, r.id)}`);
  }
  if (path === "/subscribe/thanks" && req.method === "GET") {
    const ctx = await context(env, url, "published");
    const id = await checkUnsub(env, url.searchParams.get("id"), url.searchParams.get("t"));
    const unsub = id ? `<p class="sub">Changed your mind? <a href="/unsubscribe?id=${id}&amp;t=${esc(url.searchParams.get("t"))}">Unsubscribe ›</a></p>` : "";
    return publicHtml(simplePage(ctx, "You're on the list", `<p>Thanks. We'll email you new tour dates and news from Memphis Rap Tour.</p>${unsub}<p><a class="btn btn-gold" href="/">Back to the home page ›</a></p>`), ctx);
  }
  if (path === "/unsubscribe") {
    const ctx = await context(env, url, "published");
    let idQ = url.searchParams.get("id"), tQ = url.searchParams.get("t");
    if (req.method === "POST") {
      const form = await req.formData().catch(() => new FormData());
      idQ = String(form.get("id") || idQ || ""); tQ = String(form.get("t") || tQ || "");
    }
    const id = await checkUnsub(env, idQ, tQ);
    if (!id) return publicHtml(simplePage(ctx, "This link doesn't work", `<p>This unsubscribe link isn't valid. Email <a href="mailto:${esc(ctx.c.ticket.email)}">${esc(ctx.c.ticket.email)}</a> and we'll take you off the list.</p>`), ctx, 400);
    if (req.method === "POST") {
      await unsubscribe(env, id);
      return publicHtml(simplePage(ctx, "You're unsubscribed", "<p>You won't get any more emails from Memphis Rap Tour.</p>"), ctx);
    }
    // One tap. A page with a button (not a plain link) so email scanners that open links don't unsubscribe people.
    return publicHtml(simplePage(ctx, "Unsubscribe", `<form method="post" action="/unsubscribe"><input type="hidden" name="id" value="${id}"><input type="hidden" name="t" value="${esc(tQ)}"><button class="btn btn-gold" type="submit">Unsubscribe me ›</button></form>`), ctx);
  }

  if (path === "/private-tours/request" && req.method === "POST") {
    const ctx = await context(env, url, "published");
    const form = await req.formData();
    const r = await tourRequest(req, env, form);
    if (r.kind === "invalid") return publicHtml(simplePage(ctx, "Check the form", requestForm(ctx, "Ask for a private tour", "", "request", r.error, r.values)), ctx, 400);
    if (r.kind === "saved") {
      const mail = await mailer.send(env, {
        to: ctx.c.ticket.email,
        replyTo: String(form.get("email") || ""),
        subject: `Private tour request: ${String(form.get("name") || "").slice(0, 60)}, ${String(form.get("group_size") || "?")} riding`,
        text: ["A private tour request came in on the website.", "", ...["name", "email", "date_wanted", "group_size", "occasion", "message"].map((k) => `${k.replace("_", " ")}: ${String(form.get(k) || "").slice(0, 2000)}`), "", "Reply to this email to answer them. Mark it handled in the admin: /admin/requests"].join("\n"),
      });
      await env.DB.prepare("UPDATE tour_requests SET email_status = ? WHERE id = ?").bind(statusText(mail), r.id).run();
    }
    if (r.kind === "limited") return publicHtml(simplePage(ctx, "Too many requests", `<p>Too many requests from this connection. Try again in an hour, or email <a href="mailto:${esc(ctx.c.ticket.email)}">${esc(ctx.c.ticket.email)}</a>.</p>`), ctx, 429);
    return redirect("/private-tours/thanks");
  }
  if (path === "/private-tours/thanks") {
    const ctx = await context(env, url, "published");
    return publicHtml(simplePage(ctx, "Request sent", `<p>Thanks. We have your request and will reply by email. For anything urgent, email <a href="mailto:${esc(ctx.c.ticket.email)}">${esc(ctx.c.ticket.email)}</a>.</p><p><a class="btn btn-gold" href="/">Back to the home page ›</a></p>`), ctx);
  }

  if (path === "/tickets" || path.startsWith("/tickets/") || path === "/stripe/webhook") {
    const ctx = await context(env, url, "published");
    const r = await handleTickets(req, env, url, ctx);
    if (r) return r;
  }

  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed", undefined, 405);

  if (path === "/robots.txt") return text(robots(url.origin, url.hostname === env.CANONICAL_HOST));
  if (path === "/sitemap.xml") {
    const ctx = await context(env, url, "published");
    return text(sitemap(ctx.c, url.origin, ctx.updated), "application/xml; charset=utf-8");
  }
  if (path === "/llms.txt") {
    const ctx = await context(env, url, "published");
    return text(llms(ctx.c, url.origin, ctx.bookUrl), "text/plain; charset=utf-8");
  }
  if (path === "/health") return text("ok");

  const norm = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (norm !== path) return redirect(norm + url.search, 301);
  const res = await renderPath(env, url, norm, "published", false);
  if (res.status === 200 && countable(req)) ectx.waitUntil(bump(env.DB, norm, "view"));
  return res;
}

export default {
  async fetch(req: Request, env: FullEnv, ectx: ExecutionContext): Promise<Response> {
    try {
      return await handle(req, env, ectx);
    } catch (e) {
      console.error("request failed", (e as Error)?.stack || e);
      return html("<!doctype html><title>Something went wrong</title><p>Something went wrong on our side. Try again in a minute.</p>", { status: 500 });
    }
  },
  async scheduled(_c: ScheduledController, env: FullEnv, ectx: ExecutionContext): Promise<void> {
    ectx.waitUntil(dailyJob(env));
  },
};
