<#
.SYNOPSIS
    Install ai-bridge as an auto-starting, auto-restarting service on Windows.

.DESCRIPTION
    Builds the release output (npm run build -> dist\), then registers a
    Scheduled Task that launches the bridge at logon and restarts it on
    failure. Registering the task requires administrator rights: if the
    installer is not elevated it relaunches an elevated child (via UAC) to
    register the task, and aborts if elevation is declined or blocked. There
    is no non-admin fallback. The task runs as your user account in a hidden
    background session (no console window), so it can read your GitHub Copilot
    credentials and write ~/.claude.

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
    [switch]$Uninstall,
    # --- internal: used when the installer relaunches an elevated child solely to
    # register (or unregister) the Scheduled Task. Not intended to be passed by users. ---
    [switch]$RegisterTaskOnly,
    [switch]$UnregisterTaskOnly,
    [string]$TaskLauncher,
    [string]$TaskWorkingDir,
    [string]$TaskUser
)

$ErrorActionPreference = 'Stop'

# --- locations ---------------------------------------------------------------
$RepoDir   = $PSScriptRoot
$DistEntry = Join-Path $RepoDir 'dist\index.js'
$TaskName  = 'ai-bridge'
$BinDir    = Join-Path $env:LOCALAPPDATA 'ai-bridge\bin'
$Wrapper   = Join-Path $BinDir 'ai-bridge.cmd'
$ServiceLauncher = Join-Path $BinDir 'ai-bridge-service.cmd'

# Port selection. A single AI_BRIDGE_PORT feeds both the server bind and the
# ANTHROPIC_BASE_URL written into ~/.claude/settings.json, so the two must agree.
# Probe for a free port at install time: when a Windows host and its WSL guest
# both install ai-bridge they share localhost, and both defaulting to 11500 makes
# one server lose the bind -- Claude Code, pointed at that dead base URL, then
# fails with an opaque 400. DefaultPort is the starting point (overridable via
# $env:AI_BRIDGE_PORT); $Port is the winner chosen by Select-Port.
$DefaultPort  = if ($env:AI_BRIDGE_PORT) { [int]$env:AI_BRIDGE_PORT } else { 11500 }
$PortScanLimit = 50
$BindHost     = if ($env:AI_BRIDGE_HOST) { $env:AI_BRIDGE_HOST } else { '127.0.0.1' }
$Port         = $null
$BaseUrl      = $null

function Write-Info { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Warn { param([string]$Msg) Write-Host "warning: $Msg" -ForegroundColor Yellow }

# True when the current process is running with an elevated (Administrator) token.
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

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
        Write-Info "detected proxy $($script:ProxyUrl) -- baking it into the service env"
    } else {
        Write-Info "no proxy detected in env; service will connect directly"
        Write-Warn "if Copilot withholds models (e.g. Claude) without a proxy, re-run with:`n    `$env:AI_BRIDGE_PROXY='http://host:port'; .\install.ps1"
    }
}

# --- port selection ----------------------------------------------------------
# True if $BindHost:$Port is free to bind. We probe with node's net.createServer
# (the same runtime the server binds with) rather than Test-NetConnection or a
# raw socket: only an actual listen() reflects the bind semantics
# @hono/node-server uses, and node is already a hard dependency here.
# exclusive:true rejects any SO_REUSEADDR-style shared bind so a port another
# instance already holds reads as taken.
function Test-PortFree {
    param([string]$NodeBin, [int]$Port)
    # Single-quoted JS on ONE line. Windows PowerShell 5.1 -- which this installer
    # relaunches via powershell.exe for elevation, and which most Windows users run
    # -- does NOT escape embedded double quotes when handing an argument to a native
    # exe, so double-quoted JS would reach node as require(net) -> ReferenceError ->
    # exit 1 for every port. Keeping the probe free of double quotes (and on one
    # line) sidesteps that quoting bug. Single quotes inside a single-quoted
    # here-string are literal, so they survive to node intact.
    $probe = @'
const net=require('net');const s=net.createServer();s.once('error',()=>process.exit(1));s.listen({host:process.env.AI_BRIDGE_PROBE_HOST,port:Number(process.env.AI_BRIDGE_PROBE_PORT),exclusive:true},()=>s.close(()=>process.exit(0)));
'@
    $env:AI_BRIDGE_PROBE_HOST = $BindHost
    $env:AI_BRIDGE_PROBE_PORT = "$Port"
    try {
        & $NodeBin -e $probe 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        # PS 7.4+ defaults $PSNativeCommandUseErrorActionPreference=$true, so with
        # $ErrorActionPreference='Stop' (top of script) a busy port (node exit 1)
        # raises a TERMINATING error instead of just returning non-zero. Without
        # this catch the first occupied port would abort the whole install -- the
        # exact Windows+WSL-both-on-11500 collision this feature exists to handle.
        return $false
    } finally {
        Remove-Item Env:AI_BRIDGE_PROBE_HOST -ErrorAction SilentlyContinue
        Remove-Item Env:AI_BRIDGE_PROBE_PORT -ErrorAction SilentlyContinue
    }
}

