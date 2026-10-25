/**
 * instar#2122: `instar join` installs a standby's LaunchAgent with
 * `server start` (no Telegram config exists at join time, and the lifeline
 * requires one). Once Telegram is configured, server boot must switch the
 * LaunchAgent to the lifeline supervisor, as on the first machine.
 */
import { describe, it, expect } from 'vitest';
import { autoStartNeedsLifeline } from '../../src/commands/setup.js';

const plist = (args: string[]) =>
  `<plist><dict><key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array></dict></plist>`;

describe('autoStartNeedsLifeline', () => {
  const serverPlist = plist(['/x/.instar/bin/node', '/x/.instar/instar-boot.cjs', 'server', 'start', '--foreground', '--dir', '/x']);
  const lifelinePlist = plist(['/x/.instar/bin/node', '/x/.instar/instar-boot.cjs', 'lifeline', 'start', '--dir', '/x']);

  it('asks for the lifeline when Telegram is configured but the plist starts the bare server', () => {
    expect(autoStartNeedsLifeline(serverPlist, true)).toBe(true);
  });
  it('leaves a lifeline plist alone', () => {
    expect(autoStartNeedsLifeline(lifelinePlist, true)).toBe(false);
  });
  it('leaves a server plist alone when Telegram is not configured (the lifeline would refuse to start)', () => {
    expect(autoStartNeedsLifeline(serverPlist, false)).toBe(false);
  });
});
