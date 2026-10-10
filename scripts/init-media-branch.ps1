# init-media-branch.ps1 - creates the orphan `media` branch ONCE and checks it out as the .media/ worktree
# (design.md section 8.6, review M16, plan D6). The engine never creates branches: when .media/.git is
# absent the Designer records `skipped: media_branch_missing` and the run continues. Run this from the
# repository root (or anywhere; the script changes to the repo root itself) on Windows PowerShell 5.1:
#
#     powershell -ExecutionPolicy Bypass -File scripts\init-media-branch.ps1
#
# Idempotent: an existing remote branch is only checked out; an existing worktree is left alone.
# Requires: git on PATH, an `origin` remote with push rights to Sudish007/hoshlab. No secrets involved.

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot
$mediaDir = Join-Path $repoRoot '.media'

# Runs git without a shell; stderr is captured (git prints progress there), the exit code decides.
function Invoke-Git {
    param([string[]]$GitArgs, [switch]$AllowFail)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git @GitArgs 2>&1
    }
    finally {
        $ErrorActionPreference = $previous
    }
    $script:GitExit = $LASTEXITCODE
    if ($script:GitExit -ne 0) {
        if ($AllowFail) { return $output }
        throw ('git ' + ($GitArgs -join ' ') + ' failed (exit ' + $script:GitExit + '): ' + (($output | ForEach-Object { "$_" }) -join "`n"))
    }
    return $output
}

function Test-LocalMediaBranch {
    Invoke-Git @('show-ref', '--verify', '--quiet', 'refs/heads/media') -AllowFail | Out-Null
    return ($script:GitExit -eq 0)
}

Write-Host ('init-media-branch: repository ' + $repoRoot)

$remoteText = ((Invoke-Git @('ls-remote', '--heads', 'origin', 'media') | ForEach-Object { "$_" }) -join "`n").Trim()

if ($remoteText.Length -eq 0) {
    Write-Host 'init-media-branch: origin has no `media` branch yet - creating the orphan branch'
    if (Test-Path $mediaDir) {
        throw ('init-media-branch: ' + $mediaDir + ' exists but origin has no media branch. Remove or move .media/ (git worktree remove .media) and run again.')
    }
    if (Test-LocalMediaBranch) {
        throw 'init-media-branch: a local `media` branch exists without a remote counterpart. Push it (git push -u origin media) or delete it (git branch -D media) and run again.'
    }
    Invoke-Git @('worktree', 'add', '--detach', $mediaDir) | Out-Null
    Push-Location $mediaDir
    try {
        Invoke-Git @('checkout', '--orphan', 'media') | Out-Null
        Invoke-Git @('rm', '-rf', '-q', '.') | Out-Null
        $readme = Join-Path $mediaDir 'README.md'
        [IO.File]::WriteAllText($readme, "# media`n", (New-Object Text.UTF8Encoding $false))
        Invoke-Git @('add', 'README.md') | Out-Null
        Invoke-Git @('commit', '-q', '-m', 'media: init') | Out-Null
        Invoke-Git @('push', '-u', 'origin', 'media') | Out-Null
    }
    finally {
        Pop-Location
    }
    Write-Host ('init-media-branch: created orphan branch `media` (one commit: README.md) and pushed it to origin; worktree at ' + $mediaDir)
}
else {
    Write-Host ('init-media-branch: origin already has `media` (' + $remoteText.Split("`t")[0] + ')')
    if (Test-Path (Join-Path $mediaDir '.git')) {
        Write-Host ('init-media-branch: worktree already present at ' + $mediaDir + '; nothing to do')
    }
    elseif (Test-Path $mediaDir) {
        throw ('init-media-branch: ' + $mediaDir + ' exists but is not a git worktree. Remove it and run again.')
    }
    else {
        Invoke-Git @('fetch', 'origin', 'media') | Out-Null
        if (Test-LocalMediaBranch) {
            Invoke-Git @('worktree', 'add', $mediaDir, 'media') | Out-Null
        }
        else {
            Invoke-Git @('worktree', 'add', '--track', '-b', 'media', $mediaDir, 'origin/media') | Out-Null
        }
        Write-Host ('init-media-branch: checked out `media` as the worktree ' + $mediaDir)
    }
}

$verify = ((Invoke-Git @('ls-remote', '--heads', 'origin', 'media') | ForEach-Object { "$_" }) -join "`n").Trim()
if ($verify.Length -eq 0) {
    throw 'init-media-branch: origin still has no media branch after the push'
}
$present = Test-Path (Join-Path $mediaDir '.git')
Write-Host ('init-media-branch: ok - origin/media = ' + $verify.Split("`t")[0] + '; .media/.git present = ' + $present)
