// engine/render/probe.js — table-driven ffprobe assertions over the JSON fixtures under tests/fixtures/probe/
// (design.md §10 "ffprobe checks", P2-02): the good reel passes, every wrong fixture is rejected with the named
// error; the moov/mdat scan is tested on a synthetic `ffprobe -v trace` log and on hand-built MP4 box headers;
// a missing ffprobe binary is ProbeUnavailableError (what the Designer turns into the `ffmpeg` deferral).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, tmpDir } from "./helpers.js";
import { PROBE_SUMMARY_SPEC, validate } from "../engine/lib/schema.js";
import { REEL_HARD_CAP_BYTES, REEL_HOUSE_CAP_BYTES, reelProbeErrors } from "../engine/lib/checks.js";
import { ProbeUnavailableError, TRACE_ATOM_RE, assertReel, faststartFromFile, faststartFromTrace, probe, summarize, topLevelBoxes } from "../engine/render/probe.js";

const DIR = join(ROOT, "tests", "fixtures", "probe");
const fixture = (name) => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));

// name → the error assertReel must name (P2-02: wrong codec, size, fps, duration, cap, faststart)
const TABLE = {
  "wrong-codec-hevc": /codec_name hevc, expected h264/,
  "square-1080x1080": /1080x1080, expected 1080x1920/,
  "fps-25": /r_frame_rate 25\/1, expected 30\/1/,
  "short-2s": /duration 2 s, expected 3–90 s/,
  "long-95s": /duration 95 s, expected 3–90 s/,
  "big-70mb": /format\.size 73400320 bytes above the 62914560 byte house cap/,
  "huge-110mb": /above the 104857600 byte git hard cap/,
  "moov-after-mdat": /moov atom at 2457500 after mdat at 40 \(no \+faststart\)/,
  "pix-fmt-yuv444p": /pix_fmt yuv444p, expected yuv420p/,
  "no-video-stream": /no video stream/,
};