# Pick the first free port at/after $DefaultPort and publish it as $Port/$BaseUrl
# plus $env:AI_BRIDGE_PORT, so the service launcher, the CLI wrapper, and the
# pre-start login all read the SAME port. Without this, a Windows host and its
# WSL guest both default to 11500; the loser of the bind leaves Claude Code
# pointed at a dead base URL, which surfaces as an opaque 400.
function Select-Port {
    param([string]$NodeBin)
    $limit = $DefaultPort + $PortScanLimit
    for ($candidate = $DefaultPort; $candidate -lt $limit; $candidate++) {
        if (Test-PortFree -NodeBin $NodeBin -Port $candidate) {
            $script:Port    = $candidate
            $script:BaseUrl = "http://${BindHost}:${candidate}"
            $env:AI_BRIDGE_PORT = "$candidate"
            if ($candidate -eq $DefaultPort) {
                Write-Info "port $candidate is free -- using it"
            } else {
                Write-Info "port $DefaultPort is in use; selected free port $candidate instead"
            }
            return
        }
        Write-Info "port $candidate is in use; trying $($candidate + 1)"
    }
    throw "no free port found in range $DefaultPort-$($limit - 1). Free one up or set `$env:AI_BRIDGE_PORT to an open port and re-run."
}

# =============================================================================
# credential detection + pre-start login
# =============================================================================
# The service mints short-lived Copilot bearer tokens from a long-lived GitHub
# oauth_token on disk (apps.json/hosts.json, written by VS Code Copilot, gh, or
# our own `ai-bridge login`). If that token is absent the service starts but
# answers 401 to every request -- and because it caches the empty credential set
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
        Write-Info "GitHub Copilot credentials already present -- skipping login"
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

# Reconcile ~/.claude/settings.json's base URL with the port we just chose. MUST
# run on every install, unconditionally -- Invoke-EnsureLogin returns early (and
# so never rewrites settings.json) whenever Copilot creds already exist, so on a
# re-install the dynamically reselected port (e.g. 11501 when WSL holds 11500)
# would otherwise never reach Claude Code, leaving it dialing the stale 11500 and
# failing with ConnectionRefused once WSL's forwarder goes away. sync-config
# patches only the base URL + auth token (model/window untouched) and needs no
# network, so it is safe to run regardless of login state. $env:AI_BRIDGE_PORT is
# already set by Select-Port, so the child reads the SAME port.
function Invoke-SyncConfig {
    param([string]$NodeBin)
    & $NodeBin $DistEntry sync-config
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "could not reconcile ~/.claude/settings.json; set ANTHROPIC_BASE_URL=$BaseUrl there by hand if Claude Code can't connect."
    }
}

# =============================================================================
# uninstall
# =============================================================================

