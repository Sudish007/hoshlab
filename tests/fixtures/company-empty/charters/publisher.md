# Publisher (deterministic)

## Identity

The Publisher is a deterministic agent: a program, not a language model. Once an hour it looks at the queue of drafts that QA passed and decides, for each one, whether this is the hour to post it to Instagram. It is the only code path in Hoshlab that calls the Instagram publishing API, and it has no opinion about content — it only checks permissions, timing and state.

It runs hourly (the Actions schedule fires at :47 IST, off the top of the hour because GitHub delays and under load drops scheduled runs; a due slot posts at the next run that fires) and on demand from the admin's "Run now".

## Method

Inputs per draft: the draft (`status`, `revision`, `slotAt`, `media[]`, `publishAttempts[]`), the page's mode (`approve_first` or `autopilot`), the latest approval record for the draft (decision, revision), the page's token state and Instagram user id, the current time in IST, and the defaults (`maxPublishAttempts`, `lateAfterHours`, `expireAfterHours`, `minGapHours`).

`decide()` returns `{ publish, reason }`; the checks run in this order and the first one that fails names the reason:

1. Draft must be `queued` (QA passed its current `revision`); anything else → `status:<status>`.
2. Timing: more than `expireAfterHours` after `slotAt` → `expired` (the draft is stamped `expired` and its slot is freed); `slotAt` in the future → `not_due`. If now is more than `lateAfterHours` after `slotAt`, publish anyway and mark the record `late: true`.
3. Attempts: `maxPublishAttempts` failed attempts → `attempts_exhausted` (the draft is already `failed`).
4. Page must be configured: a token state other than `invalid` (→ `token_invalid`), a token secret and a non-empty Instagram user id (→ `page_not_configured`); such a page is skipped as a whole.
5. Approval: a latest `reject` → `rejected` in every mode. Mode `approve_first` needs a latest `approve` (→ `awaiting_approval`) whose `revision` equals the draft's (→ `approval_stale`). Mode `autopilot` needs no approval.
6. Gap: never two posts on the same page within `minGapHours`; the later one waits (`min_gap`).
7. Otherwise publish, reason `approved` or `autopilot`.

Publishing a draft: read the page's publishing quota (`content_publishing_limit`; skip the page within two posts of the cap), check the media URL answers (`HEAD` on the raw URL, then the Pages URL), create the media container (image, or carousel items then the carousel container), publish and read the permalink (reels, phase 2, also poll the container status until `FINISHED`). Every attempt is appended to `publishAttempts[]` with stage, code and message; a success appends a record to `published.jsonl`, sets the draft `published`, and updates the page's `lastPublishedAt`. A code-190 response flips the page's token state to `invalid` and skips the page; a bad-parameter error (code 100) or the third failed attempt sets the draft `failed` with a `publish_failed` flag. Under `IG_DRY_RUN=1` the exact call sequence is logged and nothing is sent.

Boundaries: never post without a QA pass; never post in Approve first without an approve record for the exact revision; never retry a draft more than once per run; never post a rejected or expired draft; never create or refresh tokens.

## Output

The Publisher produces records, not prose:

- `published.jsonl` record on success: `{ "draftId": "…", "page": "…", "igMediaId": "…", "permalink": "https://www.instagram.com/p/…", "publishedAt": "…+05:30", "slotAt": "…+05:30", "late": false, "mode": "approve_first", "approvedBy": "owner", "approvedAt": "…", "qaRevision": 1, "format": "image", "mediaUrlUsed": "raw", "runId": "…" }`.
- `publishAttempts[]` entry per attempt: `{ "at": "…", "ok": false, "stage": "container", "code": 190, "message": "…", "mediaUrlUsed": "raw", "runId": "…" }`.
- Run log line per draft: `[publisher] <draftId> publish|skip|terminal <reason>`.

Nothing here is estimated; every field comes from the API response or the engine clock.
