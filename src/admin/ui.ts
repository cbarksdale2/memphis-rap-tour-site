// Admin screen frame: one calm column, a bottom tab bar, an "unpublished changes" banner, sticky save bar.
import type { Auth } from "../auth";
import { esc, html } from "../http";

export interface Frame {
  auth: Auth | null;
  title: string;
  tab?: "home" | "tours" | "pages" | "tour" | "more";
  back?: { href: string; label: string };
  unpublished?: number; // saves since the live version; 0 = up to date
  flash?: { kind: "ok" | "err"; text: string } | null;
  status?: number;
  headers?: Record<string, string>;
}

export function csrf(auth: Auth | null): string {
  return auth ? `<input type="hidden" name="csrf" value="${esc(auth.session.csrf)}">` : "";
}

export function postButton(auth: Auth, action: string, label: string, cls = "btn", extra = ""): string {
  return `<form method="post" action="${esc(action)}" class="inline">${csrf(auth)}${extra}<button class="${cls}" type="submit">${label}</button></form>`;
}

/** Destructive actions: apart, labelled, confirmed in the page (no browser pop-ups). */
export function confirmRemove(auth: Auth, action: string, what: string, note = ""): string {
  return `<details class="danger"><summary>Remove ${esc(what)} ▾</summary><div class="danger-in">
<p>${note ? esc(note) + " " : ""}You can bring it back from History.</p>
<div class="row-actions">${postButton(auth, action, "Yes, remove", "btn btn-red")}</div>
</div></details>`;
}

export function field(name: string, label: string, value: string, opts: { type?: string; textarea?: boolean; hint?: string; required?: boolean; rows?: number; disabled?: boolean; autocomplete?: string; maxlength?: number } = {}): string {
  const id = `f-${name}`;
  const common = `id="${id}" name="${esc(name)}"${opts.required ? " required" : ""}${opts.disabled ? " disabled" : ""}${opts.autocomplete ? ` autocomplete="${opts.autocomplete}"` : ""}${opts.maxlength ? ` maxlength="${opts.maxlength}"` : ""}`;
  const input = opts.textarea
    ? `<textarea ${common} rows="${opts.rows || 4}">${esc(value)}</textarea>`
    : `<input ${common} type="${opts.type || "text"}" value="${esc(value)}">`;
  return `<label class="field" for="${id}"><span class="flabel">${esc(label)}</span>${input}${opts.hint ? `<span class="hint">${esc(opts.hint)}</span>` : ""}</label>`;
}

export function check(name: string, label: string, on: boolean): string {
  return `<label class="checkline"><input type="checkbox" name="${esc(name)}" value="1"${on ? " checked" : ""}><span>${esc(label)}</span></label>`;
}

export function frame(f: Frame, body: string): Response {
  const a = f.auth;
  const tabs = a
    ? `<nav class="tabs" aria-label="Admin">
<a href="/admin"${f.tab === "home" ? ' aria-current="page"' : ""}>Home</a>
<a href="/admin/tours"${f.tab === "tours" ? ' aria-current="page"' : ""}>Tours</a>
<a href="/admin/pages"${f.tab === "pages" ? ' aria-current="page"' : ""}>Pages</a>
<a href="/admin/more"${f.tab === "more" ? ' aria-current="page"' : ""}>☰ More</a>
</nav>`
    : "";
  const banner =
    a && f.unpublished
      ? `<div class="banner-gold" role="status"><span><b>Not live yet:</b> ${f.unpublished} change${f.unpublished === 1 ? "" : "s"} saved since the site was last published.</span>
<span class="row-actions"><a class="btn btn-quiet" href="/admin/preview/">Preview ›</a>${postButton(a, "/admin/publish", "Publish ✓", "btn btn-green")}</span></div>`
      : "";
  const flash = f.flash ? `<p class="flash flash-${f.flash.kind}" role="${f.flash.kind === "err" ? "alert" : "status"}">${esc(f.flash.text)}</p>` : "";
  return html(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(f.title)} · Memphis Rap Tour admin</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/admin.css?v=4">
<script src="/assets/admin.js?v=4" defer></script>
</head><body class="admin${a ? " signed-in" : ""}">
${banner}
<main class="wrap">
${f.back ? `<a class="back" href="${esc(f.back.href)}">← ${esc(f.back.label)}</a>` : ""}
${flash}
${body}
</main>
${tabs}
</body></html>`,
    { admin: true, status: f.status, headers: f.headers },
  );
}

/** One row in a list: title + grey sub line + one action on the right. */
export function row(title: string, sub: string, action: string, id = ""): string {
  return `<li class="row"${id ? ` id="${esc(id)}"` : ""}><div class="row-main"><b>${title}</b>${sub ? `<span class="sub">${sub}</span>` : ""}</div><div class="row-act">${action}</div></li>`;
}
