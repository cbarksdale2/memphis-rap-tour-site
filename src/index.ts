// Memphis Rap Tour website: one Worker. Static files (CSS, fonts, photos, share images) are served by
// Workers static assets before this code runs; everything else is here.
import { handleAdmin } from "./admin/routes";
import { type Content, loadVersion, pointers } from "./content";
import { esc, type Env, html, now, redirect, text } from "./http";
import { readImage } from "./images";
import { type ImageRow, type RenderCtx, renderPage, requestForm, signupForm, simplePage } from "./render";
import { llms, robots, sitemap } from "./seo";
import { bump, checkUnsub, countable, signup, tourRequest, unsubscribe, unsubToken } from "./subscribe";

export interface FullEnv extends Env {
  BACKUPS: KVNamespace;
}

async function context(env: Env, url: URL, which: "published" | "draft", preview = false): Promise<RenderCtx> {
  const p = await pointers(env.DB);
  const id = which === "draft" ? p.draft : p.published;
  const [v, imgs] = await Promise.all([
    loadVersion(env.DB, id),
    env.DB.prepare("SELECT id, storage, width, height, alt FROM images WHERE deleted_at IS NULL").all<ImageRow>(),
  ]);
  return {
    c: v!.content as Content,
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
    return redirect(ctx.c.ticket.book_url, 302, { "X-Robots-Tag": "noindex" });
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
    if (r.kind === "limited") return publicHtml(simplePage(ctx, "Too many requests", `<p>Too many requests from this connection. Try again in an hour, or email <a href="mailto:${esc(ctx.c.ticket.email)}">${esc(ctx.c.ticket.email)}</a>.</p>`), ctx, 429);
    return redirect("/private-tours/thanks");
  }
  if (path === "/private-tours/thanks") {
    const ctx = await context(env, url, "published");
    return publicHtml(simplePage(ctx, "Request sent", `<p>Thanks. We have your request and will reply by email. For anything urgent, email <a href="mailto:${esc(ctx.c.ticket.email)}">${esc(ctx.c.ticket.email)}</a>.</p><p><a class="btn btn-gold" href="/">Back to the home page ›</a></p>`), ctx);
  }

  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed", undefined, 405);

  if (path === "/robots.txt") return text(robots(url.origin, url.hostname === env.CANONICAL_HOST));
  if (path === "/sitemap.xml") {
    const ctx = await context(env, url, "published");
    return text(sitemap(ctx.c, url.origin, ctx.updated), "application/xml; charset=utf-8");
  }
  if (path === "/llms.txt") {
    const ctx = await context(env, url, "published");
    return text(llms(ctx.c, url.origin), "text/plain; charset=utf-8");
  }
  if (path === "/health") return text("ok");

  const norm = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (norm !== path) return redirect(norm + url.search, 301);
  const res = await renderPath(env, url, norm, "published", false);
  if (res.status === 200 && countable(req)) ectx.waitUntil(bump(env.DB, norm, "view"));
  return res;
}

// ---------- daily job: backup to KV (keep 30) and tidy up ----------

const BACKUP_TABLES = ["schema_version", "users", "settings", "images", "subscribers", "tour_requests", "audit", "counts", "recovery_codes"];
export const KEEP_BACKUPS = 30;

export async function dailyJob(env: FullEnv, t = now()): Promise<string> {
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  const dump: Record<string, unknown[]> = {};
  for (const tb of BACKUP_TABLES) dump[tb] = (await env.DB.prepare(`SELECT * FROM ${tb}`).all()).results;
  const p = await pointers(env.DB);
  dump.versions = (await env.DB.prepare("SELECT * FROM versions WHERE id IN (?, ?) OR id > (SELECT MAX(id) - 200 FROM versions) ORDER BY id").bind(p.draft, p.published).all()).results;
  const body = JSON.stringify({ day, at: t, tables: dump });
  await env.BACKUPS.put(`backup:${day}`, body);
  const keys = (await env.BACKUPS.list({ prefix: "backup:" })).keys.map((k) => k.name).sort();
  const old = keys.slice(0, Math.max(0, keys.length - KEEP_BACKUPS));
  for (const k of old) await env.BACKUPS.delete(k);

  // Photos removed more than 30 days ago lose their stored bytes; attempts older than 2 days go.
  const gone = await env.DB.prepare("SELECT id, storage FROM images WHERE deleted_at IS NOT NULL AND deleted_at < ? AND storage LIKE 'kv:%'").bind(t - 30 * 86400).all<{ id: string; storage: string }>();
  for (const g of gone.results) {
    await env.IMAGES.delete(g.storage.slice(3));
    await env.DB.prepare("UPDATE images SET storage = 'gone:' || storage WHERE id = ?").bind(g.id).run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(t - 2 * 86400),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
  ]);
  const rows = Object.values(dump).reduce((n, r) => n + r.length, 0);
  const census = `backup ${day}: ${rows} rows, ${Math.round(body.length / 1024)} KB; kept ${Math.min(keys.length, KEEP_BACKUPS)}, removed ${old.length}; purged ${gone.results.length} photo(s)`;
  if (rows === 0) throw new Error(`NAMED STOP [BACKUP_EMPTY] ${census}: the backup read no rows, so it proves nothing. Check the D1 binding.`);
  console.log(census);
  return census;
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
