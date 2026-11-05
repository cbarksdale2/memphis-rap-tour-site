// Text the admin types becomes safe HTML here. Everything is escaped first; only a few marks are turned
// back into tags: blank line = new paragraph, "- " = bullet, "1. " = numbered, [words](link), **bold**, *em*.
// {price}, {duration} and friends fill in from Tour info, so a price is typed once and shown the same everywhere.
import type { Content } from "./content";
import { esc } from "./http";

export function tokens(c: Content): Record<string, string> {
  const t = c.ticket;
  const stops = c.stops.map((x) => x.name);
  const list = stops.length > 1 ? `${stops.slice(0, -1).join(", ")} and ${stops[stops.length - 1]}` : stops.join("");
  return {
    price: t.price_text,
    duration: t.duration_text,
    schedule: t.schedule_text,
    schedule_long: t.schedule_long,
    private_price: t.private_price_text,
    private_price_amount_text: t.private_price_amount ? `$${t.private_price_amount}` : t.private_price_text,
    email: t.email,
    meeting_point: t.meeting_point,
    book_url: t.book_url,
    stop_count: String(stops.length),
    stops: list,
    site_name: c.site.name,
  };
}

export function fill(s: string, tok: Record<string, string>): string {
  return String(s ?? "").replace(/\{([a-z_]+)\}/g, (m, k) => (k in tok ? tok[k] : m));
}

/** A link target the admin may use: web, email, or a page on this site. Never javascript: or data:. */
/** Owner ruling, 4 Nov 2026: the site never links out to Tripadvisor or Viator. */
export function bannedLink(u: string): boolean {
  return /^(https?:)?\/\/([a-z0-9-]+\.)*(tripadvisor|viator)\.[a-z.]+(\/|$|\?|#)/i.test(u.trim());
}

export function safeHref(u: string): string | null {
  const v = u.trim();
  if (bannedLink(v)) return null;
  if (/^(https?:\/\/|mailto:)[^\s"<>]+$/i.test(v)) return v;
  if (/^\/(?!\/)[^\s"<>]*$/.test(v) || /^#[\w-]*$/.test(v)) return v;
  return null;
}

function inline(escaped: string): string {
  return escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const raw = href.replace(/&amp;/g, "&");
      const ok = safeHref(raw);
      return ok ? `<a href="${esc(ok)}">${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

/** One line of text (headings, labels): tokens, escaping, *em* and links only. */
export function line(s: string, tok: Record<string, string>): string {
  return inline(esc(fill(s, tok)));
}

/** Plain text, no marks (meta tags, JSON-LD, alt text). */
export function plain(s: string, tok: Record<string, string>): string {
  return fill(s, tok)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function rich(s: string, tok: Record<string, string>): string {
  const src = fill(s, tok).replace(/\r\n?/g, "\n").trim();
  if (!src) return "";
  return src
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.every((l) => /^[-•]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(esc(l.replace(/^[-•]\s+/, "")))}</li>`).join("")}</ul>`;
      }
      if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(esc(l.replace(/^\d+[.)]\s+/, "")))}</li>`).join("")}</ol>`;
      }
      return `<p>${lines.map((l) => inline(esc(l))).join("<br>")}</p>`;
    })
    .join("");
}
