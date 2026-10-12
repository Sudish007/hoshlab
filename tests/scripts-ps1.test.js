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
  assert.ok(files.includes("setup-secrets.ps1"), files.join());
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

test("setup-secrets.ps1 (P1-20, M15, design §16): hidden prompts, Enter keeps, gh secret set on stdin, names + lengths only, /me user_id → igUserId through set-page-ids.mjs, check-models for provider keys, no commit; ASCII only", () => {
  const text = readFileSync(join(SCRIPTS, "setup-secrets.ps1"), "utf8");
  for (const ch of text) assert.ok(ch.charCodeAt(0) < 128, `non-ASCII character U+${ch.charCodeAt(0).toString(16)} in setup-secrets.ps1`);
  assert.match(text, /\[string\]\$Repo = 'Sudish007\/hoshlab'/, "-Repo defaults to Sudish007/hoshlab");
  assert.match(text, /\[switch\]\$SkipValidate/, "-SkipValidate");
  for (const name of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "IG_TOKEN_RISHTAPATRA", "IG_TOKEN_KAATDO", "IG_TOKEN_JOB_REZ"]) assert.ok(text.includes(name), `names ${name}`);
  assert.match(text, /providers\.PSObject\.Properties/, "secret names come from config providers.*.secret");
  assert.match(text, /\$page\.tokenSecret/, "… and pages[].tokenSecret");
  assert.match(text, /Read-Host -Prompt \$prompt -AsSecureString/, "hidden prompt");
  assert.match(text, /\(Enter keeps the existing secret\)/, "Enter keeps the existing secret");
  assert.match(text, /SecureStringToBSTR|PtrToStringBSTR/, "SecureString → plain text in a variable (PS 5.1 has no -AsPlainText)");
  assert.match(text, /\$psi\.Arguments = 'secret set ' \+ \$Name \+ ' --repo ' \+ \$Repository/, "gh secret set <NAME> --repo <Repo>");
  assert.match(text, /RedirectStandardInput = \$true/, "the value travels on stdin");
  assert.match(text, /\$proc\.StandardInput\.Write\(\$Value\)/, "… written to the process's stdin");
  assert.match(text, /'set \(' \+ \$plain\.Length \+ ' chars\)'/, "prints 'NAME: set (<length> chars)'");
  assert.match(text, /\$entry\.Status = 'kept'/, "prints 'NAME: kept'");
  assert.match(text, /'\/me\?fields=id,user_id,username'/, "GET /me?fields=id,user_id,username");
  assert.match(text, /graph\.instagram\.com\/' \+ \$Version/, "the pinned ig.version from config.json");
  assert.match(text, /\$igVersion = \[string\]\$config\.ig\.version/, "version read from config.json, not hard-coded");
  assert.match(text, /Invoke-RestMethod -Method Get -Uri \$uri/, "the probe");
  assert.match(text, /'--ig-user-id', \$me\.UserId/, "user_id → igUserId (M15/D5)");
  assert.match(text, /'--app-scoped-id', \$me\.Id/, "id → appScopedId");
  assert.match(text, /'--reset-token-state'/, "a stored tokenState 'invalid' is reset after a successful probe (FEAT-107)");
  assert.match(text, /scripts\\lib\\set-page-ids\.mjs/, "config.json is written by the Node helper (JSON round-trip, UTF-8 no BOM)");
  assert.match(text, /'check-models'/, "provider keys validated with check-models");
  assert.match(text, /SetEnvironmentVariable\(\$entry\.Name, \$entry\.Value, 'Process'\)/, "keys reach check-models through the process environment only…");
  assert.match(text, /SetEnvironmentVariable\(\$entry\.Name, \$null, 'Process'\)/, "… and are removed afterwards");
  assert.match(text, /config: instagram ids/, "tells the owner what to commit");
  // FEAT-202 (P2-09): HOSHLAB_SECRETS_PAT joins the prompt list with the same hidden input + stdin path, validated read-only
  assert.match(text, /\$entries \+= \[pscustomobject\]@\{ Name = 'HOSHLAB_SECRETS_PAT'; Kind = 'pat';/, "the PAT is one more entry of the same loop (same Read-Host -AsSecureString, same Set-RepoSecret on stdin)");
  assert.match(text, /Fine-grained tokens -> Generate new token ->\s*\n#\s*Only select repositories -> Sudish007\/hoshlab -> Repository permissions -> Secrets: Read and write/, "the click path is in the script's comment");
  assert.match(text, /function Test-SecretsPat/, "the PAT is validated…");
  assert.match(text, /'repos\/' \+ \$Repository \+ '\/actions\/secrets\/public-key'/, "… with gh api repos/<Repo>/actions/secrets/public-key (needs Secrets: Read)");
  assert.match(text, /SetEnvironmentVariable\('GH_TOKEN', \$Pat, 'Process'\)/, "the PAT reaches gh as GH_TOKEN through the process environment only…");
  assert.match(text, /SetEnvironmentVariable\('GH_TOKEN', \$previousToken, 'Process'\)/, "… and the previous value is restored afterwards");
  assert.match(text, /\$patCheck = Test-SecretsPat -Pat \$entry\.Value -Repository \$Repo/);
  assert.match(text, /write is proven by the first weekly token-refresh run/, "honest about what the read-only probe proves");
  assert.ok(!/'--body'|--body/.test(text), "the PAT travels on stdin like every other secret");
  // R1-01: the summary names company/state/status.json whenever $statusChanged, independently of $configChanged
  // (a token replacement for the same account leaves config.json unchanged), and says to pull first.
  const summary = text.slice(text.indexOf("setup-secrets: summary for"));
  assert.match(summary, /^\$changedFiles = @\(\)$/m, "the changed-file list starts empty");
  assert.match(summary, /^if \(\$configChanged\) \{ \$changedFiles \+= 'company\/config\.json' \}$/m, "config.json is added on its own condition");
  assert.match(summary, /^if \(\$statusChanged\) \{ \$changedFiles \+= 'company\/state\/status\.json' \}$/m, "status.json is added on its own condition — not nested under $configChanged");
  assert.match(summary, /^if \(\$changedFiles\.Count -gt 0\) \{$/m, "the commit instructions print whenever either file changed");
  assert.ok(!/if \(\$configChanged\) \{[^}]*\$statusChanged/s.test(summary), "$statusChanged is not evaluated inside the $configChanged branch");
  assert.match(summary, /Write-Host '  git pull --ff-only'/, "pull before committing (the bot rewrites status.json hourly)");
  assert.match(summary, /re-probes a paused page every hour/, "says the publisher clears the pause by itself, so the status.json commit is optional");
  // R2-02: with the local status.json modified, `git pull --ff-only` refuses ('Your local changes … would be overwritten')
  // and changes nothing — the summary names that case and the recovery command instead of claiming the pull 'brings' a file
  assert.match(summary, /If git pull --ff-only refuses because company\/state\/status\.json changed upstream, run git checkout -- company\/state\/status\.json and pull again; the publisher clears the pause itself on its next hourly run\./, "R2-02: the refusal case with the recovery command, inside the $statusChanged branch");
  assert.match(summary, /if \(\$statusChanged\) \{\s*\n\s*Write-Host '[^\n]*refuses because company\/state\/status\.json changed upstream/, "R2-02: printed only when status.json changed");
  assert.ok(!/brings a newer status\.json/.test(text), "R2-02: the misworded 'if the pull brings a newer status.json' sentence is gone");
  assert.match(summary, /company\/config\.json and company\/state\/status\.json unchanged; nothing to commit/, "the unchanged line names both files");
  assert.ok(!/git (add|commit|push)[^"']*$/m.test(text.replace(/Write-Host.*$/gm, "")), "the script itself never commits");
  assert.ok(!/ConvertFrom-SecureString -AsPlainText/.test(text), "PowerShell 7 only");
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!/Write-Host|Write-Output|Write-Verbose/.test(line)) continue;
    assert.ok(!/\$plain|\$Token|\$Value\b|\.Value\b|\$uri|\$secure/.test(line), `${i + 1}: a print statement names a secret-bearing variable: ${line.trim()}`);
  }
  assert.ok(!/\$plain\b.*\+.*Write-Host|Write-Host.*\$plain\b/.test(text), "the plain value is never printed");
});
