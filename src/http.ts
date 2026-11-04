// Small HTTP helpers shared by the public site and the admin.

export interface Env {
  DB: D1Database;
  IMAGES: KVNamespace;
  ASSETS: Fetcher;
  UNSUB_SECRET: string;
  IP_SALT: string;
  CANONICAL_HOST: string;
}

export const now = () => Math.floor(Date.now() / 1000);

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Frame-Options": "DENY",
};

export const PUBLIC_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'none'; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
export const ADMIN_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

export function html(body: string, init: { status?: number; headers?: Record<string, string>; admin?: boolean } = {}): Response {
  const headers = new Headers({
    ...BASE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": init.admin ? ADMIN_CSP : PUBLIC_CSP,
    ...(init.admin ? { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } : {}),
    ...(init.headers || {}),
  });
  return new Response(body, { status: init.status ?? 200, headers });
}

export function text(body: string, type = "text/plain; charset=utf-8", status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...BASE_HEADERS, "Content-Type": type, ...extra } });
}

export function redirect(location: string, status = 303, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, Location: location, "Cache-Control": "no-store", ...headers } });
}

export function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(b);
}

export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function need(v: string | undefined, name: string): string {
  if (!v || v.length < 16) throw new Error(`NAMED STOP [SECRET_MISSING] ${name} is not set on the Worker. Set it: see RUNBOOK.md, "Secrets".`);
  return v;
}

export async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return b64url(sig);
}

/** Constant-time compare of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false; // only fixed-length tokens and hashes are compared here
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export async function ipHash(req: Request, env: Env): Promise<string> {
  const ip = req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  return (await sha256Hex(`${need(env.IP_SALT, "IP_SALT")}|${ip}`)).slice(0, 32);
}

/** Same-origin check for every POST: a browser always sends Origin on a cross-site form post. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (origin && origin !== new URL(req.url).origin) return false;
  const site = req.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;
  return true;
}

/** Dates on admin screens are on Carlos's clock (America/New_York). */
export function adminDate(sec: number): string {
  return new Date(sec * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Dates on the public site: plain day, Memphis time. */
export function publicDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-GB", { timeZone: "America/Chicago", day: "numeric", month: "short", year: "numeric" });
}

/** YYYY-MM-DD on Memphis time, so machine dates match the dates people read on the page. */
export function isoDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
