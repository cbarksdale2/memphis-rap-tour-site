# Memphis Rap Tour website: runbook

One Cloudflare Worker serves the public site, the admin at `/admin`, and the booking pages at `/tickets`.
Content, bookings, the email list and logins live in D1 (`mrt-site`). Photos and daily backups live in
Workers KV. Everything runs on Cloudflare's free tier ($0).

| Thing | Where |
|---|---|
| Preview site | `https://memphis-rap-tour-site.<account>.workers.dev` (see the last deploy line) |
| Admin | `<site>/admin` |
| Database | D1 `mrt-site` |
| Photos | KV namespace `mrt-site-images` (R2 is not enabled on the account: it needs a card on file) |
| Backups | KV namespace `mrt-site-backups`, key `backup:YYYY-MM-DD`, newest 30 kept |
| Code | this repo (public: no secrets, no customer data) |

## Signing in

- **One shared login**: `team@memphisraptour.com` (Carlos and Taylor share it). Owner ruling, 3 Nov 2026.
- **First sign-in**: the temporary password is in the vault as `MRT_ADMIN_TEMP_PASSWORD_CARLOS`. The site asks
  for a new password at once, then shows **10 recovery codes once**. Save them in a password manager.
- **Change the password**: More › Your account › Password.
- **Forgot it**: the sign-in page has "Email a reset link" (works once you set up email, below) and "Use a
  recovery code" (works now). Each code works once; make new ones on Your account.
- **Locked out after wrong tries**: 5 wrong tries from one connection wait 15 minutes on that connection
  only; 20 from one connection across any email wait 15 minutes. Nothing is ever locked for good, and
  tries from somewhere else never lock you out.
- **Sign out everywhere**: More › Your account › Sign out everywhere. The same page lists every device.
- **Reset the password without email or codes** (Claude can do this):
  ```sh
  openssl rand -base64 18 | tr -d '\n' | vault set MRT_ADMIN_TEMP_PASSWORD_CARLOS
  vault run -- node scripts/reset-password.mjs --email team@memphisraptour.com
  ```

## Editing the site

- **Pages** tab: each page's sections, top to bottom. Edit ✎, ↑ ↓ to reorder, Hide/Show, + Add a section.
  Section types: top of page, text, photo and text, tour stops, reviews, FAQ, call to action, gallery,
  email sign-up, private tour request form.
- **Saves are drafts.** A gold bar says "Not live yet". Preview › shows exactly what will go live;
  Publish ✓ puts it live.
- **History** (More): every save, who and when, and one-tap Restore (puts the site back as it was and
  makes it live). The "Who did what" list below it is the audit log.
- **Tour info** (More): price, length, times, meeting point, stops, Book link, refund policy text. These
  fill in everywhere via `{price}`, `{duration}`, `{schedule_long}`, `{private_price}`, `{email}`.
- **Photos** (More): upload from the phone (shrunk to 2000 px and converted in the browser, which also
  removes location data), a description is required, removed photos can be brought back for 30 days.
- **Share images** (`public/og/*.png`) are drawn from fixed text. If the price or length changes, rerun
  `node scripts/make-images.mjs` and land the change.

## Bookings (own booking tool)

Status: **built and tested against Stripe in test mode. Book buttons still go to Acuity.**

- **Tours** tab: add repeating dates (default every Fri and Sat at 2:00 pm Memphis time, 30 seats, the Tour
  info price), or one date. Open a date for the riders list, check-in list, spreadsheet, seats and price,
  and to close it.
- **Outside sales** (Viator, Eventnoire, Airbnb, Acuity): open the date › + Add outside booking. It comes
  off the same seat count. The site refuses to go over the seat limit unless you tick "Allow it".
- **Cancel / refund**: open the date › the rider › Cancel and refund. Site bookings are refunded through
  Stripe (nothing changes if Stripe says no); outside bookings just free the seats (refund them on that site).
- **Seats are never oversold**: a checkout holds seats for 15 minutes, and a hold is one database insert
  that only succeeds while enough seats are left. A payment that arrives after its hold ran out keeps the
  seats if still free, otherwise it is refunded automatically and marked.
- **Refund policy**: placeholder text "coming soon" (NEEDS CARLOS / COUNSEL). Edit it on Tour info.

### Stripe set-up (Carlos)

1. Create the Stripe account at https://dashboard.stripe.com/register (business: Memphis Rap Tour).
2. Test mode first (toggle top right). Developers › API keys › Secret key (`sk_test_…`):
   `vault set STRIPE_SECRET_KEY_MRT` (paste at the hidden prompt).
