---
handle: kaatdo
name: KaatDo
nameDevanagari: काट दो
site: https://kaatdo.com
contact: info@kaatdo.com
languages: [en]
emoji: none
allowedDevanagari: ["काट दो"]
sourceRepo: kaatdo
sourceRevision: working tree 2026-10-10
sourceVerifiedAt: 2026-10-10
---

Source pointers are `<repo-folder>/<path>:<lines>` relative to the owner's workspace folder (`c:\Users\sudiskmr\Downloads\DomainClassification\`), several joined by ` ; `. `status` is `confirmed` for verbatim product copy, `source-only` for facts present in docs or code but not yet owner-confirmed as marketing-safe, `disputed` where the owner flagged the wording. Nothing about user counts, testimonials, ratings or anyone's P&L exists in any source and none may be written.

## Voice

- Terse, console-like: short declaratives, second person, present tense ("Your rule fires. Every order is cancelled.").
- Risk-first: lead with what can go wrong and what the switch does about it; never with upside.
- Never promises outcomes: the product cuts losses faster, it does not make money.
- The Hindi "काट दो." is the brand's own sign-off and the only Devanagari allowed on this page; everything else is English.
- Honest limitations are part of the voice: say "squared off within seconds, not prevented" when the topic comes up.
- No emoji, no exclamation marks, no hype adjectives; numbers only from the fact and pricing tables.
- Words to prefer: rule, cut, lock, square off, audit log, broker. Words to avoid: guaranteed, profit, risk-free, never lose, SEBI registered.

## Facts

| id | fact | source | status |
|---|---|---|---|
| kd-f01 | Name "KaatDo ╱ काट दो" ("cut it"); site kaatdo.com; support address info@kaatdo.com; "we reply within one trading day" | kaatdo/web/index.html:31,34,776 | confirmed |
| kd-f02 | Tagline "The kill switch for Indian F&O traders" | kaatdo/web/index.html:20,27,31 | confirmed |
| kd-f03 | Server-side kill switch on six brokers: Fyers, Upstox, Zerodha, Angel One, Dhan and Groww, built on their official trade APIs (the older README intro names only Fyers and Upstox) | kaatdo/web/index.html:21,34,445,777 ; kaatdo/README.md:3 | confirmed |
| kd-f04 | Six rules: max_daily_loss, profit_target, max_trades, kill_time, kill_days, kill_dates | kaatdo/README.md:17-22 | confirmed |
| kd-f05 | On breach: cancels every pending order, squares off every position at market, keeps the account locked until close, and re-fires if trading activity reappears | kaatdo/README.md:3-7 ; kaatdo/web/index.html:34 | confirmed |
| kd-f06 | Extras: override PIN, rules locked during market hours, full audit log of every evaluation and broker call, Telegram alerts, webhook and email notifications | kaatdo/README.md:24-28 ; kaatdo/README.md:438-441 ; kaatdo/web/index.html:21 | confirmed |
| kd-f07 | Broker tokens expire every day (SEBI norms), so the trader reconnects each trading morning; 08:45 IST stale-token nudge and 09:20 IST "connected but NOT armed" alert | kaatdo/README.md:80 ; kaatdo/README.md:440-441 | source-only |
| kd-f08 | Honest limitation: no broker-level "block trading" API exists except at Dhan; the LOCKED state is enforced by a re-fire loop, so trades are squared off within seconds, not prevented outright | kaatdo/README.md:458-460 | confirmed |
| kd-f09 | Honest limitation: market orders on illiquid strikes can slip; if the server is down, monitoring is down (the Fyers Smart Exit backstop partially covers P&L rules) | kaatdo/README.md:461-464 | confirmed |
| kd-f10 | KaatDo is a risk-management technology tool, not investment advice, and is not registered with SEBI; broker API execution is never guaranteed | kaatdo/README.md:9-11 ; kaatdo/web/index.html:775 | confirmed |
| kd-f11 | MCX commodity scope is beta on Fyers and Upstox; Zerodha, Angel One, Dhan and Groww are equity-only; Groww has no live unrealised P&L | kaatdo/README.md:417-420 | source-only |
| kd-f12 | Hindi (Devanagari) UI available for the landing page, status page and dashboard; light theme site-wide with two dark "terminal" panels on the landing page | kaatdo/README.md:220-234 | source-only |
| kd-f13 | The hero headline ends with the sign-off "काट दो." | kaatdo/web/index.html:446 | confirmed |

## Pricing

Prices may be quoted only from this table and only with "at the time of posting". Status of every row: source-only.

