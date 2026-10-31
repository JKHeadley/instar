# A bounded Windows-local HTTP hop for an Instar agent in WSL. The companion
# remains bound to the Windows host; this process opens no listening socket.
param(
  [Parameter(Mandatory=$true)][string]$Address,
  [int]$Port = 44818,
  [Parameter(Mandatory=$true)][ValidateSet('probe','capture','cursor','input','start','heartbeat','stop','release')][string]$Operation
)
$ErrorActionPreference = 'Stop'
$phase = 'encoding'
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
  $phase = 'input'
  $line = [Console]::ReadLine()
  if (-not $line -or $line.Length -gt 12000) { throw 'request' }
  $command = $line | ConvertFrom-Json
  $body = [System.Text.Encoding]::UTF8.GetBytes([string]$command.body)
  if ($body.Length -gt 4096) { throw 'request' }
  $phase = 'request'
  $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create("http://${Address}:$Port/$Operation")
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
  $phase = 'response'
  try { $response = [System.Net.HttpWebResponse]$request.GetResponse() }
  catch [System.Net.WebException] {
    if (-not $_.Exception.Response) { throw 'transport' }
    $response = [System.Net.HttpWebResponse]$_.Exception.Response
  }
  try {
    $phase = 'body'
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
} catch {
  # Never return a Windows path, request header, or native exception text.
  @{ status = 503; type = 'application/json'; body = ''; error = $phase } | ConvertTo-Json -Compress
}
