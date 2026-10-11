// ffprobe validation of a rendered reel (design.md §10 "ffprobe checks", P2-02; FEAT-201).
//
//   probe(path, { ffprobePath })  → the parsed `ffprobe -v error -print_format json -show_streams -show_format`
//                                   JSON plus `faststart: { ok, moovOffset, mdatOffset, source }` from a second
//                                   `ffprobe -v trace` run whose log names every top-level atom in file order
//                                   (`type:'moov' parent:'root' sz: <size> <offset> <total>`); when the trace
//                                   carries no atom lines the MP4 box headers are walked directly (`boxes`).
//   summarize(probeJson)          → PROBE_SUMMARY_SPEC row { ok, codec, width, height, pixFmt, frameRate,
//                                   durationSec, bytes, faststart, errors? } — what the Designer records on the
//                                   draft's video media row and QA's media_spec reads back.
//   assertReel(probeJson, caps)   → errors[]: codec h264, 1080×1920, yuv420p, r_frame_rate 30/1, 3 ≤ duration ≤ 90,
//                                   format.size ≤ house cap (60 MB; the 100 MB git hard cap is a second, louder error),
//                                   moov before mdat. Pure — table-tested with the fixture JSONs under tests/fixtures/probe/.
//
// Missing ffprobe (spawn ENOENT) → ProbeUnavailableError; the Designer turns it into the per-draft `ffmpeg` deferral.
import { spawnSync } from "node:child_process";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { REEL_CODEC, REEL_FRAME_RATE, REEL_HARD_CAP_BYTES, REEL_HEIGHT, REEL_HOUSE_CAP_BYTES, REEL_MAX_SEC, REEL_MIN_SEC, REEL_PIX_FMT, REEL_WIDTH } from "../lib/checks.js";

export const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
export const TRACE_ATOM_RE = /type:'(\w{4})'\s+parent:'root'\s+sz:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)/g;

export class ProbeUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProbeUnavailableError";
    this.code = "ffmpeg";
    if (cause) this.cause = cause;
  }
}

export class ProbeError extends Error {
  constructor(message, { status, stderr } = {}) {
    super(message);
    this.name = "ProbeError";
    this.code = "ffmpeg";
    this.status = status;
    this.stderr = stderr;
  }
}

function spawn(cmd, args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false, windowsHide: true, maxBuffer });
  if (r.error) {
    if (r.error.code === "ENOENT") throw new ProbeUnavailableError(`${cmd} not installed (spawn ENOENT)`, r.error);
    throw new ProbeUnavailableError(`${cmd} could not be started: ${r.error.message}`, r.error);
  }
  return r;
}

// faststartFromTrace(stderrText) → { ok, moovOffset, mdatOffset, source: 'trace' } | null when no root atoms were logged.
// libavformat's mov demuxer logs each atom as it reads it: `type:'moov' parent:'root' sz: <atom size> <offset of the
// atom's payload within the parent> <parent size>`; for `parent:'root'` the second number is the file offset.
// Reading order follows file order, so a lower offset (or an earlier line) means the atom comes first.
export function faststartFromTrace(text) {
  const atoms = [];
  for (const m of String(text || "").matchAll(TRACE_ATOM_RE)) atoms.push({ type: m[1], size: Number(m[2]), offset: Number(m[3]) });
  if (!atoms.length) return null;
  const first = (type) => atoms.find((a) => a.type === type) || null;
  const moov = first("moov");
  const mdat = first("mdat");
  if (!moov || !mdat) return { ok: false, moovOffset: moov ? moov.offset : null, mdatOffset: mdat ? mdat.offset : null, source: "trace" };
  const ok = moov.offset !== mdat.offset ? moov.offset < mdat.offset : atoms.indexOf(moov) < atoms.indexOf(mdat);
  return { ok, moovOffset: moov.offset, mdatOffset: mdat.offset, source: "trace" };
}

// topLevelBoxes(readAt, fileSize) → [{ type, offset, size }] walking the ISO BMFF box headers (size32 + type, with
// size 1 = 64-bit largesize and size 0 = to end of file). `readAt(offset, length)` returns a Buffer.
export function topLevelBoxes(readAt, fileSize) {
  const out = [];
  let offset = 0;
  while (offset + 8 <= fileSize) {
    const head = readAt(offset, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    let headerLen = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = Number(head.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) size = fileSize - offset;
    if (size < headerLen) break;
    out.push({ type, offset, size });
    offset += size;
  }
  return out;
}

// faststartFromFile(path) → { ok, moovOffset, mdatOffset, source: 'boxes' } by reading the box headers.
export function faststartFromFile(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const readAt = (offset, length) => {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, n);
    };
    const boxes = topLevelBoxes(readAt, size);
    const moov = boxes.find((b) => b.type === "moov") || null;
    const mdat = boxes.find((b) => b.type === "mdat") || null;
    return { ok: Boolean(moov && mdat && moov.offset < mdat.offset), moovOffset: moov ? moov.offset : null, mdatOffset: mdat ? mdat.offset : null, source: "boxes" };
  } finally {
    closeSync(fd);
  }
}

