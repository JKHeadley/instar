# A bounded Windows-local HTTP hop for an Instar agent in WSL. The companion
# remains bound to the Windows host; this process opens no listening socket.
param(
  [Parameter(Mandatory=$true)][string]$Address,
  [int]$Port = 44818,
  [ValidateSet('probe','capture','cursor','input','start','heartbeat','stop','release')][string]$Operation,
  # Relay mode: stay up, read one request per line, answer one line each.
  # Starting PowerShell from WSL costs about a second per process.
  [switch]$Serve
)
$ErrorActionPreference = 'Stop'
$phase = 'encoding'
function Invoke-Relay([string]$line) {
  if (-not $line -or $line.Length -gt 12000) { throw 'request' }
  $script:phase = 'input-parse'
  $command = $line | ConvertFrom-Json
  $op = $Operation
  if ($Serve) {
    $op = [string]$command.operation
    if (@('probe','capture','cursor','input','start','heartbeat','stop','release') -notcontains $op) { throw 'request' }
  }
  $script:phase = 'input-body'
  $body = [System.Text.Encoding]::UTF8.GetBytes([string]$command.body)
  if ($body.Length -gt 4096) { throw 'request' }
  $script:phase = 'request'
  $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create("http://${Address}:$Port/$op")
  $request.Proxy = $null
  $request.ServicePoint.Expect100Continue = $false
  $request.Method = 'POST'
  $request.ContentType = 'application/json'
  $request.AllowAutoRedirect = $false
  $request.KeepAlive = $false
  $request.Timeout = 3500
  $request.ReadWriteTimeout = 3500
  $request.ContentLength = $body.Length
  $request.Headers.Add('X-Instar-Desktop-Time', [string]$command.time)
  $request.Headers.Add('X-Instar-Desktop-Nonce', [string]$command.nonce)
  $request.Headers.Add('X-Instar-Desktop-Mac', [string]$command.mac)
  $upload = $request.GetRequestStream()
  try { $upload.Write($body, 0, $body.Length) } finally { $upload.Dispose() }
  $script:phase = 'response'
  try { $response = [System.Net.HttpWebResponse]$request.GetResponse() }
  catch [System.Net.WebException] {
    if (-not $_.Exception.Response) { throw 'transport' }
    $response = [System.Net.HttpWebResponse]$_.Exception.Response
  }
  try {
    $script:phase = 'body'
    $stream = $response.GetResponseStream()
    $buffer = New-Object byte[] 1250001
    $count = 0
    while ($count -lt $buffer.Length) {
      $read = $stream.Read($buffer, $count, $buffer.Length - $count)
      if ($read -eq 0) { break }
      $count += $read
    }
    if ($count -gt 1250000) { throw 'reply' }
    $bytes = New-Object byte[] $count
    [Array]::Copy($buffer, $bytes, $count)
    @{ status = [int]$response.StatusCode; type = $response.ContentType.Split(';')[0]; body = [Convert]::ToBase64String($bytes) } |
      ConvertTo-Json -Compress
  } finally { $response.Dispose() }
}
function Write-Failure {
  # Never return a Windows path, request header, or native exception text.
  @{ status = 503; type = 'application/json'; body = ''; error = $script:phase } | ConvertTo-Json -Compress
}
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $phase = 'address'
  $parsed = [System.Net.IPAddress]::Parse($Address)
  if ($Port -lt 1024 -or $Port -gt 65535) { throw 'port' }
  if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'address' }
  $owned = $Address -eq '127.0.0.1'
  if (-not $owned) {
    foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      foreach ($unicast in $adapter.GetIPProperties().UnicastAddresses) {
        if ($unicast.Address.ToString() -eq $Address) { $owned = $true }
      }
    }
  }
  if (-not $owned) { throw 'address' }
  if ($Serve) {
    while ($true) {
      $script:phase = 'input-read'
      $line = [Console]::ReadLine()
      if ($null -eq $line) { break }
      try { $reply = Invoke-Relay $line } catch { $reply = Write-Failure }
      [Console]::Out.WriteLine($reply)
      [Console]::Out.Flush()
    }
  } else {
    if (-not $Operation) { throw 'request' }
    $script:phase = 'input-read'
    Invoke-Relay ([Console]::ReadLine())
  }
} catch {
  Write-Failure
}
