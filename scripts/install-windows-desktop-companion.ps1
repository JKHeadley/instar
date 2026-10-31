# Instar's WSL agent invokes this once after explicit remoteDesktop opt-in.
# The task runs in the Windows user's interactive session, never in WSL/session 0.
param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$BindAddress,
  [int]$Port = 44818,
  [Parameter(Mandatory=$true)][ValidateSet('Stage','InstallPrepared','RequestUpdate')][string]$Phase,
  [string]$RequestAddress,
  [ValidateSet('prepare-update','commit-update','cancel-update')][string]$Operation
)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid companion port' }
$address = [System.Net.IPAddress]::Parse($BindAddress)
if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 bind address required' }
$octets = $address.GetAddressBytes()
$private = ($BindAddress -eq '127.0.0.1') -or ($octets[0] -eq 10) -or
  ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
  ($octets[0] -eq 192 -and $octets[1] -eq 168)
if (-not $private) { throw 'Companion bind must be loopback or on the local WSL bridge' }
$root = Join-Path $env:LOCALAPPDATA 'InstarDesktop'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$secret = Join-Path $root 'companion.secret'
if (-not (Test-Path $secret)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  [System.IO.File]::WriteAllBytes($secret, $bytes)
}
if (([System.IO.File]::ReadAllBytes($secret)).Length -ne 32) { throw 'Companion secret has invalid length' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User, 'Read', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($secret, $acl)
if ($Phase -eq 'RequestUpdate') {
  if (-not $RequestAddress -or -not $Operation) { throw 'windows-local-request-invalid' }
  $requestIp = [System.Net.IPAddress]::Parse($RequestAddress)
  if ($requestIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'windows-local-request-invalid'
  }
  $owned = $RequestAddress -eq '127.0.0.1'
  if (-not $owned) {
    foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      foreach ($unicast in $adapter.GetIPProperties().UnicastAddresses) {
        if ($unicast.Address.ToString() -eq $RequestAddress) { $owned = $true }
      }
    }
  }
  if (-not $owned) { throw 'windows-local-request-invalid' }
  $updateToken = $env:INSTAR_DESKTOP_UPDATE_TOKEN
  if ($Operation -ne 'prepare-update' -and $updateToken -notmatch '^[A-Za-z0-9_-]{32}$') {
    throw 'windows-local-request-invalid'
  }
  $body = if ($Operation -eq 'prepare-update') { '{}' }
    else { @{ updateToken = $updateToken } | ConvertTo-Json -Compress }
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $timestamp = [string]([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()
  $nonceBytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($nonceBytes) } finally { $rng.Dispose() }
  $nonce = [Convert]::ToBase64String($nonceBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($sha.ComputeHash($bodyBytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
  $canonical = "instar-windows-desktop-v1`n$Operation`n$timestamp`n$nonce`n$digest"
  $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.IO.File]::ReadAllBytes($secret))
  try { $macBytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonical)) }
  finally { $hmac.Dispose() }
  $mac = [Convert]::ToBase64String($macBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create("http://${RequestAddress}:$Port/$Operation")
  $request.Proxy = $null
  $request.Method = 'POST'
  $request.ContentType = 'application/json'
  $request.AllowAutoRedirect = $false
  $request.KeepAlive = $false
  $request.Timeout = 5000
  $request.ReadWriteTimeout = 5000
  $request.ContentLength = $bodyBytes.Length
  $request.Headers.Add('X-Instar-Desktop-Time', $timestamp)
  $request.Headers.Add('X-Instar-Desktop-Nonce', $nonce)
  $request.Headers.Add('X-Instar-Desktop-Mac', $mac)
  try {
    $upload = $request.GetRequestStream()
    try { $upload.Write($bodyBytes, 0, $bodyBytes.Length) } finally { $upload.Dispose() }
    $response = [System.Net.HttpWebResponse]$request.GetResponse()
    try {
      if ([int]$response.StatusCode -ne 200 -or $response.ContentType.Split(';')[0] -ne 'application/json') {
        throw 'windows-local-request-invalid'
      }
      $stream = $response.GetResponseStream()
      $buffer = New-Object byte[] 4097
      $count = 0
      while ($count -lt $buffer.Length) {
        $read = $stream.Read($buffer, $count, $buffer.Length - $count)
        if ($read -eq 0) { break }
        $count += $read
      }
      if ($count -gt 4096) { throw 'windows-local-request-invalid' }
      $reply = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $count) | ConvertFrom-Json
      $reply | ConvertTo-Json -Compress
    } finally { $response.Dispose() }
  } catch [System.Net.WebException] {
    if ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::Timeout) { throw 'windows-local-request-timeout' }
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 403) { throw 'windows-local-request-forbidden' }
    throw 'windows-local-request-unavailable'
  }
  return
}
$code = Join-Path $root 'InstarDesktopCompanion.cs'
if (-not [string]::Equals([System.IO.Path]::GetFullPath($Source),
  [System.IO.Path]::GetFullPath($code), [System.StringComparison]::OrdinalIgnoreCase)) {
  Copy-Item -Force -Path $Source -Destination $code
}
$exe = Join-Path $root 'InstarDesktopCompanion.exe'
$nextExe = Join-Path $root 'InstarDesktopCompanion.next.exe'
$taskName = 'Instar Desktop Companion'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$prior = $null
try {
  $prior = $folder.GetTask($taskName)
} catch {
  # Task Scheduler reports an absent task as either FILE_NOT_FOUND or
  # SCHED_E_UNKNOWN_OBJECT depending on the Windows version.
  if ($_.Exception.HResult -ne -2147024894 -and $_.Exception.HResult -ne -2147216625) { throw }
}
if ($Phase -eq 'Stage') {
  if (Test-Path $nextExe) { Remove-Item -Force $nextExe }
  Add-Type -Path $code -ReferencedAssemblies @('System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions') `
    -OutputAssembly $nextExe -OutputType ConsoleApplication -ErrorAction Stop
  if (-not (Test-Path $nextExe)) { throw 'Companion compiler produced no executable' }
  @{ staged = $true; taskRunning = ($null -ne $prior -and $prior.State -eq 4) } | ConvertTo-Json -Compress
  return
}
if (-not (Test-Path $nextExe)) { throw 'No staged companion executable' }
if ($null -ne $prior) {
  for ($attempt = 0; $attempt -lt 20 -and $prior.State -eq 4; $attempt++) { Start-Sleep -Milliseconds 250 }
  if ($prior.State -eq 4) { throw 'Previous companion is still running' }
}
if (Test-Path $exe) { Remove-Item -Force $exe }
Move-Item -Force $nextExe $exe
$task = $service.NewTask(0)
$task.RegistrationInfo.Description = 'Interactive Windows desktop companion for the PIN-gated Instar dashboard'
$task.Principal.UserId = $identity.Name
$task.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN: no password prompt
$task.Principal.RunLevel = 0
$task.Settings.Enabled = $true
$task.Settings.Hidden = $false
$task.Settings.ExecutionTimeLimit = 'PT0S'
$task.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
$trigger = $task.Triggers.Create(9) # TASK_TRIGGER_LOGON
$trigger.UserId = $identity.Name
$action = $task.Actions.Create(0) # TASK_ACTION_EXEC
$action.Path = $exe
$action.Arguments = ('{0} {1} "{2}"' -f $BindAddress, $Port, $secret)
$folder.RegisterTaskDefinition($taskName, $task, 6, $null, $null, 3) | Out-Null
$registered = $folder.GetTask($taskName)
$registered.Run($null) | Out-Null
@{ installed = $true; bindAddress = $BindAddress; port = $Port; taskName = $taskName } | ConvertTo-Json -Compress
