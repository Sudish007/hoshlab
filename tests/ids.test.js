import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { draftId, draftPath, editPath, hrProposalPath, hrReviewPath, ideaId, memoPath, nextIdeaNumber, qaPath, reportPath, runId, slugify } from "../engine/lib/ids.js";

test("slugify: lower-case [a-z0-9-], collapsed dashes, ≤ 40 chars, no trailing dash", () => {
  assert.equal(slugify("Free Janam Kundali, computed on the device"), "free-janam-kundali-computed-on-the-devic");
  assert.equal(slugify("Free Janam Kundali, computed on the device").length, 40);
  assert.equal(slugify("  Hello --- World!!  "), "hello-world");
  assert.equal(slugify("Café résumé"), "cafe-resume");
  assert.equal(slugify("कुंडली"), "untitled");
  assert.equal(slugify("A".repeat(39) + "-B"), "a".repeat(39));
  assert.match(slugify("x".repeat(100)), /^[a-z0-9-]{1,40}$/);
});

test("draftId: <prefix>-<YYYY-MM-DD>-<slug> with -2/-3 de-dupe", () => {
  const taken = [];
  const a = draftId("rp", "2026-10-14", "Kundali free", taken);
  assert.equal(a, "rp-2026-10-14-kundali-free");
  taken.push(a);
  const b = draftId("rp", "2026-10-14", "Kundali free", taken);
  assert.equal(b, "rp-2026-10-14-kundali-free-2");
  taken.push(b);
  assert.equal(draftId("rp", "2026-10-14", "Kundali free", taken), "rp-2026-10-14-kundali-free-3");
  // a Date slot is rendered as its IST calendar date (23:50 UTC on the 13th is the 14th in IST)
  assert.equal(draftId("kd", new Date("2026-10-13T23:50:00Z"), "Compress a PDF", []), "kd-2026-10-14-compress-a-pdf");
  assert.equal(draftId("jr", "2026-10-14T19:30:00+05:30", "Six layout rules", []), "jr-2026-10-14-six-layout-rules");
});

test("ideaId / nextIdeaNumber: rp-i0031 sequential per page", () => {
  assert.equal(ideaId("rp", 31), "rp-i0031");
  assert.equal(ideaId("kd", 1), "kd-i0001");
  assert.equal(ideaId("jr", 12345), "jr-i12345");
  assert.throws(() => ideaId("rp", -1), TypeError);
  assert.equal(nextIdeaNumber("rp", ["rp-i0031", "rp-i0007", "kd-i0099"]), 32);
  assert.equal(nextIdeaNumber("kd", []), 1);
});

test("runId: <workflow>-<YYYYMMDD-HHmm IST>-<6 hex>", () => {
  const id = runId("engine-daily", new Date("2026-10-12T00:01:00Z"), "a1b2c3");
  assert.equal(id, "engine-daily-20261012-0531-a1b2c3");
  assert.match(runId("publisher-hourly"), /^publisher-hourly-\d{8}-\d{4}-[0-9a-f]{6}$/);
  assert.throws(() => runId("engine-daily", new Date(), "xyz"), TypeError);
});

test("memoPath / reportPath use the ISO week id of the IST date (N7)", () => {
  assert.equal(memoPath("2026-10-12T05:30:00+05:30"), "memos/2026-W42.md");
  assert.equal(memoPath(new Date("2026-10-12T05:30:00+05:30")), "memos/2026-W42.md");
  assert.equal(reportPath("2026-10-18T23:59:00+05:30"), "reports/2026-W42.md");
  assert.equal(reportPath("2026-10-19T00:00:00+05:30"), "reports/2026-W43.md");
  // Sunday 23:00 UTC is Monday 04:30 IST → the next ISO week
  assert.equal(memoPath(new Date("2026-10-18T23:00:00Z")), "memos/2026-W43.md");
});

test("hrReviewPath / hrProposalPath use the IST month; draft/qa/edit paths", () => {
  assert.equal(hrReviewPath("2026-10-01T00:10:00+05:30"), "hr/2026-10-review.md");
  assert.equal(hrProposalPath("2026-10-01T00:10:00+05:30"), "hr/proposals/2026-10.json");
  assert.equal(hrReviewPath(new Date("2026-10-31T19:00:00Z")), "hr/2026-11-review.md");
  assert.equal(draftPath("rp-2026-10-14-kundali-free"), "drafts/rp-2026-10-14-kundali-free/draft.json");
  assert.equal(qaPath("rp-2026-10-14-kundali-free"), "drafts/rp-2026-10-14-kundali-free/qa.json");
  assert.equal(editPath("rp-2026-10-14-kundali-free"), "edits/rp-2026-10-14-kundali-free.json");
});
