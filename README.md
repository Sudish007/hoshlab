# Hoshlab · होशलैब

Hoshlab is an **agentic company**: 8 AI agents and 1 human owner (Sudish Kumar) that run the Instagram pages of three real products — [@rishtapatra](https://www.instagram.com/rishtapatra/) (RishtaPatra, biodata · kundali · rishta), [@kaatdo](https://www.instagram.com/kaatdo/) (KaatDo, the kill switch for F&O traders) and [@job_rez](https://www.instagram.com/job_rez/) (JobRez, resume builder). The agents run inside GitHub Actions on a schedule; every idea, draft, approval, run and published post is a JSON, JSONL or Markdown file under `company/`; the public site at https://sudish007.github.io/hoshlab/ is built from those files on every push; the owner steers everything from a browser-only admin at `/admin/` (unlinked, reached by URL).

Plain Node ESM (Node >= 22.2 locally, Node 24 in Actions), no framework, no bundler, no TypeScript, no vendor SDKs. Dependencies are exact-pinned (`marked`, `playwright`, ten `@fontsource/*` packages; `fast-xml-parser` for tests). Media binaries (rendered JPEGs) live on an orphan `media` branch, never on `main`.

The roster (`company/roster.json`): CEO (weekly memo, Mondays) and Writer on Anthropic `claude-sonnet-5-5`; HR (monthly review, phase 2) and QA on Google Gemini `gemini-3.8-flash`; Strategist and Analyst (phase 2) on OpenAI `gpt-6-luna`; Designer and Publisher are deterministic code, no language model. Each agent's working rules are a Markdown charter in `company/charters/`, editable in the admin. Each page's facts, pricing, voice, disclaimers, forbidden words and design tokens are a brand charter in `company/brands/`, every fact row pointing at a file and line in the product's own repository.

**Status of this repository at the time of writing:** the code is built and tested offline (`npm test`, the Playwright audits and the end-to-end dry run pass on the owner's machine with mock models and the dry-run Instagram client), but nothing has been exercised live: GitHub Pages is **not configured yet**, the `media` branch is **not configured yet**, provider keys and Instagram tokens are **not configured yet**, the four workflows have never run (**untested** until the first push), and the real Instagram publishing path is **untested** until the throwaway post below. The site prints `—` / `No runs yet` in its status strip until the first engine run.

## Owner to-do (exact click path)

Things only the owner can do. Nothing below has been done or verified by the build; items marked *merge step* are done by the automated merge/verify workflow and you only confirm them.

1. **Meta app.** Meta for Developers (https://developers.facebook.com/) → **My Apps** → **Create app** → use case **Other** → app type **Business** → create. In the app dashboard → **Add product** → **Instagram** → set up → open **API setup with Instagram login**. (Labels as of the design date, 2026-10-10; Meta renames panels now and then.)
2. **Professional accounts.** For each of @rishtapatra, @kaatdo and @job_rez: Instagram app → profile → **Settings** → **Account type and tools** → **Switch to professional account** (Business or Creator; either works with the Instagram API with Instagram login).
3. **Testers.** In the Meta app → **App roles** → **Roles** → **Add people** → **Instagram tester** → add the three accounts. Then accept the invite in *each* Instagram account's settings (Instagram app → **Settings** → **Website permissions** → **Apps and websites** → **Tester invites** → **Accept**; the exact labels differ between app versions).
4. **Long-lived tokens.** In the app's **API setup with Instagram login** panel → **Generate token** for each account (log in as that account) → copy the token. These are **long-lived tokens that expire after 60 days**; regenerate them by hand when they expire (the refresh job is phase 2, not built yet). Each token must be at least 50 non-space characters or the engine treats it as not configured.
5. **Secrets.** In PowerShell, from the repository folder:

   ```
   powershell -ExecutionPolicy Bypass -File scripts\setup-secrets.ps1
   ```

   It prompts for `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `IG_TOKEN_RISHTAPATRA`, `IG_TOKEN_KAATDO`, `IG_TOKEN_JOB_REZ` with hidden input (Enter keeps a secret that is already set), stores each one as a GitHub Actions repository secret through `gh secret set` on standard input (the value is never on a command line, never printed, never written to disk), validates each Instagram token with `GET /me` and writes the two non-secret ids it returns (`user_id` → `pages[].igUserId`, `id` → `pages[].appScopedId`) into `company/config.json`, and runs `check-models` with the provider keys you typed. It prints only secret **names and lengths**. It does not commit: review the diff and commit it yourself —

   ```
   git diff company/config.json
   git add company/config.json; git commit -m "config: instagram ids"; git push
   ```

   Requires `gh` (authenticated with `gh auth login`, scopes `repo` and `workflow`) and `node` on PATH. `-SkipValidate` skips the network checks; `-Repo owner/name` targets a fork. A page keeps `page_not_configured` in the publisher log until both its secret and its `igUserId` exist.
6. **Pages source.** GitHub → repository **Settings** → **Pages** → **Build and deployment** → Source **GitHub Actions**. *Merge step* (done with `gh api`); verify that the page shows "GitHub Actions" and that https://sudish007.github.io/hoshlab/ answers after the first `Deploy to GitHub Pages` run.
7. **Media branch.** Run once, from the repository folder: `powershell -ExecutionPolicy Bypass -File scripts\init-media-branch.ps1` (creates the orphan `media` branch with one README commit, pushes it and checks it out as the `.media/` worktree). *Merge step*; verify with `git ls-remote --heads origin media` (one line) — until it exists every engine run records `skipped: media_branch_missing` for the Designer and QA.
8. **First engine run.** GitHub → **Actions** → **Hoshlab engine (daily)** → **Run workflow** → tick **dry_run** (and **mock_llm** if the provider keys are not stored yet) → **Run workflow**. A dry run works on a temp copy on the runner and commits nothing; read its log, then run it again without `dry_run`. The first real run writes `company/state/` and the site shows the Monday memo, the calendar and the first drafts.
9. **Admin token.** https://github.com/settings/personal-access-tokens/new → Token name `hoshlab admin` → Resource owner `Sudish007` → Expiration 90 days or less → Repository access **Only select repositories** → `Sudish007/hoshlab` → Repository permissions **Contents: Read and write** and **Actions: Read and write** (Metadata is added automatically), nothing else → Generate. Open https://sudish007.github.io/hoshlab/admin/ by URL (no public page links to it), paste the token, sign in. Sign-in makes one call, `GET /repos/Sudish007/hoshlab`, and refuses a token without push access. The token lives in `sessionStorage` (gone when the tab closes) or, only when "Remember on this device" is ticked, in `localStorage` (key `hoshlab.admin.token`); it is sent only in the `Authorization` header to `api.github.com`, never to `raw.githubusercontent.com`, never in a URL, commit, log or console. `sudish007.github.io` is one origin for all of the owner's project sites, so keep "remember" off on shared machines and revoke the token at https://github.com/settings/tokens if in doubt.
10. **Throwaway post (before any Autopilot).** With every page still in **Approve first**: in the admin queue, open **Edit caption** on one *image* draft per page and set its alt text to **exactly 100 characters** (`defaults.altTextMax`; the editor's live checks show `alt text` green at 100 and red at 101), save, then **Approve**. Wait for the next publisher run (Hourly at :30 IST) and confirm on Instagram that the post is live with that alt text — this proves the account id, the token, the media URL and the alt-text limit for carousels and images alike. Only after one such post per page may a page be switched to **Autopilot**. If the post fails, the admin's **Blocked** list and the Home page's status notes show the publisher's reason (`token_invalid:<page>`, `publish_failed:<id>`).
11. **Prices in January 2027.** Gemini's list price doubles on 2027-01-01 ($0.75 / $3.75 → $1.50 / $7.50 per MTok, per `providers.gemini.priceNote`). Run `node --env-file=.env engine/index.js check-models`, update `providers.gemini.models["gemini-3.8-flash"].inputPerMTok/outputPerMTok` and `pricesVerifiedAt` in `company/config.json`, commit. Do the same whenever a provider changes a model id.

## Secrets

Names only — the values exist exactly in two places: the repository's **Actions secrets** (Settings → Secrets and variables → Actions) and, optionally, your local `.env` (gitignored; template `.env.example`).

| Name | Used by | Where it comes from |
|---|---|---|
| `ANTHROPIC_API_KEY` | CEO, Writer (and fallbacks) | console.anthropic.com |
| `GEMINI_API_KEY` | HR, QA (and fallbacks) | aistudio.google.com |
| `OPENAI_API_KEY` | Strategist, Analyst (and fallbacks) | platform.openai.com |
| `IG_TOKEN_RISHTAPATRA` | Publisher, page @rishtapatra | Meta app → API setup with Instagram login |
| `IG_TOKEN_KAATDO` | Publisher, page @kaatdo | same |
| `IG_TOKEN_JOB_REZ` | Publisher, page @job_rez | same |

The workflows pass them to the engine as environment variables (`env:` blocks in `.github/workflows/engine-daily.yml` and `publisher-hourly.yml`); in those two workflows `GITHUB_TOKEN` has `contents: write` and `actions: read` only (the deploy job adds `pages: write` and `id-token: write` for Pages). The admin never holds a provider key or an Instagram token — it can approve, edit, move, reject and dispatch workflows, but it cannot post. Logs scrub every secret value; `check-models` prints presence and model ids, never key material. Phase 2 adds `HOSHLAB_SECRETS_PAT` for the token-refresh job (not built yet).

## Modes

Each page has a mode in `company/config.json` (`pages[].mode`), shown as **Approve first** or **Autopilot** everywhere a human reads it. Switch it in the admin (**Modes**, typed-handle confirmation for Autopilot) or locally with `node engine/index.js set-page --page kaatdo --mode autopilot` and commit.

- **Approve first** (default for all three pages): a draft posts only when the latest `approvals.jsonl` record for it is an *approve* for its *current revision*. Approve first stops unapproved posting immediately: only drafts with an approve record for their current revision post. Drafts already in the queue wait for your approval in the admin.
- **Autopilot**: every draft that passed QA posts at its slot. Autopilot applies to drafts already in the queue: they post at their slots without an approval. Nothing posts without a QA pass; a reject on a draft still blocks it. In either mode a *reject* is final for that draft, and an *approve* made for an older revision is stale and ignored.

## How a post happens

1. **Monday 05:30 IST — CEO.** Reads the brand charters, the last 30 days of owner feedback, this month's spend and the last 14 days of posts; writes `company/state/memos/YYYY-Www.md` (priorities per page, budget split, questions for the owner).
2. **Daily 05:30 IST — Strategist**, per page: keeps at least 2 weeks of open ideas in `ideas.jsonl` (every idea cites brand facts by id) and fills `calendar.json` for the next 14 days from the page's cadence (RishtaPatra Mon/Wed/Fri 19:30; KaatDo Tue/Thu 08:15 + Sat 11:00; JobRez Mon–Thu 12:30 — 10 slots a week in total), honouring `minGapHours` (6) and owner moves in `overrides.jsonl`. Reel slots are refused while `features.reels` is false.
3. **Writer**: for every slot within the next 3 days (`leadDays`) without a draft, writes `drafts/<id>/draft.json` — caption (≤ 2200 code points including hashtags), ≤ 8 hashtags, alt text ≤ 100 characters, artwork text or 2–10 carousel slides, every claim tagged with the fact id it comes from.
4. **Designer** (deterministic): renders 1080×1350 JPEGs (quality 90, ≤ 1.5 MB) with Playwright Chromium from the brand's own fonts, colours and templates, refuses overflow, missing glyphs, text under the 30-unit floor or contrast under 4.5:1 (3:1 for text of 60 units and more), and writes the files to the `media` branch under `media/<draftId>/`.
5. **QA**: twelve deterministic checks (caption length, hashtags, alt text, every number traceable to a brand fact or price, forbidden words, required disclaimers, language, links on allowed domains, emoji policy, duplicates against the last 30 captions, media spec, brand lint incl. the JobRez no-country rule) and one model review; pass → `queued`, fail → back to the Writer, at most 2 loops, then `blocked` for the owner.
6. **Owner** (Approve first): approves, edits the caption, moves the slot or rejects with a reason in the admin. Every action is one commit on `main`, which also rebuilds the site.
7. **Hourly at :30 IST — Publisher** (deterministic): for each page with a usable token, takes the first queued draft whose slot has passed, checks the live Instagram quota, preflights the media URL (`raw.githubusercontent.com`, falling back to the Pages copy), creates the container(s), publishes, fetches the permalink and appends `published.jsonl`. One post per page per run. Three failed attempts → `failed`; an Instagram token error pauses that page. A draft whose slot passed more than 48 hours ago expires unpublished.
8. **Site**: `pages.yml` rebuilds https://sudish007.github.io/hoshlab/ from the state after every state commit — Home status, Team, per-page charters, Activity (every run, every agent step), Calendar, Published posts, feed.xml.

## Honesty rules

Enforced by code, not by promises:

- **Facts only from `brand.md`.** The Writer is offered only facts with a source pointer and status `confirmed` or `source-only`; `disputed` facts are hidden from it and from QA's number allow-list. No charter contains user counts, testimonials or ratings, so none can be written.
- **Nothing posts without QA**, and in Approve first nothing posts without the owner.
- **Costs are visible.** Every model call is one line in `company/state/usage/YYYY-MM.jsonl` with provider, model, tokens and USD from the price table in `config.json`. The month budget is USD 25 with a hard stop at 100 % (warning at 80 %): when it is spent, drafting pauses and the Home page says so.
- **Real numbers, human labels.** Every number on the site, in the admin and in this README is computed from the state files at build time or copied from `config.json`; config tokens (`approve_first`, cron strings) never appear on a public page. Anything that is not built says so: **not built yet**, **not configured yet**, **untested**.
- **Mock output is labelled.** With `MOCK_LLM=1` every usage line carries `mock: true` and every draft `mock: true`; QA fails mock drafts with `mock_output`, so a mock run can never reach Instagram.
- **Nothing confidential in the repository.** `company/` holds no keys, tokens or personal data; the repository is public (see Limits).

## Cadence

One set of strings, used identically in `company/config.json` (`schedule.*`), on the site, in this README and in the comment at the top of all four workflow files (a test checks they are byte-identical):

- Engine: **Daily 05:30 IST** (`engine-daily.yml`, cron `0 0 * * *` UTC).
- Publisher: **Hourly at :30 IST** (`publisher-hourly.yml`, cron `0 * * * *` UTC — that is :30 in IST).
- **Actions cron may start 10–30 min late**; a slot is never posted early. A 19:30 IST slot posts in the first publisher run at or after 19:30 IST — normally the 20:30 IST run, i.e. between 20:30 and about 21:00 IST. A post more than 6 hours after its slot is marked `late` in `published.jsonl` and on the Published page.
- Change the cadence in `config.json` (`pages[].cadence.slots`, ≤ 7 per page per week; formats `image` or `carousel`); the Strategist re-plans from the next run and drops planned slots the cadence no longer produces.

## Limits

- **Drafts are public.** The repository is public, so unpublished drafts, QA notes, memos and rejected ideas are readable by anyone who looks at `company/state/`. The owner's approval controls what posts, not what is visible in the repository. Never write anything confidential into `company/`.
- **Schedules drift.** Actions cron may start 10–30 min late, and top-of-hour crons (both of ours fire at :00 UTC) can be late by more than 30 minutes on busy days. A slot posts in the first publisher run at or after its time.
- **Instagram caps API publishing.** Meta's content-publishing guide states a cap of **100 API posts per 24 h** per account in one place and 50 in another; the Publisher reads the live `content_publishing_limit` (`quota_usage` / `quota_total`) before every post and stops with 2 posts of headroom, so the number is never hard-coded.
- **Tokens expire.** Long-lived Instagram tokens expire after 60 days and must be regenerated by hand until the phase-2 refresh job exists. When a token dies mid-month the publisher records `token_invalid:<page>`, the page pauses, and the Home page and admin say so; run `scripts\setup-secrets.ps1` with the new token — a successful `GET /me` resets the page's token state so the next publisher run retries.
- **Scheduled workflows stop on idle repositories.** GitHub disables scheduled workflows after 60 days without repository activity. Whether the bot's own state commits keep the repository "active" in GitHub's sense is not something this README can promise (**untested**); if the Actions page ever shows the two schedules disabled, press **Enable workflow** on each and dispatch one run.
- **One owner, one browser.** The admin is a static page talking to `api.github.com` from your browser; there are no roles, no comments or DM handling, no Stories, no paid promotion. It is tested in Chromium only (the audits); Firefox and Safari are **untested**.
- **Model and price facts age.** Model ids and prices in `config.json` were read from the providers' pages on 2026-10-10 (`pricesVerifiedAt`); `check-models` lists what each provider currently offers so the owner can correct them. Whether `gemini-3.8-flash` and `gpt-6-luna` accept the roster's `temperature` and `reasoning` settings is **untested** until the first run with real keys.

## Media retention and compaction

Rendered JPEGs are committed to the orphan `media` branch (`media/<draftId>/<file>` plus `index.json`), one commit per draft, and served from `https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/<draftId>/<file>` and from the site under `/hoshlab/media/<draftId>/<file>`. The fixture renders in `tests/fixtures/media/` weigh 78–119 KB per JPEG; at 10 posts a week the branch grows by roughly 1–2 MB a week, which is harmless for a long time. Raw URLs point at the branch *tip*, so a file stays reachable as long as it exists at the same path on the branch.

Quarterly procedure (manual until the phase-2 `scripts/compact-media.mjs` exists — **not built yet**): in the `.media/` worktree, delete `media/<draftId>/` folders of posts older than 90 days that you no longer need on the site (their `published.jsonl` records keep the Instagram permalink; the site shows an honest placeholder instead of the artwork), remove their keys from `index.json`, commit `media: retention <YYYY-MM-DD>` and push. To shrink history, recreate the branch as a single commit: `git checkout --orphan media-compact`, `git add -A`, `git commit -m "media: compacted <YYYY-MM-DD>"`, `git branch -M media`, `git push --force origin media` — this is the one place a force-push is acceptable; `main` is never rewritten.

## Instagram API version

`company/config.json` pins `ig.version` **v26.0** (`ig.versionSource` https://developers.facebook.com/docs/graph-api/changelog, `ig.versionVerifiedAt` 2026-10-10 — the newest version in Meta's "Available Graph API Versions" table that day; v21.0, the design's placeholder, is available until 2027-01-21). Every Instagram call uses `https://graph.instagram.com/v26.0/…`. Honest caveat: `curl -sS -i "https://graph.instagram.com/v26.0/me?fields=id,user_id,username"` without a token answers `HTTP 400` with the same `code 190` ("Invalid OAuth 2.0 Access Token") envelope as a made-up version does (the host validates the token before the version), so the version's validity rests on the changelog table, not on that probe. When Meta deprecates v26.0, change the one value and run `check-models`/a dry run.

## Local development

```
npm ci                              # exact-pinned dependencies (package-lock.json is committed)
npm test                            # builds tests/fixtures/company-populated into dist/, then node --test (offline: MOCK_LLM=1 IG_DRY_RUN=1)
npm run build                       # the real company/ -> dist/ (public-surface greps + size budgets fail the build by design)
npm run serve                       # dist/ at http://127.0.0.1:4173/hoshlab/
npm run audit                       # Playwright audit of dist/ at 390/820/1440/1920/2560 (0 failing rows or exit 1)
npm run audit:admin                 # the admin with api.github.com + raw.githubusercontent.com mocked
npm run dryrun                      # end-to-end on a temp copy: mock LLM -> render -> QA -> dry-run publish -> files validate
npm run build:fonts                 # copies the @fontsource woff2 files into engine/render/fonts/ (gitignored) + cmap coverage table
node scripts/render-brand.mjs       # regenerates public/og-default.png, apple-touch-icon.png, favicon.ico
node scripts/verify-sources.mjs --write   # checks every brand fact's file:line pointer against the sibling repos, stamps sourceVerifiedAt
```

Engine commands read secrets only from the environment — locally through Node's `--env-file` (copy `.env.example` to `.env`; never commit it):

```
node --env-file=.env engine/index.js check-models                 # provider keys present? model ids listed by the provider? prices set?
node --env-file=.env engine/index.js daily --dry-run              # whole daily run on a temp copy; add --agents ceo,strategist or --page kaatdo
node --env-file=.env engine/index.js publish --dry-run            # publisher with the dry-run Instagram client (prints the exact call sequence)
node engine/index.js set-page --page kaatdo --mode approve_first  # owner mode switch (then commit config.json)
node engine/index.js render-sample --page kaatdo --out $env:TEMP\hoshlab-sample   # one fixture draft rendered with the real templates (PowerShell path)
```

`MOCK_LLM=1` answers every model call from `tests/fixtures/llm/` (no keys, USD 0, usage lines `mock: true`); `IG_DRY_RUN=1` selects the dry-run Instagram client; `--dry-run` additionally works on a temp copy and commits nothing; `--now <iso>` back-dates a dry run only. `RENDER_TESTS=1 npm test` also runs the Playwright render smoke tests (needs `npx playwright install chromium`; CI installs it with `--with-deps`). On Windows PowerShell set variables as `$env:RENDER_TESTS='1'; npm test` and separate commands with `;`. `BUILD_NOW` and `PUBLIC_DIR` are test-only knobs set by `scripts/test.mjs` — never set them for the real build or in CI. `AUDIT_OUT` moves the audit output (default `.agents/audit/`, gitignored; CI uses `audit-out/`), `AUDIT_URL=<origin>` audits a live site. `ffmpeg`/`ffprobe` are not needed in phase 1.

### Workflows

| File | Trigger | What it does |
|---|---|---|
| `pages.yml` — Deploy to GitHub Pages | push to `main`, dispatch, `workflow_call` | checkout `main` + the `media` branch (optional until it exists), `npm ci`, `npm test`, `npm run build`, deploy `dist/`. Concurrency group `pages`. |
| `ci.yml` — CI | push, pull request, dispatch | Chromium + fonts, `RENDER_TESTS=1 npm test`, `npm run build`, both audits, `scripts/dry-run-publish.mjs`; uploads `audit-out/` as an artifact. |
| `engine-daily.yml` — Hoshlab engine (daily) | cron `0 0 * * *`, dispatch (`agents`, `page`, `dry_run`, `mock_llm`) | `node engine/index.js daily --commit …`; commits as `hoshlab-bot`, pushes `media` then `main`; calls `pages.yml` when state changed. |
| `publisher-hourly.yml` — Hoshlab publisher (hourly) | cron `0 * * * *`, dispatch (`dry_run`) | `node engine/index.js publish --commit [--dry-run]`; deploys only when `published.jsonl` or a draft changed. |

The engine and publisher runs share the concurrency group `hoshlab-state` (never two state writers at once) and call `pages.yml` with the group `pages` on the caller side, so a deploy never overlaps a push-triggered deploy. Pushes made with `GITHUB_TOKEN` do not trigger `push` workflows, which is why the state runs deploy explicitly. Admin writes are commits on `main` (`approve: <id> (rev n)`, `reject: <id> (rev n)`, `feedback: reject <id>` / `feedback: note`, `edit: <id> (base rev n)`, `override: <id> -> <slotAt>`, `config: @<handle> -> <mode>`, `brand: <handle>`, `brand: <handle> confirm <factId>`, `charter: <agent>`, `roster: update`); each one rebuilds the site; "Run now" in the admin dispatches `engine-daily.yml` / `publisher-hourly.yml` with `dry_run: false`.

## Phase 2 — not built yet

Listed on the site and in the admin as "not built yet (phase 2)": reels (`kinetic` and `capture` styles, ffmpeg/ffprobe, the reel publish path), the Analyst (Instagram insights at 48 h and 7 d, weekly `reports/YYYY-Www.md`, the Reports page content), HR's monthly review and roster proposals with Apply/Dismiss in the admin, the token-refresh job (`token-refresh.yml`, `HOSHLAB_SECRETS_PAT`, `tokens.json`), media retention and `scripts/compact-media.mjs`, and the feedback digest in the Writer's and Strategist's prompts.
