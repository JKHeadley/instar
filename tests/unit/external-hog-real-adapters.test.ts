import { describe, it, expect } from 'vitest';
import {
  createExternalHogAdapters, parseLsofFdRecords, hasWritableUserFile, parseLaunchctlPids,
  type ExternalHogPrimitives, type ExternalHogAdapterOpts,
} from '../../src/monitoring/ExternalHogRealAdapters.js';
import type { Candidate } from '../../src/monitoring/ExternalHogSampler.js';
import { classContentHash, classIsArmed, type ArmMarker } from '../../src/monitoring/ExternalHogArmMarker.js';
import { classRuleSources } from '../../src/monitoring/ExternalHogFloor.js';

/**
 * ExternalHogRealAdapters — the impure edge (CMT-1901). It holds NO kill decision; these tests
 * prove it WIRES the reviewed modules correctly over fake primitives (no real process spawned or
 * signalled) and that the two safety-relevant reads are honest: the §4.5 kill-time CPU re-confirm
 * (a below-threshold reading forces sustainedHighCpu:false → the floor aborts), and the arm-status
 * composition. Plus the pure lsof/launchctl parsers.
 */

const OWN = 501;
const EXTHOST_ARGV = '/App/Code Helper (Plugin) --type=extensionHost --parentPid=4242';
const PS_TABLE = '9000 1 501 Wed Jul 2 10:00:00 2026 500:00.00 Code Helper (Plugin)';
const opts: ExternalHogAdapterOpts = {
  cpuCoreThreshold: 1.5, maxAncestorHops: 30, killTimeCpuRecheckWindowMs: 2500, killTimeCpuCoreThreshold: 0.5,
};

function candidate(): Candidate {
  return { pid: 9000, startTime: 'Wed Jul 2 10:00:00 2026', comm: 'Code Helper (Plugin)', coreEquivalents: 2.2 };
}

function mkPrims(over: Partial<ExternalHogPrimitives> & { cores?: number | null; modelReply?: string } = {}): {
  prims: ExternalHogPrimitives; signals: Array<{ pid: number; sig: string }>; attention: any[]; prompts: string[];
} {
  const signals: Array<{ pid: number; sig: string }> = [];
  const attention: any[] = [];
  const prompts: string[] = [];
  const prims: ExternalHogPrimitives = {
    exec: over.exec ?? (async (cmd, args) => {
      if (cmd === 'ps' && args.includes('args=')) return EXTHOST_ARGV;
      if (cmd === 'ps') return PS_TABLE;
      if (cmd === 'launchctl') return '42 0 com.apple.Something\n- 0 com.apple.NotRunning';
      if (cmd === 'lsof') return '';
      return '';
    }),
    signal: (pid, sig) => { signals.push({ pid, sig: String(sig) }); return true; },
    cpuCoresOver: over.cpuCoresOver ?? (async () => (over.cores === undefined ? 2.0 : over.cores)),
    callModel: async (p) => { prompts.push(p); return over.modelReply ?? '{"action":"kill"}'; },
    raiseAttention: (item) => { attention.push(item); return undefined; },
    now: () => 1000,
    ownEuid: () => OWN,
    serverPid: () => 1,
    listTmuxPanePids: async () => [],
    loadArm: over.loadArm ?? (() => ({ marker: null, lastDisarmEpoch: 0 })),
    config: over.config ?? (() => ({ enabled: true, dryRun: true })),
  };
  return { prims, signals, attention, prompts };
}

describe('pure parsers', () => {
  it('parseLaunchctlPids extracts running pids, skips "-" (not running)', () => {
    const pids = parseLaunchctlPids('42 0 com.apple.A\n- 0 com.apple.B\n99 0 com.apple.C');
    expect([...pids].sort((a, b) => a - b)).toEqual([42, 99]);
  });
  it('parseLsofFdRecords groups by fd; hasWritableUserFile finds a writable $HOME doc', () => {
    const out = 'f3\ntREG\naw\nn/Users/me/Projects/app/src/x.ts\nf4\ntREG\nar\nn/Users/me/Library/Caches/y';
    const recs = parseLsofFdRecords(out);
    expect(recs).toHaveLength(2);
    expect(hasWritableUserFile(out, { homeDir: '/Users/me' })).toBe(true); // fd3 is writable + under a project
  });
  it('hasWritableUserFile ignores a writable Library/cache file, and read-only files', () => {
    const cacheOnly = 'f3\ntREG\naw\nn/Users/me/Library/Caches/z\nf4\ntREG\nar\nn/Users/me/Projects/app/x.ts';
    expect(hasWritableUserFile(cacheOnly, { homeDir: '/Users/me' })).toBe(false);
  });
});

