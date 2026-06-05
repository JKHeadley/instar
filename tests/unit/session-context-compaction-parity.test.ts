/**
 * Compaction Parity — structural enforcement (constitution: docs/STANDARDS-REGISTRY.md
 * § Compaction Parity).
 *
 * Whatever a session must know at message one, it must still know after
 * compaction. Any session-context block (`/.../session-context`) the session-start hook injects at
 * boot MUST also be re-injected by the compaction-recovery hook — re-injected,
 * never presumed to survive in the compaction summary. (Earned from PR #811:
 * the boot self-knowledge block survived three review rounds boot-only; the
 * operator's "sessions last days" question caught it.)
 *
 * RATCHET: the allowlist below names the legacy boot-only injectors that
 * predate the standard. It may ONLY SHRINK. Adding a new injector to the
 * session-start hook without its compact twin fails this test; adding a name
 * to the allowlist is a constitutional violation, not a fix.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

/**
 * Legacy boot-only injectors, tracked as framework-issue
 * `session-context-injectors-lack-compaction-parity`. Shrink-only: remove an
 * entry when its compact-path twin lands. NEVER add to this list.
 */
const LEGACY_BOOT_ONLY_ALLOWLIST = [
  '/intent/org/session-context',
  '/preferences/session-context',
];

function hooks(): { bootHook: string; compactHook: string } {
  const tmp = path.join(os.tmpdir(), 'compaction-parity-probe');
  const migrator = new PostUpdateMigrator({
    projectDir: tmp,
    stateDir: path.join(tmp, '.instar'),
    port: 4042,
    authToken: 'parity-probe',
    agentName: 'parity-probe',
  });
  return {
    bootHook: migrator.getHookContent('session-start'),
    compactHook: migrator.getHookContent('compaction-recovery'),
  };
}

function extractSessionContextEndpoints(hookSource: string): string[] {
  const re = /(\/[a-z][a-z0-9/-]*\/session-context)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(hookSource)) !== null) found.add(m[1]);
  return [...found].sort();
}

describe('Compaction Parity (constitutional enforcement)', () => {
  it('every session-start */session-context injector has a compaction-recovery twin (allowlist shrink-only)', () => {
    const { bootHook, compactHook } = hooks();
    const bootEndpoints = extractSessionContextEndpoints(bootHook);

    // The probe must actually see the injector family — if extraction breaks,
    // the test must fail loudly rather than vacuously pass.
    expect(bootEndpoints.length).toBeGreaterThan(0);

    const bootOnly = bootEndpoints.filter((e) => !compactHook.includes(e));
    const violators = bootOnly.filter((e) => !LEGACY_BOOT_ONLY_ALLOWLIST.includes(e));

    expect(
      violators,
      `Boot-only session-context injector(s) with no compaction-recovery twin: ${violators.join(', ')}. ` +
        'Per Compaction Parity (docs/STANDARDS-REGISTRY.md), wire the same fetch into getCompactionRecovery() — ' +
        'do NOT add to the allowlist.',
    ).toEqual([]);
  });

  it('the allowlist only shrinks: entries that gained a compact twin must be removed', () => {
    const { compactHook } = hooks();
    const healed = LEGACY_BOOT_ONLY_ALLOWLIST.filter((e) => compactHook.includes(e));
    expect(
      healed,
      `Allowlist entries now have compact twins and must be removed from LEGACY_BOOT_ONLY_ALLOWLIST: ${healed.join(', ')}`,
    ).toEqual([]);
  });
});
