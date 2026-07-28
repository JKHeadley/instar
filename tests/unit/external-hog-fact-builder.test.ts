import { describe, it, expect } from 'vitest';
import {
  parseParentPid, lstartToEpochMs, deriveOwnerAppRunning, buildFacts, buildIdentity,
  type FactBuilderInput,
} from '../../src/monitoring/ExternalHogFactBuilder.js';
import type { ProcTableRow } from '../../src/monitoring/ExternalHogProcTable.js';
import type { ProcTree, ProcNode } from '../../src/monitoring/ExternalHogOwnership.js';
import { evaluateKillFloor } from '../../src/monitoring/ExternalHogFloor.js';

/**
 * ExternalHogFactBuilder — the stage-2 deterministic fact + identity derivation (CMT-1901 §2/§4).
 * The load-bearing property is ownerAppRunning polarity (true = veto, false = kill-eligible) and
 * its round-8 reused-parent-pid rule. Also covered: uid/launchctl/instar-owned facts and the
 * allowlist-gated identity. Facts are validated by evaluating them through the REAL floor.
 */

const OWN = 501;
const EXTHOST_ARGV = '/Applications/VS.app/Code Helper (Plugin) --type=extensionHost --parentPid=4242';

function node(pid: number, startTime: string, ppid = 1): ProcNode {
  return { pid, ppid, startTime };
}
function row(over: Partial<ProcTableRow> = {}): ProcTableRow {
  return { pid: 9000, ppid: 1, uid: OWN, startTime: 'Wed Jul 2 10:00:00 2026', cputimeSeconds: 500, comm: 'Code Helper (Plugin)', ...over };
}
function input(over: Partial<FactBuilderInput> = {}): FactBuilderInput {
  return {
    row: row(), argv: EXTHOST_ARGV, tree: new Map(), ownedRefs: new Map(),
    maxAncestorHops: 30, ownEuid: OWN, launchctlLabeledPids: new Set(), sustainedThisWindow: true,
    ...over,
  };
}

describe('parseParentPid', () => {
  it('extracts --parentPid=N', () => expect(parseParentPid(EXTHOST_ARGV)).toBe(4242));
  it('returns null when absent', () => expect(parseParentPid('/App/Code Helper (Plugin) --type=extensionHost')).toBeNull());
  it('returns null on a non-positive/garbage value', () => expect(parseParentPid('--parentPid=0')).toBeNull());
});

describe('lstartToEpochMs — ORDERING only, fail-safe null', () => {
  it('parses a real lstart and orders correctly', () => {
    const early = lstartToEpochMs('Wed Jul 2 10:00:00 2026')!;
    const late = lstartToEpochMs('Wed Jul 2 11:00:00 2026')!;
    expect(late).toBeGreaterThan(early);
  });
  it('returns null on unparseable input (→ caller fails safe)', () => {
    expect(lstartToEpochMs('not a date')).toBeNull();
    expect(lstartToEpochMs('')).toBeNull();
  });
});

describe('deriveOwnerAppRunning — the load-bearing polarity (true = veto, false = kill-eligible)', () => {
  it('no --parentPid → owner cannot be established → TRUE (veto)', () => {
    expect(deriveOwnerAppRunning(row(), '/App/Code Helper (Plugin) --type=extensionHost', new Map())).toBe(true);
  });
  it('--parentPid ABSENT from the table → parent dead → FALSE (kill-eligible)', () => {
    expect(deriveOwnerAppRunning(row(), EXTHOST_ARGV, new Map())).toBe(false); // 4242 not in tree
  });
  it('--parentPid ALIVE and OLDER than the child → live real parent → TRUE (veto)', () => {
    const tree: ProcTree = new Map([[4242, node(4242, 'Wed Jul 2 09:00:00 2026')]]); // parent older
    expect(deriveOwnerAppRunning(row({ startTime: 'Wed Jul 2 10:00:00 2026' }), EXTHOST_ARGV, tree)).toBe(true);
  });
  it('--parentPid present but NEWER than the child → pid reused, real parent dead → FALSE (kill-eligible)', () => {
    const tree: ProcTree = new Map([[4242, node(4242, 'Wed Jul 2 11:00:00 2026')]]); // occupant newer than child
    expect(deriveOwnerAppRunning(row({ startTime: 'Wed Jul 2 10:00:00 2026' }), EXTHOST_ARGV, tree)).toBe(false);
  });
  it('start-times un-orderable (unparseable) → fail-safe TRUE (veto)', () => {
    const tree: ProcTree = new Map([[4242, node(4242, 'garbage')]]);
    expect(deriveOwnerAppRunning(row({ startTime: 'garbage' }), EXTHOST_ARGV, tree)).toBe(true);
  });
});

describe('buildFacts — assembles the floor input; validated through the REAL floor', () => {
  it('a genuine orphaned same-uid exthost hog → the floor PERMITS', () => {
    const facts = buildFacts(input())!; // parentPid 4242 absent → ownerAppRunning false
    expect(facts.ownerAppRunning).toBe(false);
    expect(facts.sustainedHighCpu).toBe(true);
    expect(facts.targetUid).toBe(OWN);
    expect(evaluateKillFloor(facts).permitted).toBe(true);
  });
  it('a root-owned process is flagged ownerRootDaemon → floor vetoes system-root-daemon', () => {
    const facts = buildFacts(input({ row: row({ uid: 0 }), ownEuid: 0 }))!;
    expect(facts.ownerRootDaemon).toBe(true);
    expect(evaluateKillFloor(facts).permitted).toBe(false);
  });
  it('a launchctl-labeled pid is flagged → floor vetoes launchctl-labeled', () => {
    const facts = buildFacts(input({ launchctlLabeledPids: new Set([9000]) }))!;
    expect(facts.hasLaunchctlLabel).toBe(true);
    expect(evaluateKillFloor(facts).permitted).toBe(false);
  });
  it('a non-sustained candidate → sustainedHighCpu false → floor vetoes not-sustained-hog', () => {
    const facts = buildFacts(input({ sustainedThisWindow: false }))!;
    expect(facts.sustainedHighCpu).toBe(false);
    expect(evaluateKillFloor(facts).permitted).toBe(false);
  });
  it('a structurally-unusable row (bad pid) → null', () => {
    expect(buildFacts(input({ row: row({ pid: 0 }) }))).toBeNull();
  });
});

describe('buildIdentity — allowlist-gated, stable command-hash', () => {
  it('an allowlist-matching exthost → classId + commandHash + ledgerKey', () => {
    const id = buildIdentity(buildFacts(input())!)!;
    expect(id.classId).toBe('vscode-exthost');
    expect(id.commandHash).toMatch(/^[0-9a-f]{64}$/);
    expect(id.ledgerKey).toBe(`vscode-exthost:${id.commandHash}`);
  });
  it('the command-hash is STABLE across a changed --parentPid (breaker counts respawns of the same command)', () => {
    const a = buildIdentity(buildFacts(input({ argv: EXTHOST_ARGV }))!)!;
    const b = buildIdentity(buildFacts(input({ argv: EXTHOST_ARGV.replace('4242', '5555') }))!)!;
    expect(b.commandHash).toBe(a.commandHash); // volatile parentPid stripped before hashing
  });
  it('a process OUTSIDE the allowlist → null (not kill-eligible)', () => {
    const facts = buildFacts(input({ row: row({ comm: 'some-random-daemon' }), argv: '/usr/bin/some-random-daemon' }))!;
    expect(buildIdentity(facts)).toBeNull();
  });
});
