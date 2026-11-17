// Connect the site's email to team@memphisraptour.com (Google Workspace, Gmail API, scope gmail.send only).
// Run once, from the repo root, on the Mac:
//   node scripts/google-auth.mjs
// It asks for the OAuth client ID, then reads the secret from the clipboard after you click its copy icon
// (Google Cloud › Google Auth Platform › Clients › the "Desktop app" client), unless the vault already has them as MRT_GMAIL_CLIENT_ID / MRT_GMAIL_CLIENT_SECRET (then run it as
// `vault run -- node scripts/google-auth.mjs`). It opens Google's consent page in the browser: sign in as
// team@memphisraptour.com and allow "Send email on your behalf". Then it:
//   1. sends one test email from team@ to team@ ("Site email is connected"), proving the sign-in can send;
//   2. saves the three values to the vault (MRT_GMAIL_CLIENT_ID, MRT_GMAIL_CLIENT_SECRET, MRT_GMAIL_REFRESH_TOKEN);
//   3. puts them on the Worker as GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (by pipe).
// Nothing is printed or written to disk. Exit 0 only when all three steps worked.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const TEAM = "team@memphisraptour.com";
const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const stop = (code, exit, msg) => { console.error(`NAMED STOP [${code}] ${msg}`); process.exit(exit); };

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a.trim()); });
  });
}

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let clientId = process.env.MRT_GMAIL_CLIENT_ID || "";
let clientSecret = process.env.MRT_GMAIL_CLIENT_SECRET || "";
// Pasted text can carry invisible characters (bracketed-paste markers, spaces, line breaks); keep only what an
// OAuth value can contain.
const clean = (s) => String(s).replace(/\x1b\[20[01]~/g, "").replace(/[^A-Za-z0-9._\-]/g, "");
const clipboard = () => { try { return execFileSync("pbpaste", { encoding: "utf8" }); } catch { return ""; } };

if (!clientId) clientId = await ask("OAuth client ID (ends in .apps.googleusercontent.com): ");
clientId = clean(clientId);
if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) stop("BAD_CLIENT_ID", 3, "that doesn't look like a client ID (digits-letters.apps.googleusercontent.com); copy it from Google Cloud › Clients.");
if (!clientSecret) {
  // The secret is read from the clipboard, never typed or shown: click the copy icon next to the secret in
  // Google Cloud, then press Return here.
  await ask("Click the copy icon next to the client secret in Google Cloud, then press Return here: ");
  clientSecret = clipboard();
}
clientSecret = clean(clientSecret);
if (clientSecret === clientId) stop("BAD_CLIENT_SECRET", 3, "the clipboard holds the client ID, not the secret. Copy the secret (the icon on its row under Client secrets) and run again.");
if (!/^GOCSPX-[A-Za-z0-9_\-]{20,}$/.test(clientSecret)) stop("BAD_CLIENT_SECRET", 3, `the clipboard doesn't hold a client secret (it should start with GOCSPX-; got ${clientSecret.length} characters starting "${clientSecret.slice(0, 3)}"). Copy the secret and run again.`);

// Local consent flow: Google sends the browser back to this Mac (loopback), with PKCE.
const verifier = b64url(randomBytes(32));
const state = b64url(randomBytes(16));
const { code, redirect } = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (!u.searchParams.has("code") && !u.searchParams.has("error")) { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(ok ? "Done. You can close this tab and go back to the terminal." : "Something went wrong. Go back to the terminal.");
    server.close();
    if (!ok) reject(new Error(u.searchParams.get("error") || "the reply did not match this sign-in"));
    else resolve({ code: u.searchParams.get("code"), redirect: `http://127.0.0.1:${port}` });
  });
  let port = 0;
  server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", login_hint: TEAM, state, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" })) url.searchParams.set(k, v);
    console.log(`Opening Google sign-in. Sign in as ${TEAM} and allow sending email.\nIf no browser opens, paste this into Chrome:\n${url}\n`);
    spawn("open", [url.toString()], { stdio: "ignore" }).on("error", () => {});
  });
  setTimeout(() => { server.close(); reject(new Error("no answer from the browser within 10 minutes")); }, 600_000).unref();
}).catch((e) => stop("CONSENT_NOT_GIVEN", 3, `${e.message}. Run the command again.`));

const tok = await (await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }),
})).json().catch(() => ({}));
if (!tok.refresh_token) stop("NO_REFRESH_TOKEN", 3, `Google gave no lasting sign-in (${tok.error || "no refresh_token"}${tok.error_description ? ": " + tok.error_description : ""}). Run the command again.`);
if (tok.scope && tok.scope.trim() !== SCOPE) stop("WRONG_SCOPE", 3, `Google granted "${tok.scope}", not gmail.send only. Nothing was saved.`);

// 1. Prove it can send: one email from team@ to team@.
const mime = [`From: Memphis Rap Tour <${TEAM}>`, `To: ${TEAM}`, "Subject: Site email is connected", "Content-Type: text/plain; charset=utf-8", "",
  "The website can now send booking confirmations and tour reminders from this address.", "", "Sent once by scripts/google-auth.mjs."].join("\r\n");
const sent = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
  method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ raw: b64url(Buffer.from(mime)) }),
});
if (sent.status !== 200) stop("TEST_SEND_FAILED", 9, `Gmail refused the test email (${sent.status}). Is the signed-in account ${TEAM}? Nothing was saved.`);

// 2 and 3. Save to the vault and the Worker, values by pipe only.
const values = { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret, REFRESH_TOKEN: tok.refresh_token };
try {
  for (const [k, v] of Object.entries(values)) execFileSync("vault", ["set", `MRT_GMAIL_${k}`], { input: v, stdio: ["pipe", "ignore", "inherit"] });
} catch { stop("VAULT_NOT_SAVED", 2, "the vault didn't take the values; the test email went out, so run the command again to save them."); }
try {
  for (const [k, v] of Object.entries(values)) execFileSync("npx", ["wrangler", "secret", "put", `GOOGLE_${k}`], { input: v, stdio: ["pipe", "ignore", "inherit"] });
} catch { stop("WORKER_SECRET_NOT_SET", 2, "saved to the vault, but the Worker didn't take the secrets. Claude can finish with: vault run -- sh -c 'printf %s \"$MRT_GMAIL_REFRESH_TOKEN\" | npx wrangler secret put GOOGLE_REFRESH_TOKEN' (and the same for CLIENT_ID, CLIENT_SECRET)."); }
console.log(`connected: test email sent from ${TEAM}; saved to the vault as MRT_GMAIL_CLIENT_ID, MRT_GMAIL_CLIENT_SECRET, MRT_GMAIL_REFRESH_TOKEN; put on the Worker as GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.`);
