import { describe, expect, it } from 'vitest';
import { MacDisplayWake, parseConsoleLocked, realDisplayWakeBlockedUnderTest, macDisplayWakePorts } from '../../src/core/MacDisplayWake.js';

const root = (value: string, nested = '') => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>IOConsoleLocked</key>
\t${value}
\t<key>IOConsoleUsers</key>
\t<array>
\t\t<dict>
${nested}\t\t\t<key>CGSSessionScreenIsLocked</key>
\t\t\t<true/>
\t\t</dict>
\t</array>
</dict>
</plist>
`;

describe('parseConsoleLocked', () => {
  it('reads the Root entry key only', () => {
    expect(parseConsoleLocked(root('<true/>'))).toBe(true);
    expect(parseConsoleLocked(root('<false/>'))).toBe(false);
    expect(parseConsoleLocked(root('<integer>1</integer>'))).toBeNull();
    expect(parseConsoleLocked('')).toBeNull();
    // A nested key of the same name never answers.
    const nestedOnly = root('<false/>').replace('\t<key>IOConsoleLocked</key>\n\t<false/>\n', '');
    expect(parseConsoleLocked(nestedOnly.replace('\t\t\t<key>CGSSessionScreenIsLocked</key>', '\t\t\t<key>IOConsoleLocked</key>\n\t\t\t<false/>\n\t\t\t<key>CGSSessionScreenIsLocked</key>'))).toBeNull();
  });
});

describe('MacDisplayWake', () => {
  const ports = (plist: string | Error, activity: Error | null = null) => {
    let declared = 0;
    return {
      declared: () => declared,
      ports: {
        readIoreg: async () => { if (plist instanceof Error) throw plist; return plist; },
        declareActivity: async () => { declared++; if (activity) throw activity; },
      },
    };
  };

  it('wakes only when macOS says the console is not locked', async () => {
    const open = ports(root('<false/>'));
    expect(await new MacDisplayWake(open.ports).wake()).toBe('woke');
    expect(open.declared()).toBe(1);
  });

  it('never wakes a locked console', async () => {
    const locked = ports(root('<true/>'));
    expect(await new MacDisplayWake(locked.ports).wake()).toBe('console-locked');
    expect(locked.declared()).toBe(0);
  });

  it('never wakes when the console lock is unreadable', async () => {
    for (const plist of [new Error('ioreg failed'), '', root('<string>no</string>')]) {
      const unread = ports(plist);
      expect(await new MacDisplayWake(unread.ports).wake()).toBe('unknown');
      expect(unread.declared()).toBe(0);
    }
  });

  it('reports a wake that could not start as unknown', async () => {
    const failing = ports(root('<false/>'), new Error('spawn failed'));
    expect(await new MacDisplayWake(failing.ports).wake()).toBe('unknown');
  });

  it('the real ports refuse under the test runner without the opt-in', async () => {
    expect(realDisplayWakeBlockedUnderTest({ VITEST: 'true' })).toBe(true);
    expect(realDisplayWakeBlockedUnderTest({ VITEST: 'true', INSTAR_REAL_DESKTOP_HELPER_TESTS: '1' })).toBe(false);
    expect(realDisplayWakeBlockedUnderTest({})).toBe(false);
    if (process.env.INSTAR_REAL_DESKTOP_HELPER_TESTS === '1') return;
    await expect(macDisplayWakePorts.readIoreg()).rejects.toThrow(/blocked-under-test/);
    await expect(macDisplayWakePorts.declareActivity()).rejects.toThrow(/blocked-under-test/);
    expect(await new MacDisplayWake().wake()).toBe('unknown');
  });
});