3. Developers › Webhooks › Add endpoint: URL `<site>/stripe/webhook`, events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`,
   `charge.refunded`. Copy its Signing secret (`whsec_…`): `vault set STRIPE_WEBHOOK_SECRET_MRT`.
4. Claude puts them on the Worker:
   ```sh
   vault run -- sh -c 'printf %s "$STRIPE_SECRET_KEY_MRT" | npx wrangler secret put STRIPE_SECRET_KEY'
   vault run -- sh -c 'printf %s "$STRIPE_WEBHOOK_SECRET_MRT" | npx wrangler secret put STRIPE_WEBHOOK_SECRET'
   ```
5. Test with card `4242 4242 4242 4242`. Test payments are marked "TEST PAYMENT" on the riders list.

### Cutover from Acuity (only with Carlos's yes)

1. Live keys saved (steps 2–4 with live-mode values), and `STRIPE_MODE = "live"` set in `wrangler.toml`
   through a PR. A live key is refused while that says anything else.
2. Carlos makes one real booking on `/tickets` and refunds it from the admin.
3. Admin › Tours › Online booking set-up › "Switch Book buttons to this site". The switch refuses until
   1 and 2 are true. "Send Book buttons back to Acuity" undoes it at once.
4. Keep Acuity, Viator, Eventnoire and Airbnb dates in line with the Tours tab (outside bookings).

## Email (not set up yet)

Nothing is emailed until the domain is on Cloudflare. Until then, private tour requests, bookings and
reset links all still work in the admin, and each row says "not sent: email not set up yet".

To turn it on (after the domain switch below): Cloudflare dashboard › memphisraptour.com › Email ›
Email Sending (or Email Routing with team@memphisraptour.com verified as a destination), then add to
`wrangler.toml` through a PR:

```toml
send_email = [{ name = "EMAIL" }]
[vars]
EMAIL_FROM = "team@memphisraptour.com"
```

Customer booking confirmations need Email Sending (Email Routing only sends to verified addresses).
Check its price on the free plan before turning it on.

## Secrets

Set once per Worker, values from the vault, never typed on a command line:

```sh
vault run -- sh -c 'printf %s "$MRT_UNSUB_SECRET" | npx wrangler secret put UNSUB_SECRET'
vault run -- sh -c 'printf %s "$MRT_IP_SALT" | npx wrangler secret put IP_SALT'
```

`UNSUB_SECRET` signs unsubscribe and booking links; changing it breaks every link already sent.
The site refuses sign-ups and bookings (named stop `SECRET_MISSING`) if either is missing.

## Deploying

- Every change: worktree → PR → `land <pr>`. CI (typecheck, behaviour tests, safety checks) must be green.
- `land` runs `npm run deploy:production` (`scripts/deploy.sh`) from a clean copy at the merge commit:
  it applies new D1 migrations, deploys, and checks `/health`. Never a bare `wrangler deploy`.
- Migrations are additive only and end with their `schema_version` row (a test pins this).

## Backups and restore

- **Automatic**: a daily job (09:00 UTC) copies every table (and the newest 200 content versions) to KV
  `mrt-site-backups` as `backup:YYYY-MM-DD` and keeps 30. It fails loudly if it read no rows.
- **By hand, to this Mac** (do this before any risky change):
  ```sh
  npx wrangler d1 export mrt-site --remote --output ~/work/records/mrt-site-$(date +%F).sql
  ```
- **Restore the site content only**: Admin › History › Restore (no code needed).
- **Restore the whole database** from a hand export: create a new D1 database, import the file, point
  `database_id` in `wrangler.toml` at it through a PR:
  ```sh
  npx wrangler d1 create mrt-site-restore
  npx wrangler d1 execute mrt-site-restore --remote --file ~/work/records/mrt-site-YYYY-MM-DD.sql
  ```
- **From a KV backup**: `npx wrangler kv key get --namespace-id 18838207c81e4be38bb6e4b052b047a1 backup:YYYY-MM-DD --remote > backup.json`
  (JSON, one array per table) and re-insert the rows needed.

## Rollback

- **Content**: Admin › History › Restore.
- **Code**: `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`; then revert the PR on
  main so the next land doesn't bring it back.
- **Booking**: Online booking set-up › Send Book buttons back to Acuity.

## Scheduled jobs

| Job | When | What | Where it reports |
|---|---|---|---|
| Daily backup + tidy | 09:00 UTC (Worker cron) | KV backup, keep 30; purge photos removed 30+ days ago; drop old rate-limit rows and dead sessions | Worker logs: one census line |
| Daily site check | 13:00 UTC (GitHub Actions) | Every sitemap page answers 200; Book reaches the booking page; the site's price, length and days match the booking page | Opens or updates one GitHub issue; closes it when clear. "Could not read" is never treated as all clear |

## Domain switch (Carlos's step, later)

Do this only after the preview is approved. **Don't cancel Squarespace until Acuity billing is confirmed
separate**: the Acuity account reports `isIntegratedSquarespace: true` (read 3 Nov 2026).

1. Find where team@memphisraptour.com's mailbox is hosted (its MX records). It must keep working.
2. Cloudflare dashboard › Add a site › `memphisraptour.com` › Free plan. Cloudflare copies the current DNS
   records. Check the MX, TXT (SPF/DKIM/verification) and any other records match the old ones exactly.
3. At the domain registrar (Squarespace Domains if bought there), change the nameservers to the two that
   Cloudflare shows. Wait until Cloudflare says Active.
4. In Cloudflare DNS, delete the old website records for `@` and `www` (the A records and the `www` CNAME
   that point at Squarespace; read their values in the imported list). Leave MX and TXT alone.
5. Claude adds the custom domains through a PR (`wrangler.toml`):
   ```toml
   routes = [
     { pattern = "www.memphisraptour.com", custom_domain = true },
     { pattern = "memphisraptour.com", custom_domain = true },
   ]
   ```
   Cloudflare creates the DNS records and certificates. The bare domain redirects to `www` (the host
   Google already knows). The site becomes indexable on that host only.
6. Change `SITE_URL` in `.github/workflows/site-check.yml` to `https://www.memphisraptour.com`, submit the
   sitemap in Google Search Console and Bing Webmaster Tools, and update the Stripe webhook URL.
7. Only then: cancel Squarespace, after confirming on its billing page that Acuity is billed on its own.

## Things that need counsel or Carlos

- NEEDS COUNSEL: may the site show artist press photos? (None are used.) Is the "Fair Use" line needed?
  (Left out; the plain "not affiliated" disclaimer is shown.)
- NEEDS COUNSEL: review excerpts from Tripadvisor (short, credited, linked) versus the official widget.
- NEEDS CARLOS / COUNSEL: refund and cancellation policy text.
- NEEDS CARLOS: the bus image on About looks AI-generated; replace it with a real photo when there is one.
