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
    static Thread BannerThread;

    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
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
          && String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
      } finally { CloseDesktop(desktop); }
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
      using (client) using (NetworkStream stream = client.GetStream()) {
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
        if (op != "probe" && op != "capture" && op != "cursor" && op != "input"
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
          string lease = op == "probe" || updateOperation ? "" : Text(command, "leaseId");
          if (op != "probe" && !updateOperation && !ValidLease(lease)) throw new InvalidDataException();
          object result; string type = "application/json";
          bool exitAfterWrite = false;
          lock (Gate) {
            ExpireUpdate();
            if (Active && (Now() - LastHeartbeat > 5000 || !InteractiveDesktop())) StopLocked();
            if (op == "probe") {
              bool ready = !Updating && InteractiveDesktop() && Screen.AllScreens.Length > 0;
              result = Reply(new { screenPermission = ready, inputPermission = ready,
                sessionActive = ready, displayCount = ready ? Screen.AllScreens.Length : 0,
                controlActive = Active, updatePrepared = Updating });
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
              if (op == "capture") { result = Capture(); type = "image/jpeg"; }
              else if (op == "cursor") {
                Point point; if (!GetCursorPos(out point)) throw new InvalidOperationException();
                Rectangle screen = SystemInformation.VirtualScreen;
                result = Reply(new { x = Math.Max(0, Math.Min(1, (double)(point.X - screen.Left) / Math.Max(1, screen.Width - 1))),
                  y = Math.Max(0, Math.Min(1, (double)(point.Y - screen.Top) / Math.Max(1, screen.Height - 1))) });
              } else {
                object actionValue; if (!command.TryGetValue("action", out actionValue)) throw new InvalidDataException();
                Dictionary<string,object> action = actionValue as Dictionary<string,object>;
                if (action == null) throw new InvalidDataException();
                Input(action); result = Reply(new { ok = true });
              }
            }
          }
          Write(stream, 200, type, (byte[])result);
          if (exitAfterWrite) Environment.Exit(0);
        } catch { Write(stream, 400, "application/json", Reply(new { error = "desktop-unavailable" })); }
      }
    }
    static byte[] Capture() {
      Rectangle bounds = SystemInformation.VirtualScreen;
      if (bounds.Width < 1 || bounds.Height < 1 || bounds.Width > 16000 || bounds.Height > 16000
        || (long)bounds.Width * bounds.Height > 33177600) throw new InvalidOperationException();
      using (Bitmap full = new Bitmap(bounds.Width, bounds.Height)) {
        using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size);
        double scale = Math.Min(1, Math.Min(2560.0 / bounds.Width, 1440.0 / bounds.Height));
        int width = Math.Max(1, (int)(bounds.Width * scale)), height = Math.Max(1, (int)(bounds.Height * scale));
        using (Bitmap image = new Bitmap(width, height)) {
          using (Graphics g = Graphics.FromImage(image)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.DrawImage(full, 0, 0, width, height);
          }
          ImageCodecInfo codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
          foreach (long quality in new long[] { 82, 70, 55 }) {
            using (MemoryStream output = new MemoryStream()) using (EncoderParameters options = new EncoderParameters(1)) {
              options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
              image.Save(output, codec, options);
              if (output.Length <= MaxFrame) return output.ToArray();
            }
          }
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
        case "a": return 0x41; case "c": return 0x43; case "v": return 0x56; case "x": return 0x58; case "z": return 0x5A;
        default: throw new InvalidDataException();
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
    static void MoveTo(double fx, double fy) {
      Rectangle bounds = SystemInformation.VirtualScreen;
      int x = Coordinate(fx, bounds.Left, bounds.Width), y = Coordinate(fy, bounds.Top, bounds.Height);
      int ax = (int)Math.Round((x - bounds.Left) * 65535.0 / Math.Max(1, bounds.Width - 1));
      int ay = (int)Math.Round((y - bounds.Top) * 65535.0 / Math.Max(1, bounds.Height - 1));
      SendMouse(0x0001u | 0x4000u | 0x8000u, ax, ay, 0);
    }
    static void Mouse(string button, bool down) {
      if (button != "left" && button != "right") throw new InvalidDataException();
      uint flag = button == "left" ? (down ? 0x0002u : 0x0004u) : (down ? 0x0008u : 0x0010u);
      SendMouse(flag, 0, 0, 0);
      if (down) HeldButtons.Add(button); else HeldButtons.Remove(button);
    }
    static void Input(Dictionary<string,object> action) {
      string kind = Text(action, "kind");
      if (kind == "move" || kind == "click" || kind == "buttonDown" || kind == "buttonUp") {
        string button = kind == "move" ? null : Text(action,"button");
        if (button != null && button != "left" && button != "right") throw new InvalidDataException();
        MoveTo(Number(action,"x"), Number(action,"y"));
        if (kind == "click") { Thread.Sleep(15); Mouse(button,true); Thread.Sleep(30); Mouse(button,false); }
        else if (kind != "move") { Thread.Sleep(15); Mouse(button,kind == "buttonDown"); }
      } else if (kind == "scroll") {
        double dx = Number(action,"dx"), dy = Number(action,"dy");
        if (Math.Abs(dx) > 1000 || Math.Abs(dy) > 1000) throw new InvalidDataException();
        if (dy != 0) SendMouse(0x0800u, 0, 0, unchecked((uint)(int)Math.Round(-dy * 1.2)));
        if (dx != 0) SendMouse(0x01000u, 0, 0, unchecked((uint)(int)Math.Round(dx * 1.2)));
      } else if (kind == "keyDown" || kind == "keyUp") {
        string key = Text(action,"key"); byte vk = Key(key);
        keybd_event(vk, 0, kind == "keyUp" ? 0x0002u : 0u, UIntPtr.Zero);
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
        keybd_event(Key(key), 0, 0x0002u, UIntPtr.Zero); HeldKeys.Remove(key);
      }
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
          Form form = new Form(); form.Text = "Instar remote control active";
          form.Width = 260; form.Height = 48; form.FormBorderStyle = FormBorderStyle.FixedToolWindow;
          form.ControlBox = false; form.ShowInTaskbar = false; form.TopMost = true;
          form.BackColor = Color.DarkRed; form.ForeColor = Color.White;
          Rectangle area = Screen.PrimaryScreen.WorkingArea;
          form.StartPosition = FormStartPosition.Manual;
          form.Location = new Point(area.Right - form.Width, area.Top);
          Label label = new Label(); label.Text = "Instar remote control active";
          label.TextAlign = ContentAlignment.MiddleCenter; label.Dock = DockStyle.Fill;
          form.Controls.Add(label); Banner = form;
          form.Shown += (sender, args) => { BannerShown = true; ready.Set(); };
          Application.Run(form);
        } finally { ready.Set(); lock (Gate) { if (BannerExitOwnsLease(ownerLease)) StopLocked(); } }
      });
      BannerThread.IsBackground = true; BannerThread.SetApartmentState(ApartmentState.STA); BannerThread.Start();
      if (!ready.WaitOne(2000) || !BannerShown) throw new InvalidOperationException();
    }
    static void StopLocked() {
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
    public static int Main(string[] args) {
      if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
      IPAddress bind; int port;
      if (args.Length != 3 || !IPAddress.TryParse(args[0], out bind)
        || !Int32.TryParse(args[1], out port) || port < 1024 || port > 65535) return 2;
      Secret = File.ReadAllBytes(args[2]); if (Secret.Length != 32) return 2;
      System.Threading.Timer watchdog = new System.Threading.Timer(_ => { lock (Gate) {
        ExpireUpdate();
        if (Active && (Now() - LastHeartbeat > 5000 || !InteractiveDesktop())) StopLocked();
      } }, null, 1000, 1000);
      TcpListener server = new TcpListener(bind, port); server.Start(8);
      while (true) {
        try { Handle(server.AcceptTcpClient()); }
        catch { /* Per-client errors never drop the companion's stop watchdog. */ }
      }
    }
  }
}
