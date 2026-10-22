<#
  native-drive.ps1 — Native Browser Drive (Windows)

  Drives a NORMALLY-launched Chrome with real OS-level mouse/keyboard input and
  the Windows UI Automation (accessibility) tree. No CDP, no --remote-debugging-port,
  no WebDriver — so from the page's perspective every click/keystroke is a genuine
  human input (isTrusted=true, carries user-activation), and there is no automation
  connection for reCAPTCHA / device-fingerprinting to detect.

  This is the Windows counterpart to INSTAR's macOS normal-browser sign-in path
  (which drives Chrome via Apple Events). Same principle, Windows primitives:
    - element discovery  -> UI Automation (reads Chrome's a11y tree)
    - input injection    -> Win32 SendInput (real HID-level events)
    - page/URL readback   -> UI Automation Value/Text patterns
    - visual verification -> PrintWindow capture of the target window only

  TARGET BINDING (safety): every command acts ONLY on the Chrome browser process that
  owns one profile directory (the "target"). `launch` and `attach` record that profile
  in a state file; nothing ever falls back to "the newest Chrome". Input is sent only
  after verifying the foreground window belongs to the target browser process — if
  focus is elsewhere (another app, the operator's own Chrome on another profile), the
  command refuses with exit 2. Secrets are re-checked before every character.

  Requires an interactive desktop session (a logged-in, visible Windows desktop).
  Pure in-box PowerShell 5.1 + .NET — no package installs, no admin.

  USAGE (one command per invocation):
    launch  <userDataDir> <url> [chromeExe]   Start a clean Chrome (no debug port) on a profile dir; bind it
    attach  <userDataDir>                       Bind an ALREADY-running Chrome on that profile dir
    target                                      Print the bound profile, browser pid and window handle
    focus                                       Bring the target window to the foreground
    canfocus                                    Read-only: would input be allowed now? (exit 2 if operator active)
    nav     <url>                               Ctrl+L, type the URL, Enter
    url                                         Print the current page URL (from the omnibox)
    tree    <outfile>                           Dump the a11y tree (name|type|rect) as JSON
    text    <outfile>                           Dump all visible document text as JSON (page readback)
    find    <name-substring> [browser]          Print center x,y + rect of the first matching element
    click   <name-substring> [browser]          Real OS mouse click at a matched element's center
    invoke  <name-substring> [browser]          UIA Invoke a matched element (no foreground needed)
    clickxy <x> <y>                             Real OS mouse click at screen coords (must land on the target)
    editfields                                  List page input fields top-to-bottom with their index
    typeedit       <index> <text>               Focus field <index> (UIA), clear it, type text
    typesecretedit <index>                      Same, value read from ONE stdin line (never on argv)
    type    <text>                              Type text via real keystrokes into the focused field
    typesecret                                  Read ONE line from stdin and type it (passwords; never on argv)
    key     <Enter|Tab|Esc|Down|...>            Send a single special key
    ctrl    <char>                              Ctrl+<char> chord (e.g. ctrl a)
    clearfield <x> <y>                          Click a point, then Ctrl+A + Delete
    shot    <outfile>                           PNG of the target window ONLY (not the rest of the screen)

  Env: ND_ALLOW_FOCUS_STEAL=1  allow taking focus while the operator is active (unattended machines)
       ND_OPERATOR_IDLE_MS  how long input must be idle before taking focus (default 30000)
       ND_STATE_FILE   override the binding file (default %LOCALAPPDATA%\native-drive\target.json)
       ND_USER_DATA_DIR use this profile dir for this call instead of the bound one
       ND_CHROME_FLAGS  extra launch flags (space-separated), e.g. --disable-extensions

  find/click/invoke search the web page only; add 'browser' to include Chrome's own UI.
  ND_CHROME_FLAGS is an allowlist: --disable-extensions, --start-maximized, --new-window,
  --window-size=W,H, --window-position=X,Y, --lang=xx. Anything else is refused (exit 1).

  Exit codes: 0 ok; 2 target/element not found or focus check refused; 1 error.
#>

param(
  [Parameter(Mandatory=$true)][string]$Cmd,
  [string]$A1,
  [string]$A2,
  [string]$A3
)

$ErrorActionPreference = 'Stop'

# Print to stderr and exit with an explicit code. (Write-Error under Stop would
# throw and always exit 1, hiding the documented exit 2 for refusals.)
function Fail([string]$msg, [int]$code = 1) { [Console]::Error.WriteLine($msg); exit $code }

# --- Win32 input + window primitives -----------------------------------------
if (-not ([System.Management.Automation.PSTypeName]'Native.Win32').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace Native {
  public static class Win32 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    // Milliseconds since the last keyboard/mouse input on this session (any source).
    public static uint LastInputTick() {
      LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
      GetLastInputInfo(ref li);
      return li.dwTime;
    }
    public static uint IdleMs() { return unchecked((uint)Environment.TickCount - LastInputTick()); }
    // True if the window is always-on-top AND covers its whole monitor (full-screen app/game).
    public static bool IsFullscreenTopmost(IntPtr h) {
      if ((GetWindowLong(h, -20) & 0x8) == 0) return false;          // GWL_EXSTYLE, WS_EX_TOPMOST
      RECT r; GetWindowRect(h, out r);
      MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false; // MONITOR_DEFAULTTONEAREST
      return r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top &&
             r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
    }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint flags; public uint time; public IntPtr extra; }
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP   = 0x0004;
    public const uint KEYEVENTF_UNICODE    = 0x0004;
    public const uint KEYEVENTF_KEYUP      = 0x0002;
    public const uint INPUT_MOUSE          = 0;
    public const uint INPUT_KEYBOARD       = 1;

    public static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

    // Visible, UNOWNED top-level windows of a process: real browser windows and popups
    // (e.g. an OAuth window). Owned windows (bubbles like "Restore pages?") are skipped.
    // Sorted largest-first so [0] is the main browser window.
    public static System.Collections.Generic.List<IntPtr> WindowsOf(uint pid) {
      var list = new System.Collections.Generic.List<IntPtr>();
      EnumWindows((h, l) => {
        if (IsWindowVisible(h) && PidOf(h) == pid && GetWindow(h, 4) == IntPtr.Zero) list.Add(h); // GW_OWNER
        return true;
      }, IntPtr.Zero);
      list.Sort((a, b) => Area(b).CompareTo(Area(a)));
      return list;
    }
    public static long Area(IntPtr h) { RECT r; GetWindowRect(h, out r); return (long)(r.Right - r.Left) * (r.Bottom - r.Top); }

    // Root top-level window under a screen point.
    public static IntPtr RootAt(int x, int y) {
      POINT p; p.X = x; p.Y = y;
      return GetAncestor(WindowFromPoint(p), 2); // GA_ROOT
    }

    public static void MouseButton(uint flag) {
      INPUT[] ins = new INPUT[1];
      ins[0].type = INPUT_MOUSE; ins[0].U.mi.flags = flag;
      SendInput(1, ins, Marshal.SizeOf(typeof(INPUT)));
    }
    // Type one UTF-16 code unit as a real keystroke (down+up).
    public static void TypeChar(char c) {
      INPUT[] ins = new INPUT[2];
      ins[0].type = INPUT_KEYBOARD; ins[0].U.ki.wScan = c; ins[0].U.ki.flags = KEYEVENTF_UNICODE;
      ins[1].type = INPUT_KEYBOARD; ins[1].U.ki.wScan = c; ins[1].U.ki.flags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(2, ins, Marshal.SizeOf(typeof(INPUT)));
    }
    // Press a virtual key by code (down+up).
    public static void TypeVk(ushort vk) {
      INPUT[] ins = new INPUT[2];
      ins[0].type = INPUT_KEYBOARD; ins[0].U.ki.wVk = vk;
      ins[1].type = INPUT_KEYBOARD; ins[1].U.ki.wVk = vk; ins[1].U.ki.flags = KEYEVENTF_KEYUP;
      SendInput(2, ins, Marshal.SizeOf(typeof(INPUT)));
    }
    // Ctrl+<vk> chord (e.g. Ctrl+L to focus the omnibox).
    public static void TypeCtrl(ushort vk) {
      const ushort VK_CONTROL = 0x11;
      INPUT[] ins = new INPUT[4];
      ins[0].type = INPUT_KEYBOARD; ins[0].U.ki.wVk = VK_CONTROL;
      ins[1].type = INPUT_KEYBOARD; ins[1].U.ki.wVk = vk;
      ins[2].type = INPUT_KEYBOARD; ins[2].U.ki.wVk = vk; ins[2].U.ki.flags = KEYEVENTF_KEYUP;
      ins[3].type = INPUT_KEYBOARD; ins[3].U.ki.wVk = VK_CONTROL; ins[3].U.ki.flags = KEYEVENTF_KEYUP;
      SendInput(4, ins, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
"@
}

# DPI awareness BEFORE any UIA/coordinate work, so UIA rects, SetCursorPos and
# window rects all speak the same physical-pixel space at 125%/150% scaling.
try {
  # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (Win10 1703+)
  if (-not [Native.Win32]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [Native.Win32]::SetProcessDPIAware() | Out-Null }
} catch { try { [Native.Win32]::SetProcessDPIAware() | Out-Null } catch {} }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

$AE  = [System.Windows.Automation.AutomationElement]
$TW  = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# --- Target binding -------------------------------------------------------------
$StateFile = if ($env:ND_STATE_FILE) { $env:ND_STATE_FILE } else { Join-Path $env:LOCALAPPDATA 'native-drive\target.json' }

function Normalize-Dir([string]$d) { return ([System.IO.Path]::GetFullPath($d)).TrimEnd('\').ToLower() }

function Save-Target([string]$udd) {
  $dir = Split-Path $StateFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  @{ userDataDir = ([System.IO.Path]::GetFullPath($udd)); boundAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

function Get-TargetDir {
  if ($env:ND_USER_DATA_DIR) { return $env:ND_USER_DATA_DIR }
  if (-not (Test-Path $StateFile)) { return $null }
  try { return (Get-Content $StateFile -Raw | ConvertFrom-Json).userDataDir } catch { return $null }
}

# The Chrome BROWSER process (not a renderer/GPU child) whose --user-data-dir is $udd.
function Get-BrowserPid([string]$udd) {
  $want = Normalize-Dir $udd
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $cl = $p.CommandLine
    if (-not $cl -or $cl -match '--type=') { continue }
    # Three forms: "--user-data-dir=C:\a b" (whole arg quoted), --user-data-dir="C:\a b", --user-data-dir=C:\a
    $m = [regex]::Match($cl, '"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=(\S+)')
    if (-not $m.Success) { continue }
    $d = @($m.Groups[1], $m.Groups[2], $m.Groups[3]) | Where-Object { $_.Success } | Select-Object -First 1 -ExpandProperty Value
    try { if ((Normalize-Dir $d) -eq $want) { return [uint32]$p.ProcessId } } catch {}
  }
  return $null
}

# Resolve the bound target: { dir, pid, hwnd }. hwnd = the foreground window if it
# belongs to the target browser (e.g. an OAuth popup), else its largest browser window.
function Get-Target {
  $udd = Get-TargetDir
  if (-not $udd) { Fail 'no target bound: run `launch` or `attach <userDataDir>` first' 2 }
  $bpid = Get-BrowserPid $udd
  if (-not $bpid) { Fail "no running Chrome on profile: $udd" 2 }
  $wins = [Native.Win32]::WindowsOf($bpid)
  if ($wins.Count -eq 0) { Fail "target Chrome has no visible window (pid $bpid)" 2 }
  $fg = [Native.Win32]::GetForegroundWindow()
  $h = if ($wins.Contains($fg)) { $fg } else { $wins[0] }
  return [pscustomobject]@{ dir = $udd; pid = $bpid; hwnd = $h }
}

function Get-TargetElement($t) { return $AE::FromHandle($t.hwnd) }

function Test-TargetForeground($t) {
  return ([Native.Win32]::PidOf([Native.Win32]::GetForegroundWindow()) -eq $t.pid)
}

# Bring the target window forward. Windows often refuses SetForegroundWindow from a
# background process; attaching to the current foreground thread's input queue is the
# documented way through. The RESULT is verified, never assumed.
# Session input tick recorded after this driver's own last input burst (or $null).
$OwnInputFile = Join-Path (Split-Path $StateFile -Parent) 'own-input.txt'
function Save-OwnInputTick {
  try { Set-Content -Path $OwnInputFile -Value ([Native.Win32]::LastInputTick()) -Encoding ASCII } catch {}
}
function Get-OwnInputTick {
  try { return [uint32](Get-Content $OwnInputFile -Raw).Trim() } catch { return $null }
}

# Why taking focus right now would interrupt the operator, or $null if it's fine.
function Get-FocusBlocker {
  if ($env:ND_ALLOW_FOCUS_STEAL -eq '1') { return $null }
  if ([Native.Win32]::IsFullscreenTopmost([Native.Win32]::GetForegroundWindow())) { return 'a full-screen app is in front' }
  # GetLastInputInfo also counts this driver's own SendInput. If the last input on the
  # session is the one we recorded after our own last burst, nobody else has touched it.
  $own = Get-OwnInputTick
  if ($own -ne $null -and [Native.Win32]::LastInputTick() -eq $own) { return $null }
  $idle = [Native.Win32]::IdleMs()
  $quiet = if ($env:ND_OPERATOR_IDLE_MS) { [int]$env:ND_OPERATOR_IDLE_MS } else { 30000 }
  if ($idle -lt $quiet) { return "input $([int]($idle/1000))s ago in another app" }
  return $null
}

function Focus-Target($t) {
  if (Test-TargetForeground $t) { return $true }
  # Never take focus from an operator who is using another app: it interrupts them, and
  # their own typing could land in the target (even a password field mid-sign-in).
  # ND_ALLOW_FOCUS_STEAL=1 overrides this for unattended machines.
  $why = Get-FocusBlocker
  if ($why) { Fail "refused: operator active ($why; input NOT sent)" 2 }
  if ([Native.Win32]::IsIconic($t.hwnd)) { [Native.Win32]::ShowWindow($t.hwnd, 9) | Out-Null }  # SW_RESTORE
  $fgPid = [uint32]0
  $fgThread = [Native.Win32]::GetWindowThreadProcessId([Native.Win32]::GetForegroundWindow(), [ref]$fgPid)
  $me = [Native.Win32]::GetCurrentThreadId()
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $me) { $attached = [Native.Win32]::AttachThreadInput($me, $fgThread, $true) }
  try {
    [Native.Win32]::BringWindowToTop($t.hwnd) | Out-Null
    [Native.Win32]::SetForegroundWindow($t.hwnd) | Out-Null
  } finally {
    if ($attached) { [Native.Win32]::AttachThreadInput($me, $fgThread, $false) | Out-Null }
  }
  Start-Sleep -Milliseconds 250
  return (Test-TargetForeground $t)
}

# Gate before every SendInput burst: refuse (exit 2) unless the target owns focus.
function Assert-Foreground($t) {
  if (Test-TargetForeground $t) { return }
  if (Focus-Target $t) { return }
  Fail 'refused: focus is not on the target Chrome window (input NOT sent)' 2
}

function Real-Click($t, $x, $y) {
  Assert-Foreground $t
  $root = [Native.Win32]::RootAt([int]$x, [int]$y)
  if ([Native.Win32]::PidOf($root) -ne $t.pid) { Fail "refused: point $x,$y is not on the target Chrome window" 2 }
  [Native.Win32]::SetCursorPos([int]$x, [int]$y) | Out-Null
  Start-Sleep -Milliseconds 90
  Assert-Foreground $t
  # Re-check right before button-down: a toast or dialog may have appeared over the point.
  if ([Native.Win32]::PidOf([Native.Win32]::RootAt([int]$x, [int]$y)) -ne $t.pid) { Fail "refused: point $x,$y is no longer on the target Chrome window" 2 }
  [Native.Win32]::MouseButton([Native.Win32]::MOUSEEVENTF_LEFTDOWN)
  Start-Sleep -Milliseconds 55
  [Native.Win32]::MouseButton([Native.Win32]::MOUSEEVENTF_LEFTUP)
  Save-OwnInputTick
}

# Every character is preceded by a foreground check — a mid-run focus change stops
# typing before the next character, so a secret never lands in another app.
function Type-String($t, [string]$s) {
  foreach ($ch in $s.ToCharArray()) {
    if (-not (Test-TargetForeground $t)) { Fail 'refused: focus left the target window mid-typing (stopped)' 2 }
    [Native.Win32]::TypeChar($ch)
    Start-Sleep -Milliseconds 18
  }
  Save-OwnInputTick
}

function Send-Vk($t, [int]$vk) { Assert-Foreground $t; [Native.Win32]::TypeVk([System.UInt16]$vk); Save-OwnInputTick }
function Send-Ctrl($t, [int]$vk) { Assert-Foreground $t; [Native.Win32]::TypeCtrl([System.UInt16]$vk); Save-OwnInputTick }

# Walk the a11y subtree of an element, yield elements.
function Walk-Elements($root) {
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  $n = 0
  while ($stack.Count -gt 0 -and $n -lt 6000) {
    $el = $stack.Pop(); $n++
    [void]$out.Add($el)
    try {
      $child = $TW.GetFirstChild($el)
      while ($child -ne $null) { $stack.Push($child); $child = $TW.GetNextSibling($child) }
    } catch {}
  }
  return $out
}

# The web page's Document element (page content, excluding Chrome's own UI), or $null.
function Get-DocumentElement($t) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Document)
  return (Get-TargetElement $t).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

# Search scope: the page Document by default, so `click Close` can't hit a tab or toolbar
# control. Pass scope 'browser' to search Chrome's own UI (tabs, toolbar, dialogs) too.
function Find-ByName($t, [string]$needle, [string]$scope) {
  $needleL = $needle.ToLower()
  $root = if ($scope -eq 'browser') { Get-TargetElement $t } else { Get-DocumentElement $t }
  if (-not $root) { Fail 'page document not found (use scope "browser" for Chrome UI)' 2 }
  foreach ($el in (Walk-Elements $root)) {
    try {
      $name = $el.Current.Name
      if ($name -and $name.ToLower().Contains($needleL)) {
        $r = $el.Current.BoundingRectangle
        if ($r.Width -gt 0 -and $r.Height -gt 0) { return $el }
      }
    } catch {}
  }
  return $null
}

# Page input fields, top-to-bottom. "Page" = inside the web Document element's
# rectangle, so the omnibox/toolbar is excluded on any window position or monitor.
function Get-PageEdits($t) {
  # Walk only the page's Document subtree (same notion of "the page" as Find-ByName), so the
  # omnibox, side panel and any other Chrome UI can never get an index.
  $doc = Get-DocumentElement $t
  if (-not $doc) { Fail 'page document not found' 2 }
  $edits = @()
  foreach ($el in (Walk-Elements $doc)) {
    try {
      if ($el.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit') { continue }
      $r = $el.Current.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { continue }
      $edits += [pscustomobject]@{ el = $el; y = $r.Y; x = $r.X; name = $el.Current.Name }
    } catch {}
  }
  return @($edits | Sort-Object y, x)
}

switch ($Cmd) {

  'launch' {
    $udd = $A1; $url = $A2; $exe = $A3
    if (-not $udd) { Fail 'usage: launch <userDataDir> <url> [chromeExe]' 1 }
    if (-not $exe) {
      $cands = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
      )
      $exe = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if (-not $exe) { Fail 'chrome.exe not found' 1 }
    # Chrome hands a second launch on the same profile to the running process, which would
    # silently ignore --force-renderer-accessibility and ND_CHROME_FLAGS.
    if (Get-BrowserPid $udd) { Fail "Chrome is already running on this profile; use: attach $udd (then nav <url>)" 2 }
    # Clean launch: NO --remote-debugging-port. --force-renderer-accessibility makes
    # Chrome publish its a11y tree to UIA (this is NOT an automation signal pages can see).
    # ND_CHROME_FLAGS adds flags, e.g. "--disable-extensions" for a scripted login where a
    # password-manager extension would otherwise race the form-fill.
    # PS 5.1 joins ArgumentList with spaces and does not quote, so quote paths ourselves.
    $chromeArgs = @(
      "--user-data-dir=`"$udd`"",
      '--force-renderer-accessibility',
      '--no-first-run',
      '--no-default-browser-check'
    )
    if ($env:ND_CHROME_FLAGS) {
      $extra = @($env:ND_CHROME_FLAGS -split '\s+' | Where-Object { $_ })
      # Allowlist, not a denylist: Chromium also accepts -flag and /flag forms, so blocking
      # known-bad names can be bypassed. Only these harmless flags may be added.
      $ok = '^--(disable-extensions|start-maximized|new-window|window-size=\d+,\d+|window-position=-?\d+,-?\d+|lang=[A-Za-z-]+)$'
      $bad = $extra | Where-Object { $_ -cnotmatch $ok }
      if ($bad) { Fail "refused: ND_CHROME_FLAGS may only contain allowlisted flags; not allowed: $($bad -join ' ')" 1 }
      $chromeArgs += $extra
    }
    if ($url) { $chromeArgs += "`"$url`"" }
    Start-Process -FilePath $exe -ArgumentList $chromeArgs | Out-Null
    Save-Target $udd
    $bpid = $null
    for ($i = 0; $i -lt 40 -and -not $bpid; $i++) { Start-Sleep -Milliseconds 250; $bpid = Get-BrowserPid $udd }
    if (-not $bpid) { Fail "launched but no browser process found on profile $udd" 2 }
    Write-Output "launched: $exe pid=$bpid profile=$udd"
    exit 0
  }

  'attach' {
    if (-not $A1) { Fail 'usage: attach <userDataDir>' 1 }
    $bpid = Get-BrowserPid $A1
    if (-not $bpid) { Fail "no running Chrome on profile: $A1" 2 }
    Save-Target $A1
    Write-Output "attached: pid=$bpid profile=$A1"
    exit 0
  }

  'target' {
    $t = Get-Target
    Write-Output "profile=$($t.dir) pid=$($t.pid) hwnd=$($t.hwnd) foreground=$(Test-TargetForeground $t)"
    exit 0
  }

  'canfocus' {
    # Read-only: would input be allowed right now? Never moves focus.
    $t = Get-Target
    if (Test-TargetForeground $t) { Write-Output 'yes: target already has focus'; exit 0 }
    $why = Get-FocusBlocker
    if ($why) { Write-Output "no: operator active ($why)"; exit 2 }
    Write-Output 'yes: operator idle, focus may be taken'; exit 0
  }

  'focus' {
    $t = Get-Target
    if (Focus-Target $t) { Write-Output 'focused' } else { Fail 'could not bring the target window to the foreground' 2 }
    exit 0
  }

  'nav' {
    $t = Get-Target
    Send-Ctrl $t 0x4C                    # Ctrl+L -> focus omnibox
    Start-Sleep -Milliseconds 350
    Type-String $t $A1
    Start-Sleep -Milliseconds 250
    Send-Vk $t 0x0D                      # Enter
    Write-Output "nav: $A1"
    exit 0
  }

  'url' {
    $t = Get-Target
    $edit = $null
    foreach ($el in (Walk-Elements (Get-TargetElement $t))) {
      try {
        if ($el.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and
            $el.Current.Name -match 'Address|search bar') { $edit = $el; break }
      } catch {}
    }
    if (-not $edit) { Fail 'omnibox not found' 2 }
    $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    Write-Output $vp.Current.Value
    exit 0
  }

  'tree' {
    $t = Get-Target
    $items = New-Object System.Collections.ArrayList
    foreach ($el in (Walk-Elements (Get-TargetElement $t))) {
      try {
        $c = $el.Current
        if ($c.Name -or $c.ControlType) {
          $r = $c.BoundingRectangle
          [void]$items.Add([ordered]@{
            name = $c.Name
            type = $c.ControlType.ProgrammaticName
            x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
          })
        }
      } catch {}
    }
    ($items | ConvertTo-Json -Depth 4) | Set-Content -Path $A1 -Encoding UTF8
    Write-Output ("tree: " + $items.Count + " elements")
    exit 0
  }

  'text' {
    $t = Get-Target
    $texts = New-Object System.Collections.ArrayList
    foreach ($el in (Walk-Elements (Get-TargetElement $t))) {
      try {
        $c = $el.Current
        $s = $c.Name
        if ($s -and $s.Trim().Length -gt 0) {
          $tn = $c.ControlType.ProgrammaticName
          if ($tn -eq 'ControlType.Text' -or $tn -eq 'ControlType.Button' -or
              $tn -eq 'ControlType.Hyperlink' -or $tn -eq 'ControlType.Edit') {
            [void]$texts.Add($s.Trim())
          }
        }
      } catch {}
    }
    ($texts | ConvertTo-Json -Depth 2) | Set-Content -Path $A1 -Encoding UTF8
    Write-Output ("text: " + $texts.Count + " strings")
    exit 0
  }

  'find' {
    $t = Get-Target
    $el = Find-ByName $t $A1 $A2
    if (-not $el) { Fail "not found: $A1" 2 }
    $r = $el.Current.BoundingRectangle
    $cx = [int]($r.X + $r.Width/2); $cy = [int]($r.Y + $r.Height/2)
    Write-Output ("name=" + $el.Current.Name)
    Write-Output ("center=$cx,$cy rect=$([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height)")
    exit 0
  }

  'click' {
    $t = Get-Target
    $el = Find-ByName $t $A1 $A2
    if (-not $el) { Fail "not found: $A1" 2 }
    Assert-Foreground $t
    $r = $el.Current.BoundingRectangle      # re-read after focusing (window may have moved)
    $cx = [int]($r.X + $r.Width/2); $cy = [int]($r.Y + $r.Height/2)
    Real-Click $t $cx $cy
    Write-Output "clicked '$($el.Current.Name)' at $cx,$cy"
    exit 0
  }

  'invoke' {
    $t = Get-Target
    $el = Find-ByName $t $A1 $A2
    if (-not $el) { Fail "not found: $A1" 2 }
    try {
      $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $ip.Invoke()
      Write-Output "invoked '$($el.Current.Name)'"
      exit 0
    } catch { Fail "no invoke pattern: $_" 2 }
  }

  'clickxy' {
    $t = Get-Target
    Real-Click $t ([int]$A1) ([int]$A2)
    Write-Output "clicked $A1,$A2"
    exit 0
  }

  'type' {
    $t = Get-Target
    Assert-Foreground $t
    Type-String $t $A1
    Write-Output ("typed " + $A1.Length + " chars")
    exit 0
  }

  'typesecret' {
    $secret = [Console]::In.ReadLine()
    if ($null -eq $secret) { Fail 'no stdin' 1 }
    $t = Get-Target
    Assert-Foreground $t
    Type-String $t $secret
    Write-Output 'typed secret'
    exit 0
  }

  'editfields' {
    # Index is what `typeedit` / `typesecretedit` target — deterministic, no coordinates.
    $t = Get-Target
    $edits = Get-PageEdits $t
    for ($i = 0; $i -lt $edits.Count; $i++) {
      Write-Output ("[$i] y=$([int]$edits[$i].y) name='" + $edits[$i].name + "'")
    }
    exit 0
  }

  { $_ -eq 'typeedit' -or $_ -eq 'typesecretedit' } {
    # Focus the Nth page input via UIA SetFocus (deterministic), clear it, type.
    $idx = [int]$A1
    $val = if ($Cmd -eq 'typeedit') { $A2 } else { [Console]::In.ReadLine() }
    if ($null -eq $val) { Fail 'no value' 1 }
    $t = Get-Target
    $edits = Get-PageEdits $t
    if ($idx -ge $edits.Count) { Fail "only $($edits.Count) fields" 2 }
    Assert-Foreground $t
    try { $edits[$idx].el.SetFocus() } catch { Fail "setfocus failed: $_" 2 }
    Start-Sleep -Milliseconds 250
    Send-Ctrl $t 0x41                    # Ctrl+A
    Start-Sleep -Milliseconds 100
    Send-Vk $t 0x2E                      # Delete
    Start-Sleep -Milliseconds 120
    Type-String $t $val
    if ($Cmd -eq 'typeedit') { Write-Output ("typed into field $idx len=" + $val.Length) } else { Write-Output "typed secret into field $idx" }
    exit 0
  }

  'key' {
    $map = @{ 'Enter'=0x0D; 'Tab'=0x09; 'Esc'=0x1B; 'Escape'=0x1B; 'Down'=0x28; 'Up'=0x26;
              'Left'=0x25; 'Right'=0x27; 'Space'=0x20; 'Back'=0x08; 'Del'=0x2E; 'Delete'=0x2E;
              'Home'=0x24; 'End'=0x23 }
    if (-not $map.ContainsKey($A1)) { Fail "unknown key: $A1" 1 }
    $t = Get-Target
    Send-Vk $t $map[$A1]
    Write-Output "key $A1"
    exit 0
  }

  'ctrl' {
    # Ctrl+<single char>, e.g. ctrl a (select-all), ctrl l (omnibox)
    $t = Get-Target
    Send-Ctrl $t ([int][char]([string]$A1).ToUpper()[0])
    Write-Output "ctrl+$A1"
    exit 0
  }

  'clearfield' {
    # Click a point, then select-all + delete to empty the field it focuses.
    $t = Get-Target
    Real-Click $t ([int]$A1) ([int]$A2)
    Start-Sleep -Milliseconds 200
    Send-Ctrl $t 0x41                    # Ctrl+A
    Start-Sleep -Milliseconds 120
    Send-Vk $t 0x2E                      # Delete
    Write-Output "cleared $A1,$A2"
    exit 0
  }

  'shot' {
    # The target window only. PrintWindow renders the window itself, so other windows
    # (even ones overlapping it) are never captured.
    $t = Get-Target
    $r = New-Object Native.Win32+RECT
    [Native.Win32]::GetWindowRect($t.hwnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { Fail 'target window has no area (minimized?)' 2 }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Native.Win32]::PrintWindow($t.hwnd, $hdc, 2)   # PW_RENDERFULLCONTENT
    $g.ReleaseHdc($hdc)
    if ($ok) { $bmp.Save($A1, [System.Drawing.Imaging.ImageFormat]::Png) }
    $g.Dispose(); $bmp.Dispose()
    if (-not $ok) { Fail 'PrintWindow failed' 1 }
    Write-Output "shot: $A1 (${w}x${h}, target window only)"
    exit 0
  }

  default { Fail "unknown cmd: $Cmd" 1 }
}
