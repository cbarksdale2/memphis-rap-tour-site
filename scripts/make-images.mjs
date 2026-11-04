// Makes the share images (1200x630), logo and touch icon with headless Chrome. Run locally:
//   node scripts/make-images.mjs
// Output goes to public/og and public/assets and is committed. Chrome is only used on this Mac.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) { console.error("NAMED STOP [NO_CHROME] Google Chrome is needed to draw the images."); process.exit(2); }
const root = resolve(new URL("..", import.meta.url).pathname);
const font = (f) => `url(data:font/woff2;base64,${readFileSync(join(root, "public/fonts", f)).toString("base64")})`;
const mural = `data:image/jpeg;base64,${readFileSync(join(root, "public/photos/mural.jpg")).toString("base64")}`;
const css = `@font-face{font-family:A;src:${font("alfa-slab-one-400.woff2")}}@font-face{font-family:B;src:${font("archivo-400.woff2")};font-weight:400 700}@font-face{font-family:M;src:${font("ibm-plex-mono-600.woff2")}}
*{margin:0;box-sizing:border-box}body{width:1200px;height:630px;background:#1C1730;color:#fff;font-family:B;overflow:hidden}`;

const PAGES = {
  home: ["Come ride with us, Mane.", "Memphis rap & hip hop bus tour", "3 hours · 8 stops · from Beale Street"],
  route: ["The route: 8 stops", "Beale Street to North Memphis", "Fri & Sat · 2:00 pm Central"],
  book: ["Book a seat on the bus", "$70 per person · 3 hours", "Fri & Sat · 2:00 pm Central"],
  reviews: ["What riders say", "5.0 · 20 reviews on Tripadvisor", "as of 3 Nov 2026"],
  private: ["Take the whole bus", "Private tours from $600", "team@memphisraptour.com"],
  faq: ["Questions people ask", "Times, meeting point, kids, access", "Memphis Rap Tour"],
  about: ["About Memphis Rap Tour", "A local Memphis company", "Owned by Carlos Barksdale"],
};

function shot(htmlBody, out, w, h) {
  const dir = mkdtempSync(join(tmpdir(), "mrt-img-"));
  const file = join(dir, "x.html");
  writeFileSync(file, `<!doctype html><meta charset=utf-8><style>${css}body{width:${w}px;height:${h}px}</style>${htmlBody}`);
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${w},${h}`, `--screenshot=${out}`, `file://${file}`], { stdio: "ignore" });
  if (!existsSync(out) || statSync(out).size < 2000) { console.error(`NAMED STOP [IMAGE_NOT_MADE] ${out}`); process.exit(9); }
  console.log("made", out.replace(root + "/", ""), statSync(out).size, "bytes");
}

for (const [slug, [h, sub, small]] of Object.entries(PAGES)) {
  shot(`<div style="display:grid;grid-template-columns:720px 480px;height:630px">
<div style="padding:64px 56px;display:grid;align-content:space-between">
<div style="font:600 20px M;letter-spacing:.14em;color:#F0AE1A">MEMPHIS RAP TOUR</div>
<div><div style="font:76px/1.02 A">${h}</div><div style="font:600 34px/1.25 B;margin-top:22px">${sub}</div></div>
<div style="font:600 22px M;color:#E4E2EA">${small}</div></div>
<div style="background:url(${mural}) center 30%/cover;border-left:12px solid #F0AE1A"></div></div>`, join(root, "public/og", `${slug}.png`), 1200, 630);
}
const mark = (s) => `<div style="width:${s}px;height:${s}px;display:grid;place-items:center;background:#1C1730"><div style="width:${s * 0.62}px;height:${s * 0.62}px;border-radius:50%;border:${s * 0.08}px solid #F0AE1A;display:grid;place-items:center"><div style="width:${s * 0.16}px;height:${s * 0.16}px;border-radius:50%;background:#F0AE1A"></div></div></div>`;
shot(mark(180), join(root, "public/assets", "icon-180.png"), 180, 180);
shot(`<div style="width:512px;height:512px;display:grid;place-items:center;background:#1C1730;text-align:center"><div style="font:64px/1.05 A;color:#fff">MEMPHIS<br>RAP<br><span style="color:#F0AE1A">TOUR</span></div></div>`, join(root, "public/assets", "logo.png"), 512, 512);
