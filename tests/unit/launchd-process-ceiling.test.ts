import { describe, it, expect } from 'vitest';
import {
  LAUNCHD_PROCESS_CEILING_FLOOR,
  readLaunchdProcessCeilings,
  raiseLaunchdProcessCeilings,
} from '../../src/core/PostUpdateMigrator.js';
import { preserveHigherProcessCeiling } from '../../src/commands/setup.js';

/** The shape `installAutoStart` writes: Hard and Soft limits, each its own key. */
const plistWith = (hard: number, soft: number): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.instar.echo</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>HardResourceLimits</key>
    <dict>
        <key>NumberOfProcesses</key>
        <integer>${hard}</integer>
    </dict>
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfProcesses</key>
        <integer>${soft}</integer>
    </dict>
</dict>
</plist>`;

describe('readLaunchdProcessCeilings', () => {
  it('reads both the Hard and Soft ceilings', () => {
    expect(readLaunchdProcessCeilings(plistWith(512, 512))).toEqual([512, 512]);
  });
  it('returns empty for a plist declaring no ceiling (older / hand-rolled — a state, not an error)', () => {
    expect(readLaunchdProcessCeilings('<plist><dict><key>Label</key><string>x</string></dict></plist>')).toEqual([]);
  });
  it('tolerates whitespace between the key and its integer', () => {
    expect(
      readLaunchdProcessCeilings('<key>NumberOfProcesses</key>\n\t<integer> 700 </integer>'),
    ).toEqual([700]);
  });
  it('does not confuse a different key that carries an integer', () => {
    expect(readLaunchdProcessCeilings('<key>ThrottleInterval</key><integer>10</integer>')).toEqual([]);
  });
});

describe('raiseLaunchdProcessCeilings', () => {
  // THE DEFECT (observed live on a Mac Studio, 2026-08-19): NumberOfProcesses maps to
  // RLIMIT_NPROC, counted per real UID. A macOS desktop idles at ~530 user processes,
  // so a 512 ceiling sat BELOW the idle floor and every fork() from an agent shell
  // returned EAGAIN on an otherwise idle machine.
  it('raises the shipped 512 belt to the floor', () => {
    const out = raiseLaunchdProcessCeilings(plistWith(512, 512), LAUNCHD_PROCESS_CEILING_FLOOR);
    expect(readLaunchdProcessCeilings(out)).toEqual([
      LAUNCHD_PROCESS_CEILING_FLOOR,
      LAUNCHD_PROCESS_CEILING_FLOOR,
    ]);
  });

  it('is RAISE-ONLY — an operator who tuned theirs higher is never clobbered', () => {
    const tuned = plistWith(8192, 8192);
    expect(raiseLaunchdProcessCeilings(tuned, LAUNCHD_PROCESS_CEILING_FLOOR)).toBe(tuned);
  });

  it('is idempotent — a second pass over a migrated plist changes nothing', () => {
    const once = raiseLaunchdProcessCeilings(plistWith(512, 512), LAUNCHD_PROCESS_CEILING_FLOOR);
    expect(raiseLaunchdProcessCeilings(once, LAUNCHD_PROCESS_CEILING_FLOOR)).toBe(once);
  });

  it('raises only the low ceiling when Hard and Soft disagree', () => {
    const out = raiseLaunchdProcessCeilings(plistWith(4096, 512), LAUNCHD_PROCESS_CEILING_FLOOR);
    expect(readLaunchdProcessCeilings(out)).toEqual([4096, LAUNCHD_PROCESS_CEILING_FLOOR]);
  });

  it('leaves the rest of the plist byte-identical (surgical, not regenerated)', () => {
    const before = plistWith(512, 512);
    const after = raiseLaunchdProcessCeilings(before, LAUNCHD_PROCESS_CEILING_FLOOR);
    expect(after).toBe(before.replace(/<integer>512<\/integer>/g, `<integer>${LAUNCHD_PROCESS_CEILING_FLOOR}</integer>`));
    expect(after).toContain('<key>ThrottleInterval</key>\n    <integer>10</integer>');
  });

  it('never touches an unrelated integer key', () => {
    const out = raiseLaunchdProcessCeilings(plistWith(512, 512), LAUNCHD_PROCESS_CEILING_FLOOR);
    expect(out).toContain('<key>ThrottleInterval</key>\n    <integer>10</integer>');
  });

  it('the floor clears a real macOS desktop idle process count', () => {
    // 531 uid processes measured on the affected machine; the belt must clear it
    // with room for the agent's own work, not merely exceed it by a hair.
    expect(LAUNCHD_PROCESS_CEILING_FLOOR).toBeGreaterThan(531 * 2);
  });
});

describe('preserveHigherProcessCeiling — raise-only on the REGENERATING setup path', () => {
  // The migration is raise-only, but `setup` REWRITES the plist from the template. Without
  // this, a setup re-run silently clobbers an operator who deliberately raised their ceiling
  // for a heavy host — which would make the spec's "your change sticks" contract false.
  const tpl = (v: number) =>
    `<key>NumberOfProcesses</key>\n<integer>${v}</integer>\n<key>NumberOfProcesses</key>\n<integer>${v}</integer>`;

  it('carries an operator value ABOVE the template forward', () => {
    expect(preserveHigherProcessCeiling(tpl(2048), tpl(8192))).toContain('<integer>8192</integer>');
  });

  it('does NOT carry a stale LOW value forward — the template wins', () => {
    const out = preserveHigherProcessCeiling(tpl(2048), tpl(512));
    expect(out).toContain('<integer>2048</integer>');
    expect(out).not.toContain('<integer>512</integer>');
  });

  it('is a no-op on a first install (no previous plist)', () => {
    expect(preserveHigherProcessCeiling(tpl(2048), null)).toBe(tpl(2048));
  });

  it('is a no-op when the previous plist declares no ceiling', () => {
    expect(preserveHigherProcessCeiling(tpl(2048), '<key>Label</key><string>x</string>')).toBe(tpl(2048));
  });

  it('carries the HIGHEST previous value when the previous plist was half-raised', () => {
    const prev = `<key>NumberOfProcesses</key><integer>8192</integer><key>NumberOfProcesses</key><integer>512</integer>`;
    const out = preserveHigherProcessCeiling(tpl(2048), prev);
    expect(out).toContain('<integer>8192</integer>');
    expect(out).not.toContain('<integer>512</integer>');
  });

  it('leaves every other byte of the new template alone', () => {
    const next = `<key>Label</key><string>ai.instar.echo</string>\n${tpl(2048)}\n<key>KeepAlive</key><true/>`;
    const out = preserveHigherProcessCeiling(next, tpl(8192));
    expect(out).toContain('<key>Label</key><string>ai.instar.echo</string>');
    expect(out).toContain('<key>KeepAlive</key><true/>');
  });
});

describe('plist forms: the "safe no-op" claim, actually verified', () => {
  // The spec claims an unrecognised plist form yields NO match and therefore NO rewrite.
  // A claim of safety that no test exercises is the kind this project treats as unearned,
  // so each named form gets a case (round-9 review finding).
  const FLOOR = LAUNCHD_PROCESS_CEILING_FLOOR;

  it('malformed XML: no match, no rewrite, no throw', () => {
    const bad = '<plist><dict><key>NumberOfProcesses</key><integer>512';
    expect(readLaunchdProcessCeilings(bad)).toEqual([]);
    expect(raiseLaunchdProcessCeilings(bad, FLOOR)).toBe(bad);
  });

  it('an unparseable binary-ish blob: no match, no rewrite, no throw', () => {
    const bin = 'bplist00 NumberOfProcesses';
    expect(readLaunchdProcessCeilings(bin)).toEqual([]);
    expect(raiseLaunchdProcessCeilings(bin, FLOOR)).toBe(bin);
  });

  it('comments survive byte-for-byte around a raised value', () => {
    const withComment =
      '<!-- operator: raised for CI host, do not lower -->' +
      '<key>NumberOfProcesses</key><integer>512</integer>';
    const out = raiseLaunchdProcessCeilings(withComment, FLOOR);
    expect(out).toContain('<!-- operator: raised for CI host, do not lower -->');
    expect(out).toContain('<integer>' + FLOOR + '</integer>');
  });

  it('duplicate keys are each evaluated independently', () => {
    const dup =
      '<key>NumberOfProcesses</key><integer>512</integer>' +
      '<key>NumberOfProcesses</key><integer>8192</integer>';
    expect(readLaunchdProcessCeilings(dup)).toEqual([512, 8192]);
    const out = raiseLaunchdProcessCeilings(dup, FLOOR);
    expect(out).toContain('<integer>' + FLOOR + '</integer>');
    expect(out).toContain('<integer>8192</integer>');
  });

  it('Soft-before-Hard and Hard-before-Soft both raise correctly (order-independent)', () => {
    const hardFirst =
      '<dict><key>HardResourceLimits</key><dict><key>NumberOfProcesses</key>' +
      '<integer>512</integer></dict><key>SoftResourceLimits</key><dict>' +
      '<key>NumberOfProcesses</key><integer>512</integer></dict></dict>';
    for (const p of [plistWith(512, 512), hardFirst]) {
      expect(readLaunchdProcessCeilings(raiseLaunchdProcessCeilings(p, FLOOR))).toEqual([FLOOR, FLOOR]);
    }
  });

  it('a value nested deeper than expected is still found and raised', () => {
    const nested =
      '<dict><key>Outer</key><dict><key>Inner</key><dict>' +
      '<key>NumberOfProcesses</key><integer>512</integer></dict></dict></dict>';
    expect(raiseLaunchdProcessCeilings(nested, FLOOR)).toContain('<integer>' + FLOOR + '</integer>');
  });

  it('a decoy that only LOOKS like the key is not rewritten', () => {
    const decoy = '<string>NumberOfProcesses</string><integer>512</integer>';
    expect(readLaunchdProcessCeilings(decoy)).toEqual([]);
    expect(raiseLaunchdProcessCeilings(decoy, FLOOR)).toBe(decoy);
  });
});
