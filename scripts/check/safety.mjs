// Safety checks for a PUBLIC repo. Protects: no secrets, no private email addresses, no phone number on
// the site (owner ruling 3 Nov 2026), and no secret values in wrangler.toml.
// Why: the repo is public; anything committed is published forever.
//   node scripts/check/safety.mjs             check every tracked file
//   node scripts/check/safety.mjs --self-test prove the checks catch what they claim to
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED_EMAILS = /^(team@memphisraptour\.com|noreply@anthropic\.com|[^@]+@example\.(org|com)|[a-z0-9.+-]+@users\.noreply\.github\.com)$/i;
const SECRET_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Cloudflare API token assignment", /CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["OpenAI/OpenRouter key", /\bsk-(or-)?[A-Za-z0-9-]{20,}\b/],
  ["Slack token", /\bxox[abp]-[A-Za-z0-9-]{10,}\b/],
  ["secret value in config", /^\s*(UNSUB_SECRET|IP_SALT|MRT_ADMIN_TEMP_PASSWORD_CARLOS)\s*=\s*["'][^"']+["']/m],
];
const PHONE = /(\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const BINARY = /\.(png|jpe?g|webp|woff2?|ico|gif)$/i;

export function check(files) {
  const problems = [];
  for (const { path, text } of files) {
    if (BINARY.test(path)) continue;
    if (path === ".dev.vars" || path.endsWith("/.dev.vars")) problems.push(`${path}: local secrets file is committed`);
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${path}: looks like a ${name}`);
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      if (!ALLOWED_EMAILS.test(m[0]) && !/^[^@]+@\d/.test(m[0])) problems.push(`${path}: private email address ${m[0]}`);
    }
    if ((path.startsWith("src/") || path.startsWith("public/")) && PHONE.test(text)) problems.push(`${path}: a phone number (the site shows none)`);
  }
  return problems;
}

function tracked() {
  const list = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
  return list.map((path) => ({ path, text: BINARY.test(path) ? "" : readFileSync(path, "utf8") }));
}

if (process.argv.includes("--self-test")) {
  const real = tracked();
  const src = real.find((f) => f.path === "src/content.ts");
  const BROKEN = [
    ["a gmail address", [{ path: "README.md", text: "write to someone.private" + "@" + "gmail.com" }]],
    ["a phone number in the site", [{ ...src, text: src.text + "\nconst p = '" + ["901", "555", "0100"].join("-") + "';" }]],
    ["a GitHub token", [{ path: "x.js", text: "const t='ghp_" + "a".repeat(36) + "'" }]],
    ["a secret in wrangler.toml", [{ path: "wrangler.toml", text: 'UNSUB_SECRET = "abc123"' }]],
    ["a committed .dev.vars", [{ path: ".dev.vars", text: "X=1" }]],
  ];
  const missed = BROKEN.filter(([, f]) => check(f).length === 0).map(([n]) => n);
  if (missed.length) { console.error(`NAMED STOP [SELF_TEST_BLIND] not caught: ${missed.join(", ")}`); process.exit(1); }
  console.log(`SELF-TEST OK — ${BROKEN.length} broken shapes caught`);
} else {
  const files = tracked();
  if (files.length < 20) { console.error(`NAMED STOP [CHECKED_TOO_FEW] only ${files.length} files seen; is this the repo root?`); process.exit(2); }
  const problems = check(files);
  if (problems.length) { console.error(problems.map((p) => "✗ " + p).join("\n")); process.exit(1); }
  console.log(`safety OK — ${files.length} files checked: no secrets, no private emails, no phone number on the site`);
}
