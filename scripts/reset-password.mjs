// Reset an admin password by hand when email and recovery codes are both unavailable.
// The new temporary password comes from the vault and is never printed or written to disk:
//   vault run -- node scripts/reset-password.mjs --email team@memphisraptour.com
// The person must choose their own password at the next sign-in; every session is signed out.
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";

const i = process.argv.indexOf("--email");
const email = (i > 0 ? process.argv[i + 1] : "").trim().toLowerCase();
const pw = process.env.MRT_ADMIN_TEMP_PASSWORD_CARLOS || "";
if (!email) { console.error("NAMED STOP [USAGE] give --email"); process.exit(1); }
if (pw.length < 16) { console.error("NAMED STOP [NO_TEMP_PASSWORD] put a new temporary password in the vault as MRT_ADMIN_TEMP_PASSWORD_CARLOS first."); process.exit(3); }
const salt = randomBytes(16);
const stored = `pbkdf2-sha256$100000$${salt.toString("base64")}$${pbkdf2Sync(pw, salt, 100000, 32, "sha256").toString("base64")}`;
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "mrt-site", "--remote", "--json", "--command", sql], { encoding: "utf8" }));
const r = d1(`UPDATE users SET pw_hash = ${q(stored)}, must_change = 1, updated_at = unixepoch() WHERE email = ${q(email)}`)[0];
if (r.meta.changes !== 1) { console.error(`NAMED STOP [NO_SUCH_USER] no admin account for ${email}; nothing changed.`); process.exit(1); }
d1(`DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${q(email)})`);
d1(`INSERT INTO audit (at, user_id, action, detail) SELECT unixepoch(), id, 'Password reset by hand from the command line', '' FROM users WHERE email = ${q(email)}`);
console.log(`password reset for ${email}: temporary password from the vault, must be changed at the next sign-in; all sessions signed out.`);
