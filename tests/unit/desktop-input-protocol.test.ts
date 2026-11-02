import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { DESKTOP_KEYS, validDesktopInput } from '../../src/core/DesktopHost.js';

describe('shared desktop input protocol', () => {
  it('accepts double and middle clicks and the extended key list', () => {
    expect(validDesktopInput({ kind: 'click', x: 0.5, y: 0.5, button: 'middle' })).toBe(true);
    expect(validDesktopInput({ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 2 })).toBe(true);
    for (const key of ['F1', 'F12', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'q', '7']) {
      expect(validDesktopInput({ kind: 'keyDown', key })).toBe(true);
    }
  });

  it('refuses out-of-range counts, unknown buttons and unknown keys', () => {
    expect(validDesktopInput({ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 4 as 3 })).toBe(false);
    expect(validDesktopInput({ kind: 'click', x: 0.5, y: 0.5, button: 'back' as 'left' })).toBe(false);
    for (const key of ['F13', 'A', 'Ctrl', 'Meta2', '']) expect(validDesktopInput({ kind: 'keyDown', key })).toBe(false);
  });

  it('every shared key is mapped by both host helpers', () => {
    const swift = fs.readFileSync('src/native/remote-desktop/macos/InstarDesktopHost.swift', 'utf8');
    const table = swift.slice(swift.indexOf('keyCodes: [String: CGKeyCode] = ['), swift.indexOf('private static func mouseButton'));
    for (const key of DESKTOP_KEYS) expect(table, `swift ${key}`).toContain(`"${key}":`);
    const cs = fs.readFileSync('src/native/remote-desktop/windows/InstarDesktopCompanion.cs', 'utf8');
    for (const key of DESKTOP_KEYS.filter(k => k.length > 1 && !/^F\d+$/.test(k))) {
      expect(cs, `windows ${key}`).toContain(`case "${key}":`);
    }
    expect(cs).toContain("key[0] >= 'a' && key[0] <= 'z'");
    expect(cs).toContain("key[0] >= '0' && key[0] <= '9'");
    expect(cs).toContain("f >= 1 && f <= 12");
  });
});
