import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hashPassword } from "../src/auth";

export const BASE = "https://example.com";
export const ORIGIN = { Origin: BASE };

let n = 0;
export function uniqueEmail(tag = "u"): string {
  n++;
  return `${tag}${n}${Date.now().toString(36)}@example.org`;
}
export function ip(): string {
  n++;
  return `10.0.${n % 250}.${(n * 7) % 250}`;
}

export async function makeUser(opts: { email?: string; password?: string; role?: "owner" | "editor"; mustChange?: boolean } = {}) {
  const email = opts.email || uniqueEmail();
  const password = opts.password || "correct horse battery staple";
  await env.DB.prepare("INSERT INTO users (email, name, role, pw_hash, must_change) VALUES (?, ?, ?, ?, ?)")
    .bind(email, "Test Person", opts.role || "owner", await hashPassword(password), opts.mustChange ? 1 : 0)
    .run();
  return { email, password };
}

export function cookiesFrom(res: Response): string {
  const all = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [res.headers.get("Set-Cookie") || ""];
  return all.filter(Boolean).map((c: string) => c.split(";")[0]).join("; ");
}

export async function loginForm(fromIp: string) {
  const res = await SELF.fetch(`${BASE}/admin/login`, { headers: { "CF-Connecting-IP": fromIp } });
  const body = await res.text();
  const lc = body.match(/name="lc" value="([^"]+)"/)![1];
  return { lc, cookie: cookiesFrom(res) };
}

export async function tryLogin(email: string, password: string, fromIp = ip()): Promise<Response> {
  const { lc, cookie } = await loginForm(fromIp);
  return SELF.fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { ...ORIGIN, Cookie: cookie, "CF-Connecting-IP": fromIp, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ lc, email, password }),
  });
}

export async function login(email: string, password: string, fromIp = ip()): Promise<string> {
  const res = await tryLogin(email, password, fromIp);
  if (res.status !== 303) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return cookiesFrom(res);
}

export async function owner(): Promise<{ cookie: string; email: string; password: string }> {
  const u = await makeUser({ role: "owner" });
  return { ...u, cookie: await login(u.email, u.password) };
}

export async function get(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
}

export async function csrfOf(cookie: string, path = "/admin/more"): Promise<string> {
  const body = await (await get(cookie, path)).text();
  const m = body.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error("no csrf on " + path + ": " + body.slice(0, 200));
  return m[1];
}

export async function post(cookie: string, path: string, fields: Record<string, string | string[]> | FormData, opts: { csrf?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
  let body: FormData | URLSearchParams;
  if (fields instanceof FormData) {
    body = fields;
  } else {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) p.append(k, x);
    body = p;
  }
  const token = opts.csrf === undefined ? await csrfOf(cookie) : opts.csrf;
  if (token !== null) body.append("csrf", token);
  return SELF.fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { ...ORIGIN, Cookie: cookie, ...(opts.headers || {}) }, body });
}

export async function publicPage(path: string): Promise<{ status: number; body: string; res: Response }> {
  const res = await SELF.fetch(`${BASE}${path}`, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (iPhone) Safari/605" } });
  return { status: res.status, body: await res.text(), res };
}

export function flash(res: Response): string {
  return decodeURIComponent((res.headers.get("Location") || "").replace(/\+/g, " "));
}
