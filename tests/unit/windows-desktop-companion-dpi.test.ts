import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/native/remote-desktop/windows/InstarDesktopCompanion.cs', 'utf8');

describe('Windows desktop companion DPI awareness', () => {
  it('declares per-monitor DPI awareness as the first statement of Main', () => {
    const main = source.indexOf('public static int Main(string[] args) {');
    expect(main).toBeGreaterThan(-1);
    const body = source.slice(main + 'public static int Main(string[] args) {'.length).trimStart();
    expect(body.startsWith('DeclareDpiAware();')).toBe(true);
    expect(source).toContain('SetProcessDpiAwarenessContext(new IntPtr(-4))');
  });

  it('reads screen bounds only after Main has started (no static field initialisers touch them)', () => {
    const staticInit = /static\s+(readonly\s+)?\w+\s+\w+\s*=\s*[^;]*(SystemInformation|Screen\.)/;
    expect(staticInit.test(source)).toBe(false);
  });
});
