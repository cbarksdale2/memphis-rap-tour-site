# memphisraptour.com: moving DNS to Cloudflare, then the site to the Worker

Plan only. Nothing here has been changed live. Records were read on 3 Nov 2026 at 7:45 pm New York
(00:45 UTC on 4 Nov) from Google's authoritative server `ns-cloud-e1.googledomains.com`.

## Read this first

1. **Switching nameservers disconnects the Squarespace site.** Squarespace's help says "Your domain will
   disconnect from your site" when a Squarespace-registered domain moves to custom nameservers
   ([Squarespace: change nameservers](https://support.squarespace.com/hc/en-us/articles/4404183898125-Review-change-or-reset-your-domain-s-nameservers)).
   So step 1 can't promise "no visible change" just by copying the records. SUSPECTED: for a few minutes
   to hours, the old site may show a Squarespace "not connected" page. Step 1b says what to do about it.
   The safest choice is to do step 2 in the same sitting, since the new site is built and checked.
2. **The SPF record is broken today.** It includes `dc-aa8e722993._spfm.memphisraptour.com`, and that name
   has no record (CONFIRMED with dig). An include that doesn't resolve makes SPF a permanent error, so mail
   from team@memphisraptour.com currently passes no SPF check. Step 1c fixes it with Google's own value.
3. **No DKIM or DMARC records exist**, so team@ mail is less trusted by Gmail, Yahoo and Outlook. Step 1d
   (optional, later) adds them.
4. **DNSSEC is off** (no DS record, and the registry's RDAP record says `delegationSigned: false`), so there is nothing to undo before the switch.
5. **Two sign-ins are Carlos's**: the Cloudflare dashboard (Claude's command-line login can only read
   zones, not add one) and Squarespace Domains (the registrar). Claude does every click once he is signed in.

## What is there today

| Name | Type | Value | Keep? |
|---|---|---|---|
| `@` | A | `198.49.23.145` | Step 1: yes. Step 2: replaced by the Worker |
| `www` | CNAME | `ext-sq.squarespace.com` | Step 1: yes. Step 2: replaced by the Worker |
| `@` | MX | 1 `aspmx.l.google.com`, 5 `alt1`, 5 `alt2`, 10 `alt3`, 10 `alt4` `.aspmx.l.google.com` | **Always** (Google Workspace email) |
| `@` | TXT | `v=spf1 include:dc-aa8e722993._spfm.memphisraptour.com ~all` | Repaired in step 1c |
| `@` | TXT | `google-site-verification=bAI0XaSd1UHkQPwa7qz89CG0h8jGwiRqJ8AL9Qz7xjk` | **Always** |
| `_domainconnect` | CNAME | `_domainconnect.domains.squarespace.com` | Yes (harmless) |

Not present: AAAA, CAA, SRV, DMARC (`_dmarc`), DKIM (`google._domainkey`), wildcard, DNSSEC. A zone
transfer was refused, so names were checked one by one (the list is in the zone file header).
The importable copy is [`memphisraptour.com.zone`](memphisraptour.com.zone).

## Step 1: DNS moves to Cloudflare (site stays on Squarespace)

### 1a. Cloudflare (Carlos signed in, Claude clicks)

Labels from [Cloudflare: full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).

1. https://dash.cloudflare.com, Carlos's account (the one wrangler uses) › **Domains** › **Onboard a domain**.
2. Enter `memphisraptour.com`. Choose to add records by uploading the zone file (if the screen only offers a
   scan, take the scan and fix it in step 4). **Continue** › choose the **Free** plan.
3. **DNS** › **Records** › **Import and Export** › upload `docs/memphisraptour.com.zone`. Leave the option to
   proxy imported records **off**. Every record must show **DNS only** (grey cloud).
4. Compare the Cloudflare list against the table above, line by line. Delete anything a scan added that
   isn't in the table.
5. Write down the two nameservers Cloudflare assigns (also shown later on the zone's **Overview** page).
   Claude records them here: `__________.ns.cloudflare.com`, `__________.ns.cloudflare.com`.
6. Before switching, Claude checks Cloudflare answers exactly like Google does:
   ```sh
   CF=<first Cloudflare nameserver>
   for q in "@ A" "www CNAME" "@ MX" "@ TXT" "_domainconnect CNAME"; do set -- $q; n=$([ "$1" = @ ] && echo memphisraptour.com || echo "$1.memphisraptour.com")
     diff <(dig @ns-cloud-e1.googledomains.com +short $n $2 | sort) <(dig @$CF +short $n $2 | sort) && echo "same: $q"; done
   ```
   Every line must say `same`. Any difference: fix it in Cloudflare first. Don't switch.

### 1b. Squarespace Domains (Carlos signed in, Claude clicks)

Path from [Squarespace: change nameservers](https://support.squarespace.com/hc/en-us/articles/4404183898125-Review-change-or-reset-your-domain-s-nameservers).

1. https://account.squarespace.com/domains › **memphisraptour.com** › **DNS** › **Domain Nameservers** ›
   **Use Custom Nameservers**.
2. Squarespace asks for Carlos's password or 2FA (**his step**) › **Continue**. It may offer to disable
   DNSSEC: **Continue** (it is already off).
3. **Nameserver 1** and **Nameserver 2**: the two Cloudflare names from 1a step 5, copied exactly › **Save**.
4. Cloudflare shows the domain as **Active** when the switch is seen (often within an hour; Squarespace
   says up to 48 hours). Cloudflare emails the account when it's active.

**If the old site shows "not connected"** after the switch, pick one:
- **Recommended: go straight to step 2.** The new site is built and verified, and Book still goes to Acuity.
- Or keep Squarespace showing it: reconnect it as a third-party domain. Squarespace needs four A records
  (`198.185.159.144`, `198.185.159.145`, `198.49.23.144`, `198.49.23.145`), `www` CNAME
  `ext-cust.squarespace.com`, and a verification CNAME with a code that only Squarespace's panel shows
  ([Squarespace: third-party domain](https://support.squarespace.com/hc/en-us/articles/205812378-Connect-a-third-party-domain-to-your-Squarespace-site)).
  SUSPECTED: Squarespace may not offer this for a domain registered in the same account.

### 1c. Repair SPF (Claude, in Cloudflare, once Active)

Replace the TXT `v=spf1 include:dc-aa8e722993._spfm.memphisraptour.com ~all` with Google's value for
Workspace mail, `v=spf1 include:_spf.google.com ~all`
([Google: set up SPF](https://support.google.com/a/answer/33786)). One SPF record only.
Check: `dig +short TXT memphisraptour.com` shows it, and an SPF checker reports pass for Google's servers.
Nothing else sends as @memphisraptour.com today as far as the records show. Acuity and Stripe send from
their own domains. If a sender is found later, add its `include:` to the same record.

### 1d. Later, optional: DKIM and DMARC

- DKIM: Google Admin console (admin.google.com, **Carlos signs in**) › Apps › Google Workspace › Gmail ›
  Authenticate email › Generate new record. Claude adds the `google._domainkey` TXT in Cloudflare, then
  clicks Start authentication.
- DMARC, after DKIM passes for a week: TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:team@memphisraptour.com`.

### Check after step 1

- `dig +short NS memphisraptour.com` lists the two Cloudflare names.
- MX, TXT, A and www answer as in the table (repeat the 1a step 6 loop against a public resolver).
- Email: Carlos confirms team@ still receives (Claude can't send test emails). MX didn't change, so it
  should. CONFIRMED only once he sees a new message arrive.

## Step 2: the site moves to the Worker

Only after step 1 is Active and email is confirmed.

1. Cloudflare › **DNS** › **Records**: delete `@` A `198.49.23.145` and `www` CNAME `ext-sq.squarespace.com`
   (plus any Squarespace records added in 1b). Leave MX, TXT and `_domainconnect`.
2. **Workers & Pages** › `memphis-rap-tour-site` › **Settings** › **Domains & Routes** › **Add** ›
   **Custom Domain** › `www.memphisraptour.com` › **Add Custom Domain**. Repeat for `memphisraptour.com`.
   Cloudflare creates the DNS records and certificates
   ([Cloudflare: Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)).
3. Claude lands a PR that writes the same thing into `wrangler.toml`, so later deploys keep it:
   ```toml
   [[routes]]
   pattern = "www.memphisraptour.com"
   custom_domain = true

   [[routes]]
   pattern = "memphisraptour.com"
   custom_domain = true
   ```
   The same PR sets `SITE_URL: https://www.memphisraptour.com` in `.github/workflows/site-check.yml`.
4. **Noindex comes off by itself.** The code marks every host noindex except `CANONICAL_HOST`
   (`www.memphisraptour.com`), and sends the bare domain to `www` with a 301. Nothing to change. Checks:
   - `https://www.memphisraptour.com/robots.txt` says `Allow: /` and names the sitemap
   - the home page has no `noindex`
   - `https://memphisraptour.com/faq` answers 301 to `https://www.memphisraptour.com/faq`
   - `vault run -- node scripts/verify-live.mjs https://www.memphisraptour.com --booking` confirms every line
5. Stripe: Claude creates a webhook endpoint for `https://www.memphisraptour.com/stripe/webhook` through the
   API (test mode), saves its secret to the vault and the Worker, and removes the workers.dev endpoint.
6. Search: the `google-site-verification` TXT is kept, so Search Console stays verified. Submit
   `https://www.memphisraptour.com/sitemap.xml` in Search Console and Bing Webmaster Tools.
7. Squarespace: the site there is no longer on the domain. **Don't cancel the plan** until its billing page
   shows Acuity is billed on its own (Acuity reports `isIntegratedSquarespace: true`). The domain itself stays
   registered at Squarespace Domains LLC (expires 16 Feb 2027, CONFIRMED from the .com registry's RDAP
   record on 4 Nov 2026 UTC; check auto-renew).

## Rollback

| Undo | How | How fast |
|---|---|---|
| Step 2 (site back to Squarespace) | Remove both custom domains from the Worker; re-add `@` A `198.49.23.145` and `www` CNAME `ext-sq.squarespace.com`, both DNS only | Minutes |
| Step 1c (SPF) | Put the old TXT back (it is in the zone file) | Minutes |
| Step 1 (DNS back to Google/Squarespace) | Squarespace › memphisraptour.com › **DNS** › **Domain Nameservers** › **Use Squarespace nameservers** › reauthenticate (Carlos) › **Save**. The old Google-hosted records were never touched, so everything comes back as it was. DNSSEC was off before; leave it off | Up to 48 hours (Squarespace), usually sooner |

## Who does what, in one sitting (about 30 minutes plus waiting)

| # | Who | What |
|---|---|---|
| 1 | Carlos | Signs in at dash.cloudflare.com in Chrome |
| 2 | Claude | 1a: onboard the domain, import the zone file, check DNS-only, compare, note the nameservers |
| 3 | Carlos | Signs in at account.squarespace.com in Chrome (and re-enters the password or 2FA when asked) |
| 4 | Claude | 1b: enter the Cloudflare nameservers, save |
| 5 | Claude | Waits for Active (one bounded background check), then 1c (SPF), then step 2 if Carlos said yes in advance |
| 6 | Carlos | Confirms an email reached team@memphisraptour.com |
