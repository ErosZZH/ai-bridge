<#
.SYNOPSIS
    Install ai-bridge as an auto-starting, auto-restarting service on Windows.

.DESCRIPTION
    Builds the release output (npm run build -> dist\), then registers a
    Scheduled Task that launches the bridge at logon and restarts it on
    failure. The task runs in your user session (no administrator required),
    so it can read your GitHub Copilot credentials and write ~/.claude.

    Also installs an `ai-bridge` CLI wrapper (ai-bridge.cmd) on your user PATH
    so you can run `ai-bridge login` / `ai-bridge model` interactively.

.PARAMETER Uninstall
    Stop and remove the Scheduled Task and the CLI wrapper.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# --- locations ---------------------------------------------------------------
$RepoDir   = $PSScriptRoot
$DistEntry = Join-Path $RepoDir 'dist\index.js'
$TaskName  = 'ai-bridge'
$BinDir    = Join-Path $env:LOCALAPPDATA 'ai-bridge\bin'
$Wrapper   = Join-Path $BinDir 'ai-bridge.cmd'
$ServiceLauncher = Join-Path $BinDir 'ai-bridge-service.cmd'

function Write-Info { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Warn { param([string]$Msg) Write-Host "warning: $Msg" -ForegroundColor Yellow }

# --- proxy detection ---------------------------------------------------------
# The scheduled task runs in a logon session that does NOT inherit the proxy you
# have exported interactively. On some networks GitHub Copilot only serves
# certain models (e.g. Claude) when traffic exits through a proxy, so a missing
# proxy silently strips those models from the catalog. Detect the proxy now and
# bake it into the service env. Override with $env:AI_BRIDGE_PROXY=... ; disable
# with $env:AI_BRIDGE_PROXY='none'.
$ProxyUrl   = ''
$NoProxyVal = ''
function Invoke-DetectProxy {
    if ($env:AI_BRIDGE_PROXY -eq 'none') {
        Write-Info "proxy detection disabled (AI_BRIDGE_PROXY=none)"
        return
    }

    # Windows env vars are case-insensitive, so HTTPS_PROXY covers https_proxy.
    $url = $env:AI_BRIDGE_PROXY
    if (-not $url) { $url = $env:HTTPS_PROXY }
    if (-not $url) { $url = $env:HTTP_PROXY }
    $script:ProxyUrl = $url

    if ($env:NO_PROXY) {
        $script:NoProxyVal = $env:NO_PROXY
    } else {
        $script:NoProxyVal = 'localhost,127.0.0.0/8,::1'
    }

    if ($script:ProxyUrl) {
        Write-Info "detected proxy $($script:ProxyUrl) — baking it into the service env"
    } else {
        Write-Info "no proxy detected in env; service will connect directly"
        Write-Warn "if Copilot withholds models (e.g. Claude) without a proxy, re-run with:`n    `$env:AI_BRIDGE_PROXY='http://host:port'; .\install.ps1"
    }
}

# =============================================================================
# credential detection + pre-start login
# =============================================================================
# The service mints short-lived Copilot bearer tokens from a long-lived GitHub
# oauth_token on disk (apps.json/hosts.json, written by VS Code Copilot, gh, or
# our own `ai-bridge login`). If that token is absent the service starts but
# answers 401 to every request — and because it caches the empty credential set
# at startup, a later `ai-bridge login` won't recover until the task is
# restarted. So sign in BEFORE registering the task. Mirrors
# findCopilotConfigDirs()/readGitHubTokens() in src/auth/index.ts (win32 dirs).
function Test-CopilotCreds {
    $dirs = @()
    if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA 'github-copilot') }
    if ($env:APPDATA)      { $dirs += (Join-Path $env:APPDATA 'GitHub Copilot') }
    foreach ($dir in $dirs) {
        foreach ($f in @('apps.json', 'hosts.json')) {
            $path = Join-Path $dir $f
            if (Test-Path $path) {
                if (Select-String -Path $path -Pattern '"oauth_token"\s*:\s*"[^"]' -Quiet -ErrorAction SilentlyContinue) {
                    return $true
                }
            }
        }
    }
    return $false
}

# Sign in before the task starts. Skips when usable creds already exist (the
# oauth_token is long-lived and the bearer auto-refreshes). Non-fatal: on failure
# the install continues with a warning.
function Invoke-EnsureLogin {
    param([string]$NodeBin)
    if (Test-CopilotCreds) {
        Write-Info "GitHub Copilot credentials already present — skipping login"
        return
    }
    Write-Info "no GitHub Copilot credentials found; starting sign-in before the service launches"
    & $NodeBin $DistEntry login
    if ($LASTEXITCODE -eq 0) {
        Write-Info "GitHub Copilot sign-in complete"
    } else {
        Write-Warn "sign-in did not complete; the service will start but return 401 until you run ``ai-bridge login`` then restart the task (Stop-ScheduledTask / Start-ScheduledTask -TaskName $TaskName)."
    }
}

