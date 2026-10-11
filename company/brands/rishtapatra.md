---
handle: rishtapatra
name: RishtaPatra
nameDevanagari: रिश्तापत्र
site: https://rishtapatra.com
contact: info@rishtapatra.com
languages: [hi, en]
emoji: sparse
allowedDevanagari: null
sourceRepo: shubhpatra
sourceRevision: working tree 2026-10-10
sourceVerifiedAt: 2026-10-10
---

Source pointers are `<repo-folder>/<path>:<lines>` relative to the owner's workspace folder (`c:\Users\sudiskmr\Downloads\DomainClassification\`), several joined by ` ; `. `status` is `confirmed` for verbatim product copy, `source-only` for facts present in docs or code but not yet owner-confirmed as marketing-safe, `disputed` where the owner flagged the wording (unusable until confirmed). Nothing about user counts, testimonials or ratings exists in any source and none may be written.

## Voice

- Warm and family-facing: the page talks to the person making a biodata for themselves or for a son, daughter, brother or sister.
- Plain Hindi + English; Hindi lines in Devanagari (display face Tiro Devanagari Hindi), English lines short and concrete.
- Religion-neutral: never assume a faith, a ritual or a community; "kundali" is offered, never required.
- Never pushy: no urgency, no countdowns, no "limited offer"; the free product leads.
- "biodata", "rishta", "kundali" stay as the product's own words (not "CV", "match", "horoscope" in the headline).
- Sentences of one idea each; one claim per line on artwork.
- Emoji: sparse (at most 2 per caption), never in the headline.
- Words to prefer: free, on your device, one page, family, kundali, rishta. Words to avoid: guaranteed, perfect, best, #1, verified, trusted by.

## Facts

| id | fact | source | status |
|---|---|---|---|
| rp-f01 | Name "RishtaPatra · रिश्तापत्र"; site rishtapatra.com; support address info@rishtapatra.com; operates from India | shubhpatra/src/lib/brand.ts:4-9 ; shubhpatra/public/logo.svg:1,17 ; shubhpatra/README.md:1 | confirmed |
| rp-f02 | Tagline "From biodata to rishta" / "बायोडाटा से रिश्ते तक" | shubhpatra/.agents/tasks/rishta-auth/design-brief.md:7 ; shubhpatra/public/logo.svg:18 ; shubhpatra/README.md:1 | confirmed |
| rp-f03 | Hero line "Make your biodata. Match your kundali. Find your rishta." / "बायोडाटा बनाइए। कुंडली मिलाइए। रिश्ता ढूंढिए।" | shubhpatra/.agents/tasks/rishta-auth/design-brief.md:9 | confirmed |
| rp-f04 | Three products: biodata maker · Rishta Connect (matchmaking) · Janam Kundali (free) | shubhpatra/README.md:3 ; shubhpatra/.agents/tasks/rishta-auth/design-brief.md:8 | confirmed |
| rp-f05 | Local-first: every detail, photo and imported resume is processed in the browser and saved only on the device; an account is optional | shubhpatra/README.md:4-5 | confirmed |
| rp-f06 | Guided 7-step editor (Personal, Kundali, Education & Career, Family, About, Partner, Contact) plus a Photo step; live A4 preview that auto-fits to one page | shubhpatra/README.md:20-25 | source-only |
| rp-f07 | Janam Kundali is computed client-side (the astrology engine runs in the browser); no request carries birth data | shubhpatra/.agents/tasks/rishta-kundali/context.json:2,8 | source-only |
| rp-f08 | 36-point Guna Milan score shown on Rishta Connect match cards ("Guna Milan 22.5/36") | shubhpatra/.agents/tasks/rishta-auth/design-brief.md:30 | source-only |
| rp-f09 | Kundali disclaimer: "indicative, North Indian method; consult your pandit/astrologer"; no health, money or legal advice | shubhpatra/.agents/tasks/rishta-kundali/context.json:11 | confirmed |
| rp-f10 | Religion-neutral mark "Do Patra" (two overlapping biodata pages, gold where they meet); the product serves Hindu, Muslim, Sikh, Christian, Jain, Buddhist and Parsi users | shubhpatra/.agents/tasks/rishta-auth/design-brief.md:10 ; shubhpatra/README.md:9 | confirmed |
| rp-f11 | Rishta Connect has human moderation; payments via Razorpay; a refund policy exists; contact info@ | shubhpatra/.agents/tasks/rishta-auth/design-brief.md:26 | source-only |
| rp-f12 | Biodata document language: English or any of 11 Indian languages (Hindi, Marathi, Tamil, Telugu, Urdu, Gujarati, Bengali, Kannada, Malayalam, Punjabi, Odia); the UI is Hindi + English (owner says EN/HI; unusable until confirmed in the brand editor) | shubhpatra/README.md:4 ; shubhpatra/README.md:37-38 | disputed |

## Pricing

Prices may be quoted only from this table and only with "at the time of posting". Status of every row: source-only.