test("the good fixture is a valid reel: assertReel → [] and summarize → an ok PROBE_SUMMARY_SPEC row", () => {
  const good = fixture("good");
  assert.deepEqual(assertReel(good), []);
  const s = summarize(good);
  assert.deepEqual(validate(s, PROBE_SUMMARY_SPEC), { ok: true, errors: [] });
  assert.deepEqual(s, { ok: true, codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", frameRate: "30/1", durationSec: 16, bytes: 2457600, faststart: true });
  assert.deepEqual(reelProbeErrors(s), [], "the browser-safe check agrees with the summary");
  assert.equal(REEL_HOUSE_CAP_BYTES, 60 * 1024 * 1024);
  assert.equal(REEL_HARD_CAP_BYTES, 100 * 1024 * 1024);
});

test("P2-02 table: every wrong fixture is rejected with the named error, its summary says ok:false with the errors, and every fixture file is in the table", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  assert.deepEqual(files, ["good", ...Object.keys(TABLE)].sort(), "each fixture under tests/fixtures/probe/ has a row here");
  for (const [name, re] of Object.entries(TABLE)) {
    const json = fixture(name);
    const errors = assertReel(json);
    assert.ok(errors.length >= 1, `${name}: rejected`);
    assert.ok(errors.some((e) => re.test(e)), `${name}: ${errors.join(" | ")}`);
    const s = summarize(json);
    assert.equal(s.ok, false, name);
    assert.deepEqual(s.errors, errors);
    assert.deepEqual(validate(s, PROBE_SUMMARY_SPEC), { ok: true, errors: [] }, `${name}: the summary still validates`);
  }
  assert.equal(assertReel(fixture("huge-110mb")).length, 2, "the hard cap adds a second, louder error");
  // the house cap is adjustable (the hard cap stays git's)
  assert.deepEqual(assertReel(fixture("big-70mb"), { houseCapBytes: 80 * 1024 * 1024 }), []);
  assert.deepEqual(assertReel(null), ["probe: no ffprobe output"]);
  assert.deepEqual(assertReel({ ...fixture("good"), faststart: undefined }), ["faststart unknown (no moov/mdat scan)"]);
  const twoStreams = fixture("good");
  twoStreams.streams = [twoStreams.streams[0], { ...twoStreams.streams[0], index: 1 }];
  assert.deepEqual(assertReel(twoStreams), ["streams: 2 video streams, expected 1"]);
});

test("faststartFromTrace reads libavformat's `type:'moov' parent:'root' sz: <size> <offset> <total>` lines in file order; nested atoms and other parents are ignored", () => {
  const faststart = [
    "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] type:'ftyp' parent:'root' sz: 32 8 2457600",
    "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] ISO: File Type Major Brand: isom",
    "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] type:'free' parent:'root' sz: 8 48 2457600",
    "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] type:'moov' parent:'root' sz: 3856 56 2457600",
    "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] type:'mvhd' parent:'moov' sz: 108 8 3848",
    "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] type:'trak' parent:'moov' sz: 3660 116 3848",
    "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d] type:'mdat' parent:'root' sz: 2453704 3904 2457600",
  ].join("\n");
  assert.deepEqual(faststartFromTrace(faststart), { ok: true, moovOffset: 56, mdatOffset: 3904, source: "trace" });
  const slow = ["type:'ftyp' parent:'root' sz: 32 8 2457600", "type:'free' parent:'root' sz: 8 48 2457600", "type:'mdat' parent:'root' sz: 2453704 56 2457600", "type:'moov' parent:'root' sz: 3856 2453768 2457600", "type:'mvhd' parent:'moov' sz: 108 8 3848"].join("\n");
  assert.deepEqual(faststartFromTrace(slow), { ok: false, moovOffset: 2453768, mdatOffset: 56, source: "trace" });
  assert.equal(faststartFromTrace("nothing useful\n[AVIOContext @ 0x1] Statistics: 2457600 bytes read"), null, "no atom lines → null so probe() falls back to the box walk");
  assert.deepEqual(faststartFromTrace("type:'ftyp' parent:'root' sz: 32 8 100\ntype:'moov' parent:'root' sz: 50 40 100"), { ok: false, moovOffset: 40, mdatOffset: null, source: "trace" }, "a file without mdat is not a reel");
  assert.ok(TRACE_ATOM_RE.global, "the regex scans the whole log");
});

test("topLevelBoxes / faststartFromFile walk real ISO BMFF box headers (32-bit, 64-bit largesize and size 0 = to end of file)", () => {
  const box = (type, payload, { large = false } = {}) => {
    const size = payload.length + (large ? 16 : 8);
    const head = Buffer.alloc(large ? 16 : 8);
    if (large) {
      head.writeUInt32BE(1, 0);
      head.write(type, 4, "latin1");
      head.writeBigUInt64BE(BigInt(size), 8);
    } else {
      head.writeUInt32BE(size, 0);
      head.write(type, 4, "latin1");
    }
    return Buffer.concat([head, payload]);
  };
  const fast = Buffer.concat([box("ftyp", Buffer.alloc(24)), box("moov", Buffer.alloc(100)), box("mdat", Buffer.alloc(500), { large: true })]);
  const readAt = (buf) => (offset, length) => buf.subarray(offset, offset + length);
  assert.deepEqual(topLevelBoxes(readAt(fast), fast.length), [
    { type: "ftyp", offset: 0, size: 32 },
    { type: "moov", offset: 32, size: 108 },
    { type: "mdat", offset: 140, size: 516 },
  ]);
  const dir = tmpDir("hoshlab-probe-");
  const fastFile = join(dir, "fast.mp4");
  writeFileSync(fastFile, fast);
  assert.deepEqual(faststartFromFile(fastFile), { ok: true, moovOffset: 32, mdatOffset: 140, source: "boxes" });
  // size 0 = "to the end of the file" on the last box; moov after mdat → not faststart
  const slowTail = Buffer.alloc(8 + 100);
  slowTail.writeUInt32BE(0, 0);
  slowTail.write("moov", 4, "latin1");
  const slow = Buffer.concat([box("ftyp", Buffer.alloc(24)), box("mdat", Buffer.alloc(500)), slowTail]);
  const slowFile = join(dir, "slow.mp4");
  writeFileSync(slowFile, slow);
  assert.deepEqual(faststartFromFile(slowFile), { ok: false, moovOffset: 540, mdatOffset: 32, source: "boxes" });
  assert.deepEqual(topLevelBoxes(readAt(slow), slow.length).map((b) => [b.type, b.size]), [["ftyp", 32], ["mdat", 508], ["moov", 108]]);
  // garbage: a header claiming a size smaller than itself stops the walk
  const bad = Buffer.alloc(16);
  bad.writeUInt32BE(4, 0);
  bad.write("ftyp", 4, "latin1");
  assert.deepEqual(topLevelBoxes(readAt(bad), bad.length), []);
});

test("probe(): a missing ffprobe binary is ProbeUnavailableError (code ffmpeg), never a fabricated result", () => {
  assert.throws(() => probe("nothing.mp4", { ffprobePath: join(tmpDir("hoshlab-probe-missing-"), "ffprobe-does-not-exist") }), (e) => e instanceof ProbeUnavailableError && e.code === "ffmpeg" && /not installed \(spawn ENOENT\)/.test(e.message));
});
