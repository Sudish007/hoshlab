---
handle: job_rez
name: JobRez
nameDevanagari: ""
site: https://jobrez.com
contact: ""
languages: [en]
emoji: none
allowedDevanagari: []
sourceRepo: vitae-os
sourceRevision: working tree 2026-10-10
sourceVerifiedAt: 2026-10-10
---

Source pointers are `<repo-folder>/<path>:<lines>` relative to the owner's workspace folder (`c:\Users\sudiskmr\Downloads\DomainClassification\`), several joined by ` ; `. `status` is `confirmed` for verbatim product copy, `source-only` for facts present in docs or code but not yet owner-confirmed as marketing-safe, `disputed` where the owner flagged the wording. Nothing about user counts, testimonials or ratings exists in any source and none may be written. No public support address is listed in the sources (contact: not configured yet).

## Voice

- Plain, specific, honest by default: say what is real and what is not ("self-reported", "not a certification").
- Speaks to engineers: concrete nouns (branch, posting, taxonomy, layout rule), no marketing abstractions.
- No hype, no exclamation marks, no superlatives; the product's own README is the register.
- No country-specific branding tokens anywhere in captions, hashtags, alt text or artwork (OF-2): no country names, no local job boards, no local degree or tax acronyms. Write "live jobs panel", never a country.
- Prices are allowed only from the pricing table and only in ₹ as the product lists them.
- Emoji: none. Language: English only (no Devanagari).
- Words to prefer: master resume, branch, Job DNA, evidence, layout rules, free to export. Words to avoid: AI-powered, ATS-certified, beat the ATS, guaranteed.

## Facts

| id | fact | source | status |
|---|---|---|---|
| jr-f01 | Name "JobRez" (two-tone wordmark "Job" + "Rez"); domain jobrez.com; live at https://jobrez.com since 2026-10-03 | vitae-os/src/data/brand.ts:7-10 ; vitae-os/README.md:150 | confirmed |
| jr-f02 | Tagline "Build the resume. Land the job." | vitae-os/src/data/brand.ts:11 ; vitae-os/README.md:3 | confirmed |
| jr-f03 | Description: "One honest master resume, branched for every role and matched to real postings. ATS-safe by structure, private by default, free to export." | vitae-os/src/data/brand.ts:13 | confirmed |
| jr-f04 | One master resume; branches are copies tailored per role; each branch is scored against the posting in Job DNA | vitae-os/README.md:5 ; vitae-os/README.md:37 ; vitae-os/README.md:66 | confirmed |
| jr-f05 | Role match is deterministic: a curated technology taxonomy with aliases, whole-word matching, required terms weighted double and preferred terms once; no cloud AI, no external verification | vitae-os/README.md:28 ; vitae-os/README.md:30 | confirmed |
| jr-f06 | Evidence notes are self-reported: "linked source" (a URL is attached), "self-attested" (a source was named), "open" (nothing supports the claim yet); nothing is externally verified | vitae-os/README.md:31 | confirmed |
| jr-f07 | Six layout rules measured on the rendered page after every edit (single-column order, standard headings, real bullet lists, selectable text, no tables or floats, body text of at least 9.5pt); "not a certification against any ATS vendor" | vitae-os/README.md:32 | confirmed |
| jr-f08 | Grounded rewrites are rule-based: they replace weak openers, remove filler, fix capitalisation and punctuation, list every change, and never add numbers, tools or employers | vitae-os/README.md:33 | confirmed |
| jr-f09 | Exports to PDF, Word and plain text; PDF and plain-text export are unlimited and watermark-free on the free plan; Word (.docx) export is Pro | vitae-os/README.md:5 ; vitae-os/README.md:127-128 | confirmed |
| jr-f10 | Nine templates: TeXline, Stack First, Campus One (free); Nova, Product Engineer, Systems Lead, ATS Dense, Staff+ Impact, Executive Mono (Pro); Nova has a one-column / two-column switch | vitae-os/README.md:77-78 | confirmed |
| jr-f11 | Typefaces: Arial and Georgia (free), Calibri, Cambria and Verdana (Pro); seven accents; three densities | vitae-os/README.md:18-19 ; vitae-os/README.md:80 | confirmed |
| jr-f12 | The Jobs panel lists live roles from company careers pages (Lever, Greenhouse and Ashby boards), Adzuna and employer posts, with a link to the original posting; no sample or placeholder listings exist (write "live jobs panel", never a country) | vitae-os/README.md:5 ; vitae-os/README.md:36 ; vitae-os/README.md:47-49 | confirmed |
| jr-f13 | Tracker statuses: Saved, Applied, Interviewing, Offer, Closed; stored locally in the browser | vitae-os/README.md:57 | source-only |
| jr-f14 | Prep sheets and the cover-note draft are templates filled from the resume and the posting; nothing is paraphrased or invented; the scam flag is a fixed list of "pay to apply" phrases | vitae-os/README.md:38 | confirmed |
| jr-f15 | Dated metric: the first fill on 2026-10-03 produced 1,011 live listings from 35 boards; 47 sources are refreshed about six times a day (usable only with the date "as of 2026-10-03") | vitae-os/README.md:51 ; vitae-os/README.md:43 | source-only |

