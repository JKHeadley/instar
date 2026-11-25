<#
.SYNOPSIS
  Windows-side owner signal for the borrowed-machine helper (docs/specs/local-verify-borrowed-unit-slices.md, E "Windows").

.DESCRIPTION
  Runs as a per-user scheduled task (installed by install-windows-owner-signal.ps1). Every 2 seconds
  it writes Windows CPU use, available memory and power state into ECHO'S OWN distro (where the
  helper service and its governor run), at ~/.instar/state/helper-owner-signal.json. It is never
  written into the helper distro, so its writes never restart a stopped sandbox, and `tester` /
  `builder` (in the other distro) cannot reach it.

  The helper treats a missing signal, or one older than 10 seconds, as "do not run".
  It reads nothing from the sandbox and starts nothing in it.

.PARAMETER Distro
  Echo's WSL distro name (NOT instar-helper).
.PARAMETER LinuxUser
  The Linux user the Echo agent runs as in that distro (the signal file must belong to it).
.PARAMETER HelperDistroDir
  Where the helper distro was imported. Its drive's free bytes are written as helperDriveFreeBytes; the
  helper refuses (host-disk-low) whenever the signal lacks them.
#>
param(
  [Parameter(Mandatory = $true)][string]$Distro,
  [Parameter(Mandatory = $true)][string]$LinuxUser,
  # The folder holding the helper distro's virtual disk: its drive's free space is the host-disk margin input.
  [string]$HelperDistroDir = 'C:\instar-helper\distro',
  [int]$IntervalMs = 2000
)

$ErrorActionPreference = 'Stop'
if ($Distro -eq 'instar-helper') { throw 'The owner signal is written into Echo''s distro, never the helper distro.' }

$stateDir = "\\wsl.localhost\$Distro\home\$LinuxUser\.instar\state"
$target = Join-Path $stateDir 'helper-owner-signal.json'
$temp = Join-Path $stateDir 'helper-owner-signal.json.tmp'
$ncpu = [Environment]::ProcessorCount
$cpuCounter = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total')
[void]$cpuCounter.NextValue()

$helperDrive = ([System.IO.Path]::GetPathRoot($HelperDistroDir)).TrimEnd('\')

function Get-HelperDriveFreeBytes {
  $d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$helperDrive'" -ErrorAction SilentlyContinue
  if ($null -eq $d) { return $null }
  return [long]$d.FreeSpace
}

function Get-OnBattery {
  $b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $b) { return $false }       # no battery: mains
  return ($b.BatteryStatus -eq 1)           # 1 = discharging
}

while ($true) {
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $signal = [ordered]@{
      v              = 1
      writer         = 'instar-owner-signal'
      writtenAtMs    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      ncpu           = $ncpu
      cpuPercent     = [Math]::Round([Math]::Min(100, [Math]::Max(0, $cpuCounter.NextValue())), 1)
      availableMemMb = [Math]::Round($os.FreePhysicalMemory / 1024)
      totalMemMb     = [Math]::Round($os.TotalVisibleMemorySize / 1024)
      onBattery      = (Get-OnBattery)
    }
    $free = Get-HelperDriveFreeBytes
    if ($null -ne $free) { $signal['helperDriveFreeBytes'] = $free }
    if (Test-Path $stateDir) {
      ($signal | ConvertTo-Json -Compress) | Set-Content -LiteralPath $temp -Encoding ascii -NoNewline
      Move-Item -LiteralPath $temp -Destination $target -Force
    }
  } catch {
    # A missed write leaves the file stale; the helper stops after 10 s. Nothing else to do here.
  }
  Start-Sleep -Milliseconds $IntervalMs
}
