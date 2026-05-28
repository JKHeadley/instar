/**
 * Unit tests for buildLaunchAgentPlist — the runtime-root-aware LaunchAgent
 * plist. Verifies the macOS 26 TCC fix: nothing launchd touches on boot points
 * into a TCC-protected folder.
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope A).
 */

import { describe, it, expect } from 'vitest';
import { buildLaunchAgentPlist } from '../../src/commands/setup.js';

const ROOT = '/Users/test/Library/Application Support/instar/foo-abc12345';

function plistForRoot(root: string): string {
  return buildLaunchAgentPlist({
    label: 'ai.instar.foo',
    programArgs: [
      `${root}/bin/node`,
      `${root}/instar-boot.cjs`,
      'lifeline',
      'start',
      '--dir',
      '/Users/test/Documents/Projects/foo',
      '--runtime-root',
      root,
    ],
    workingDirectory: root,
    stdoutPath: `${root}/logs/lifeline-launchd.log`,
    stderrPath: `${root}/logs/lifeline-launchd.err`,
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
  });
}

describe('buildLaunchAgentPlist', () => {
  const plist = plistForRoot(ROOT);

  it('spawns node from the runtime root, never from Documents', () => {
    expect(plist).toContain(`<string>${ROOT}/bin/node</string>`);
    // The node executable launchd posix_spawns must NOT be under a TCC folder.
    expect(plist).not.toMatch(/<string>[^<]*\/Documents\/[^<]*\/bin\/node<\/string>/);
  });

  it('passes --runtime-root so the boot path resolves state without the Documents symlink', () => {
    expect(plist).toContain('<string>--runtime-root</string>');
    expect(plist).toContain(`<string>${ROOT}</string>`);
  });

  it('points WorkingDirectory at the runtime root (not the Documents project dir)', () => {
    expect(plist).toMatch(
      new RegExp(`<key>WorkingDirectory</key>\\s*<string>${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`),
    );
  });

  it('writes launchd logs into the runtime root (fixes the 0-byte-log symptom)', () => {
    expect(plist).toContain(`<string>${ROOT}/logs/lifeline-launchd.log</string>`);
    expect(plist).toContain(`<string>${ROOT}/logs/lifeline-launchd.err</string>`);
    // The log paths must not be under a TCC folder, or launchd can't create them.
    expect(plist).not.toMatch(/<string>[^<]*\/Documents\/[^<]*launchd\.(log|err)<\/string>/);
  });

  it('keeps KeepAlive + RunAtLoad + INSTAR_SUPERVISED + ThrottleInterval', () => {
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>INSTAR_SUPERVISED</key>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
  });

  it('is well-formed XML with a single dict and escapes special chars', () => {
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true);
    expect(plist).toContain('<plist version="1.0">');
    expect((plist.match(/<dict>/g) || []).length).toBe(2); // root dict + EnvironmentVariables dict
    const amped = buildLaunchAgentPlist({
      label: 'ai.instar.a&b',
      programArgs: ['/x & y/node'],
      workingDirectory: '/x & y',
      stdoutPath: '/x/o.log',
      stderrPath: '/x/e.log',
      pathEnv: '/bin',
    });
    expect(amped).toContain('a&amp;b');
    expect(amped).not.toMatch(/<string>[^<]*[^&]& [^<]*<\/string>/); // raw ' & ' not left unescaped
  });

  it('a non-relocated agent (root under .instar) still produces a valid plist', () => {
    // Backward-compat: when root defaults to <projectDir>/.instar the builder is
    // unchanged in shape — only the paths differ.
    const legacyRoot = '/Users/test/.instar/agents/echo/.instar';
    const p = plistForRoot(legacyRoot);
    expect(p).toContain(`<string>${legacyRoot}/bin/node</string>`);
    expect(p).toContain('<string>--runtime-root</string>');
  });
});
