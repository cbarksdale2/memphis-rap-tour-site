# Google Business Profile: draft for Memphis Rap Tour

Draft only. Nothing has been submitted. Facts come from the business brain (owner rulings of 3 Nov 2026)
and the Tripadvisor listing read on 3 Nov 2026. Each line says where it came from.

## Read this first

- **Don't list the meeting point as the business address.** Google says a profile must be for "your
  actual, real-world location", and a location the business doesn't own or staff doesn't qualify
  ([Google Business Profile guidelines](https://support.google.com/business/answer/3038177)). A street
  corner outside Patio Bar is a meeting point, not premises. Set the profile up as a **service-area
  business** with the address hidden, and put the meeting point in the description (below).
  Google still asks for a real mailing address to verify the business, which is **Carlos's to give**.
- **Verification is Carlos's step**: Google usually asks for a short video or a postcard code.
- **Hours**: Google says businesses that run "only by appointment shouldn't list hours". The tours run at
  fixed public times, so listing them is reasonable, but it's a judgement call (below).

## The fields

| Field | Draft | Source |
|---|---|---|
| Business name | Memphis Rap Tour | Brain; Google forbids extra keywords in the name |
| Primary category | Tour operator | UNVERIFIED: pick the nearest match in Google's category list when creating |
| Additional category | Sightseeing tour agency | UNVERIFIED: as above |
| Business type | Service-area business, address hidden | Google guidelines (above) |
| Service area | Memphis, Tennessee | Brain |
| Hours | Friday 2:00–5:00 pm, Saturday 2:00–5:00 pm (Central). Mark holidays or cancelled dates as special hours | Brain: Fri & Sat 2:00 pm, 3 hours (Acuity, read 3 Nov 2026) |
| Phone | Leave empty | Owner ruling 3 Nov 2026: no phone number on the website. Carlos may choose differently for Google |
| Website | https://www.memphisraptour.com | After the domain switch (`docs/dns-cutover.md`). Until then the domain still shows the Squarespace site |
| Booking (appointment) link | https://app.acuityscheduling.com/schedule.php?owner=35599844 | Brain. Change to `https://www.memphisraptour.com/tickets` only at the booking cutover |
| Email | team@memphisraptour.com | Brain |
| Social profiles | Instagram https://www.instagram.com/memphisraptour/ · TikTok https://www.tiktok.com/@memphis.rap.tour | Site audit, 3 Nov 2026 |
| Opening date | August 2025 | Brain: first tour 23 Aug 2025 (Canva flyer) |

### Description (702 of 750 characters)

> Memphis Rap Tour is a guided bus tour of the neighborhoods, venues and landmarks behind Memphis rap and
> hip hop. Your guide tells the stories of the city's rappers, DJs and producers on a 3-hour ride, with
> photo stops at the murals and bites from local food spots on the way. The tour makes 8 stops: Beale
> Street, the Orpheum Theatre, the Young Dolph Mural, Makeda's Cookies, the Orange Mound neighborhood, the
> Gangsta Boo Mural, North Memphis and a downtown rapper mural. Tours leave Fridays and Saturdays at 2:00 pm
> from Beale St and S B.B. King Blvd, outside Patio Bar, and end at the same spot. The bus is
> air-conditioned and wheelchair accessible. Groups can book the whole bus for a private tour.

Every claim traces to a source:
- 3 hours, Fri and Sat at 2:00 pm, the 8 stops in order, the meeting point, and "ends at the same spot":
  owner rulings, 3 Nov 2026 (brain).
- Guided bus tour, stories of rappers, DJs and producers, photo stops, local food: the current site's
  feature blocks, plus the food line Carlos approved on the mock-up.
- Air-conditioned and wheelchair accessible: Tripadvisor listing details (owner-supplied), read 3 Nov 2026.
- "First" tour claim: left out (no source).
- No prices in the description: they go in Products, where Google shows them as offers.

### Products / services

| Name | Price | Description |
|---|---|---|
| Memphis Rap & Hip Hop Bus Tour | $70 per person | 3-hour guided bus tour, Fridays and Saturdays at 2:00 pm from Beale Street. |
| Private tour (whole bus) | From $600 | Book the bus for your group: birthdays, reunions, work trips. Email team@memphisraptour.com. |

Sources: $70 (Acuity, Viator; owner ruling 3 Nov 2026), from $600 (owner, 2 Nov 2026).

### Attributes (tick only those Google offers for a service-area tour business)

| Attribute | Value | Source |
|---|---|---|
| Wheelchair accessible | Yes | Tripadvisor details: "Wheelchair and stroller accessible" |
| Online appointments / booking | Yes | Acuity booking page |
| Service animals | Allowed | Tripadvisor details |

Leave out anything not in the record (for example ownership identity attributes): those are Carlos's to
choose.

## Photos

| Use | File | Note |
|---|---|---|
| Logo | `public/assets/logo.png` (512 × 512) | Made for the new site |
| Cover | `public/photos/mural.jpg` (900 × 1200; Google crops covers to landscape, so check the crop) | Carlos's own photo from the current site |
| Don't use | `public/photos/bus.jpg` | Looks AI-generated. Google asks for photos that show the real business |
| Don't use | Artist press photos; Tripadvisor photos | Rights unclear (NEEDS COUNSEL in the audit) |
| Wanted | Real photos: the bus outside, the guide, riders at the murals (with their OK) | Ask Carlos or Taylor after the next tour |

## Steps (when Carlos says go)

1. Carlos signs in at https://business.google.com with the Google account that should own the profile.
2. Claude fills in the fields above in Chrome while he's signed in, and stops at verification.
3. Carlos does Google's verification (video or postcard).
4. After the domain switch, Claude updates the website link. After the booking cutover, the booking link.
