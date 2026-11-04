// One-time: create the first owner account. Refuses if any user already exists.
// The temporary password comes from the vault and is never printed or written to disk:
//   vault run -- node scripts/create-owner.mjs --email <owner email> --name "Carlos Barksdale"
// Only the PBKDF2 hash goes to the database.
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ""; };
const email = (arg("--email") || "").trim().toLowerCase();
const name = (arg("--name") || "").trim();
const pw = process.env.MRT_ADMIN_TEMP_PASSWORD_CARLOS || "";
const where = process.argv.includes("--local") ? "--local" : "--remote";
if (!email || !name) { console.error("NAMED STOP [USAGE] give --email and --name"); process.exit(1); }
if (pw.length < 16) { console.error("NAMED STOP [NO_TEMP_PASSWORD] MRT_ADMIN_TEMP_PASSWORD_CARLOS is not in the vault (or is too short). Run this under `vault run --`."); process.exit(3); }

const salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, 100000, 32, "sha256");
const stored = `pbkdf2-sha256$100000$${salt.toString("base64")}$${hash.toString("base64")}`;
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "mrt-site", where, "--json", "--command", sql], { encoding: "utf8" }));

d1(`INSERT INTO users (email, name, role, pw_hash, must_change) SELECT ${q(email)}, ${q(name)}, 'owner', ${q(stored)}, 1 WHERE NOT EXISTS (SELECT 1 FROM users)`);
d1(`INSERT INTO audit (at, user_id, action, detail) SELECT unixepoch(), id, 'Owner account created by the set-up command', '' FROM users WHERE email = ${q(email)} AND NOT EXISTS (SELECT 1 FROM audit WHERE action LIKE 'Owner account created%')`);
const row = d1(`SELECT COUNT(*) AS n, SUM(email = ${q(email)} AND role = 'owner') AS mine FROM users`)[0].results[0];
if (row.mine !== 1) { console.error(`NAMED STOP [OWNER_NOT_CREATED] there are ${row.n} user(s) and none is this owner; an account already existed, so nothing was changed.`); process.exit(1); }
console.log(`owner account ready for ${email} (temporary password from the vault; must be changed at first sign-in). Users in the database: ${row.n}.`);