# Remove the Scheduled Task, elevating if necessary. Unregister-ScheduledTask
# fails with a NON-TERMINATING "Access is denied" for a standard user, which
# slips past $ErrorActionPreference='Stop' -- so we must check Get-ScheduledTask
# afterwards rather than trust the call. Mirrors the install path
# (Invoke-ElevatedTaskRegister): already-admin removes in-process; otherwise we
# relaunch an elevated child (UAC) to do it. Returns $true once the task is gone.
function Remove-AiBridgeTask {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        Write-Info "scheduled task '$TaskName' not present"
        return $true
    }

    if (Test-Admin) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    } else {
        Write-Info "removing the Scheduled Task requires administrator rights."
        Write-Host "    A UAC prompt will ask you to approve (or sign in as) an administrator." -ForegroundColor Yellow
        $scriptPath = $PSCommandPath
        if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
        $argList = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"",
            '-UnregisterTaskOnly'
        )
        try {
            Start-Process -FilePath 'powershell.exe' -ArgumentList $argList `
                -Verb RunAs -Wait -ErrorAction Stop | Out-Null
        } catch {
            Write-Warn "elevation was declined or blocked ($($_.Exception.Message.Trim()))."
        }
    }

    # Trust the state, not the exit path: confirm the task is actually gone.
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Write-Warn "could not remove scheduled task '$TaskName'. Re-run from an elevated PowerShell:`n    Stop-ScheduledTask -TaskName $TaskName; Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
        return $false
    }
    Write-Info "removed scheduled task '$TaskName'"
    return $true
}

function Invoke-Uninstall {
    Remove-AiBridgeTask | Out-Null

    # Remove the per-user logon fallback (HKCU Run) if it was used.
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (Get-ItemProperty -Path $runKey -Name $TaskName -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name $TaskName -ErrorAction SilentlyContinue
        Write-Info "removed logon auto-start $runKey\$TaskName"
    }
    # Stop any running bridge started via the fallback.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$DistEntry*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

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

    $ver   = (& node -p 'process.versions.node')
    $parts = $ver.Split('.')
    $major = [int]$parts[0]
    if ($major -lt 22) {
        throw "Node.js >= 22 required, found v$ver. Upgrade Node (e.g. ``nvm install 22``) and re-run."
    }
    Write-Info "using v$ver at $($node.Source)"
    return $node.Source
}

