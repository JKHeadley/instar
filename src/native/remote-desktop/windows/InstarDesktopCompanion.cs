// Runs only in the logged-in Windows user's interactive session. WSL is the
// policy authority; this companion has no public desktop protocol. Every
// request is HMAC authenticated, replay bounded, and scoped to a short local
// control lease. The visible banner and held input stop on lease loss.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace InstarDesktop {
  internal static class Program {
    const int MaxRequest = 4096;
    const int MaxFrame = 1250000;
    static readonly object Gate = new object();
    static readonly Dictionary<string, long> Nonces = new Dictionary<string, long>();
    static readonly HashSet<string> HeldKeys = new HashSet<string>();
    static readonly HashSet<string> HeldButtons = new HashSet<string>();
    static readonly Dictionary<string, long> CancelledLeases = new Dictionary<string, long>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static byte[] Secret;
    static volatile bool Active;
    static bool Updating;
    static string UpdateToken;
    static long UpdatePreparedAt;
    static string LeaseId;
    static volatile bool BannerShown;
    static long LastHeartbeat;
    static Form Banner;
    static Point? BannerPlace;
    static Thread BannerThread;
    // Live H.264 for the current lease (null until the viewer asks for video).
    static VideoStream Video;

    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)]
    static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DISPLAY_DEVICE {
      public int cb;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
      public int StateFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE info, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
      [FieldOffset(0)] public KEYBDINPUT keyboard;
      [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
      public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
      public ushort vk, scan; public uint flags, time; public UIntPtr extra;
    }

    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static bool InteractiveDesktop() {
      if (!SystemInformation.UserInteractive || Process.GetCurrentProcess().SessionId != (int)WTSGetActiveConsoleSessionId()) return false;
      IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
      if (desktop == IntPtr.Zero) return false;
      try {
        int needed;
        StringBuilder name = new StringBuilder(80);
        return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)
          && String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase)
          && !ScreenLocked();
      } finally { CloseDesktop(desktop); }
    }
    // A locked PC keeps its lock picture on the Default desktop, so the desktop
    // name alone reads it as usable. The first click then lifts that picture,
    // Windows switches to the secure sign-in desktop that no program in the
    // user's session can see or type into, and the session went blank and
    // ended. Locked needs BOTH Windows' own session flag and the sign-in screen
    // process in this session, so a misread flag can never block an unlocked PC.
    static readonly object LockGate = new object();
    static long LockReadAt; // 0 = never read (Now() is milliseconds since 1970)
    static bool LockCached;
    static bool ScreenLocked() {
      lock (LockGate) {
        long now = Now();
        if (now - LockReadAt < 500) return LockCached;
        LockCached = SessionFlagLocked() && SignInScreenShown();
        LockReadAt = now;
        return LockCached;
      }
    }
    static int OwnSessionId = -1;
    static int OwnSession() {
      if (OwnSessionId < 0) { using (Process self = Process.GetCurrentProcess()) OwnSessionId = self.SessionId; }
      return OwnSessionId;
    }
    static bool SessionFlagLocked() {
      IntPtr buffer; int bytes;
      int session = OwnSession();
      // WTSSessionInfoEx (25): WTSINFOEXW, level 1. SessionFlags follows
      // Level (padded to 8), SessionId and SessionState: 0 = locked, 1 = unlocked.
      if (!WTSQuerySessionInformationW(IntPtr.Zero, session, 25, out buffer, out bytes)) return false;
      try {
        if (bytes < 20 || Marshal.ReadInt32(buffer) != 1 || Marshal.ReadInt32(buffer, 8) != session) return false;
        return Marshal.ReadInt32(buffer, 16) == 0;
      } finally { WTSFreeMemory(buffer); }
    }
    static bool SignInScreenShown() {
      int session = OwnSession();
      Process[] found = Process.GetProcessesByName("LogonUI");
      try {
        foreach (Process process in found) { if (process.SessionId == session) return true; }
        return false;
      } finally { foreach (Process process in found) process.Dispose(); }
    }
    static Dictionary<string, object> Parse(string json) {
      object value = Json.DeserializeObject(json);
      Dictionary<string, object> map = value as Dictionary<string, object>;
      if (map == null) throw new InvalidDataException();
      return map;
    }
    static string Text(Dictionary<string, object> map, string key) {
      object value;
      if (!map.TryGetValue(key, out value) || !(value is string)) throw new InvalidDataException();
      return (string)value;
    }
    static double Number(Dictionary<string, object> map, string key) {
      object value;
      if (!map.TryGetValue(key, out value)) throw new InvalidDataException();
      double n = Convert.ToDouble(value);
      if (Double.IsNaN(n) || Double.IsInfinity(n)) throw new InvalidDataException();
      return n;
    }
    static string Hex(byte[] bytes) {
      StringBuilder result = new StringBuilder(bytes.Length * 2);
      foreach (byte b in bytes) result.Append(b.ToString("x2"));
      return result.ToString();
    }
    static string Base64Url(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_'); }
    static bool Same(byte[] a, byte[] b) {
      if (a.Length != b.Length) return false;
      int diff = 0; for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
      return diff == 0;
    }
    static byte[] DecodeUrl(string value) {
      string v = value.Replace('-','+').Replace('_','/');
      while (v.Length % 4 != 0) v += "=";
      return Convert.FromBase64String(v);
    }
    static bool Authenticate(string op, byte[] body, Dictionary<string,string> headers) {
      string time, nonce, mac;
      if (!headers.TryGetValue("x-instar-desktop-time", out time)
        || !headers.TryGetValue("x-instar-desktop-nonce", out nonce)
        || !headers.TryGetValue("x-instar-desktop-mac", out mac)) return false;
      long stamp;
      if (!Int64.TryParse(time, out stamp) || Math.Abs(Now() - stamp) > 5000
        || nonce.Length < 30 || nonce.Length > 64 || mac.Length < 40 || mac.Length > 64) return false;
      string digest;
      using (SHA256 sha = SHA256.Create()) digest = Hex(sha.ComputeHash(body));
      byte[] expected;
      using (HMACSHA256 hmac = new HMACSHA256(Secret))
        expected = hmac.ComputeHash(Encoding.UTF8.GetBytes("instar-windows-desktop-v1\n" + op + "\n" + time + "\n" + nonce + "\n" + digest));
      byte[] received;
      try { received = DecodeUrl(mac); } catch { return false; }
      if (!Same(expected, received)) return false;
      lock (Gate) {
        List<string> expired = new List<string>();
        foreach (KeyValuePair<string,long> row in Nonces) if (row.Value < Now() - 10000) expired.Add(row.Key);
        foreach (string key in expired) Nonces.Remove(key);
        if (Nonces.ContainsKey(nonce) || Nonces.Count >= 1000) return false;
        Nonces[nonce] = Now();
      }
      return true;
    }
    static byte[] Reply(object value) { return Encoding.UTF8.GetBytes(Json.Serialize(value)); }
    static bool ValidLease(string value) {
      if (value.Length < 32 || value.Length > 64) return false;
      foreach (char c in value) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
        || (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
      return true;
    }
    static void PruneCancelled() {
      List<string> expired = new List<string>();
      foreach (KeyValuePair<string,long> row in CancelledLeases) if (row.Value < Now()) expired.Add(row.Key);
      foreach (string key in expired) CancelledLeases.Remove(key);
    }
    static void CancelLease(string lease) {
      PruneCancelled();
      CancelledLeases[lease] = Now() + 60000;
    }
    static void ExpireUpdate() {
      if (Updating && Now() - UpdatePreparedAt > 30000) {
        Updating = false; UpdateToken = null; UpdatePreparedAt = 0;
      }
    }
    static bool OwnsLease(string lease) { return Active && LeaseId == lease; }
    static bool MayStartLease(string lease) {
      PruneCancelled();
      return !Updating && !Active && !CancelledLeases.ContainsKey(lease);
    }
    static void StopLease(string lease) {
      if (OwnsLease(lease)) StopLocked();
      else CancelLease(lease); // A Stop racing ahead of Start fences that future Start.
    }
    static bool BannerExitOwnsLease(string ownerLease) { return OwnsLease(ownerLease); }
    static void Write(NetworkStream stream, int status, string type, byte[] body) {
      string reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : "Bad Request";
      byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type
        + "\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
      stream.Write(header, 0, header.Length); stream.Write(body, 0, body.Length);
    }
    static void Handle(TcpClient client) {
      client.ReceiveTimeout = 2500; client.SendTimeout = 2500;
      bool handedOff = false; // a video request finishes on its own thread
      NetworkStream stream = client.GetStream();
      try {
        List<byte> header = new List<byte>(); int matched = 0;
        while (header.Count < 8192 && matched < 4) {
          int b = stream.ReadByte(); if (b < 0) return;
          header.Add((byte)b);
          matched = b == "\r\n\r\n"[matched] ? matched + 1 : b == '\r' ? 1 : 0;
        }
        if (matched != 4) return;
        string[] lines = Encoding.ASCII.GetString(header.ToArray()).Split(new string[] {"\r\n"}, StringSplitOptions.None);
        string[] first = lines[0].Split(' ');
        if (first.Length != 3 || first[0] != "POST" || !first[1].StartsWith("/") || first[2] != "HTTP/1.1") return;
        string op = first[1].Substring(1);
        if (op != "probe" && op != "displays" && op != "capture" && op != "capture-h264" && op != "cursor" && op != "input"
          && op != "start" && op != "heartbeat" && op != "stop" && op != "release"
          && op != "prepare-update" && op != "cancel-update" && op != "commit-update") return;
        Dictionary<string,string> headers = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length && lines[i].Length > 0; i++) {
          int sep = lines[i].IndexOf(':'); if (sep <= 0) return;
          string key = lines[i].Substring(0, sep).Trim().ToLowerInvariant();
          if (headers.ContainsKey(key)) return;
          headers[key] = lines[i].Substring(sep + 1).Trim();
        }
        string lengthText; int length;
        if (!headers.TryGetValue("content-length", out lengthText) || !Int32.TryParse(lengthText, out length)
          || length < 0 || length > MaxRequest || headers.ContainsKey("transfer-encoding")) return;
        byte[] body = new byte[length]; int offset = 0;
        while (offset < length) { int count = stream.Read(body, offset, length - offset); if (count <= 0) return; offset += count; }
        if (!Authenticate(op, body, headers)) { Write(stream, 403, "application/json", Reply(new { error = "forbidden" })); return; }
        try {
          Dictionary<string,object> command = Parse(Encoding.UTF8.GetString(body));
          bool updateOperation = op == "prepare-update" || op == "cancel-update" || op == "commit-update";
          bool leaseless = op == "probe" || op == "displays" || updateOperation;
          string lease = leaseless ? "" : Text(command, "leaseId");
          if (!leaseless && !ValidLease(lease)) throw new InvalidDataException();
          object result; string type = "application/json";
          bool exitAfterWrite = false;
          if (op == "capture-h264") {
            // Validated under the gate; the short wait for a picture runs on a
            // worker thread, so the next request is served meanwhile.
            bool keyframe = command.ContainsKey("keyframe") && command["keyframe"] is bool && (bool)command["keyframe"];
            VideoStream video;
            lock (Gate) {
              if (Active && (Now() - LastHeartbeat > 5000 || !InteractiveDesktop())) StopLocked();
              if (!OwnsLease(lease) || !InteractiveDesktop()) throw new InvalidOperationException();
              video = VideoFor(lease, ShownArea(command));
            }
            handedOff = true;
            ThreadPool.QueueUserWorkItem(delegate { ServeVideo(client, stream, video, keyframe); });
            return;
          }
          lock (Gate) {
            ExpireUpdate();
            if (Active && (Now() - LastHeartbeat > 5000 || !InteractiveDesktop())) StopLocked();
            if (op == "probe") {
              bool ready = !Updating && InteractiveDesktop() && Screen.AllScreens.Length > 0;
              result = Reply(new { screenPermission = ready, inputPermission = ready,
                sessionActive = ready, displayCount = ready ? Screen.AllScreens.Length : 0,
                controlActive = Active, updatePrepared = Updating, screenLocked = ScreenLocked() });
            } else if (op == "displays") {
              result = Reply(new { displays = !Updating && InteractiveDesktop() ? DisplayRows() : new object[0] });
            } else if (op == "prepare-update") {
              if (Active || Updating) throw new InvalidOperationException();
              Updating = true;
              UpdatePreparedAt = Now();
              ReleaseHeld();
              byte[] updateBytes = new byte[24];
              using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(updateBytes);
              UpdateToken = Base64Url(updateBytes);
              result = Reply(new { ok = true, updateToken = UpdateToken });
            } else if (op == "cancel-update") {
              if (!Updating || Text(command, "updateToken") != UpdateToken) throw new InvalidOperationException();
              Updating = false; UpdateToken = null; UpdatePreparedAt = 0;
              result = Reply(new { ok = true });
            } else if (op == "commit-update") {
              if (!Updating || Active || Text(command, "updateToken") != UpdateToken) throw new InvalidOperationException();
              result = Reply(new { ok = true });
              exitAfterWrite = true;
            } else if (op == "start") {
              if (!InteractiveDesktop()) throw new InvalidOperationException();
              if (!MayStartLease(lease)) throw new InvalidOperationException();
              StartBanner(lease); LeaseId = lease; Active = true; LastHeartbeat = Now(); result = Reply(new { ok = true });
            } else if (op == "heartbeat") {
              if (!OwnsLease(lease) || !InteractiveDesktop()) throw new InvalidOperationException();
              LastHeartbeat = Now(); result = Reply(new { ok = true });
            } else if (op == "stop") {
              StopLease(lease);
              result = Reply(new { ok = true });
            } else if (op == "release") {
              if (!OwnsLease(lease)) throw new InvalidOperationException();
              ReleaseHeld(); result = Reply(new { ok = true });
            } else {
              if (!OwnsLease(lease) || !InteractiveDesktop()) throw new InvalidOperationException();
              Rectangle shown = ShownArea(command);
              if (op == "capture") { result = Capture(shown); type = "image/jpeg"; }
              else if (op == "cursor") {
                Point point; if (!GetCursorPos(out point)) throw new InvalidOperationException();
                Rectangle screen = shown;
                result = Reply(new { x = Math.Max(0, Math.Min(1, (double)(point.X - screen.Left) / Math.Max(1, screen.Width - 1))),
                  y = Math.Max(0, Math.Min(1, (double)(point.Y - screen.Top) / Math.Max(1, screen.Height - 1))) });
              } else {
                object actionValue; if (!command.TryGetValue("action", out actionValue)) throw new InvalidDataException();
                Dictionary<string,object> action = actionValue as Dictionary<string,object>;
                if (action == null) throw new InvalidDataException();
                Input(action, shown); result = Reply(new { ok = true });
              }
            }
          }
          Write(stream, 200, type, (byte[])result);
          if (exitAfterWrite) Environment.Exit(0);
        } catch { Write(stream, 400, "application/json", Reply(new { error = "desktop-unavailable" })); }
      } finally {
        if (!handedOff) { stream.Dispose(); client.Close(); }
      }
    }
    /// <summary>Waits briefly for the next access unit and answers, off the accept
    /// loop, so clicks, keys, heartbeats and Stop never queue behind video. An
    /// empty 200 means no new picture yet; the caller simply asks again.</summary>
    static void ServeVideo(TcpClient client, NetworkStream stream, VideoStream video, bool keyframe) {
      try {
        byte[] unit = video.Take(keyframe, keyframe ? 300 : 50);
        Write(stream, 200, "video/h264", unit ?? new byte[0]);
      } catch {
        try { Write(stream, 400, "application/json", Reply(new { error = "desktop-unavailable" })); } catch { /* the caller has gone */ }
      } finally { stream.Dispose(); client.Close(); }
    }
    // A stable short id: "\\\\.\\DISPLAY1" is not safe to carry as viewer text.
    static string DisplayId(Screen screen) { return screen.DeviceName.TrimStart('\\', '.'); }
    static string DisplayName(Screen screen, int index) {
      DISPLAY_DEVICE device = new DISPLAY_DEVICE();
      device.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      string monitor = EnumDisplayDevices(screen.DeviceName, 0, ref device, 0) ? device.DeviceString : null;
      if (String.IsNullOrEmpty(monitor) || monitor.IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0) {
        return "Display " + (index + 1);
      }
      return monitor;
    }
    static object[] DisplayRows() {
      Screen[] screens = Screen.AllScreens;
      object[] rows = new object[Math.Min(screens.Length, 16)];
      for (int i = 0; i < rows.Length; i++) {
        rows[i] = new { id = DisplayId(screens[i]), name = DisplayName(screens[i], i),
          width = screens[i].Bounds.Width, height = screens[i].Bounds.Height, main = screens[i].Primary };
      }
      return rows;
    }
    // Without a displayId this is the whole virtual screen, as it always was.
    static Rectangle ShownArea(Dictionary<string,object> command) {
      if (!command.ContainsKey("displayId")) return SystemInformation.VirtualScreen;
      string id = Text(command, "displayId");
      foreach (Screen screen in Screen.AllScreens) if (DisplayId(screen) == id) return screen.Bounds;
      throw new InvalidOperationException();
    }
    static byte[] Capture(Rectangle bounds) {
      if (bounds.Width < 1 || bounds.Height < 1 || bounds.Width > 16000 || bounds.Height > 16000
        || (long)bounds.Width * bounds.Height > 33177600) throw new InvalidOperationException();
      using (Bitmap full = new Bitmap(bounds.Width, bounds.Height)) {
        using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size);
        double scale = Math.Min(1, Math.Min(2560.0 / bounds.Width, 1440.0 / bounds.Height));
        int width = Math.Max(1, (int)(bounds.Width * scale)), height = Math.Max(1, (int)(bounds.Height * scale));
        // A screen that already fits is encoded as captured: redrawing it at
        // the same size cost a full-screen bicubic pass on every picture.
        if (width == bounds.Width && height == bounds.Height) return EncodeJpeg(full);
        using (Bitmap image = new Bitmap(width, height)) {
          using (Graphics g = Graphics.FromImage(image)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.DrawImage(full, 0, 0, width, height);
          }
          return EncodeJpeg(image);
        }
      }
    }
    static readonly ImageCodecInfo JpegCodec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
    static byte[] EncodeJpeg(Bitmap image) {
      foreach (long quality in new long[] { 82, 70, 55 }) {
        using (MemoryStream output = new MemoryStream()) using (EncoderParameters options = new EncoderParameters(1)) {
          options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
          image.Save(output, JpegCodec, options);
          if (output.Length <= MaxFrame) return output.ToArray();
        }
      }
      throw new InvalidOperationException();
    }
    static int Coordinate(double fraction, int start, int size) {
      if (fraction < 0 || fraction > 1) throw new InvalidDataException();
      return start + Math.Min(size - 1, Math.Max(0, (int)Math.Round(fraction * (size - 1))));
    }
    static byte Key(string key) {
      switch (key) {
        case "Meta": return 0x5B; case "Control": return 0x11; case "Alt": return 0x12; case "Shift": return 0x10;
        case "Enter": return 0x0D; case "Tab": return 0x09; case "Escape": return 0x1B;
        case "Backspace": return 0x08; case "Delete": return 0x2E; case "Space": return 0x20;
        case "ArrowLeft": return 0x25; case "ArrowUp": return 0x26; case "ArrowRight": return 0x27; case "ArrowDown": return 0x28;
        case "Home": return 0x24; case "End": return 0x23; case "PageUp": return 0x21; case "PageDown": return 0x22;
        case "Insert": return 0x2D;
      }
      if (key.Length == 1 && key[0] >= 'a' && key[0] <= 'z') return (byte)(0x41 + (key[0] - 'a'));
      if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') return (byte)(0x30 + (key[0] - '0'));
      int f;
      if (key.Length >= 2 && key.Length <= 3 && key[0] == 'F' && Int32.TryParse(key.Substring(1), out f) && f >= 1 && f <= 12)
        return (byte)(0x6F + f);
      throw new InvalidDataException();
    }
    // Navigation keys share scan codes with the number pad; without the
    // extended flag Windows can read them as keypad keys.
    static uint KeyFlags(string key) {
      switch (key) {
        case "Delete": case "Insert": case "Home": case "End": case "PageUp": case "PageDown":
        case "ArrowLeft": case "ArrowUp": case "ArrowRight": case "ArrowDown": case "Meta": return 0x0001u;
        default: return 0u;
      }
    }
    // Mouse input goes through SendInput, the same queue a physical mouse uses,
    // so the move reaches the window under the cursor before the press. Chrome
    // and WinUI apps ignored a press injected straight after SetCursorPos.
    static void SendMouse(uint flags, int dx, int dy, uint data) {
      INPUT input = new INPUT(); input.type = 0;
      input.data.mouse.dx = dx; input.data.mouse.dy = dy;
      input.data.mouse.mouseData = data; input.data.mouse.flags = flags;
      if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException();
    }
    static void MoveTo(double fx, double fy, Rectangle shown) {
      // The absolute scale is always the whole virtual desktop, whichever screen is shown.
      Rectangle bounds = SystemInformation.VirtualScreen;
      int x = Coordinate(fx, shown.Left, shown.Width), y = Coordinate(fy, shown.Top, shown.Height);
      int ax = (int)Math.Round((x - bounds.Left) * 65535.0 / Math.Max(1, bounds.Width - 1));
      int ay = (int)Math.Round((y - bounds.Top) * 65535.0 / Math.Max(1, bounds.Height - 1));
      SendMouse(0x0001u | 0x4000u | 0x8000u, ax, ay, 0);
    }
    static void Mouse(string button, bool down) {
      uint flag;
      if (button == "left") flag = down ? 0x0002u : 0x0004u;
      else if (button == "right") flag = down ? 0x0008u : 0x0010u;
      else if (button == "middle") flag = down ? 0x0020u : 0x0040u;
      else throw new InvalidDataException();
      SendMouse(flag, 0, 0, 0);
      if (down) HeldButtons.Add(button); else HeldButtons.Remove(button);
    }
    static void Input(Dictionary<string,object> action, Rectangle shown) {
      string kind = Text(action, "kind");
      if (kind == "move" || kind == "click" || kind == "buttonDown" || kind == "buttonUp") {
        string button = kind == "move" ? null : Text(action,"button");
        if (button != null && button != "left" && button != "right" && button != "middle") throw new InvalidDataException();
        int count = 1;
        if (kind == "click" && action.ContainsKey("count")) {
          double c = Number(action,"count");
          if (c != 1 && c != 2 && c != 3) throw new InvalidDataException();
          count = (int)c;
        }
        MoveTo(Number(action,"x"), Number(action,"y"), shown);
        if (kind == "click") {
          // Repeated press/release at one point inside the double-click time is
          // what Windows itself turns into a double or triple click.
          for (int i = 0; i < count; i++) {
            Thread.Sleep(i == 0 ? 15 : 40); Mouse(button,true); Thread.Sleep(30); Mouse(button,false);
          }
        }
        else if (kind != "move") { Thread.Sleep(15); Mouse(button,kind == "buttonDown"); }
      } else if (kind == "scroll") {
        double dx = Number(action,"dx"), dy = Number(action,"dy");
        if (Math.Abs(dx) > 1000 || Math.Abs(dy) > 1000) throw new InvalidDataException();
        if (dy != 0) SendMouse(0x0800u, 0, 0, unchecked((uint)(int)Math.Round(-dy * 1.2)));
        if (dx != 0) SendMouse(0x01000u, 0, 0, unchecked((uint)(int)Math.Round(dx * 1.2)));
      } else if (kind == "keyDown" || kind == "keyUp") {
        string key = Text(action,"key"); byte vk = Key(key);
        keybd_event(vk, 0, (kind == "keyUp" ? 0x0002u : 0u) | KeyFlags(key), UIntPtr.Zero);
        if (kind == "keyDown") HeldKeys.Add(key); else HeldKeys.Remove(key);
      } else if (kind == "type") {
        string text = Text(action,"text");
        if (text.Length < 1 || text.Length > 1024 || text.IndexOf('\0') >= 0) throw new InvalidDataException();
        foreach (char ch in text) {
          INPUT down = new INPUT(); down.type = 1; down.data.keyboard.scan = ch; down.data.keyboard.flags = 0x0004;
          INPUT up = down; up.data.keyboard.flags = 0x0004 | 0x0002;
          if (SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException();
        }
      } else throw new InvalidDataException();
    }
    static void ReleaseHeld() {
      foreach (string button in new List<string>(HeldButtons)) Mouse(button,false);
      foreach (string key in new List<string>(HeldKeys)) {
        keybd_event(Key(key), 0, 0x0002u | KeyFlags(key), UIntPtr.Zero); HeldKeys.Remove(key);
      }
    }
    static Point BannerStart(Rectangle area, Size size) {
      if (BannerPlace.HasValue) return KeepOnScreen(BannerPlace.Value, size);
      return new Point(area.Right - size.Width, area.Bottom - size.Height);
    }
    // A screen unplugged since the last move must not hide the signal.
    static Point KeepOnScreen(Point at, Size size) {
      Rectangle area = Screen.GetWorkingArea(at);
      return new Point(Math.Max(area.Left, Math.Min(area.Right - size.Width, at.X)),
        Math.Max(area.Top, Math.Min(area.Bottom - size.Height, at.Y)));
    }
    static void StartBanner(string ownerLease) {
      ManualResetEvent ready = new ManualResetEvent(false);
      BannerShown = false;
      BannerThread = new Thread(() => {
        try {
          // While someone is connected, keep the display composing and the machine
          // awake. With the display powered off, Windows keeps returning its last
          // picture, so the viewer looked frozen and input appeared to do nothing.
          // The request belongs to this thread and ends when the banner closes.
          SetThreadExecutionState(0x80000000u | 0x00000002u | 0x00000001u);
          // The safety signal stays on top and on screen, but it must not sit on
          // window buttons: a small strip at the bottom right that either the
          // person at this machine or the viewer can drag somewhere else.
          Form form = new Form(); form.Text = "Instar remote control active";
          form.FormBorderStyle = FormBorderStyle.None;
          form.ControlBox = false; form.ShowInTaskbar = false; form.TopMost = true;
          form.BackColor = Color.DarkRed; form.ForeColor = Color.White;
          Label label = new Label(); label.Text = "Instar remote control active";
          label.TextAlign = ContentAlignment.MiddleCenter; label.Dock = DockStyle.Fill;
          label.Cursor = Cursors.SizeAll;
          Size text = TextRenderer.MeasureText(label.Text, label.Font);
          form.Size = new Size(text.Width + 16, text.Height + 8);
          Rectangle area = Screen.PrimaryScreen.WorkingArea;
          form.StartPosition = FormStartPosition.Manual;
          form.Location = BannerStart(area, form.Size);
          Point grab = Point.Empty; bool dragging = false;
          label.MouseDown += (sender, args) => {
            if (args.Button == MouseButtons.Left) { dragging = true; grab = args.Location; }
          };
          label.MouseMove += (sender, args) => {
            if (!dragging) return;
            Point at = form.Location; at.Offset(args.X - grab.X, args.Y - grab.Y);
            form.Location = KeepOnScreen(at, form.Size);
            BannerPlace = form.Location;
          };
          label.MouseUp += (sender, args) => { dragging = false; };
          form.Controls.Add(label); Banner = form;
          form.Shown += (sender, args) => { BannerShown = true; ready.Set(); };
          Application.Run(form);
        } finally { ready.Set(); lock (Gate) { if (BannerExitOwnsLease(ownerLease)) StopLocked(); } }
      });
      BannerThread.IsBackground = true; BannerThread.SetApartmentState(ApartmentState.STA); BannerThread.Start();
      if (!ready.WaitOne(2000) || !BannerShown) throw new InvalidOperationException();
    }
    /// <summary>The lease's live stream for this area, started on first use and
    /// restarted for a new area or after it went idle. A failed stream stays
    /// failed for its lease so the caller falls back to pictures once.</summary>
    static VideoStream VideoFor(string lease, Rectangle area) {
      if (Video != null && Video.Lease == lease && Video.Area == area && !Video.Idle) return Video;
      if (Video != null && Video.Lease == lease && Video.Failed) return Video;
      StopVideo();
      Video = new VideoStream(lease, area);
      return Video;
    }
    static void StopVideo() {
      VideoStream video = Video; Video = null;
      if (video != null) video.Dispose();
    }
    static void StopLocked() {
      StopVideo();
      string priorLease = LeaseId;
      Active = false; LeaseId = null; BannerShown = false; ReleaseHeld();
      if (priorLease != null) CancelLease(priorLease);
      Form form = Banner; Banner = null;
      if (form != null && !form.IsDisposed && form.IsHandleCreated) form.BeginInvoke((Action)(() => form.Close()));
    }
    static int SelfTest() {
      string oldLease = new string('a', 32), newLease = new string('b', 32), futureLease = new string('c', 32);
      lock (Gate) {
        Active = true; LeaseId = oldLease;
        StopLease(oldLease);
        if (Active || MayStartLease(oldLease)) return 1;
        Active = true; LeaseId = newLease;
        if (OwnsLease(oldLease) || !OwnsLease(newLease)) return 2;
        if (BannerExitOwnsLease(oldLease) || !BannerExitOwnsLease(newLease)) return 3;
        StopLease(oldLease);
        if (!OwnsLease(newLease)) return 4;
        StopLease(newLease);
        StopLease(futureLease);
        if (MayStartLease(futureLease) || !MayStartLease(new string('d', 32))) return 5;
        Updating = true;
        UpdatePreparedAt = Now() - 30001;
        if (MayStartLease(new string('d', 32))) return 6;
        ExpireUpdate();
        if (Updating || !MayStartLease(new string('d', 32))) return 7;
      }
      Console.WriteLine("Windows companion lease self-test passed");
      return 0;
    }
    // Without this, on a display scaled above 100% Windows reports scaled-down
    // screen bounds: the capture covered only the top-left part of the screen
    // (the viewer looked zoomed and cropped) while SendInput spans the real
    // desktop, so clicks landed below and right of the drawn cursor. Declared
    // before any Screen/SystemInformation call; per-monitor v2 (-4), with the
    // Vista-era system-aware call as the fallback on older Windows.
    static bool DeclareDpiAware() {
      try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch (EntryPointNotFoundException) { }
      return SetProcessDPIAware();
    }
    public static int Main(string[] args) {
      DeclareDpiAware();
      if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
      IPAddress bind; int port;
      if (args.Length != 3 || !IPAddress.TryParse(args[0], out bind)
        || !Int32.TryParse(args[1], out port) || port < 1024 || port > 65535) return 2;
      Secret = File.ReadAllBytes(args[2]); if (Secret.Length != 32) return 2;
      System.Threading.Timer watchdog = new System.Threading.Timer(_ => { lock (Gate) {
        ExpireUpdate();
        if (Active && (Now() - LastHeartbeat > 5000 || !InteractiveDesktop())) StopLocked();
        if (Video != null && Video.Idle) StopVideo(); // nobody is watching: release the encoder and capture
      } }, null, 1000, 1000);
      TcpListener server = new TcpListener(bind, port); server.Start(8);
      while (true) {
        try { Handle(server.AcceptTcpClient()); }
        catch { /* Per-client errors never drop the companion's stop watchdog. */ }
      }
    }
  }

  // ---- Live video (H.264) ------------------------------------------------
  /// <summary>Live H.264 for one lease and one screen area. A capture thread keeps
  /// the newest picture; an encode thread turns it into the next access unit and
  /// holds at most two until requests take them, so every delta reaches the viewer
  /// in order and the slow WSL hop overlaps the next capture and encode. A stream
  /// that stops producing while it is being asked fails, so the session falls
  /// back to pictures instead of freezing.</summary>
  internal sealed class VideoStream : IDisposable {
    const int IdleStopMs = 4000;      // no request for this long: the companion stops the stream
    const int StallMs = 3000;         // asked, but nothing produced for this long: fail
    const int FirstFrameMs = 6000;    // encoder start-up allowance before the stall clock applies
    const int CapturePeriodMs = 50;   // at most 20 grabs a second; the stream asks for 15
    const long MaxPixels = 33177600;  // the same cap as a JPEG capture
    public readonly string Lease;
    public readonly Rectangle Area;
    public readonly Size Size;
    readonly object sync = new object();
    readonly Thread captureThread, encodeThread;
    byte[] latest;                 // newest captured BGRA (swapped, never copied, under the lock)
    long latestSequence, encodedSequence;
    const int Ready = 2;           // encoded units held for requests: the encoder keeps up with capture
    readonly Queue<byte[]> packets = new Queue<byte[]>(); // in encoding order, so every delta arrives in order
    bool forceKeyframe = true;
    volatile bool stopped;
    string failure;
    long lastTakeAt, lastProducedAt;
    readonly long createdAt;
    public string EncoderName = "";

    public VideoStream(string lease, Rectangle area) {
      if ((long)area.Width * area.Height > MaxPixels) throw new InvalidOperationException("video-area-too-large");
      Lease = lease; Area = area; Size = ScreenGrabber.VideoSize(area);
      createdAt = lastTakeAt = lastProducedAt = Environment.TickCount;
      captureThread = new Thread(CaptureLoop); captureThread.IsBackground = true; captureThread.Name = "instar-video-capture";
      encodeThread = new Thread(EncodeLoop); encodeThread.IsBackground = true; encodeThread.Name = "instar-video-encode";
      captureThread.Start(); encodeThread.Start();
    }

    public bool Failed { get { lock (sync) return failure != null; } }
    public bool Idle { get { return Environment.TickCount - Interlocked.Read(ref lastTakeAt) > IdleStopMs; } }

    /// <summary>The waiting access unit, or null after waitMs with none ready. A
    /// keyframe request discards a waiting delta and waits for the forced IDR.</summary>
    public byte[] Take(bool keyframe, int waitMs) {
      Interlocked.Exchange(ref lastTakeAt, Environment.TickCount);
      int deadline = Environment.TickCount + waitMs;
      lock (sync) {
        if (keyframe && (packets.Count == 0 || packets.Peek()[0] != 1)) {
          packets.Clear(); // deltas the viewer can no longer use
          forceKeyframe = true;
          Monitor.PulseAll(sync);
        }
        for (;;) {
          if (failure != null) throw new InvalidOperationException(failure);
          if (stopped) return null; // the lease stopped while this request waited
          if (packets.Count > 0 && (!keyframe || packets.Peek()[0] == 1)) {
            byte[] taken = packets.Dequeue();
            Monitor.PulseAll(sync);
            return taken;
          }
          long now = Environment.TickCount;
          if (now - createdAt > FirstFrameMs && now - lastProducedAt > StallMs) {
            failure = "video-stalled";
            Monitor.PulseAll(sync);
            throw new InvalidOperationException(failure);
          }
          int left = deadline - Environment.TickCount;
          if (left <= 0) return null;
          Monitor.Wait(sync, left);
        }
      }
    }

    void CaptureLoop() {
      try {
        using (ScreenGrabber grabber = new ScreenGrabber(Area.Width, Area.Height)) {
          byte[] spare = new byte[Area.Width * Area.Height * 4];
          while (!stopped) {
            int started = Environment.TickCount;
            grabber.Grab(Area, spare);
            lock (sync) {
              byte[] swap = latest; latest = spare; spare = swap ?? new byte[latest.Length];
              latestSequence++;
              Monitor.PulseAll(sync);
            }
            int rest = CapturePeriodMs - (Environment.TickCount - started);
            if (rest > 0) Thread.Sleep(rest);
          }
        }
      } catch (Exception error) { Fail("capture: " + error.Message); }
    }

    void EncodeLoop() {
      try {
        using (FrameConverter converter = new FrameConverter(Area.Width, Area.Height, Size.Width, Size.Height))
        using (H264Encoder encoder = H264Encoder.Create(Size.Width, Size.Height, Bitrate(Size), true)) {
          EncoderName = encoder.Name;
          byte[] picture = null;
          while (!stopped) {
            bool keyframe;
            lock (sync) {
              // Wait for room in the ready queue and for a newer picture.
              while (!stopped && failure == null && (packets.Count >= Ready || latestSequence == encodedSequence)) Monitor.Wait(sync, 250);
              if (stopped || failure != null) break;
              byte[] swap = picture; picture = latest; latest = swap; // take the newest picture without copying it
              encodedSequence = latestSequence;
              keyframe = forceKeyframe;
            }
            byte[] unit = encoder.EncodeNv12(converter.Convert(picture), keyframe, 500);
            lock (sync) {
              // A picture the encoder made but could not deliver leaves a gap: restart from a keyframe.
              if (encoder.TakeDropped()) forceKeyframe = true;
              if (unit == null) continue;
              if (forceKeyframe && unit[0] != 1) continue; // a delta from before the request
              if (unit[0] == 1) forceKeyframe = false;
              packets.Enqueue(unit);
              lastProducedAt = Environment.TickCount;
              Monitor.PulseAll(sync);
            }
          }
        }
      } catch (Exception error) { Fail("encode: " + error.Message); }
    }

    /// <summary>About 0.15 bits per pixel at 15 pictures a second: sharp text, within the 10 Mbps stream budget.</summary>
    internal static int Bitrate(Size size) {
      return Math.Max(1000000, Math.Min(6000000, (int)((long)size.Width * size.Height * 15 * 15 / 100)));
    }

    void Fail(string reason) {
      lock (sync) { if (failure == null) failure = reason; Monitor.PulseAll(sync); }
    }

    public void Dispose() {
      stopped = true;
      lock (sync) Monitor.PulseAll(sync);
    }
  }

  /// <summary>Copies (and, when needed, scales) one screen area into a reused
  /// 32-bit top-down DIB with a single GDI StretchBlt.</summary>
  internal sealed class ScreenGrabber : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfoHeader {
      public int Size; public int Width; public int Height; public short Planes; public short BitCount;
      public int Compression; public int SizeImage; public int XPelsPerMeter; public int YPelsPerMeter; public int ClrUsed; public int ClrImportant;
    }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfoHeader info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr previous);
    [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr dest, int dx, int dy, int dw, int dh, IntPtr source, int sx, int sy, int sw, int sh, uint rop);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dest, int dx, int dy, int dw, int dh, IntPtr source, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    const uint SourceCopy = 0x00CC0020;
    const int Halftone = 4;

    public readonly int Width, Height;
    readonly IntPtr memory, bitmap, previous, bits;
    readonly int pixels;
    bool disposed;

    public ScreenGrabber(int width, int height) {
      Width = width; Height = height;
      IntPtr screen = GetDC(IntPtr.Zero);
      try {
        memory = CreateCompatibleDC(screen);
        BitmapInfoHeader info = new BitmapInfoHeader();
        info.Size = Marshal.SizeOf(typeof(BitmapInfoHeader)); info.Width = width; info.Height = -height;
        info.Planes = 1; info.BitCount = 32;
        bitmap = CreateDIBSection(screen, ref info, 0, out bits, IntPtr.Zero, 0);
        if (memory == IntPtr.Zero || bitmap == IntPtr.Zero || bits == IntPtr.Zero) throw new InvalidOperationException("dib");
        previous = SelectObject(memory, bitmap);
        SetStretchBltMode(memory, Halftone);
        SetBrushOrgEx(memory, 0, 0, IntPtr.Zero);
      } finally { ReleaseDC(IntPtr.Zero, screen); }
      pixels = width * height * 4;
    }

    /// <summary>Copies the area into `target` (width*height*4 bytes).</summary>
    public void Grab(Rectangle area, byte[] target) {
      if (target.Length != pixels) throw new ArgumentException("target");
      if (disposed) throw new ObjectDisposedException("grabber");
      IntPtr screen = GetDC(IntPtr.Zero);
      if (screen == IntPtr.Zero) throw new InvalidOperationException("screen-dc");
      try {
        bool ok = area.Width == Width && area.Height == Height
          ? BitBlt(memory, 0, 0, Width, Height, screen, area.Left, area.Top, SourceCopy)
          : StretchBlt(memory, 0, 0, Width, Height, screen, area.Left, area.Top, area.Width, area.Height, SourceCopy);
        if (!ok) throw new InvalidOperationException("blt");
      } finally { ReleaseDC(IntPtr.Zero, screen); }
      GdiFlush();
      Marshal.Copy(bits, target, 0, pixels);
    }

    /// <summary>The largest even size at most 1920x1080 with the area's shape.</summary>
    public static Size VideoSize(Rectangle area) {
      double scale = Math.Min(1, Math.Min(1920.0 / area.Width, 1080.0 / area.Height));
      int width = Math.Max(2, (int)(area.Width * scale) & ~1), height = Math.Max(2, (int)(area.Height * scale) & ~1);
      return new Size(width, height);
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      SelectObject(memory, previous); DeleteObject(bitmap); DeleteDC(memory);
    }
  }

  /// <summary>Scales a top-down BGRA picture and converts it to NV12 with the
  /// Windows Video Processor MFT (SIMD on the CPU, area-averaged scaling).</summary>
  internal sealed class FrameConverter : IDisposable {
    static readonly Guid VideoProcessorClsid = new Guid("88753B26-5B24-49BD-B2E7-0C445C78C982");
    static readonly Guid MediaTypeVideo = new Guid("73646976-0000-0010-8000-00AA00389B71");
    static readonly Guid FormatRGB32 = new Guid("00000016-0000-0010-8000-00AA00389B71");
    static readonly Guid FormatNV12 = new Guid("3231564E-0000-0010-8000-00AA00389B71");
    static readonly Guid MtMajorType = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    static readonly Guid MtSubtype = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    static readonly Guid MtFrameSize = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
    static readonly Guid MtFrameRate = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    static readonly Guid MtPixelAspect = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    static readonly Guid MtInterlace = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    static readonly Guid MtDefaultStride = new Guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
    public readonly int SourceWidth, SourceHeight, Width, Height;
    readonly IMFTransform transform;
    readonly byte[] output;
    bool disposed;

    public FrameConverter(int sourceWidth, int sourceHeight, int width, int height) {
      SourceWidth = sourceWidth; SourceHeight = sourceHeight; Width = width; Height = height;
      H264Encoder.Startup();
      transform = (IMFTransform)Activator.CreateInstance(Type.GetTypeFromCLSID(VideoProcessorClsid));
      IMFMediaType input; H264Encoder.Check(H264Encoder.MFCreateMediaType(out input), "vp-input");
      Describe(input, FormatRGB32, sourceWidth, sourceHeight);
      H264Encoder.Set32(input, MtDefaultStride, (uint)(sourceWidth * 4));
      H264Encoder.Check(transform.SetInputType(0, input, 0), "vp-set-input");
      IMFMediaType nv12; H264Encoder.Check(H264Encoder.MFCreateMediaType(out nv12), "vp-output");
      Describe(nv12, FormatNV12, width, height);
      H264Encoder.Set32(nv12, MtDefaultStride, (uint)width);
      H264Encoder.Check(transform.SetOutputType(0, nv12, 0), "vp-set-output");
      output = new byte[width * height * 3 / 2];
      transform.ProcessMessage(0x10000000, IntPtr.Zero); // begin streaming
      transform.ProcessMessage(0x10000003, IntPtr.Zero); // start of stream
    }

    static void Describe(IMFMediaType type, Guid subtype, int width, int height) {
      H264Encoder.SetGuid(type, MtMajorType, MediaTypeVideo); H264Encoder.SetGuid(type, MtSubtype, subtype);
      H264Encoder.Set32(type, MtInterlace, 2);
      H264Encoder.Set64(type, MtFrameSize, (ulong)width << 32 | (uint)height);
      H264Encoder.Set64(type, MtFrameRate, 15UL << 32 | 1); H264Encoder.Set64(type, MtPixelAspect, 1UL << 32 | 1);
    }

    /// <summary>The returned array is reused by the next call.</summary>
    public byte[] Convert(byte[] bgra) {
      if (disposed) throw new ObjectDisposedException("converter");
      IMFSample sample = H264Encoder.MemorySample(bgra, bgra.Length, 0);
      try { H264Encoder.Check(transform.ProcessInput(0, sample, 0), "vp-input-frame"); }
      finally { Marshal.ReleaseComObject(sample); }
      IMFSample target = H264Encoder.MemorySample(null, output.Length, 0);
      try {
        MftOutputDataBuffer[] buffers = new MftOutputDataBuffer[1];
        buffers[0].Sample = Marshal.GetComInterfaceForObject(target, typeof(IMFSample));
        uint status;
        int hr = transform.ProcessOutput(0, 1, buffers, out status);
        Marshal.Release(buffers[0].Sample);
        if (buffers[0].Events != IntPtr.Zero) Marshal.Release(buffers[0].Events);
        H264Encoder.Check(hr, "vp-output-frame");
        H264Encoder.CopyOut(target, output);
        Settle();
        return output;
      } finally { Marshal.ReleaseComObject(target); }
    }

    /// <summary>The processor may keep the input for another output; ask until it
    /// says it needs more input so the next picture is accepted.</summary>
    void Settle() {
      for (int i = 0; i < 2; i++) {
        IMFSample spare = H264Encoder.MemorySample(null, output.Length, 0);
        try {
          MftOutputDataBuffer[] buffers = new MftOutputDataBuffer[1];
          buffers[0].Sample = Marshal.GetComInterfaceForObject(spare, typeof(IMFSample));
          uint status;
          int hr = transform.ProcessOutput(0, 1, buffers, out status);
          Marshal.Release(buffers[0].Sample);
          if (buffers[0].Events != IntPtr.Zero) Marshal.Release(buffers[0].Events);
          if (hr < 0) return; // MF_E_TRANSFORM_NEED_MORE_INPUT: ready for the next picture
        } finally { Marshal.ReleaseComObject(spare); }
      }
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      try { Marshal.ReleaseComObject(transform); } catch { /* already released */ }
    }
  }

  [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFAttributes {
    void GetItem(); void GetItemType(); void CompareItem(); void Compare();
    [PreserveSig] int GetUINT32([In] ref Guid key, out uint value);
    void GetUINT64(); void GetDouble(); void GetGUID(); void GetStringLength(); void GetString(); void GetAllocatedString();
    [PreserveSig] int GetBlobSize([In] ref Guid key, out uint size);
    [PreserveSig] int GetBlob([In] ref Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, uint size, out uint written);
    void GetAllocatedBlob(); void GetUnknown(); void SetItem(); void DeleteItem(); void DeleteAllItems();
    [PreserveSig] int SetUINT32([In] ref Guid key, uint value);
    [PreserveSig] int SetUINT64([In] ref Guid key, ulong value);
    void SetDouble();
    [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
    void SetString(); void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount(); void GetItemByIndex(); void CopyAllItems();
  }
  [ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFMediaType {
    void GetItem(); void GetItemType(); void CompareItem(); void Compare();
    [PreserveSig] int GetUINT32([In] ref Guid key, out uint value);
    void GetUINT64(); void GetDouble(); void GetGUID(); void GetStringLength(); void GetString(); void GetAllocatedString();
    [PreserveSig] int GetBlobSize([In] ref Guid key, out uint size);
    [PreserveSig] int GetBlob([In] ref Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, uint size, out uint written);
    void GetAllocatedBlob(); void GetUnknown(); void SetItem(); void DeleteItem(); void DeleteAllItems();
    [PreserveSig] int SetUINT32([In] ref Guid key, uint value);
    [PreserveSig] int SetUINT64([In] ref Guid key, ulong value);
    void SetDouble();
    [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
    void SetString(); void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount(); void GetItemByIndex(); void CopyAllItems();
  }
  [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFSample {
    void GetItem(); void GetItemType(); void CompareItem(); void Compare();
    [PreserveSig] int GetUINT32([In] ref Guid key, out uint value);
    void GetUINT64(); void GetDouble(); void GetGUID(); void GetStringLength(); void GetString(); void GetAllocatedString();
    void GetBlobSize(); void GetBlob(); void GetAllocatedBlob(); void GetUnknown(); void SetItem(); void DeleteItem(); void DeleteAllItems();
    [PreserveSig] int SetUINT32([In] ref Guid key, uint value);
    void SetUINT64(); void SetDouble(); void SetGUID(); void SetString(); void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount(); void GetItemByIndex(); void CopyAllItems();
    void GetSampleFlags(); void SetSampleFlags(); void GetSampleTime();
    [PreserveSig] int SetSampleTime(long time);
    void GetSampleDuration();
    [PreserveSig] int SetSampleDuration(long duration);
    void GetBufferCount(); void GetBufferByIndex();
    [PreserveSig] int ConvertToContiguousBuffer(out IMFMediaBuffer buffer);
    [PreserveSig] int AddBuffer(IMFMediaBuffer buffer);
  }
  [ComImport, Guid("045FA593-8799-42b8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFMediaBuffer {
    [PreserveSig] int Lock(out IntPtr data, out int maxLength, out int currentLength);
    [PreserveSig] int Unlock();
    [PreserveSig] int GetCurrentLength(out int length);
    [PreserveSig] int SetCurrentLength(int length);
  }
  [ComImport, Guid("7FEE9E9A-4A89-47a6-899C-B6A53A70FB67"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFActivate {
    void GetItem(); void GetItemType(); void CompareItem(); void Compare(); void GetUINT32(); void GetUINT64(); void GetDouble(); void GetGUID();
    void GetStringLength(); void GetString(); void GetAllocatedString(); void GetBlobSize(); void GetBlob(); void GetAllocatedBlob(); void GetUnknown();
    void SetItem(); void DeleteItem(); void DeleteAllItems(); void SetUINT32(); void SetUINT64(); void SetDouble(); void SetGUID(); void SetString();
    void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount(); void GetItemByIndex(); void CopyAllItems();
    [PreserveSig] int ActivateObject([In] ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    [PreserveSig] int ShutdownObject();
  }
  [StructLayout(LayoutKind.Sequential)] struct MftOutputStreamInfo { public uint Flags; public uint Size; public uint Alignment; }
  [StructLayout(LayoutKind.Sequential)] struct MftOutputDataBuffer { public uint StreamId; public IntPtr Sample; public uint Status; public IntPtr Events; }
  [ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFTransform {
    void GetStreamLimits(); void GetStreamCount();
    [PreserveSig] int GetStreamIDs(uint inputSize, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] inputIds, uint outputSize, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] uint[] outputIds);
    void GetInputStreamInfo();
    [PreserveSig] int GetOutputStreamInfo(uint stream, out MftOutputStreamInfo info);
    [PreserveSig] int GetAttributes(out IMFAttributes attributes);
    void GetInputStreamAttributes(); void GetOutputStreamAttributes(); void DeleteInputStream(); void AddInputStreams();
    void GetInputAvailableType();
    [PreserveSig] int GetOutputAvailableType(uint stream, uint index, out IMFMediaType type);
    [PreserveSig] int SetInputType(uint stream, IMFMediaType type, uint flags);
    [PreserveSig] int SetOutputType(uint stream, IMFMediaType type, uint flags);
    void GetInputCurrentType();
    [PreserveSig] int GetOutputCurrentType(uint stream, out IMFMediaType type);
    void GetInputStatus(); void GetOutputStatus(); void SetOutputBounds(); void ProcessEvent();
    [PreserveSig] int ProcessMessage(uint message, IntPtr param);
    [PreserveSig] int ProcessInput(uint stream, IMFSample sample, uint flags);
    [PreserveSig] int ProcessOutput(uint flags, uint count, [In, Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] MftOutputDataBuffer[] buffers, out uint status);
  }
  [ComImport, Guid("DF598932-F10C-4E39-BBA2-C308F101DAA3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFMediaEvent {
    void GetItem(); void GetItemType(); void CompareItem(); void Compare(); void GetUINT32(); void GetUINT64(); void GetDouble(); void GetGUID();
    void GetStringLength(); void GetString(); void GetAllocatedString(); void GetBlobSize(); void GetBlob(); void GetAllocatedBlob(); void GetUnknown();
    void SetItem(); void DeleteItem(); void DeleteAllItems(); void SetUINT32(); void SetUINT64(); void SetDouble(); void SetGUID(); void SetString();
    void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount(); void GetItemByIndex(); void CopyAllItems();
    [PreserveSig] int GetType(out uint type);
    void GetExtendedType();
    [PreserveSig] int GetStatus(out int status);
  }
  [ComImport, Guid("2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFMediaEventGenerator {
    [PreserveSig] int GetEvent(uint flags, out IMFMediaEvent value);
  }
  [ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ICodecAPI {
    void IsSupported(); void IsModifiable(); void GetParameterRange(); void GetParameterValues(); void GetDefaultValue(); void GetValue();
    [PreserveSig] int SetValue([In] ref Guid api, [In] ref object value);
  }

  /// <summary>Encodes NV12 desktop pictures as Annex B H.264 access units.
  /// Constrained to the viewer contract: baseline, level 4.0, at most 1920x1080,
  /// even dimensions, every keyframe carrying SPS + PPS + IDR.</summary>
  internal sealed class H264Encoder : IDisposable {
    static readonly Guid CategoryVideoEncoder = new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a");
    static readonly Guid MediaTypeVideo = new Guid("73646976-0000-0010-8000-00AA00389B71");
    static readonly Guid FormatNV12 = new Guid("3231564E-0000-0010-8000-00AA00389B71");
    static readonly Guid FormatH264 = new Guid("34363248-0000-0010-8000-00AA00389B71");
    static readonly Guid MtMajorType = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    static readonly Guid MtSubtype = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    static readonly Guid MtFrameSize = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
    static readonly Guid MtFrameRate = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    static readonly Guid MtPixelAspect = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    static readonly Guid MtInterlace = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    static readonly Guid MtAvgBitrate = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
    static readonly Guid MtProfile = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
    static readonly Guid MtLevel = new Guid("96f66574-11c5-4015-8666-bff516436da7");
    static readonly Guid MtSequenceHeader = new Guid("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");
    static readonly Guid AsyncUnlock = new Guid("e5666d6b-3422-4eb6-a421-da7db1f8e207");
    static readonly Guid LowLatency = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    static readonly Guid ApiRateControl = new Guid("1c0608e9-370c-4710-8a58-cb6181c42423");
    static readonly Guid ApiMeanBitrate = new Guid("f7222374-2144-4815-b550-a37f8e12ee52");
    static readonly Guid ApiQuality = new Guid("fcbf57a3-7ea5-4b0c-9644-69b40c39c391");
    static readonly Guid ApiGopSize = new Guid("95f31b26-95a4-41aa-9303-246a7fc6eef1");
    static readonly Guid ApiBPictures = new Guid("8d390aac-dc5c-4200-b57f-814d04babab2");
    static readonly Guid ApiForceKeyframe = new Guid("398c1b98-8353-475a-9ef2-8f265d260345");
    static readonly Guid IidTransform = new Guid("bf94c121-5b05-4e6f-8000-ba598961414d");

    const uint EnumSync = 0x1, EnumAsync = 0x2, EnumHardware = 0x4, EnumSortAndFilter = 0x40;
    const uint MessageFlush = 0x0, MessageBeginStreaming = 0x10000000, MessageStartOfStream = 0x10000003;
    const uint ProvidesSamples = 0x100, CanProvideSamples = 0x200;
    const int NeedMoreInput = unchecked((int)0xC00D6D72), StreamChange = unchecked((int)0xC00D6D61);
    const int NoEventsAvailable = unchecked((int)0xC00D3E80), NotAccepting = unchecked((int)0xC00D36B5);
    const uint NeedInputEvent = 601, HaveOutputEvent = 602;
    const int MaxAccessUnit = 1250000 - 5;
    static bool started;

    [StructLayout(LayoutKind.Sequential)] struct RegisterTypeInfo { public Guid Major; public Guid Sub; }
    internal static void Startup() { if (!started) { Check(MFStartup(0x20070, 0), "startup"); started = true; } }
    [DllImport("mfplat.dll")] static extern int MFStartup(uint version, uint flags);
    [DllImport("mfplat.dll")] static extern int MFTEnumEx(Guid category, uint flags, ref RegisterTypeInfo input,
      ref RegisterTypeInfo output, out IntPtr activates, out uint count);
    [DllImport("mfplat.dll")] internal static extern int MFCreateMediaType(out IMFMediaType type);
    [DllImport("mfplat.dll")] internal static extern int MFCreateSample(out IMFSample sample);
    [DllImport("mfplat.dll")] internal static extern int MFCreateMemoryBuffer(int length, out IMFMediaBuffer buffer);
    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr value);

    public readonly int Width, Height;
    public readonly bool Hardware;
    public readonly string Name;
    readonly IMFTransform transform;
    IMFActivate activate; // shut down with the encoder so a hardware session is released at once
    bool dropped;
    readonly IMFMediaEventGenerator events;
    readonly ICodecAPI codec;
    readonly uint inputStream, outputStream;
    readonly bool providesSamples;
    readonly int outputSize;
    readonly int pictureBytes;
    readonly Stopwatch clock = Stopwatch.StartNew();
    int pendingNeedInput;
    readonly Queue<byte[]> ready = new Queue<byte[]>();
    byte[] parameterSets; // SPS + PPS NAL units with start codes
    bool disposed;

    internal static void Check(int hr, string where) { if (hr < 0) throw new InvalidOperationException(where + " 0x" + hr.ToString("X8")); }

    H264Encoder(IMFTransform transform, bool hardware, string name, int width, int height, int bitrate) {
      this.transform = transform; Hardware = hardware; Name = name; Width = width; Height = height;
      if (hardware) {
        IMFAttributes attributes;
        Check(transform.GetAttributes(out attributes), "attributes");
        Guid key = AsyncUnlock; Check(attributes.SetUINT32(ref key, 1), "async-unlock");
        key = LowLatency; attributes.SetUINT32(ref key, 1);
        events = (IMFMediaEventGenerator)transform;
      }
      codec = transform as ICodecAPI;
      uint[] inputs = new uint[1], outputs = new uint[1];
      if (transform.GetStreamIDs(1, inputs, 1, outputs) >= 0) { inputStream = inputs[0]; outputStream = outputs[0]; }
      SetCodecValue(LowLatency, true); // VT_BOOL
      // Quality-based rate control: an unchanged screen costs ~200 bytes a picture
      // instead of padding to the bitrate, and fast motion measured below constant
      // bitrate on Mama PC (2.6 vs 4.4 Mbps at 1728x1080, quality 70). The mean
      // bitrate stays set for an encoder that refuses the mode.
      SetCodec(ApiRateControl, 3u);
      SetCodec(ApiQuality, 70u);
      SetCodec(ApiMeanBitrate, (uint)bitrate);
      SetCodec(ApiGopSize, 450u);
      SetCodec(ApiBPictures, 0u);

      IMFMediaType output; Check(MFCreateMediaType(out output), "output-type");
      SetGuid(output, MtMajorType, MediaTypeVideo); SetGuid(output, MtSubtype, FormatH264);
      Set32(output, MtAvgBitrate, (uint)bitrate); Set32(output, MtInterlace, 2);
      Set64(output, MtFrameSize, (ulong)width << 32 | (uint)height);
      Set64(output, MtFrameRate, 15UL << 32 | 1); Set64(output, MtPixelAspect, 1UL << 32 | 1);
      Set32(output, MtProfile, 66); Set32(output, MtLevel, 40);
      Check(transform.SetOutputType(outputStream, output, 0), "set-output");
      IMFMediaType input; Check(MFCreateMediaType(out input), "input-type");
      SetGuid(input, MtMajorType, MediaTypeVideo); SetGuid(input, MtSubtype, FormatNV12);
      Set32(input, MtInterlace, 2);
      Set64(input, MtFrameSize, (ulong)width << 32 | (uint)height);
      Set64(input, MtFrameRate, 15UL << 32 | 1); Set64(input, MtPixelAspect, 1UL << 32 | 1);
      Check(transform.SetInputType(inputStream, input, 0), "set-input");
      ReadSequenceHeader();

      MftOutputStreamInfo info; Check(transform.GetOutputStreamInfo(outputStream, out info), "output-info");
      providesSamples = (info.Flags & (ProvidesSamples | CanProvideSamples)) != 0;
      outputSize = Math.Max((int)info.Size, width * height * 3 / 2);
      pictureBytes = width * height * 3 / 2;
      transform.ProcessMessage(MessageFlush, IntPtr.Zero);
      Check(transform.ProcessMessage(MessageBeginStreaming, IntPtr.Zero), "begin-streaming");
      Check(transform.ProcessMessage(MessageStartOfStream, IntPtr.Zero), "start-of-stream");
    }

    void SetCodec(Guid api, uint value) { SetCodecValue(api, value); }
    void SetCodecValue(Guid api, object boxed) {
      if (codec == null) return;
      codec.SetValue(ref api, ref boxed); // optional: an encoder that refuses keeps its default // optional: an encoder that refuses keeps its default
    }
    internal static void Set32(IMFMediaType type, Guid key, uint value) { Check(type.SetUINT32(ref key, value), "set32"); }
    internal static void Set64(IMFMediaType type, Guid key, ulong value) { Check(type.SetUINT64(ref key, value), "set64"); }
    internal static void SetGuid(IMFMediaType type, Guid key, Guid value) { Check(type.SetGUID(ref key, ref value), "setguid"); }

    void ReadSequenceHeader() {
      IMFMediaType current;
      if (transform.GetOutputCurrentType(outputStream, out current) < 0 || current == null) return;
      Guid key = MtSequenceHeader; uint size;
      if (current.GetBlobSize(ref key, out size) < 0 || size < 8 || size > 4096) return;
      byte[] blob = new byte[size]; uint written;
      if (current.GetBlob(ref key, blob, size, out written) < 0) return;
      byte[] sets = KeepNals(blob, (int)written, 7, 8);
      if (sets.Length > 0) parameterSets = sets;
    }

    /// <summary>Hardware first (Quick Sync, NVENC, AMF), then Microsoft's software encoder.</summary>
    public static H264Encoder Create(int width, int height, int bitrate, bool allowHardware) {
      if (width < 2 || height < 2 || width > 1920 || height > 1080 || (width & 1) != 0 || (height & 1) != 0) {
        throw new ArgumentException("geometry");
      }
      Startup();
      List<Exception> failures = new List<Exception>();
      foreach (bool hardware in allowHardware ? new bool[] { true, false } : new bool[] { false }) {
        RegisterTypeInfo input = new RegisterTypeInfo(); input.Major = MediaTypeVideo; input.Sub = FormatNV12;
        RegisterTypeInfo output = new RegisterTypeInfo(); output.Major = MediaTypeVideo; output.Sub = FormatH264;
        IntPtr list; uint count;
        uint flags = EnumSortAndFilter | (hardware ? EnumHardware | EnumAsync : EnumSync);
        if (MFTEnumEx(CategoryVideoEncoder, flags, ref input, ref output, out list, out count) < 0 || count == 0) continue;
        try {
          for (int i = 0; i < count; i++) {
            IntPtr item = Marshal.ReadIntPtr(list, i * IntPtr.Size);
            IMFActivate activate = (IMFActivate)Marshal.GetObjectForIUnknown(item);
            try {
              object value; Guid iid = IidTransform;
              Check(activate.ActivateObject(ref iid, out value), "activate");
              H264Encoder encoder = new H264Encoder((IMFTransform)value, hardware, (hardware ? "hardware-" : "software-") + i, width, height, bitrate);
              encoder.activate = activate;
              return encoder;
            } catch (Exception error) {
              failures.Add(error);
              try { activate.ShutdownObject(); } catch { /* best effort */ }
            }
          }
        } finally {
          // MFTEnumEx hands over one reference per entry; the RCW took its own.
          for (int i = 0; i < count; i++) Marshal.Release(Marshal.ReadIntPtr(list, i * IntPtr.Size));
          CoTaskMemFree(list);
        }
      }
      throw new InvalidOperationException("no-h264-encoder" + (failures.Count > 0 ? ": " + failures[0].Message : ""));
    }

    /// <summary>One NV12 picture (width x height, tight stride) in.</summary>
    public byte[] EncodeNv12(byte[] picture, bool keyframe, int timeoutMs) {
      if (disposed) throw new ObjectDisposedException("encoder");
      if (picture.Length != pictureBytes) throw new ArgumentException("picture");
      if (keyframe) SetCodec(ApiForceKeyframe, 1u);
      IMFSample sample = MemorySample(picture, picture.Length, clock.ElapsedTicks * 10000000L / Stopwatch.Frequency);
      long deadline = clock.ElapsedMilliseconds + timeoutMs;
      if (!Hardware) {
        Check(transform.ProcessInput(inputStream, sample, 0), "input");
        for (int more = 0; more < 4; more++) { // take every output that is ready, so the next input is accepted
          byte[] produced = Drain();
          if (produced == null) break;
          ready.Enqueue(produced);
        }
      } else {
        bool submitted = false;
        while (clock.ElapsedMilliseconds < deadline && !(submitted && ready.Count > 0)) {
          IMFMediaEvent ev;
          int hr = events.GetEvent(1, out ev);
          if (hr == NoEventsAvailable) {
            if (!submitted && pendingNeedInput > 0) { pendingNeedInput--; Check(transform.ProcessInput(inputStream, sample, 0), "input"); submitted = true; continue; }
            Thread.Sleep(1); continue;
          }
          Check(hr, "event");
          uint type; ev.GetType(out type);
          Marshal.ReleaseComObject(ev);
          if (type == NeedInputEvent) pendingNeedInput++;
          else if (type == HaveOutputEvent) { byte[] produced = Drain(); if (produced != null) ready.Enqueue(produced); }
        }
      }
      Marshal.ReleaseComObject(sample);
      while (ready.Count > 0) { byte[] packet = Package(ready.Dequeue()); if (packet != null) return packet; }
      return null;
    }

    /// <summary>A system-memory sample of `length` bytes, filled from `bytes` when given.</summary>
    internal static IMFSample MemorySample(byte[] bytes, int length, long time) {
      IMFSample sample; Check(MFCreateSample(out sample), "sample");
      IMFMediaBuffer buffer; Check(MFCreateMemoryBuffer(length, out buffer), "buffer");
      try {
        if (bytes != null) {
          IntPtr data; int max, current;
          Check(buffer.Lock(out data, out max, out current), "lock");
          try { Marshal.Copy(bytes, 0, data, length); } finally { buffer.Unlock(); }
          buffer.SetCurrentLength(length);
        }
        Check(sample.AddBuffer(buffer), "add-buffer");
      } finally { Marshal.ReleaseComObject(buffer); }
      sample.SetSampleTime(time);
      sample.SetSampleDuration(666666);
      return sample;
    }

    /// <summary>Copies a sample's bytes into `target` (exact length required).</summary>
    internal static void CopyOut(IMFSample sample, byte[] target) {
      IMFMediaBuffer contiguous; Check(sample.ConvertToContiguousBuffer(out contiguous), "contiguous");
      try {
        IntPtr data; int max, length;
        Check(contiguous.Lock(out data, out max, out length), "out-lock");
        try {
          if (length < target.Length) throw new InvalidOperationException("short-sample");
          Marshal.Copy(data, target, 0, target.Length);
        } finally { contiguous.Unlock(); }
      } finally { Marshal.ReleaseComObject(contiguous); }
    }

    byte[] Drain() {
      for (int attempt = 0; attempt < 3; attempt++) {
        IMFSample provided = null;
        if (!providesSamples) {
          IMFMediaBuffer buffer; Check(MFCreateMemoryBuffer(outputSize, out buffer), "out-buffer");
          Check(MFCreateSample(out provided), "out-sample");
          provided.AddBuffer(buffer); Marshal.ReleaseComObject(buffer);
        }
        MftOutputDataBuffer[] buffers = new MftOutputDataBuffer[1];
        buffers[0].StreamId = outputStream;
        buffers[0].Sample = provided == null ? IntPtr.Zero : Marshal.GetComInterfaceForObject(provided, typeof(IMFSample));
        uint status;
        int hr = transform.ProcessOutput(0, 1, buffers, out status);
        if (buffers[0].Events != IntPtr.Zero) Marshal.Release(buffers[0].Events);
        IMFSample result = null;
        if (buffers[0].Sample != IntPtr.Zero) {
          result = (IMFSample)Marshal.GetObjectForIUnknown(buffers[0].Sample);
          Marshal.Release(buffers[0].Sample);
        }
        if (provided != null) Marshal.ReleaseComObject(provided);
        if (hr == NeedMoreInput) { if (result != null) Marshal.ReleaseComObject(result); return null; }
        if (hr == StreamChange) {
          if (result != null) Marshal.ReleaseComObject(result);
          IMFMediaType type;
          Check(transform.GetOutputAvailableType(outputStream, 0, out type), "stream-change");
          Check(transform.SetOutputType(outputStream, type, 0), "stream-change-set");
          ReadSequenceHeader();
          if (Hardware) return null; // an async encoder announces the real output with its own event
          continue;
        }
        Check(hr, "output");
        if (result == null) return null;
        try {
          IMFMediaBuffer contiguous; Check(result.ConvertToContiguousBuffer(out contiguous), "contiguous");
          IntPtr data; int max, length;
          Check(contiguous.Lock(out data, out max, out length), "out-lock");
          byte[] bytes = new byte[length];
          Marshal.Copy(data, bytes, 0, length);
          contiguous.Unlock();
          Marshal.ReleaseComObject(contiguous);
          return bytes;
        } finally { Marshal.ReleaseComObject(result); }
      }
      return null;
    }

    /// <summary>[keyflag][width u16be][height u16be][Annex B], the native packet
    /// the WSL side parses. A keyframe always carries SPS + PPS.</summary>
    byte[] Package(byte[] unit) {
      bool hasSps = false, hasPps = false, hasIdr = false, hasSlice = false;
      List<int[]> nals = Nals(unit, unit.Length);
      foreach (int[] nal in nals) {
        int type = unit[nal[0]] & 0x1f;
        if (type == 7) hasSps = true; else if (type == 8) hasPps = true;
        else if (type == 5) hasIdr = true; else if (type == 1) hasSlice = true;
      }
      if (hasSps && hasPps) { byte[] sets = KeepNals(unit, unit.Length, 7, 8); if (sets.Length > 0) parameterSets = sets; }
      if (!hasIdr && !hasSlice) return null;
      // Re-emit with 4-byte start codes only; prepend cached parameter sets to a bare IDR.
      List<byte> body = new List<byte>(unit.Length + 64);
      if (hasIdr && !(hasSps && hasPps)) {
        if (parameterSets == null) { dropped = true; return null; }
        body.AddRange(parameterSets);
      }
      foreach (int[] nal in nals) {
        int type = unit[nal[0]] & 0x1f;
        if (type == 9) continue; // access unit delimiters are noise to the viewer
        body.Add(0); body.Add(0); body.Add(0); body.Add(1);
        for (int i = nal[0]; i < nal[0] + nal[1]; i++) body.Add(unit[i]);
      }
      if (body.Count > MaxAccessUnit) { dropped = true; return null; }
      byte[] packet = new byte[5 + body.Count];
      packet[0] = (byte)(hasIdr ? 1 : 0);
      packet[1] = (byte)(Width >> 8); packet[2] = (byte)Width;
      packet[3] = (byte)(Height >> 8); packet[4] = (byte)Height;
      body.CopyTo(packet, 5);
      return packet;
    }

    /// <summary>[offset, length] of each NAL payload, 3- or 4-byte start codes.</summary>
    static List<int[]> Nals(byte[] data, int length) {
      List<int> starts = new List<int>();
      for (int i = 0; i + 2 < length; i++) {
        if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) { starts.Add(i + 3); i += 2; }
      }
      List<int[]> result = new List<int[]>();
      for (int s = 0; s < starts.Count; s++) {
        int end = s + 1 < starts.Count ? starts[s + 1] - 3 : length;
        while (end > starts[s] && data[end - 1] == 0) end--; // trailing zero of a 4-byte start code
        if (end > starts[s]) result.Add(new int[] { starts[s], end - starts[s] });
      }
      return result;
    }

    static byte[] KeepNals(byte[] data, int length, int first, int second) {
      List<byte> kept = new List<byte>();
      foreach (int[] nal in Nals(data, length)) {
        int type = data[nal[0]] & 0x1f;
        if (type != first && type != second) continue;
        kept.Add(0); kept.Add(0); kept.Add(0); kept.Add(1);
        for (int i = nal[0]; i < nal[0] + nal[1]; i++) kept.Add(data[i]);
      }
      return kept.ToArray();
    }

    /// <summary>True once after a produced picture could not be packaged (a gap the
    /// viewer cannot decode past without a new keyframe).</summary>
    public bool TakeDropped() { bool was = dropped; dropped = false; return was; }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      try { transform.ProcessMessage(0x10000001, IntPtr.Zero); } catch { /* end streaming, best effort */ }
      try { Marshal.ReleaseComObject(transform); } catch { /* already released */ }
      if (activate != null) {
        try { activate.ShutdownObject(); } catch { /* releases the encoder session; best effort */ }
        try { Marshal.ReleaseComObject(activate); } catch { /* already released */ }
        activate = null;
      }
    }
  }
}
