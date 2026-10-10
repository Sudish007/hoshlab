# Publisher (deterministic)

## Identity

The Publisher is a deterministic agent: a program, not a language model. Once an hour it looks at the queue of drafts that QA passed and decides, for each one, whether this is the hour to post it to Instagram. It is the only code path in Hoshlab that calls the Instagram publishing API, and it has no opinion about content — it only checks permissions, timing and state.

It runs hourly (the Actions cron fires at :30 IST; it may start 10–30 minutes late) and on demand from the admin's "Run now".

## Method

Inputs per draft: the draft (`status`, `revision`, `slotAt`, `media[]`, `publishAttempts[]`), the page's mode (`approve_first` or `autopilot`), the latest approval record for the draft (decision, revision), the page's token state and Instagram user id, the current time in IST, and the defaults (`maxPublishAttempts`, `lateAfterHours`, `expireAfterHours`, `minGapHours`).

`decide()` returns one of `publish`, `skip` or `terminal` with a reason, in this order of checks:

1. Draft must be `queued` with a QA pass for its current `revision`; anything else → skip (`not_queued`).
2. Page must be configured: a non-empty Instagram user id and a token state of `ok` or `expiring`; otherwise → skip (`page_not_configured` / `token_invalid`), and the page is skipped as a whole.
3. Mode `approve_first` needs an approval with `decision: approve` whose `revision` equals the draft's `revision`; a `reject` → terminal `rejected`; no record → skip (`awaiting_approval`). Mode `autopilot` needs no approval.
4. Timing: publish only when `slotAt` ≤ now. If now is more than `expireAfterHours` after `slotAt` → terminal `expired`. If now is more than `lateAfterHours` after `slotAt`, publish anyway and mark the record `late: true`.
5. Attempts: a draft is tried at most once per run; after `maxPublishAttempts` failed attempts → terminal `failed`.
6. Gap: never two posts on the same page within `minGapHours`; the later one waits (`min_gap`).

Publishing a draft: create the media container (image, or carousel items then the carousel container) with the media's raw URL, poll the container status until `FINISHED` (interval and limit from config), then publish and read the permalink. Every attempt is appended to `publishAttempts[]` with stage, code and message; a success appends a record to `published.jsonl`, sets the draft `published`, and updates the page's `lastPublishedAt`. A code-190 response flips the page's token state to `invalid` and skips the page. Under `IG_DRY_RUN=1` the exact call sequence is logged and nothing is sent.

Boundaries: never post without a QA pass; never post in Approve first without an approve record for the exact revision; never retry a draft more than once per run; never post a rejected or expired draft; never create or refresh tokens.

## Output

The Publisher produces records, not prose:

- `published.jsonl` record on success: `{ "draftId": "…", "page": "…", "igMediaId": "…", "permalink": "https://www.instagram.com/p/…", "publishedAt": "…+05:30", "slotAt": "…+05:30", "late": false, "mode": "approve_first", "approvedBy": "owner", "approvedAt": "…", "qaRevision": 1, "format": "image", "mediaUrlUsed": "raw", "runId": "…" }`.
- `publishAttempts[]` entry per attempt: `{ "at": "…", "ok": false, "stage": "container", "code": 190, "message": "…", "mediaUrlUsed": "raw", "runId": "…" }`.
- Run log line per draft: `[publisher] <draftId> publish|skip|terminal <reason>`.

Nothing here is estimated; every field comes from the API response or the engine clock.
