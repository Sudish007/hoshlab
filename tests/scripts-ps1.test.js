// Every scripts/*.ps1 must run on Windows PowerShell 5.1 (design §1 "Shell", P1-20, M16): UTF-8 without BOM,
// no `&&`, no `--body` (secrets travel on stdin), no ternary `$x ? a : b`, file writes through
// [IO.File]::WriteAllText(..., UTF8Encoding $false). Also checks what init-media-branch.ps1 must do (M16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.js";

const SCRIPTS = join(ROOT, "scripts");
const ps1 = () => readdirSync(SCRIPTS).filter((f) => f.endsWith(".ps1")).sort();
const TERNARY = /\$\w+\s*\?\s*[^:\n]+:\s*[^\n]+/; // `$x ? a : b` (PowerShell 7 only)

test("scripts/*.ps1 exist and each is UTF-8 without BOM, ASCII-clean where it must be, free of && / --body / ternary, and writes files with [IO.File]::WriteAllText", () => {
  const files = ps1();
  assert.ok(files.includes("init-media-branch.ps1"), files.join());
  for (const f of files) {
    const buf = readFileSync(join(SCRIPTS, f));
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${f}: UTF-8 BOM`);
    const text = buf.toString("utf8");
    assert.ok(!text.includes("&&"), `${f}: contains '&&' (PowerShell 5.1 has no && operator)`);
    assert.ok(!text.includes("--body"), `${f}: contains '--body' (secret values must travel on stdin)`);
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const code = line.replace(/#.*$/, "");
      assert.ok(!TERNARY.test(code), `${f}:${i + 1}: ternary operator is PowerShell 7 only: ${line.trim()}`);
    }
    const writes = text.match(/Set-Content|Out-File|Add-Content/g) || [];
    assert.deepEqual(writes, [], `${f}: writes files with ${writes.join(", ")} instead of [IO.File]::WriteAllText`);
    if (/WriteAllText/.test(text)) assert.match(text, /\[IO\.File\]::WriteAllText\([^)]*New-Object Text\.UTF8Encoding \$false\)/, `${f}: WriteAllText must use UTF8Encoding $false (no BOM)`);
    assert.match(text, /\$ErrorActionPreference\s*=\s*'Stop'/, `${f}: sets $ErrorActionPreference = 'Stop'`);
  }
});

test("init-media-branch.ps1 (M16): checks `git ls-remote --heads origin media`, creates the orphan branch only when it is absent (worktree add --detach, checkout --orphan, rm -rf -q ., README.md, commit 'media: init', push -u), otherwise only adds the worktree; ASCII only", () => {
  const text = readFileSync(join(SCRIPTS, "init-media-branch.ps1"), "utf8");
  for (const ch of text) assert.ok(ch.charCodeAt(0) < 128, `non-ASCII character U+${ch.charCodeAt(0).toString(16)} in init-media-branch.ps1`);
  const order = ["'ls-remote', '--heads', 'origin', 'media'", "'worktree', 'add', '--detach'", "'checkout', '--orphan', 'media'", "'rm', '-rf', '-q', '.'", "WriteAllText($readme, \"# media`n\"", "'add', 'README.md'", "'commit', '-q', '-m', 'media: init'", "'push', '-u', 'origin', 'media'"];
  let pos = 0;
  for (const needle of order) {
    const at = text.indexOf(needle, pos);
    assert.ok(at > pos, `expected ${needle} after position ${pos}`);
    pos = at;
  }
  assert.match(text, /'worktree', 'add', \$mediaDir, 'media'/, "existing branch → plain worktree add");
  assert.match(text, /'worktree', 'add', '--track', '-b', 'media', \$mediaDir, 'origin\/media'/, "existing remote branch without a local one → tracking worktree");
  assert.ok(!/'branch', '-D'|'--force'|'push', '-f'/.test(text), "no git call deletes a branch or force-pushes (the only mention is in an error message for the owner)");
  assert.match(text, /already present/, "idempotent: an existing worktree is left alone");
});