# =============================================================================
# release build
# =============================================================================
function Invoke-Build {
    param([string]$NodeBin)

    Push-Location $RepoDir
    try {
        # impit ships prebuilt napi binaries for Windows x64/arm64 (pulled as
        # optionalDependencies), so a normal install needs no C/C++ toolchain --
        # this is the whole reason ai-bridge moved off node-libcurl, whose Windows
        # build had to be compiled from source and routinely failed. `npm install`
        # (not `npm ci`) so an already-built node_modules is preserved across re-runs.
        Write-Info "installing dependencies"
        & npm install
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
if not defined AI_BRIDGE_PORT set "AI_BRIDGE_PORT=$Port"
"$NodeBin" "$DistEntry" %*
"@
    # ASCII, no BOM -- cmd.exe chokes on a UTF-8 BOM at the top of a .cmd.
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
# Service launcher (.cmd) -- sets env (incl. proxy) then runs the bridge
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
set "AI_BRIDGE_PORT=$Port"
$proxyLines
"$NodeBin" "$DistEntry" %*
"@
    # ASCII, no BOM -- cmd.exe chokes on a UTF-8 BOM at the top of a .cmd.
    [System.IO.File]::WriteAllText($ServiceLauncher, $cmd, [System.Text.Encoding]::ASCII)
    Write-Info "installed service launcher at $ServiceLauncher"
}

# =============================================================================
# Scheduled Task (logon trigger, restart on failure, user session)
# =============================================================================

# Register the Scheduled Task itself. Requires an elevated token on locked-down
# machines (standard users get "Access is denied" from the Task Scheduler).
# Runs both in-process (when the installer is already admin) and inside the
# elevated child we spawn via -RegisterTaskOnly. Returns nothing; throws on
# failure so the caller can fall back to the HKCU logon entry.
function Register-AiBridgeTask {
    param(
        [string]$Launcher,
        [string]$WorkingDir,
        [string]$User
    )
    $action = New-ScheduledTaskAction -Execute $Launcher -WorkingDirectory $WorkingDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    # Bind the task to the original (non-elevated) user so it runs with their
    # Copilot creds + ~/.claude -- even when an admin elevated the child. LogonType
    # S4U ("run whether logged on or not") runs the launcher in a HIDDEN, non-
    # interactive background session: no console window is ever spawned, so there
    # is nothing for the user to close that would kill the service. (Interactive,
    # by contrast, attaches node to a visible cmd window whose close event tears
    # the service down.) -RunLevel Limited keeps it off an elevated token.
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description 'ai-bridge -- Claude Code to GitHub Copilot bridge' -Force -ErrorAction Stop | Out-Null
}

# Spawn an elevated copy of this script that does nothing but register the task,
# then returns. UAC prompts the user to authenticate as an administrator. We pass
# the launcher/workdir/user explicitly so the child needs no other state, and bind
# the task to $env:USERNAME (the *current*, non-elevated user) regardless of which
# admin account approves the prompt. Returns $true if the task now exists.
function Invoke-ElevatedTaskRegister {
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"",
        '-RegisterTaskOnly',
        '-TaskLauncher',   "`"$ServiceLauncher`"",
        '-TaskWorkingDir', "`"$RepoDir`"",
        '-TaskUser',       "`"$env:USERNAME`""
    )
    try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList `
            -Verb RunAs -Wait -PassThru -ErrorAction Stop
    } catch {
        # User clicked "No" on the UAC prompt, or elevation is blocked by policy.
        Write-Warn "elevation was declined or blocked ($($_.Exception.Message.Trim()))."
        return $false
    }
    if ($proc.ExitCode -ne 0) {
        Write-Warn "elevated task registration exited with code $($proc.ExitCode)."
        return $false
    }
    # Confirm the elevated child actually created the task before reporting success.
    return [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

function Install-Task {
    # A Scheduled Task (logon trigger + restart-on-failure) is the only supported
    # mechanism. Registering it requires admin, so the path is:
    #   1. already elevated      -> register in-process
    #   2. not elevated          -> relaunch an elevated child (UAC) to register
    #   3. declined / failed     -> abort with an error (no fallback)
    if (Test-Admin) {
        try {
            Register-AiBridgeTask -Launcher $ServiceLauncher -WorkingDir $RepoDir -User $env:USERNAME
            Start-ScheduledTask -TaskName $TaskName
            Write-Info "registered scheduled task '$TaskName' (runs at logon, restarts on failure)"
        } catch {
            throw "could not register the Scheduled Task even while elevated ($($_.Exception.Message.Trim()))."
        }
    } else {
        Write-Info "registering the auto-restart Scheduled Task requires administrator rights."
        Write-Host "    A UAC prompt will ask you to approve (or sign in as) an administrator." -ForegroundColor Yellow
        if (-not (Invoke-ElevatedTaskRegister)) {
            throw "administrator elevation is required to register the Scheduled Task, but it was declined or failed. Re-run this installer from an elevated PowerShell, or approve the UAC prompt."
        }
        Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Info "registered scheduled task '$TaskName' via elevation (runs at logon, restarts on failure)"
    }

    Write-Info "started '$TaskName'"
}

# =============================================================================
# autostart verification + per-user fallback
# =============================================================================
# A Scheduled Task can report success yet never actually run: on locked-down
# domain machines the S4U logon type ("run whether logged on or not") is often
# blocked by policy, so Register/Start both succeed but no process ever spawns and
# no log is written. The only honest test is whether the bridge answers on its
# port, so we probe /health and, if it's dead, switch to an autostart that needs
# neither admin nor an S4U token.

# Poll $BaseUrl/health until it answers ok or we time out. True only when the
# service is genuinely reachable -- the real proof the autostart worked.
function Test-BridgeUp {
    param([int]$TimeoutSec = 8)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod "$BaseUrl/health" -TimeoutSec 2
            if ($r.status -eq 'ok') { return $true }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

# Per-user logon autostart: an HKCU\...\Run entry launching the hidden service
# launcher via cmd's `start "" /b` (detached, no console window). Needs no admin
# and no S4U token, so it runs in the interactive session where the Scheduled Task
# silently won't. The uninstall path already removes this key (same $TaskName).
function Install-RunFallback {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $value = 'cmd /c start "" /b "' + $ServiceLauncher + '"'
    Set-ItemProperty -Path $runKey -Name $TaskName -Value $value
    Write-Info "installed per-user logon autostart (HKCU\...\Run\$TaskName)"
}

# Remove the HKCU Run fallback if present. Called when the Scheduled Task path is
# verified working, so the two mechanisms never both fire at logon (a double start
# would make the second instance hop to the next port and rewrite settings.json).
function Remove-RunFallback {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (Get-ItemProperty -Path $runKey -Name $TaskName -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name $TaskName -ErrorAction SilentlyContinue
        Write-Info "removed stale per-user autostart (Scheduled Task is handling startup)"
    }
}

# Start the bridge now, detached and hidden, so the user need not log out/in for
# the Run entry to take effect.
function Start-BridgeDetached {
    Start-Process -FilePath $ServiceLauncher -WindowStyle Hidden -WorkingDirectory $RepoDir
}

# Register the Scheduled Task, then PROVE the bridge is reachable; fall back to the
# per-user Run autostart whenever it isn't. Never aborts the install over an
# autostart failure -- on a locked-down machine the task may throw (UAC declined)
# or register-but-never-run, and in both cases the fallback is what makes the
# bridge actually work. Returns nothing; leaves exactly one autostart active.
function Install-AutostartVerified {
    try {
        Install-Task
    } catch {
        Write-Warn "Scheduled Task setup failed: $($_.Exception.Message.Trim())"
    }

    if (Test-BridgeUp) {
        Remove-RunFallback
        return
    }

    Write-Warn "the service did not come up via the Scheduled Task (common on domain machines where S4U is blocked); falling back to a per-user logon autostart."
    Install-RunFallback
    Start-BridgeDetached
    if (Test-BridgeUp) {
        Write-Info "ai-bridge is now running via the per-user autostart."
    } else {
        Write-Warn "ai-bridge still isn't answering on $BaseUrl -- check %USERPROFILE%\.ai-bridge\logs for the startup error."
    }
}

# =============================================================================
# main
# =============================================================================
if ($Uninstall) {
    Invoke-Uninstall
    return
}

# Elevated child entry point: we were relaunched with -RegisterTaskOnly solely to
# create the Scheduled Task. Do exactly that and exit with a clear code so the
# parent (running as the normal user) can detect success/failure. Everything else
# -- build, login, PATH -- already ran (or will run) in the non-elevated parent.
if ($RegisterTaskOnly) {
    try {
        Register-AiBridgeTask -Launcher $TaskLauncher -WorkingDir $TaskWorkingDir -User $TaskUser
        Write-Info "registered scheduled task '$TaskName' (elevated)"
        exit 0
    } catch {
        Write-Warn "elevated registration failed: $($_.Exception.Message.Trim())"
        exit 1
    }
}

# Elevated child entry point for uninstall: relaunched with -UnregisterTaskOnly
# solely to remove the Scheduled Task (Unregister-ScheduledTask needs admin on
# locked-down machines). Exit code lets the non-elevated parent verify success.
if ($UnregisterTaskOnly) {
    try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Info "removed scheduled task '$TaskName' (elevated)"
        exit 0
    } catch {
        Write-Warn "elevated unregister failed: $($_.Exception.Message.Trim())"
        exit 1
    }
}

$nodeBin = Invoke-Preflight
Invoke-Build -NodeBin $nodeBin
Invoke-DetectProxy
# Choose a free port BEFORE writing the wrapper, service launcher, or login config
# -- they all bake in $Port (via $env:AI_BRIDGE_PORT), so it must be settled first.
Select-Port              -NodeBin $nodeBin
Install-Wrapper          -NodeBin $nodeBin
Install-ServiceLauncher  -NodeBin $nodeBin
# Sign in before registering the task. A task started without creds caches the
# empty credential set and answers 401 until restarted, so a later login alone
# would not recover it.
Invoke-EnsureLogin       -NodeBin $nodeBin
# Reconcile settings.json's base URL with $Port AFTER login. Unconditional by
# design: login is skipped when creds exist, but the port must sync every time.
Invoke-SyncConfig        -NodeBin $nodeBin
# Register the Scheduled Task, then verify the bridge actually answers -- falling
# back to a per-user logon autostart when the task registers but never runs (the
# silent S4U failure on locked-down domain machines).
Install-AutostartVerified

Write-Host ""
Write-Info "ai-bridge installed and running at $BaseUrl"

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

(`ai-bridge` resolves in a new terminal -- the installer just added it to PATH.)
"@
