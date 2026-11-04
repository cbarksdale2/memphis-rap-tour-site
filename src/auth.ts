// Admin sign-in: email + password. PBKDF2-SHA256 (100,000 iterations, the most the Workers runtime
// allows, which meets the ≥100k bar), a random salt per user, sessions stored in D1 for 30 days.
import { b64, type Env, getCookie, ipHash, now, randomToken, safeEqual, sameOrigin, sha256Hex, unb64 } from "./http";

export const PBKDF2_ITER = 100_000;
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = "__Host-mrt_session";
export const LOGIN_CSRF_COOKIE = "__Host-mrt_login";
export const MAX_FAILS = 5; // per account, then locked
export const LOCK_MINUTES = 15;
export const IP_MAX_FAILS = 20; // per IP across all accounts, per 15 minutes
export const MIN_PASSWORD = 12;

export interface User {
  id: number;
  email: string;
  name: string;
  role: "owner" | "editor";
  pw_hash: string;
  must_change: number;
  disabled: number;
}

export interface Session { id: string; user_id: number; csrf: string; created_at: number; expires_at: number; last_seen: number; user_agent: string }
export interface Auth { user: User; session: Session }

async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2-sha256$${PBKDF2_ITER}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iterS, saltS, hashS] = stored.split("$");
  const iter = Number(iterS);
  if (alg !== "pbkdf2-sha256" || !iter || !saltS || !hashS) return false;
  const got = await pbkdf2(password, unb64(saltS), iter);
  return safeEqual(b64(got), hashS);
}

// A real hash to check against when the email is unknown, so both paths take the same time.
const DUMMY_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function passwordProblem(pw: string, email = ""): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return "Use at most 200 characters.";
  if (email && pw.toLowerCase().includes(email.split("@")[0].toLowerCase())) return "Don't use your email name in the password.";
  return null;
}

/** A readable temporary password: 4 groups of 5 letters and digits (about 100 bits). */
export function tempPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY346789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

export function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function createSession(db: D1Database, userId: number, req?: Request): Promise<{ token: string; csrf: string }> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const t = now();
  const ua = (req?.headers.get("User-Agent") || "").slice(0, 200);
  await db
    .prepare("INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, csrf, t, t + SESSION_DAYS * 86400, t, ua)
    .run();
  // Housekeeping: expired sessions are removed whenever someone signs in.
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t).run();
  return { token, csrf };
}

export async function getAuth(req: Request, env: Env): Promise<Auth | null> {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS s_id, s.user_id, s.csrf, s.created_at AS s_created, s.expires_at, s.last_seen, s.user_agent,
            u.id, u.email, u.name, u.role, u.pw_hash, u.must_change, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<Record<string, any>>();
  if (!row) return null;
  if (row.expires_at <= now() || row.disabled) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }
  const { s_id, user_id, csrf, s_created, expires_at, last_seen, user_agent, ...user } = row;
  if (now() - last_seen > 3600) await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").bind(now(), id).run();
  return { user: user as User, session: { id: s_id, user_id, csrf, created_at: s_created, expires_at, last_seen, user_agent } };
}

export async function endSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export async function endAllSessions(db: D1Database, userId: number, exceptId?: string): Promise<void> {
  if (exceptId) await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(userId, exceptId).run();
  else await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/** CSRF on every admin POST: same origin AND the session's token in the form. */
export function csrfOk(req: Request, auth: Auth, form: FormData): boolean {
  if (!sameOrigin(req)) return false;
  const got = String(form.get("csrf") || "");
  return got.length > 0 && safeEqual(got, auth.session.csrf);
}

/** CSRF on the sign-in form (no session yet): double-submit cookie plus same origin. */
export function loginCsrfOk(req: Request, form: FormData): boolean {
  if (!sameOrigin(req)) return false;
  const cookie = getCookie(req, LOGIN_CSRF_COOKIE) || "";
  const got = String(form.get("lc") || "");
  return cookie.length > 0 && safeEqual(cookie, got);
}

export type LoginResult =
  | { ok: true; user: User; token: string }
  | { ok: false; status: number; message: string };

/**
 * Rate limits, both sliding windows, so nothing is ever locked for good and an attacker elsewhere
 * cannot lock Carlos out: (1) per IP across all accounts, (2) per account from that same IP.
 */
export async function loginBlocked(env: Env, ip: string, email: string): Promise<string | null> {
  const t = now();
  const acctKey = await sha256Hex(`${ip}|${email}`);
  const rows = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'login' AND ip_hash = ? AND at > ?").bind(ip, t - LOCK_MINUTES * 60),
    env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'login_acct' AND ip_hash = ? AND at > ?").bind(acctKey, t - LOCK_MINUTES * 60),
  ]);
  const ipN = (rows[0].results[0] as { n: number }).n;
  const acctN = (rows[1].results[0] as { n: number }).n;
  if (ipN >= IP_MAX_FAILS) return `Too many tries from this connection. Wait ${LOCK_MINUTES} minutes and try again.`;
  if (acctN >= MAX_FAILS) return `${MAX_FAILS} wrong tries in a row. Wait ${LOCK_MINUTES} minutes, or use a recovery code.`;
  return null;
}

