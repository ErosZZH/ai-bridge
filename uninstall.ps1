<#
.SYNOPSIS
    Stop and remove the ai-bridge service and CLI wrapper on Windows.

.DESCRIPTION
    Runs the uninstall path from install.ps1. Build output in dist\ and Claude
    Code config in ~/.claude are left untouched.

.EXAMPLE
    .\uninstall.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install.ps1'
& $installer -Uninstall
