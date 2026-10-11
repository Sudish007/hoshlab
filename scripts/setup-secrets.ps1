# setup-secrets.ps1 - stores the seven Hoshlab secrets as GitHub Actions repository secrets and writes the
# NON-secret Instagram ids into company/config.json (design.md section 16, review M15, plan D5, P1-20; FEAT-202).
#
#     powershell -ExecutionPolicy Bypass -File scripts\setup-secrets.ps1 [-Repo Sudish007/hoshlab] [-SkipValidate]
#
# Secret names come from company/config.json (providers.*.secret, pages[].tokenSecret), plus the phase-2 PAT:
#   ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, IG_TOKEN_RISHTAPATRA, IG_TOKEN_KAATDO, IG_TOKEN_JOB_REZ,
#   HOSHLAB_SECRETS_PAT (fine-grained PAT, this repository only, Repository permissions Secrets: Read and write;
#   the weekly token-refresh.yml run uses it as GH_TOKEN for `gh secret set` - GITHUB_TOKEN cannot write secrets)
# Each value is typed at a hidden prompt (Read-Host -AsSecureString; Enter keeps the existing secret), lives
# in a variable only, reaches `gh secret set <NAME> --repo <Repo>` on standard input (never as a command-line
# argument, never echoed) and is reported only as '<NAME>: set (<length> chars)' or '<NAME>: kept'.
# Validation (skip with -SkipValidate):
#   * Instagram tokens: GET https://graph.instagram.com/<ig.version>/me?fields=id,user_id,username with the
#     token in the query string of a request that is never printed. user_id (the professional account that
#     publishes) is written to pages[].igUserId and id (app-scoped) to pages[].appScopedId through
#     scripts/lib/set-page-ids.mjs (JSON round-trip, UTF-8 without BOM, validated against CONFIG_SPEC); a stored
#     tokenState 'invalid' in the LOCAL company/state/status.json is reset to 'unknown'. The publisher in Actions
#     re-probes a paused page every hour once the new secret is stored, so the production page resumes without a
#     commit; the local reset only keeps your checkout in step.
#   * Provider keys: `node engine/index.js check-models` with the keys entered this session in that process's
#     environment only (removed afterwards). Keys that were kept cannot be checked here and are reported as such.
#   * HOSHLAB_SECRETS_PAT: `gh api repos/<Repo>/actions/secrets/public-key` with the PAT as GH_TOKEN in that
#     process's environment only (the endpoint needs Secrets: Read; the write half is proven by the first weekly run).
# Nothing is committed: the script ends by naming EVERY changed file (config.json and/or state/status.json) and
# telling you to `git pull --ff-only` first (the bot rewrites status.json hourly), then what to commit.
# Requires: Windows PowerShell 5.1 (';' between commands, no double-ampersand, no ternary), gh on PATH and
# authenticated (gh auth status), node on PATH. ASCII only.
[CmdletBinding()]
param(
    [string]$Repo = 'Sudish007/hoshlab',
    [switch]$SkipValidate
)

$ErrorActionPreference = 'Stop'

if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw ('setup-secrets: -Repo must look like owner/name (got ' + $Repo + ')')
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot
$configPath = Join-Path $repoRoot 'company\config.json'
$setPageIds = Join-Path $repoRoot 'scripts\lib\set-page-ids.mjs'
$engineCli = Join-Path $repoRoot 'engine\index.js'

$script:GhPath = (Get-Command gh -ErrorAction Stop).Source
$script:NodePath = (Get-Command node -ErrorAction Stop).Source

# Secret shapes the engine accepts (engine/lib/env.js): API keys >= 20 non-space chars, IG tokens >= 50.
$ApiKeyMin = 20
$IgTokenMin = 50

# Older Windows builds default to TLS 1.0 for .NET web requests; graph.instagram.com needs TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Runs a native command with stderr captured; the exit code decides. Never echoes its arguments.
function Invoke-Native {
    param([string]$Exe, [string[]]$NativeArgs, [switch]$AllowFail)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Exe @NativeArgs 2>&1
    }
    finally {
        $ErrorActionPreference = $previous
    }
    $script:NativeExit = $LASTEXITCODE
    if ($script:NativeExit -ne 0) {
        if ($AllowFail) { return $output }
        throw ((Split-Path -Leaf $Exe) + ' ' + ($NativeArgs -join ' ') + ' failed (exit ' + $script:NativeExit + '): ' + (($output | ForEach-Object { "$_" }) -join "`n"))
    }
    return $output
}