# =============================================================================
# uninstall
# =============================================================================
function Invoke-Uninstall {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Info "removed scheduled task '$TaskName'"
    } else {
        Write-Info "scheduled task '$TaskName' not present"
    }

    if (Test-Path $Wrapper) {
        Remove-Item $Wrapper -Force
        Write-Info "removed CLI wrapper $Wrapper"
    }

    if (Test-Path $ServiceLauncher) {
        Remove-Item $ServiceLauncher -Force
        Write-Info "removed service launcher $ServiceLauncher"
    }

    # Drop our bin dir from the user PATH.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath) {
        $parts = $userPath.Split(';') | Where-Object { $_ -and $_ -ne $BinDir }
        [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    }
    Write-Info "ai-bridge uninstalled. (Build output in dist\ and config in ~/.claude were left in place.)"
}

# =============================================================================
# preflight: node >= 22 and npm
# =============================================================================
function Invoke-Preflight {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "node not found on PATH. Install Node.js >= 22 first." }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm not found on PATH. Install Node.js >= 22 first."
    }

    $major = [int](& node -p 'process.versions.node.split(".")[0]')
    if ($major -lt 22) {
        throw "Node.js >= 22 required, found $(& node -v). Upgrade Node and re-run."
    }
    Write-Info "using $(& node -v) at $($node.Source)"
    return $node.Source
}

# =============================================================================
# release build
# =============================================================================
function Invoke-Build {
    Push-Location $RepoDir
    try {
        Write-Info "installing dependencies"
        & npm ci
        if ($LASTEXITCODE -ne 0) { & npm install }
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

        Write-Info "building release output (npm run build)"
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path $DistEntry)) { throw "build did not produce $DistEntry" }
    Write-Info "built $DistEntry"
}

# =============================================================================
# CLI wrapper on PATH
# =============================================================================
function Install-Wrapper {
    param([string]$NodeBin)

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $cmd = @"
@echo off
"$NodeBin" "$DistEntry" %*
"@
    # ASCII, no BOM — cmd.exe chokes on a UTF-8 BOM at the top of a .cmd.
    [System.IO.File]::WriteAllText($Wrapper, $cmd, [System.Text.Encoding]::ASCII)
    Write-Info "installed CLI wrapper at $Wrapper"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath.Split(';')) -notcontains $BinDir) {
        $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Warn "added $BinDir to your user PATH. Open a new terminal for `ai-bridge` to resolve."
    }
}

# =============================================================================
# Service launcher (.cmd) — sets env (incl. proxy) then runs the bridge
# =============================================================================
# Task Scheduler has no per-task environment setting (unlike systemd's
# `Environment=` or launchd's `EnvironmentVariables`), so we bake the env into a
# small launcher .cmd and point the task at that.
function Install-ServiceLauncher {
    param([string]$NodeBin)

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

    $proxyLines = ''
    if ($ProxyUrl) {
        $proxyLines = @"
set "HTTPS_PROXY=$ProxyUrl"
set "HTTP_PROXY=$ProxyUrl"
set "NO_PROXY=$NoProxyVal"
"@
    }

    $cmd = @"
@echo off
set "NODE_ENV=production"
$proxyLines
"$NodeBin" "$DistEntry" %*
"@
    # ASCII, no BOM — cmd.exe chokes on a UTF-8 BOM at the top of a .cmd.
    [System.IO.File]::WriteAllText($ServiceLauncher, $cmd, [System.Text.Encoding]::ASCII)
    Write-Info "installed service launcher at $ServiceLauncher"
}

# =============================================================================
# Scheduled Task (logon trigger, restart on failure, user session)
# =============================================================================
function Install-Task {
    $action = New-ScheduledTaskAction -Execute $ServiceLauncher `
        -WorkingDirectory $RepoDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description 'ai-bridge — Claude Code to GitHub Copilot bridge' -Force | Out-Null
    Write-Info "registered scheduled task '$TaskName' (runs at logon, restarts on failure)"

    Start-ScheduledTask -TaskName $TaskName
    Write-Info "started '$TaskName'"
}

# =============================================================================
# main
# =============================================================================
if ($Uninstall) {
    Invoke-Uninstall
    return
}

$nodeBin = Invoke-Preflight
Invoke-Build
Invoke-DetectProxy
Install-Wrapper          -NodeBin $nodeBin
Install-ServiceLauncher  -NodeBin $nodeBin
# Sign in before registering the task. A task started without creds caches the
# empty credential set and answers 401 until restarted, so a later login alone
# would not recover it.
Invoke-EnsureLogin       -NodeBin $nodeBin
Install-Task

Write-Host ""
Write-Info "ai-bridge installed and running at http://127.0.0.1:11500"
Write-Host @"

Next steps:
  1. (optional) re-run sign-in:   ai-bridge login   (only if the service 401s)
  2. (optional) pick a model:     ai-bridge model
  3. Run Claude Code as usual:    claude

Manage the service:
  status:  Get-ScheduledTask -TaskName $TaskName
  stop:    Stop-ScheduledTask -TaskName $TaskName
  start:   Start-ScheduledTask -TaskName $TaskName
  logs:    %USERPROFILE%\.ai-bridge\logs
  remove:  .\install.ps1 -Uninstall

(`ai-bridge` resolves in a new terminal — the installer just added it to PATH.)
"@