// probe(path, { ffprobePath }) → ffprobe JSON (+ faststart). Throws ProbeUnavailableError (no ffprobe) or
// ProbeError (ffprobe exit ≠ 0 / unparsable JSON — the file is not a readable MP4).
export function probe(path, { ffprobePath = DEFAULT_FFPROBE } = {}) {
  const r = spawn(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]);
  if (r.status !== 0) throw new ProbeError(`ffprobe exited ${r.status}: ${String(r.stderr || "").trim().split("\n")[0]}`, { status: r.status, stderr: r.stderr });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch (e) {
    throw new ProbeError(`ffprobe output is not JSON: ${e.message}`, { status: r.status, stderr: r.stderr });
  }
  const trace = spawn(ffprobePath, ["-v", "trace", path]);
  json.faststart = faststartFromTrace(`${trace.stderr || ""}\n${trace.stdout || ""}`) || faststartFromFile(path);
  return json;
}

function videoStream(json) {
  return (Array.isArray(json && json.streams) ? json.streams : []).find((s) => s && s.codec_type === "video") || null;
}

function durationOf(json, v) {
  const d = Number((json && json.format && json.format.duration) ?? (v && v.duration));
  return Number.isFinite(d) ? d : NaN;
}

// assertReel(probeJson, { houseCapBytes, hardCapBytes }) → errors[] (empty = a valid reel; design §10, P2-02).
export function assertReel(json, { houseCapBytes = REEL_HOUSE_CAP_BYTES, hardCapBytes = REEL_HARD_CAP_BYTES } = {}) {
  const errors = [];
  if (!json || typeof json !== "object") return ["probe: no ffprobe output"];
  const v = videoStream(json);
  if (!v) return ["streams: no video stream"];
  const videos = json.streams.filter((s) => s && s.codec_type === "video").length;
  if (videos > 1) errors.push(`streams: ${videos} video streams, expected 1`);
  if (v.codec_name !== REEL_CODEC) errors.push(`codec_name ${v.codec_name}, expected ${REEL_CODEC}`);
  if (Number(v.width) !== REEL_WIDTH || Number(v.height) !== REEL_HEIGHT) errors.push(`${v.width}x${v.height}, expected ${REEL_WIDTH}x${REEL_HEIGHT}`);
  if (v.pix_fmt !== REEL_PIX_FMT) errors.push(`pix_fmt ${v.pix_fmt}, expected ${REEL_PIX_FMT}`);
  if (v.r_frame_rate !== REEL_FRAME_RATE) errors.push(`r_frame_rate ${v.r_frame_rate}, expected ${REEL_FRAME_RATE}`);
  const duration = durationOf(json, v);
  if (!(duration >= REEL_MIN_SEC && duration <= REEL_MAX_SEC)) errors.push(`duration ${Number.isNaN(duration) ? "unknown" : `${duration} s`}, expected ${REEL_MIN_SEC}–${REEL_MAX_SEC} s`);
  const size = Number(json.format && json.format.size);
  if (!Number.isFinite(size) || size <= 0) errors.push("format.size unknown");
  else {
    if (size > hardCapBytes) errors.push(`format.size ${size} bytes above the ${hardCapBytes} byte git hard cap`);
    if (size > houseCapBytes) errors.push(`format.size ${size} bytes above the ${houseCapBytes} byte house cap`);
  }
  const fs = json.faststart;
  if (!fs || typeof fs.ok !== "boolean") errors.push("faststart unknown (no moov/mdat scan)");
  else if (!fs.ok) errors.push(`moov atom at ${fs.moovOffset} after mdat at ${fs.mdatOffset} (no +faststart)`);
  return errors;
}

// summarize(probeJson, caps) → PROBE_SUMMARY_SPEC row (ok = assertReel found nothing).
export function summarize(json, caps) {
  const v = videoStream(json) || {};
  const errors = assertReel(json, caps);
  const size = Number(json && json.format && json.format.size);
  const duration = durationOf(json, v);
  const out = {
    ok: errors.length === 0,
    codec: String(v.codec_name || "unknown"),
    width: Number.isInteger(Number(v.width)) && Number(v.width) > 0 ? Number(v.width) : 1,
    height: Number.isInteger(Number(v.height)) && Number(v.height) > 0 ? Number(v.height) : 1,
    pixFmt: String(v.pix_fmt || "unknown"),
    frameRate: String(v.r_frame_rate || "unknown"),
    durationSec: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
    bytes: Number.isFinite(size) && size > 0 ? Math.round(size) : 1,
    faststart: Boolean(json && json.faststart && json.faststart.ok === true),
  };
  if (errors.length) out.errors = errors;
  return out;
}