## Pricing

Prices may be quoted only from this table and only with "at the time of posting". ₹ is allowed here only (OF-2). Status of every row: source-only.

| sku | price | source |
|---|---|---|
| pro-30 | ₹699 for a 30-day Pro pass | vitae-os/README.md:55 |
| pro-365 | ₹4,188 for a 1-year Pro pass | vitae-os/README.md:55 |
| career-sprint | ₹1,499 for the 90-day Career Sprint pass | vitae-os/README.md:55 |
| renewal | nothing renews; a prepaid pass recorded after Razorpay confirms the payment | vitae-os/README.md:55 ; vitae-os/README.md:35 |

## Disclaimers

Each entry: a trigger (`always`, or words joined by ` | ` any of which fires it when present in the caption) and one or more `require` lines; every `require` line is a group of alternatives joined by ` | `, and one alternative per group must appear verbatim.

- none mandatory. When "ATS" appears, the caption must not claim certification or guaranteed parsing (jr-f07); the Forbidden list enforces it.

## Forbidden

One regular expression per line (flags `iu`); a match anywhere in the caption, hashtags, alt text or artwork copy fails QA. The first six are the OF-2 tokens.

- `\bIndia\b`
- `\bIndian\b`
- `\bNaukri\b`
- `B\.?Tech\b`
- `\bGST\b`
- `#India`
- `ATS[- ]certified`
- `(?<!\bnot\s)(?<!\bnever\s)\bparseable\s+by\s+construction\b`
- `(?<!\bnot\s)(?<!\bnever\s)\bparser[- ]safe\b`
- `(?<!\bnot\s)(?<!\bnever\s)\bATS[- ]proof\b`
- `(?<!\bnot\s)(?<!\bnever\s)\bATS[- ]compatible\b`
- `(?<!\bnot\s)(?<!\bnever\s)\bpasses?\s+(?:all|every|any)\s+ATS\b`
- `(?<!\bnot\s)(?<!\bno\s)(?<!\bnever\s)(?<!\bcannot\s)(?<!\bwithout\s)\b(?:guarante(?:e|es|ed|eing)|ensur(?:e|es|ed|ing))\b.{0,40}\b(?:pars(?:e|es|ed|ing|able)|parser|ATS)\b`
- `\b(?:pars(?:e|es|ed|ing|able)|parser|ATS)\b.{0,40}(?<!\bnot\s)(?<!\bno\s)(?<!\bnever\s)(?<!\bcannot\s)(?<!\bwithout\s)\b(?:guarante(?:e|es|ed|eing)|ensur(?:e|es|ed|ing))\b`
- `(?<!\bnot\s)(?<!\bnever\s)\b(?:works?|compatib(?:le|ility))\s+(?:with|across)\s+(?:all|every|any)\s+(?:ATS|parsers?)\b`
- `(?<!\bnot\s)(?<!\bnever\s)\b(?:all|every|any)\s+(?:ATS|parsers?)\b.{0,30}\b(?:can|will)\s+(?:read|parse|accept)\b`
- `(?<!\bnot\s)(?<!\bnever\s)\b(?:read|parsed?|accepted)\s+by\s+(?:all|every|any)\s+(?:ATS|parsers?)\b`
- `(?<!\bnot\s)(?<!\bnever\s)\b(?:always|universally)\s+(?:pars(?:e|es|ed|able)|ATS[- ]compatible)\b`
- `(?<!\bnot\s)(?<!\bno\s)\b(?:universal|full|complete|100\s*%)\s+(?:ATS|parser)[- ]compatib(?:le|ility)\b`
- `(?<!\bnot\s)(?<!\bnever\s)(?<!\bno\s)\bguaranteed\s+(?:interview|job|offer)\b`
- `beat the ATS`
- `AI[- ]powered`
- `\b\d[\d,.]*\s*(?:\+|k)?\s*(?:users|members|candidates|job seekers|engineers trust)\b`
- `["“][^"”]{3,}["”]\s*[—–-]\s*\p{Lu}`
- `!`

