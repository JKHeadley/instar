<#
.SYNOPSIS
  Installs (or removes) the per-user scheduled task that runs windows-owner-signal.ps1
  (docs/specs/local-verify-borrowed-unit-slices.md, E "Windows"). Run by that machine's agent after
  its owner's yes. No administrator rights: the task runs as the current user at logon.

.PARAMETER Distro
  Echo's WSL distro name (NOT instar-helper).
.PARAMETER LinuxUser
  The Linux user the Echo agent runs as in that distro.
.PARAMETER Uninstall
  Remove the task (used by `instar helper uninstall`, which also removes the signal file).
#>
param(
  [string]$Distro,
  [string]$LinuxUser,
  [string]$HelperDistroDir = 'C:\instar-helper\distro',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskPath = '\Instar\'
$taskName = 'OwnerSignal'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output 'owner-signal task removed'
  return
}
if (-not $Distro -or -not $LinuxUser) { throw 'Distro and LinuxUser are required.' }
if ($Distro -eq 'instar-helper') { throw 'The owner signal is written into Echo''s distro, never the helper distro.' }

$script = Join-Path $PSScriptRoot 'windows-owner-signal.ps1'
if (-not (Test-Path $script)) { throw "missing $script" }
$taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Distro `"$Distro`" -LinuxUser `"$LinuxUser`" -HelperDistroDir `"$HelperDistroDir`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
Write-Output "owner-signal task installed: $taskPath$taskName"