| sku | price | source |
|---|---|---|
| trial | 7-day free trial for every signup, no card | kaatdo/README.md:151-152 |
| monthly | ₹999 | kaatdo/README.md:153 |
| quarterly | ₹2,599 | kaatdo/README.md:153-154 |
| yearly | ₹8,999 | kaatdo/README.md:154 |
| payments | one-time payments that stack on renewal, no auto-debit; Razorpay | kaatdo/README.md:153-155 ; kaatdo/README.md:453-454 |

## Disclaimers

Each entry: a trigger (`always`, or words joined by ` | ` any of which fires it when present in the caption) and one or more `require` lines; every `require` line is a group of alternatives joined by ` | `, and one alternative per group must appear verbatim. Every KaatDo caption carries all three groups.

- trigger: always
  require: not investment advice
  require: not registered with SEBI | not SEBI-registered
  require: execution is never guaranteed | always watch your positions with your broker

## Forbidden

One regular expression per line (flags `iu`); a match anywhere in the caption, hashtags, alt text or artwork copy fails QA. The required disclaimer fragments ("never guaranteed", "not SEBI-registered") are excluded by look-behind.

- `(?<!never\s)\bguaranteed\b`
- `never lose`
- `risk[- ]?free`
- `make (?:a |easy |daily )?profits?|profits? (?:are |is )?(?:guaranteed|assured)|assured (?:profits?|returns?)|daily (?:profits?|income)`
- `(?<!not\s)\bSEBI[- ]registered\b`
- `(?<!not\s)\bregistered with SEBI\b`
- `(?:₹|\$|Rs\.?)\s?\d[\d,.]*\s*(?:lakh|crore|k)?\s*(?:profit|loss|gain|returns?|P&L)`
- `\d+(?:\.\d+)?\s?%\s*(?:profit|loss|gain|returns?|P&L|a (?:day|week|month))`
- `\b\d[\d,.]*\s*(?:\+|lakh|crore|k)?\s*(?:traders|users|customers|accounts|members)\b`
- `["“][^"”]{3,}["”]\s*[—–-]\s*\p{Lu}`

## Tokens

- colour ink: #070b14 — kaatdo/web/index.html:40
- colour ink2: #0b1120 — kaatdo/web/index.html:40
- colour panel: #0e1526 — kaatdo/web/index.html:40
- colour edge: #1c2740 — kaatdo/web/index.html:40
- colour edge2: #2a3a5f — kaatdo/web/index.html:40
- colour txt: #dfe7f6 — kaatdo/web/index.html:41
- colour dim: #8b98b8 — kaatdo/web/index.html:41
- colour faint: #5a6890 — kaatdo/web/index.html:41
- colour green: #3dff8c — kaatdo/web/index.html:42 ; kaatdo/web/brand/logo.svg:2
- colour red: #ff3b4e — kaatdo/web/index.html:42 ; kaatdo/web/brand/logo.svg:4
- colour amber: #ffb02e — kaatdo/web/index.html:42
- colour light-bg: #f5f7fb — kaatdo/web/index.html:151
- colour light-panel: #ffffff — kaatdo/web/index.html:151
- colour light-txt: #0f172a — kaatdo/web/index.html:152
- colour light-dim: #475569 — kaatdo/web/index.html:152
- colour light-green: #0b8f4d — kaatdo/web/index.html:153
- colour light-red: #d5192f — kaatdo/web/index.html:153
- colour light-amber: #9a6100 — kaatdo/web/index.html:153
- colour light-blue: #1f5fd0 — kaatdo/web/index.html:153
- font display: Space Grotesk 400/500/700 — kaatdo/web/index.html:37,44
- font mono: Cascadia Code — kaatdo/web/index.html:43
- Devanagari: Noto Sans Devanagari — kaatdo/README.md:225
- logo: kaatdo/web/brand/logo.svg — kaatdo/web/brand/logo.svg:2-4 ; kaatdo/web/brand/logo-lockup-light.svg:1
- note: post templates use the dark console palette flat (no glow, no shadows); the light palette is the alternative for carousel body slides — kaatdo/web/index.html:39-45 ; kaatdo/web/index.html:149-153
- note: site chrome uses light green #0b8f4d as the page colour (contrast on white) — kaatdo/web/index.html:153

## Allowed domains

- kaatdo.com

## Formats

- image: template image — 1080×1350; dark console panel (#070b14) with an edge border, Space Grotesk headline in txt (#dfe7f6), one green or red accent line, 2–3 mono fact lines, footer "kaatdo.com" with the mark and the sign-off "काट दो." in Noto Sans Devanagari
- carousel: template carousel — 3–7 slides at 1080×1350; cover slide dark console, body slides light palette (#f5f7fb) with light-txt headings and mono body, closing slide dark with the disclaimer line and the sign-off
- reel: not built yet (phase 2; features.reels is false)