# SecureString -> plain text in a local variable only (the PowerShell 7 -AsPlainText switch does not exist in 5.1).
function ConvertTo-PlainText {
    param([Security.SecureString]$Secure)
    if ($null -eq $Secure) { return '' }
    if ($Secure.Length -eq 0) { return '' }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# Replaces a secret value inside free text (error messages) before anything is printed.
function Hide-Secret {
    param([string]$Text, [string]$Secret)
    if ($null -eq $Text) { return '' }
    if ($null -eq $Secret) { return $Text }
    if ($Secret.Length -eq 0) { return $Text }
    $clean = $Text.Replace($Secret, '[redacted]')
    $escaped = [Uri]::EscapeDataString($Secret)
    if ($escaped -ne $Secret) { $clean = $clean.Replace($escaped, '[redacted]') }
    return $clean
}

# gh secret set <Name> --repo <Repo> with the value on standard input. The value is never part of the command
# line, never written to a file and never echoed; gh's own output is shown only on failure, redacted.
function Set-RepoSecret {
    param([string]$Name, [string]$Value, [string]$Repository)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:GhPath
    $psi.Arguments = 'secret set ' + $Name + ' --repo ' + $Repository
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        $proc.StandardInput.Write($Value)
        $proc.StandardInput.Close()
        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        if ($proc.ExitCode -ne 0) {
            throw ('gh secret set ' + $Name + ' failed (exit ' + $proc.ExitCode + '): ' + (Hide-Secret ($stdout + ' ' + $stderr).Trim() $Value))
        }
    }
    finally {
        $proc.Dispose()
    }
}

# HTTP error -> 'HTTP <status> code <n>: <message>' from Meta's error envelope, or the exception message.
function Get-HttpErrorDetail {
    param($ErrorRecord)
    $status = ''
    $body = ''
    $response = $ErrorRecord.Exception.Response
    if ($null -ne $response) {
        try { $status = [string][int]$response.StatusCode } catch { $status = '' }
        try {
            $stream = $response.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object IO.StreamReader($stream)
                $body = $reader.ReadToEnd()
                $reader.Close()
            }
        }
        catch { $body = '' }
    }
    if ($body.Length -eq 0) {
        if ($null -ne $ErrorRecord.ErrorDetails) { $body = [string]$ErrorRecord.ErrorDetails.Message }
    }
    if ($body.Length -eq 0) { $body = [string]$ErrorRecord.Exception.Message }
    try {
        $json = $body | ConvertFrom-Json
        if ($null -ne $json.error) { $body = ('code ' + $json.error.code + ': ' + $json.error.message) }
    }
    catch { }
    if ($status.Length -gt 0) { return ('HTTP ' + $status + ' ' + $body) }
    return $body
}

# gh api repos/<Repo>/actions/secrets/public-key with the PAT as GH_TOKEN (process environment only, removed
# afterwards) -> @{ Ok; KeyId } or @{ Ok = $false; Error }. Reading the public key needs Secrets: Read on this
# repository, which is what the fine-grained PAT must carry (Read and write) for the weekly `gh secret set`.
function Test-SecretsPat {
    param([string]$Pat, [string]$Repository)
    $previousToken = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('GH_TOKEN', $Pat, 'Process')
        $output = Invoke-Native $script:GhPath @('api', ('repos/' + $Repository + '/actions/secrets/public-key'), '--jq', '.key_id') -AllowFail
    }
    finally {
        [Environment]::SetEnvironmentVariable('GH_TOKEN', $previousToken, 'Process')
    }
    $text = (($output | ForEach-Object { "$_" }) -join ' ').Trim()
    if ($script:NativeExit -ne 0) {
        return [pscustomobject]@{ Ok = $false; Error = (Hide-Secret $text $Pat) }
    }
    return [pscustomobject]@{ Ok = $true; KeyId = $text }
}

