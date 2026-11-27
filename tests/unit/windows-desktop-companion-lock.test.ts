import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The companion compiles only on Windows (PowerShell Add-Type), so its lock
// reading is checked here by shape; the live check runs on a real locked PC.
const source = readFileSync('src/native/remote-desktop/windows/InstarDesktopCompanion.cs', 'utf8');
const body = (name: string): string => {
  const start = source.indexOf(`static bool ${name}() {`);
  expect(start, name).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n    }\n', start));
};

describe('Windows desktop companion lock reading', () => {
  it('treats a locked PC as no usable desktop, so the watchdog and every request refuse it', () => {
    expect(body('InteractiveDesktop')).toContain('&& !ScreenLocked()');
  });

  it('needs both the session flag and the sign-in screen, so a misread flag cannot block an unlocked PC', () => {
    expect(body('ScreenLocked')).toContain('SessionFlagLocked() && SignInScreenShown()');
    // Level 1 of WTSINFOEXW for this session, SessionFlags 0 = locked.
    const flag = body('SessionFlagLocked');
    expect(flag).toContain('WTSQuerySessionInformationW(IntPtr.Zero, session, 25,');
    expect(flag).toContain('Marshal.ReadInt32(buffer) != 1');
    expect(flag).toContain('Marshal.ReadInt32(buffer, 8) != session');
    expect(flag).toContain('Marshal.ReadInt32(buffer, 16) == 0');
    expect(flag).toContain('WTSFreeMemory(buffer)');
    const screen = body('SignInScreenShown');
    expect(screen).toContain('GetProcessesByName("LogonUI")');
    expect(screen).toContain('process.SessionId == session');
  });

  it('reads the lock at most twice a second, from a cache that starts unread', () => {
    expect(body('ScreenLocked')).toContain('now - LockReadAt < 500');
    expect(source).toMatch(/static long LockReadAt;/);
  });

  it('reports the reading in the probe reply', () => {
    expect(source).toContain('screenLocked = ScreenLocked()');
  });
});
