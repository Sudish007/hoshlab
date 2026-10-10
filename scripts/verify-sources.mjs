// Owner-run source verifier for company/brands/*.md (review M4, plan D8).
// For every Facts / Pricing / Tokens source pointer: the file must exist under --root and every
// line number must be ≤ the file's line count. Prints each referenced line beside its fact id,
// then 'N pointers, M missing files, K out-of-range lines'; exits 1 when M + K > 0.
// With --write (and no errors) stamps `sourceVerifiedAt: YYYY-MM-DD` (IST) into each brand's
// front matter, UTF-8 without BOM. CI never runs this: the sibling product folders exist only
// on the owner's machine (the build validates pointer FORMAT only).
//
// Usage: node scripts/verify-sources.mjs [--company <dir>] [--root <dir>] [--write] [--quiet]
//   --company  brands live in <dir>/brands (default: COMPANY_DIR or company/)
//   --root     folder that contains the sibling product repos (default: the parent of the repo root)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBrand, sourcePointers, stampSourceVerifiedAt } from "../engine/lib/brand.js";
import { istDate } from "../engine/lib/time.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function parseArgs(argv) {
  const opts = { company: process.env.COMPANY_DIR || "company", root: resolve(REPO_ROOT, ".."), write: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") opts.company = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else if (a === "--write") opts.write = true;
    else if (a === "--quiet") opts.quiet = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

// verifyBrandFile(markdown, { root }) → { pointers, missingFiles, outOfRange, lines: [printable], problems: [] }
export function verifyBrandFile(markdown, { root, file = "brand.md", tokens = true } = {}) {
  const parsed = parseBrand(markdown, file);
  const refs = sourcePointers(parsed, { tokens });
  const fileCache = new Map();
  const readLines = (rel) => {
    if (!fileCache.has(rel)) {
      const abs = join(root, rel);
      fileCache.set(rel, existsSync(abs) ? readFileSync(abs, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/) : null);
    }
    return fileCache.get(rel);
  };
  const out = { file, handle: parsed.frontMatter.handle, pointers: 0, missingFiles: 0, outOfRange: 0, lines: [], problems: [] };
  for (const ref of refs) {
    for (const p of ref.pointers) {
      out.pointers++;
      const lines = readLines(p.path);
      if (lines === null) {
        out.missingFiles++;
        out.problems.push(`${ref.where} ${ref.id}: missing file ${p.path}`);
        continue;
      }
      // a file ending with a newline splits into an extra empty element; the last real line is length-1
      const count = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      for (const [from, to] of p.ranges) {
        if (from < 1 || to > count) {
          out.outOfRange++;
          out.problems.push(`${ref.where} ${ref.id}: ${p.path}:${from === to ? from : `${from}-${to}`} out of range (file has ${count} lines)`);
          continue;
        }
        for (let n = from; n <= to; n++) out.lines.push(`${ref.id.padEnd(16)} ${p.path}:${n}  ${lines[n - 1].trim().slice(0, 160)}`);
      }
    }
  }
  return out;
}

export function verifyCompany({ company, root, write = false, quiet = false, log = console.log, today = istDate() } = {}) {
  const brandsDir = join(resolve(company), "brands");
  if (!existsSync(brandsDir)) throw new Error(`no brands folder at ${brandsDir}`);
  const files = readdirSync(brandsDir).filter((f) => f.endsWith(".md")).sort();
  const totals = { pointers: 0, missingFiles: 0, outOfRange: 0 };
  const results = [];
  for (const name of files) {
    const path = join(brandsDir, name);
    const text = readFileSync(path, "utf8");
    const r = verifyBrandFile(text, { root, file: name });
    results.push({ ...r, path, text });
    totals.pointers += r.pointers;
    totals.missingFiles += r.missingFiles;
    totals.outOfRange += r.outOfRange;
    log(`== ${name} (${r.handle}): ${r.pointers} pointers, ${r.missingFiles} missing files, ${r.outOfRange} out-of-range lines`);
    if (!quiet) for (const l of r.lines) log("   " + l);
    for (const p of r.problems) log("   !! " + p);
  }
  const ok = totals.missingFiles + totals.outOfRange === 0;
  log(`${totals.pointers} pointers, ${totals.missingFiles} missing files, ${totals.outOfRange} out-of-range lines`);
  if (write) {
    if (!ok) log("--write skipped: fix the problems above first");
    else {
      for (const r of results) {
        writeFileSync(r.path, stampSourceVerifiedAt(r.text, today), "utf8"); // UTF-8, no BOM
        log(`stamped sourceVerifiedAt: ${today} into ${r.file}`);
      }
    }
  }
  return { ok, totals, results };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { ok } = verifyCompany(opts);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`verify-sources: ${e.message}`);
    process.exit(2);
  }
}