# GET /<version>/me?fields=id,user_id,username -> @{ Ok; Id; UserId; Username } or @{ Ok = $false; Error }.
# The request URL carries the token and is never printed.
function Test-InstagramToken {
    param([string]$Token, [string]$Version)
    $uri = 'https://graph.instagram.com/' + $Version + '/me?fields=id,user_id,username' + '&access_token=' + [Uri]::EscapeDataString($Token)
    try {
        $me = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 30
    }
    catch {
        return [pscustomobject]@{ Ok = $false; Error = (Hide-Secret (Get-HttpErrorDetail $_) $Token) }
    }
    $userId = [string]$me.user_id
    $appId = [string]$me.id
    $username = [string]$me.username
    if ($userId -notmatch '^\d+$') {
        return [pscustomobject]@{ Ok = $false; Error = ('/me answered without a numeric user_id (fields present: ' + (($me.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ') + ')') }
    }
    return [pscustomobject]@{ Ok = $true; Id = $appId; UserId = $userId; Username = $username }
}

# ---------------------------------------------------------------------------------------------------------
# Load the company config: secret names, page handles, pinned Instagram API version.
$configText = [IO.File]::ReadAllText($configPath, (New-Object Text.UTF8Encoding $false))
$config = $configText | ConvertFrom-Json
$igVersion = [string]$config.ig.version

$entries = @()
foreach ($prop in $config.providers.PSObject.Properties) {
    $provider = $prop.Value
    if ($provider.enabled) {
        $entries += [pscustomobject]@{ Name = [string]$provider.secret; Kind = 'provider'; Provider = $prop.Name; Page = ''; Status = ''; Length = 0; Value = '' }
    }
}
foreach ($page in $config.pages) {
    $entries += [pscustomobject]@{ Name = [string]$page.tokenSecret; Kind = 'instagram'; Provider = ''; Page = [string]$page.handle; Status = ''; Length = 0; Value = '' }
}
# Phase 2 (FEAT-202): the fine-grained PAT the weekly token-refresh job uses for `gh secret set`. Create it at
# GitHub -> Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens -> Generate new token ->
# Only select repositories -> Sudish007/hoshlab -> Repository permissions -> Secrets: Read and write. Same hidden
# prompt, same stdin handling; Enter keeps the stored one.
$entries += [pscustomobject]@{ Name = 'HOSHLAB_SECRETS_PAT'; Kind = 'pat'; Provider = ''; Page = ''; Status = ''; Length = 0; Value = '' }

Write-Host ('setup-secrets: repository ' + $Repo + ', ' + $entries.Count + ' secrets, Instagram API ' + $igVersion)
Write-Host 'setup-secrets: values are hidden while you type; press Enter to keep a secret that is already set.'

# gh must be authenticated; the existing secret NAMES (never values) tell us what Enter keeps.
Invoke-Native $script:GhPath @('auth', 'status') -AllowFail | Out-Null
if ($script:NativeExit -ne 0) {
    throw 'setup-secrets: gh is not authenticated. Run `gh auth login` and try again.'
}
$existing = @()
$existingKnown = $false
$listOutput = Invoke-Native $script:GhPath @('secret', 'list', '--repo', $Repo) -AllowFail
if ($script:NativeExit -eq 0) {
    $existingKnown = $true
    foreach ($line in @($listOutput)) {
        $text = "$line".Trim()
        if ($text.Length -eq 0) { continue }
        $name = ($text -split '\s+')[0]
        if ($name -ne 'NAME') { $existing += $name }
    }
}
else {
    Write-Host 'setup-secrets: could not list existing secret names (gh secret list failed); "kept" cannot be verified.'
}

# ---------------------------------------------------------------------------------------------------------
# Prompt, set, report. Values stay in $entry.Value for the optional validation below and are cleared at the end.
foreach ($entry in $entries) {
    $prompt = $entry.Name + ' (Enter keeps the existing secret)'
    $secure = Read-Host -Prompt $prompt -AsSecureString
    $plain = (ConvertTo-PlainText $secure).Trim()
    if ($plain.Length -eq 0) {
        $entry.Status = 'kept'
        if ($existingKnown) {
            if (-not ($existing -contains $entry.Name)) { $entry.Status = 'kept (WARNING: not set in ' + $Repo + ' yet)' }
        }
        Write-Host ($entry.Name + ': ' + $entry.Status)
        continue
    }
    $min = $ApiKeyMin
    if ($entry.Kind -eq 'instagram') { $min = $IgTokenMin }
    if ($plain.Length -lt $min) {
        $entry.Status = 'not set (value shorter than ' + $min + ' characters; the engine would treat it as not configured)'
        Write-Host ($entry.Name + ': ' + $entry.Status)
        continue
    }
    if ($plain -match '\s') {
        $entry.Status = 'not set (value contains whitespace)'
        Write-Host ($entry.Name + ': ' + $entry.Status)
        continue
    }
    Set-RepoSecret -Name $entry.Name -Value $plain -Repository $Repo
    $entry.Value = $plain
    $entry.Length = $plain.Length
    $entry.Status = 'set (' + $plain.Length + ' chars)'
    Write-Host ($entry.Name + ': ' + $entry.Status)
}

# ---------------------------------------------------------------------------------------------------------
# Optional validation.
$configChanged = $false
$statusChanged = $false
if (-not $SkipValidate) {
    foreach ($entry in $entries) {
        if ($entry.Kind -ne 'instagram') { continue }
        if ($entry.Value.Length -eq 0) {
            Write-Host ($entry.Name + ': not validated (no value entered this session)')
            continue
        }
        $me = Test-InstagramToken -Token $entry.Value -Version $igVersion
        if (-not $me.Ok) {
            Write-Host ($entry.Name + ': GET /' + $igVersion + '/me failed - ' + $me.Error)
            continue
        }
        Write-Host ($entry.Name + ': GET /' + $igVersion + '/me ok - @' + $me.Username + ' (user_id ' + $me.UserId.Length + ' digits, id ' + $me.Id.Length + ' digits)')
        $nodeArgs = @($setPageIds, '--page', $entry.Page, '--ig-user-id', $me.UserId, '--reset-token-state')
        if ($me.Id -match '^\d+$') { $nodeArgs += @('--app-scoped-id', $me.Id) }
        $lines = Invoke-Native $script:NodePath $nodeArgs
        foreach ($line in @($lines)) {
            $text = "$line"
            Write-Host ('  ' + $text)
            if ($text -match 'written to') { $configChanged = $true }
            if ($text -match 'tokenState .* -> unknown') { $statusChanged = $true }
        }
    }

    foreach ($entry in $entries) {
        if ($entry.Kind -ne 'pat') { continue }
        if ($entry.Value.Length -eq 0) {
            Write-Host ($entry.Name + ': not validated (no value entered this session)')
            continue
        }
        $patCheck = Test-SecretsPat -Pat $entry.Value -Repository $Repo
        if (-not $patCheck.Ok) {
            Write-Host ($entry.Name + ': gh api repos/' + $Repo + '/actions/secrets/public-key failed - ' + $patCheck.Error + ' (the PAT needs Repository permissions Secrets: Read and write on ' + $Repo + ')')
            continue
        }
        Write-Host ($entry.Name + ': gh api repos/' + $Repo + '/actions/secrets/public-key ok - the PAT can read this repository''s secrets (write is proven by the first weekly token-refresh run)')
    }

    $providerEntries = @($entries | Where-Object { $_.Kind -eq 'provider' })
    $enteredProviders = @($providerEntries | Where-Object { $_.Value.Length -gt 0 })
    if ($enteredProviders.Count -gt 0) {
        Write-Host ('setup-secrets: check-models with ' + $enteredProviders.Count + ' of ' + $providerEntries.Count + ' provider keys from this session (kept keys are not available here and will read "not configured yet")')
        try {
            foreach ($entry in $enteredProviders) { [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, 'Process') }
            $lines = Invoke-Native $script:NodePath @($engineCli, 'check-models') -AllowFail
            foreach ($line in @($lines)) { Write-Host ('  ' + "$line") }
        }
        finally {
            foreach ($entry in $enteredProviders) { [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process') }
        }
    }
    else {
        Write-Host 'setup-secrets: no provider key entered this session; run `node --env-file=.env engine/index.js check-models` to validate the stored ones locally.'
    }
}
else {
    Write-Host 'setup-secrets: validation skipped (-SkipValidate); config.json was not changed.'
}

# ---------------------------------------------------------------------------------------------------------
# Summary: names and lengths only. Clear the values.
Write-Host ''
Write-Host ('setup-secrets: summary for ' + $Repo)
foreach ($entry in $entries) {
    Write-Host ('  ' + $entry.Name + ': ' + $entry.Status)
    $entry.Value = ''
}
# Every changed file is named, whichever of the two it is (a token replacement for the same account changes
# status.json only). status.json is rewritten by the bot every hour, so pull before committing it.
$changedFiles = @()
if ($configChanged) { $changedFiles += 'company/config.json' }
if ($statusChanged) { $changedFiles += 'company/state/status.json' }
if ($changedFiles.Count -gt 0) {
    $files = $changedFiles -join ' '
    Write-Host ''
    Write-Host ('setup-secrets: ' + $files + ' changed (ids and token state only, no secret). Pull first, then review and commit:')
    Write-Host '  git pull --ff-only'
    Write-Host ('  git diff ' + $files)
    Write-Host ('  git add ' + $files + '; git commit -m "config: instagram ids"; git push')
    if ($statusChanged) {
        Write-Host 'setup-secrets: the publisher in Actions re-probes a paused page every hour with the stored secret, so committing status.json is optional; if the pull brings a newer status.json, drop your local change (git checkout -- company/state/status.json) and let the next publisher run clear the pause.'
    }
}
else {
    Write-Host 'setup-secrets: company/config.json and company/state/status.json unchanged; nothing to commit.'
}