describe('createExternalHogAdapters — wiring over fakes', () => {
  it('readProcTable parses ps; ownedRefs resolves the server pid from the table', async () => {
    const { prims } = mkPrims({ exec: async (cmd) => (cmd === 'ps' ? `1 0 501 Wed Jul 2 09:00:00 2026 10:00.00 node\n${PS_TABLE}` : '') });
    const a = createExternalHogAdapters(prims, opts);
    const table = await a.readProcTable();
    expect(table.find((r) => r.pid === 9000)).toBeTruthy();
    const owned = await a.ownedRefs();
    expect(owned.get(1)).toBe('Wed Jul 2 09:00:00 2026'); // server pid 1 resolved to its startTime
  });

  it('factsFor builds facts for a candidate; identityFor is allowlist-gated', async () => {
    const { prims } = mkPrims();
    const a = createExternalHogAdapters(prims, opts);
    const table = await a.readProcTable();
    await a.ownedRefs();
    const facts = await a.factsFor(candidate(), table);
    expect(facts).toBeTruthy();
    expect(facts!.name).toBe('Code Helper (Plugin)');
    expect(facts!.ownerAppRunning).toBe(false); // parentPid 4242 absent → dead → kill-eligible
    const id = a.identityFor(candidate(), facts!);
    expect(id?.classId).toBe('vscode-exthost');
  });

  it('classify sends the model a prompt and returns its reply', async () => {
    const { prims, prompts } = mkPrims({ modelReply: '{"action":"leave"}' });
    const a = createExternalHogAdapters(prims, opts);
    const table = await a.readProcTable();
    await a.ownedRefs();
    const facts = await a.factsFor(candidate(), table);
    const reply = await a.classify(facts!);
    expect(reply).toBe('{"action":"leave"}');
    expect(prompts[0]).toContain('matched_allowlist_class: vscode-exthost');
    expect(prompts[0]).not.toContain('9000'); // the identity tuple (pid) is withheld
  });

  it('armStatus composes config + marker validity', () => {
    const marker: ArmMarker = { armEpoch: 5, armedBy: 'pin', armedAt: 't', allowlistSnapshot: {} };
    const { prims } = mkPrims({ config: () => ({ enabled: true, dryRun: false }), loadArm: () => ({ marker, lastDisarmEpoch: 4 }) });
    const a = createExternalHogAdapters(prims, opts);
    expect(a.armStatus()).toEqual({ enabled: true, dryRun: false, markerValid: true });
  });

  it('deliverNotices raises ONE attention item (kill → high priority)', () => {
    const { prims, attention } = mkPrims();
    const a = createExternalHogAdapters(prims, opts);
    a.deliverNotices({ emitted: [{ cls: 'kill', signature: 'k', text: 'auto-killed pid 9000' }], suppressedCount: 0 } as any);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ priority: 'high', source: 'external-hog-sentinel' });
  });
});

describe('killFunnelDeps — the §4.5 kill-time CPU re-confirm gates the signal', () => {
  it('a STILL-pinning process (cores >= threshold) → reReadFacts sets sustainedHighCpu:true', async () => {
    const { prims } = mkPrims({ cores: 2.0 });
    const a = createExternalHogAdapters(prims, opts);
    await a.readProcTable(); await a.ownedRefs();
    const facts = await a.killFunnelDeps.reReadFacts(9000, 'Wed Jul 2 10:00:00 2026');
    expect(facts?.sustainedHighCpu).toBe(true);
  });
  it('a process that WENT IDLE (cores below threshold) → sustainedHighCpu:false → floor will abort', async () => {
    const { prims } = mkPrims({ cores: 0.1 });
    const a = createExternalHogAdapters(prims, opts);
    await a.readProcTable(); await a.ownedRefs();
    const facts = await a.killFunnelDeps.reReadFacts(9000, 'Wed Jul 2 10:00:00 2026');
    expect(facts?.sustainedHighCpu).toBe(false); // the kill-time re-confirm caught the idle transition
  });
  it('a null CPU probe (pid gone / unreadable) → sustainedHighCpu:false (fail-safe)', async () => {
    const { prims } = mkPrims({ cores: null });
    const a = createExternalHogAdapters(prims, opts);
    await a.readProcTable(); await a.ownedRefs();
    const facts = await a.killFunnelDeps.reReadFacts(9000, 'Wed Jul 2 10:00:00 2026');
    expect(facts?.sustainedHighCpu).toBe(false);
  });
  it('identity changed (startTime mismatch on re-read) → null (aborts the kill)', async () => {
    const { prims } = mkPrims();
    const a = createExternalHogAdapters(prims, opts);
    await a.readProcTable(); await a.ownedRefs();
    expect(await a.killFunnelDeps.reReadFacts(9000, 'DIFFERENT START')).toBeNull();
  });
  it('currentClassContentHash matches the class rule sources (arm-scope agreement)', () => {
    const { prims } = mkPrims();
    const a = createExternalHogAdapters(prims, opts);
    const expected = classContentHash(classRuleSources('vscode-exthost')!);
    expect(a.killFunnelDeps.currentClassContentHash('vscode-exthost')).toBe(expected);
    // And it agrees with a marker armed via the same rule sources.
    const marker: ArmMarker = { armEpoch: 1, armedBy: 'pin', armedAt: 't', allowlistSnapshot: { 'vscode-exthost': expected } };
    expect(classIsArmed(marker, 'vscode-exthost', a.killFunnelDeps.currentClassContentHash('vscode-exthost'))).toBe(true);
  });
});