| sku | price | source |
|---|---|---|
| premium-template | ₹99–₹349 per premium template (11 templates: 4 free + 7 premium) | shubhpatra/README.md:26 |
| shubh-pass | ₹499 for all premium templates | shubhpatra/README.md:26 |
| photo | ₹50 one-time photo add-on on free templates (included with the pass and with any premium template) | shubhpatra/README.md:27-29 |
| mandir-dwar | ₹349, the flagship premium template | shubhpatra/README.md:31 |
| spotlight | ₹49 "Boost me" on Rishta Connect | shubhpatra/.agents/tasks/rishta-auth/design-brief.md:29 |
| connect-pass | price not listed in the sources (not configured yet) | shubhpatra/.agents/tasks/rishta-auth/design-brief.md:29 |

## Disclaimers

Each entry: a trigger (`always`, or words joined by ` | ` any of which fires it when present in the caption) and one or more `require` lines; every `require` line is a group of alternatives joined by ` | `, and one alternative per group must appear verbatim.

- trigger: kundali | कुंडली | horoscope | guna milan
  require: indicative
  require: consult your pandit | अपने पंडित से सलाह लें

## Forbidden

One regular expression per line (flags `iu`); a match anywhere in the caption, hashtags, alt text or artwork copy fails QA.

- `guaranteed match`
- `100\s*%`
- `#1\b`
- `best biodata`
- `\b\d[\d,.]*\s*(?:\+|lakh|crore|k)?\s*(?:users|members|families|profiles|downloads|rishtas|matches)\b`
- `["“][^"”]{3,}["”]\s*[—–-]\s*\p{Lu}`
- `verified by`
- `trusted by`

## Tokens

- colour brand: #7a1f2b — shubhpatra/src/styles.css:5
- colour brand-700: #5e1621 — shubhpatra/src/styles.css:6
- colour brand-50: #fbeef0 — shubhpatra/src/styles.css:7
- colour accent: #c9a227 — shubhpatra/src/styles.css:8
- colour accent-ink: #8a6a0f — shubhpatra/src/styles.css:9
- colour bg: #fbf7f0 — shubhpatra/src/styles.css:10
- colour surface: #ffffff — shubhpatra/src/styles.css:11
- colour surface-2: #fff8ee — shubhpatra/src/styles.css:12
- colour ink: #2b1a1d — shubhpatra/src/styles.css:13
- colour ink-2: #6b5a5d — shubhpatra/src/styles.css:14
- colour ok: #2f6b3a — shubhpatra/src/styles.css:15
- colour line: #ead9c6 — shubhpatra/src/styles.css:16
- font display: Cormorant Garamond 700 — shubhpatra/src/styles.css:49 ; shubhpatra/public/logo.svg:16
- font ui: Inter / Mukta — shubhpatra/src/styles.css:48
- Devanagari: Tiro Devanagari Hindi — shubhpatra/src/styles.css:49-50 ; shubhpatra/public/logo.svg:17
- logo: shubhpatra/public/logo.svg — shubhpatra/public/logo.svg:3-14
- note: gold (accent) is for decoration and text at 24 px or larger only; small gold text uses accent-ink — shubhpatra/src/styles.css:8-9 ; shubhpatra/.agents/tasks/rishta-auth/design-brief.md:45
- note: no dark mode in the product; artwork stays light (cream and maroon) — shubhpatra/.agents/tasks/rishta-auth/design-brief.md:50

## Allowed domains

- rishtapatra.com

## Formats

- image: template image — 1080×1350; variant by headline length (A ≤ 36 chars, B ≤ 60, C longer); maroon headline on cream, thin gold rule, 2–3 fact lines in ink, Hindi lines in Tiro Devanagari Hindi, footer "rishtapatra.com" with the Do Patra mark
- carousel: template carousel — 3–7 slides at 1080×1350; cover slide maroon with cream display type, body slides cream with maroon headings and ink body, closing slide repeats the tagline and site
- reel: template reel-kinetic — 1080×1920, 15–30 s, silent, 30 fps; style `kinetic`: each scene's line types on in Cormorant Garamond (Hindi in Tiro Devanagari Hindi) over the cream background with the brand row, a gold rule and the footer; style `capture` (template reel-capture): the product's own public pages from the capture list below inside a phone frame on cream, one caption bar per scene in maroon, footer "rishtapatra.com"
- capture: verified 2026-10-11 — public pages of rishtapatra.com recorded at a 1080×1920 phone viewport (curl.exe returned 200 text/html for each; the routes are the product's own, see the pointers)
  - `/` — shubhpatra/src/lib/routes.ts:20
  - `/hi/` — shubhpatra/src/lib/routes.ts:20
  - `/app` — shubhpatra/src/lib/routes.ts:4
  - `/kundali` — shubhpatra/src/lib/routes.ts:12
  - `/kundali/milan` — shubhpatra/src/lib/routes.ts:12