## Tokens

- colour ink: #0f172a — vitae-os/src/styles/base.css:62
- colour ink-2: #1e293b — vitae-os/src/styles/base.css:63
- colour text: #111827 — vitae-os/src/styles/base.css:64
- colour muted: #5b6472 — vitae-os/src/styles/base.css:65
- colour line: #e5e7eb — vitae-os/src/styles/base.css:68
- colour canvas: #f6f5fb — vitae-os/src/styles/base.css:70
- colour cream: #fafafa — vitae-os/src/styles/base.css:71
- colour violet: #7c3aed — vitae-os/src/styles/base.css:73
- colour violet-dark: #6d28d9 — vitae-os/src/styles/base.css:74
- colour violet-soft: #f3f0ff — vitae-os/src/styles/base.css:76
- colour green: #16a34a — vitae-os/src/styles/base.css:77
- colour green-text: #15803d — vitae-os/src/styles/base.css:78
- colour green-soft: #eefbf3 — vitae-os/src/styles/base.css:79
- colour lime: #c4b5fd — vitae-os/src/styles/base.css:80
- colour badge: #22c55e — vitae-os/src/styles/base.css:217 ; vitae-os/src/components/Brand.tsx:17
- gradient grad-violet: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%) — vitae-os/src/styles/base.css:81 ; vitae-os/public/favicon.svg:2-3
- font body: DM Sans — vitae-os/src/styles/base.css:93
- font display: Manrope 800, letter-spacing -0.05em — vitae-os/src/styles/base.css:94 ; vitae-os/src/styles/base.css:222-226
- font mono: DM Mono — vitae-os/src/styles/base.css:95
- logo: vitae-os/src/components/Brand.tsx — vitae-os/src/components/Brand.tsx:10-21 ; vitae-os/public/favicon.svg:1-6
- note: the mark is a resume sheet with a green match badge on the violet gradient tile; the gradient is allowed only inside JobRez media, never in site chrome — vitae-os/src/styles/base.css:205-219
- note: the 12 px text floor is the product's own rule — vitae-os/src/styles/base.css:97-98
- note: no Devanagari family; JobRez copy is English only (OF-2) — vitae-os/src/styles/base.css:93-95

## Allowed domains

- jobrez.com

## Formats

- image: template image — 1080×1350; canvas (#f6f5fb) with a white card, Manrope 800 headline in ink, violet accent rule, 2–3 DM Sans fact lines in text, DM Mono tag line, the mark on its gradient tile and footer "jobrez.com"
- carousel: template carousel — 3–7 slides at 1080×1350; cover slide ink (#0f172a) with white display type and the gradient tile, body slides canvas with ink headings and text body, closing slide repeats the tagline and site
- reel: template reel-kinetic — 1080×1920, 15–30 s, silent, 30 fps; style `kinetic`: each scene's line types on in Manrope 800 over the cream canvas with the mark on its gradient tile, a violet caret, a mono scene counter and the footer; style `capture` (template reel-capture): the product's own public pages from the capture list below inside a phone frame on canvas, one caption bar per scene in ink, footer "jobrez.com". English only (OF-2)
- capture: verified 2026-10-11 — public pages of jobrez.com recorded at a 1080×1920 phone viewport (curl.exe returned 200 text/html for each; the paths are the SPA's known routes)
  - `/` — vitae-os/src/data/routes.ts:15
  - `/features` — vitae-os/src/data/routes.ts:17
  - `/features/jobs` — vitae-os/src/data/routes.ts:29
  - `/pricing` — vitae-os/src/data/routes.ts:16
