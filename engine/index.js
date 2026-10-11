// Hoshlab engine CLI (design.md §2): node engine/index.js <command> [--key value] [--flag]
// Secrets reach the process only through the environment: locally `node --env-file=.env engine/index.js …`,
// in GitHub Actions through the workflow `env:` block. Nothing here reads .env itself.
// Commands that a later FEAT owns print '<command>: not built yet (planned in …)' and exit 2.
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrub } from "./lib/log.js";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

export const EXIT = { ok: 0, failed: 1, usage: 2 };

// Registry: `load` imports the command module (export run(ctx) → exit code); null = not built yet.
export const COMMANDS = {
  "check-models": { summary: "verify provider secrets, model ids and prices (no key material printed)", planned: "FEAT-103", load: () => import("./commands/check-models.js") },
  daily: { summary: "run the daily agents (CEO, HR on the 1st, Strategist, Writer, Designer, QA, Analyst on Sundays; --agents csv, --page, --dry-run, --commit, --now <iso> with --dry-run only)", planned: "FEAT-108", load: () => import("./commands/daily.js") },
  publish: { summary: "hourly publisher: post queued, approved drafts (--page, --dry-run, --now <iso> with dry-run only)", planned: "FEAT-107", load: () => import("./commands/publish.js") },
  "render-sample": { summary: "render one fixture draft for a page into the media worktree (--page, --out, --format)", planned: "FEAT-106", load: () => import("./commands/render-sample.js") },
  "set-page": { summary: "switch a page between approve_first and autopilot (owner tool; --page, --mode)", planned: "FEAT-108", load: () => import("./commands/set-page.js") },
  analyst: { summary: "the Analyst on demand: Instagram insights at 48 h / 7 d into metrics/<month>.jsonl + this week's report (= daily --agents analyst; --dry-run, --commit, --now <iso> with --dry-run only)", planned: "FEAT-203", load: () => import("./commands/analyst.js") },
  hr: { summary: "the monthly roster review on demand: per-agent stats of the previous month → hr/<month>-review.md + hr/proposals/<month>.json (= daily --agents hr, forced; --dry-run, --commit, --now <iso> with --dry-run only)", planned: "FEAT-204", load: () => import("./commands/hr.js") },
  "refresh-tokens": { summary: "weekly: refresh Instagram long-lived tokens < 20 days from expiry, store them with gh secret set, record tokens.json (--dry-run, --commit, --page)", planned: "FEAT-202", load: () => import("./commands/refresh-tokens.js") },
  retention: { summary: "weekly: delete reel MP4s published > 90 days ago from the media branch, keep posters (--dry-run, --commit, --days)", planned: "FEAT-202", load: () => import("./commands/retention.js") },
};

// Flags that never take a value (so `--commit extra` keeps 'extra' positional); later FEATs extend this.
export const BOOLEAN_FLAGS = new Set(["dry-run", "commit", "help", "write", "quiet", "mock-llm"]);

// parseArgs(['check-models', '--page', 'kaatdo', '--dry-run', '--agents=ceo,writer'])
//   → { command: 'check-models', flags: { page: 'kaatdo', 'dry-run': true, agents: 'ceo,writer' }, rest: [] }
// `--key value` binds the next token unless the key is a known boolean flag or the token starts with '--'.
export function parseArgs(argv) {
  const out = { command: null, flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
      continue;
    }
    if (out.command === null) out.command = a;
    else out.rest.push(a);
  }
  return out;
}

export function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}${c.load ? "" : ` — not built yet (planned in ${c.planned})`}`);
  return ["usage: node engine/index.js <command> [--key value] [--flag]", "", "commands:", ...lines, "", "env: node --env-file=.env engine/index.js <command>   (MOCK_LLM=1 answers every model call from tests/fixtures/llm)"].join("\n");
}

// main(argv, { stdout, stderr, processEnv, fetchImpl, companyDir }) → exit code (never calls process.exit).
export async function main(argv = process.argv.slice(2), { stdout = (s) => process.stdout.write(s + "\n"), stderr = (s) => process.stderr.write(s + "\n"), processEnv = process.env, fetchImpl = globalThis.fetch, companyDir } = {}) {
  const { command, flags, rest } = parseArgs(argv);
  if (!command || command === "help" || flags.help === true) {
    (command ? stdout : stderr)(usage());
    return command ? EXIT.ok : EXIT.usage;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    stderr(`${command}: unknown command\n\n${usage()}`);
    return EXIT.usage;
  }
  if (!entry.load) {
    stderr(`${command}: not built yet (planned in ${entry.planned})`);
    return EXIT.usage;
  }
  const mod = await entry.load();
  const ctx = {
    command,
    flags,
    rest,
    root: ROOT,
    companyDir: resolve(ROOT, companyDir || processEnv.COMPANY_DIR || "company"),
    processEnv,
    fetchImpl,
    stdout,
    stderr,
  };
  const code = await mod.run(ctx);
  return Number.isInteger(code) ? code : EXIT.failed;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(scrub(`engine: ${err && err.message ? err.message : String(err)}`) + "\n");
      process.exit(EXIT.failed);
    },
  );
}