export async function recordFail(env: Env, ip: string, email: string): Promise<void> {
  const t = now();
  const acctKey = await sha256Hex(`${ip}|${email}`);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO attempts (kind, ip_hash, at) VALUES ('login', ?, ?)").bind(ip, t),
    env.DB.prepare("INSERT INTO attempts (kind, ip_hash, at) VALUES ('login_acct', ?, ?)").bind(acctKey, t),
    env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(t - 86400),
  ]);
}

async function clearFails(env: Env, ip: string, email: string): Promise<void> {
  await env.DB.prepare("DELETE FROM attempts WHERE kind = 'login_acct' AND ip_hash = ?").bind(await sha256Hex(`${ip}|${email}`)).run();
}

export async function attemptLogin(req: Request, env: Env, emailRaw: string, password: string): Promise<LoginResult> {
  const ip = await ipHash(req, env);
  const email = emailRaw.trim().toLowerCase().slice(0, 254);
  const blocked = await loginBlocked(env, ip, email);
  if (blocked) {
    await verifyPassword(password, DUMMY_HASH);
    return { ok: false, status: 429, message: blocked };
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
  const good = await verifyPassword(password, user && !user.disabled ? user.pw_hash : DUMMY_HASH);
  if (!user || user.disabled || !good) {
    await recordFail(env, ip, email);
    return { ok: false, status: 401, message: "That email and password don't match. Check both and try again." };
  }
  await clearFails(env, ip, email);
  const { token } = await createSession(env.DB, user.id, req);
  return { ok: true, user, token };
}

// ---------- recovery codes ----------

export const RECOVERY_COUNT = 10;

export async function makeRecoveryCodes(db: D1Database, userId: number): Promise<string[]> {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const b = crypto.getRandomValues(new Uint8Array(10));
    const c = [...b].map((x) => alphabet[x % alphabet.length]).join("");
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
  const t = now();
  await db.batch([
    db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    ...(await Promise.all(codes.map(async (c) => db.prepare("INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)").bind(userId, await sha256Hex(c), t)))),
  ]);
  return codes;
}

export async function recoveryCodesLeft(db: D1Database, userId: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Sign in with a recovery code and set a new password in one step. The code is used up. */
export async function recoverWithCode(req: Request, env: Env, emailRaw: string, codeRaw: string, newPassword: string): Promise<LoginResult> {
  const ip = await ipHash(req, env);
  const email = emailRaw.trim().toLowerCase().slice(0, 254);
  const blocked = await loginBlocked(env, ip, email);
  if (blocked) return { ok: false, status: 429, message: blocked };
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
  const code = codeRaw.trim().toLowerCase().replace(/\s+/g, "");
  const used = user && !user.disabled
    ? await env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
        .bind(now(), user.id, await sha256Hex(code)).run()
    : null;
  if (!user || !used || used.meta.changes !== 1) {
    await recordFail(env, ip, email);
    return { ok: false, status: 401, message: "That email and recovery code don't match. Each code works once." };
  }
  const problem = passwordProblem(newPassword, user.email);
  if (problem) {
    // Give the code back: the person did nothing wrong with it.
    await env.DB.prepare("UPDATE recovery_codes SET used_at = NULL WHERE user_id = ? AND code_hash = ?").bind(user.id, await sha256Hex(code)).run();
    return { ok: false, status: 400, message: problem };
  }
  await env.DB.prepare("UPDATE users SET pw_hash = ?, must_change = 0, updated_at = ? WHERE id = ?").bind(await hashPassword(newPassword), now(), user.id).run();
  await endAllSessions(env.DB, user.id);
  await clearFails(env, ip, email);
  const { token } = await createSession(env.DB, user.id, req);
  return { ok: true, user, token };
}
