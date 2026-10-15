// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup only.

/**
 * Tier-1 unit tests — TccProtectedPathGuard (Avoid TCC-Protected Directories,
 * docs/STANDARDS-REGISTRY.md). Both sides of every decision boundary:
 *  - macOS + protected zone → refused / detected; macOS + safe path → clear;
 *  - Linux → NEVER protected, whatever the path (platform honesty);
 *  - symlink AT the old path (after a move) → not a finding;
 *  - symlink INTO a protected zone → a finding;
 *  - a not-yet-existing target (fresh init) is judged by its existing parent;
 *  - ONE aggregated attention item per run; JSONL fallback dedupes for 24h;
 *  - the /guards getter reads enabled + lastTickAt, verdictUnknown on error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  assertNotTccProtected,
  buildTccAttentionItem,
  classifyTccProtectedPath,
  describeTccProtectedPath,
  realpathOfLongestExistingPrefix,
  runTccProtectedPathDetection,
  summarizeTccDetection,
  tccGuardStatus,
  tccProtectedZones,
  TccProtectedPathRefusal,
  TCC_GUARD_KEY,
  TCC_MOVE_RUNBOOK,
  type TccAttentionItemInput,
} from '../../src/core/TccProtectedPathGuard.js';

let home: string;

beforeEach(() => {
  // A fake HOME with the four protected folders and a safe sibling.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-guard-home-'));
  for (const d of ['Documents/Projects', 'Desktop', 'Downloads', 'Library/Mobile Documents/com~apple~CloudDocs', 'Projects', '.instar/agents']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/tcc-protected-path-guard.test.ts' });
});

const darwin = () => ({ platform: 'darwin', homeDir: home });
const linux = () => ({ platform: 'linux', homeDir: home });

describe('tccProtectedZones', () => {
  it('enumerates exactly Documents, Desktop, Downloads and iCloud Drive under the given home', () => {
    const zones = tccProtectedZones(home);
    expect(zones.map((z) => z.zone)).toEqual(['Documents', 'Desktop', 'Downloads', 'iCloud Drive']);
    expect(zones[3].root).toBe(fs.realpathSync(path.join(home, 'Library', 'Mobile Documents')));
  });
});

describe('classifyTccProtectedPath — macOS', () => {
  it('a project directory under ~/Documents/Projects is protected (zone Documents)', () => {
    const c = classifyTccProtectedPath(path.join(home, 'Documents', 'Projects', 'monroe-workspace'), darwin());
    expect(c.protected).toBe(true);
    expect(c.zone).toBe('Documents');
    expect(c.zoneRoot).toBe(fs.realpathSync(path.join(home, 'Documents')));
  });

  it.each([
    ['Desktop', 'Desktop/agent'],
    ['Downloads', 'Downloads/agent'],
    ['iCloud Drive', 'Library/Mobile Documents/com~apple~CloudDocs/agent'],
  ] as const)('%s is protected too', (zone, rel) => {
    const c = classifyTccProtectedPath(path.join(home, rel), darwin());
    expect(c.protected).toBe(true);
    expect(c.zone).toBe(zone);
  });

  it('the zone root itself counts (an agent home AT ~/Documents)', () => {
    expect(classifyTccProtectedPath(path.join(home, 'Documents'), darwin()).protected).toBe(true);
  });

  it('a sibling that merely shares the prefix string is NOT protected (DocumentsArchive)', () => {
    fs.mkdirSync(path.join(home, 'DocumentsArchive'));
    expect(classifyTccProtectedPath(path.join(home, 'DocumentsArchive', 'x'), darwin()).protected).toBe(false);
  });

  it('~/.instar/agents/<name> and ~/Projects/<name> are clear', () => {
    expect(classifyTccProtectedPath(path.join(home, '.instar', 'agents', 'echo'), darwin()).protected).toBe(false);
    expect(classifyTccProtectedPath(path.join(home, 'Projects', 'ai-guy'), darwin()).protected).toBe(false);
  });

  it('a NOT-YET-EXISTING target (fresh `instar init <name>`) is judged by its existing parent', () => {
    const fresh = path.join(home, 'Documents', 'Projects', 'does-not-exist-yet', 'deeper');
    expect(fs.existsSync(fresh)).toBe(false);
    const c = classifyTccProtectedPath(fresh, darwin());
    expect(c.protected).toBe(true);
    expect(c.realPath).toBe(path.join(fs.realpathSync(path.join(home, 'Documents', 'Projects')), 'does-not-exist-yet', 'deeper'));
  });

  it('a symlink LEFT AT THE OLD PATH after a move resolves outside and is NOT a finding', () => {
    const real = path.join(home, 'Projects', 'ai-guy');
    fs.mkdirSync(real);
    const old = path.join(home, 'Documents', 'Projects', 'ai-guy');
    fs.symlinkSync(real, old);
    const c = classifyTccProtectedPath(old, darwin());
    expect(c.protected).toBe(false);
    expect(c.realPath).toBe(fs.realpathSync(real));
  });

  it('a symlink INTO a protected zone resolves inside and IS a finding (the trap)', () => {
    const real = path.join(home, 'Documents', 'Projects', 'codey');
    fs.mkdirSync(real);
    const link = path.join(home, 'Projects', 'codey');
    fs.symlinkSync(real, link);
    const c = classifyTccProtectedPath(link, darwin());
    expect(c.protected).toBe(true);
    expect(c.zone).toBe('Documents');
  });

  it('relative paths are resolved against cwd before classification', () => {
    const c = classifyTccProtectedPath('.', darwin());
    expect(c.realPath).toBe(fs.realpathSync(process.cwd()));
  });
});

describe('classifyTccProtectedPath — platform honesty', () => {
  it('on Linux the SAME ~/Documents path is never protected', () => {
    const c = classifyTccProtectedPath(path.join(home, 'Documents', 'Projects', 'agent'), linux());
    expect(c.protected).toBe(false);
    expect(c.zone).toBeNull();
    expect(c.platform).toBe('linux');
  });

  it('on win32 likewise (not darwin ⇒ not applicable)', () => {
    expect(classifyTccProtectedPath(path.join(home, 'Desktop', 'agent'), { platform: 'win32', homeDir: home }).protected).toBe(false);
  });
});

describe('realpathOfLongestExistingPrefix', () => {
  it('returns realpath for an existing path and appends the missing tail otherwise', () => {
    expect(realpathOfLongestExistingPrefix(home)).toBe(fs.realpathSync(home));
    expect(realpathOfLongestExistingPrefix(path.join(home, 'a', 'b'))).toBe(path.join(fs.realpathSync(home), 'a', 'b'));
  });
});

describe('assertNotTccProtected — the creation refusal', () => {
  it('REFUSES a protected location on macOS with a typed error naming the zone and the runbook', () => {
    const target = path.join(home, 'Documents', 'Projects', 'new-agent');
    let caught: unknown;
    try {
      assertNotTccProtected(target, 'the new project directory', darwin());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TccProtectedPathRefusal);
    const refusal = caught as TccProtectedPathRefusal;
    expect(refusal.classification.zone).toBe('Documents');
    expect(refusal.message).toContain('tcc-protected-path: refused');
    expect(refusal.message).toContain('~/Documents');
    expect(refusal.message).toContain(TCC_MOVE_RUNBOOK);
    expect(refusal.message).toContain('at all costs');
  });

  it('returns the classification (no throw) for a safe location on macOS', () => {
    const c = assertNotTccProtected(path.join(home, 'Projects', 'new-agent'), 'the new project directory', darwin());
    expect(c.protected).toBe(false);
  });

  it('never refuses on Linux, even under ~/Documents', () => {
    expect(() => assertNotTccProtected(path.join(home, 'Documents', 'x'), 'the project directory', linux())).not.toThrow();
  });

  it('has no override parameter (the refusal is absolute by signature)', () => {
    // 3 params: path, what, opts — opts carries ONLY platform/homeDir injection.
    expect(assertNotTccProtected.length).toBeLessThanOrEqual(3);
    const text = assertNotTccProtected.toString();
    expect(text).not.toMatch(/override|force|allow/i);
  });

  it('describeTccProtectedPath names the resolved path when it differs from the given one', () => {
    const real = path.join(home, 'Documents', 'Projects', 'codey');
    fs.mkdirSync(real);
    const link = path.join(home, 'Projects', 'codey');
    fs.symlinkSync(real, link);
    const text = describeTccProtectedPath(classifyTccProtectedPath(link, darwin()), 'the project directory');
    expect(text).toContain('resolves to');
    expect(text).toContain(fs.realpathSync(real));
  });
});

describe('runTccProtectedPathDetection — boot-time signal', () => {
  it('macOS + protected project dir → ONE aggregated HIGH item naming the path, the zone and the runbook; nothing moved', async () => {
    const projectDir = path.join(home, 'Documents', 'Projects', 'instar-codey');
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const emitted: TccAttentionItemInput[] = [];
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir, ...darwin(),
      extraPaths: [{ label: 'vault', path: path.join(stateDir, 'secrets') }],
      emitAttention: async (item) => { emitted.push(item); },
    });
    expect(result.applicable).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.checked).toHaveLength(3);
    expect(result.protectedPaths.map((p) => p.label)).toEqual(['project directory', 'state directory', 'vault']);
    expect(result.emitted).toBe(1); // ← the Bounded Notification Surface invariant
    expect(emitted).toHaveLength(1);
    const item = emitted[0];
    expect(item.id).toMatch(/^tcc-protected-path:[0-9a-f]{16}$/);
    expect(item.priority).toBe('HIGH');
    expect(item.category).toBe('tcc-protected-path');
    expect(item.sourceContext).toBe('tcc-protected-path-guard');
    expect(item.title).toContain('Documents');
    expect(item.summary).toContain(projectDir);
    expect(item.summary).toContain(TCC_MOVE_RUNBOOK);
    expect(item.summary).toContain('Nothing was moved');
    expect(item.description).toContain('AVOIDED AT ALL COSTS');
    expect(fs.existsSync(projectDir)).toBe(true); // still there — the guard never moves
  });

  it('the item id is stable for the same finding set and changes when the set changes', () => {
    const a = buildTccAttentionItem([{ label: 'project directory', path: '/x', realPath: '/x', zone: 'Documents' }]);
    const b = buildTccAttentionItem([{ label: 'project directory', path: '/x', realPath: '/x', zone: 'Documents' }]);
    const c = buildTccAttentionItem([{ label: 'project directory', path: '/y', realPath: '/y', zone: 'Desktop' }]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it('macOS + safe location → applicable, no findings, nothing emitted', async () => {
    const projectDir = path.join(home, '.instar', 'agents', 'echo');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const emitted: TccAttentionItemInput[] = [];
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir: path.join(projectDir, '.instar'), ...darwin(),
      emitAttention: async (item) => { emitted.push(item); },
    });
    expect(result.applicable).toBe(true);
    expect(result.protectedPaths).toEqual([]);
    expect(result.emitted).toBe(0);
    expect(emitted).toEqual([]);
    expect(summarizeTccDetection(result)).toContain('clear');
  });

  it('Linux + the same ~/Documents layout → not applicable, no findings, nothing emitted (never misfires)', async () => {
    const projectDir = path.join(home, 'Documents', 'Projects', 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const emitted: TccAttentionItemInput[] = [];
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir: path.join(projectDir, '.instar'), ...linux(),
      emitAttention: async (item) => { emitted.push(item); },
    });
    expect(result.applicable).toBe(false);
    expect(result.protectedPaths).toEqual([]);
    expect(result.emitted).toBe(0);
    expect(emitted).toEqual([]);
    expect(summarizeTccDetection(result)).toContain('not applicable on linux');
  });

  it('without Telegram: JSONL fallback under <stateDir>/audit, deduped for 24h, re-emitted after', async () => {
    const projectDir = path.join(home, 'Desktop', 'agent');
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    let t = Date.parse('2026-10-15T00:00:00Z');
    const now = () => t;
    const r1 = await runTccProtectedPathDetection({ projectDir, stateDir, ...darwin(), now });
    expect(r1.emitted).toBe(1);
    const fallback = path.join(stateDir, 'audit', 'tcc-protected-path.jsonl');
    expect(fs.existsSync(fallback)).toBe(true);
    const line = JSON.parse(fs.readFileSync(fallback, 'utf-8').trim().split('\n')[0]);
    expect(line.dedupeKey).toMatch(/^tcc-protected-path:/);
    expect(line.priority).toBe('HIGH');

    t += 60 * 60 * 1000; // +1h — inside the window
    const r2 = await runTccProtectedPathDetection({ projectDir, stateDir, ...darwin(), now });
    expect(r2.emitted).toBe(0);
    expect(r2.deduped).toBe(1);

    t += 24 * 60 * 60 * 1000; // past the window
    const r3 = await runTccProtectedPathDetection({ projectDir, stateDir, ...darwin(), now });
    expect(r3.emitted).toBe(1);
    expect(fs.readFileSync(fallback, 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('a throwing attention sink is captured as result.emitError (the verdict stands), never thrown out of boot', async () => {
    const projectDir = path.join(home, 'Downloads', 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir: path.join(projectDir, '.instar'), ...darwin(),
      emitAttention: async () => { throw new Error('telegram down'); },
    });
    expect(result.emitError).toBe('telegram down');
    expect(result.error).toBeUndefined();
    expect(result.protectedPaths).toHaveLength(2);
    const line = summarizeTccDetection(result);
    expect(line).toContain('TCC-PROTECTED PATH');
    expect(line).toContain(projectDir);
    expect(line).toContain('attention sink failed: telegram down');
  });

  it('the boot line for a finding is loud and names the runbook', async () => {
    const projectDir = path.join(home, 'Documents', 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir: path.join(projectDir, '.instar'), ...darwin(), emitAttention: async () => {},
    });
    const line = summarizeTccDetection(result);
    expect(line).toContain('TCC-PROTECTED PATH');
    expect(line).toContain(projectDir);
    expect(line).toContain(TCC_MOVE_RUNBOOK);
    expect(line).toContain('Nothing was moved');
  });
});

describe('tccGuardStatus — the /guards runtime getter', () => {
  it('reads enabled + lastTickAt = checkedAt after a clean check', async () => {
    const projectDir = path.join(home, 'Projects', 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const result = await runTccProtectedPathDetection({ projectDir, stateDir: path.join(projectDir, '.instar'), ...darwin(), now: () => 1_700_000_000_000 });
    const status = tccGuardStatus(result);
    expect(status).toEqual({ enabled: true, lastTickAt: 1_700_000_000_000 });
    expect(TCC_GUARD_KEY).toBe('monitoring.tccProtectedPathGuard');
  });

  it('reads verdictUnknown (never green) when the CLASSIFICATION failed, and lastTickAt 0 before any check', async () => {
    const projectDir = path.join(home, 'Documents', 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const ok = await runTccProtectedPathDetection({
      projectDir, stateDir: path.join(projectDir, '.instar'), ...darwin(), emitAttention: async () => { throw new Error('sink down'); },
    });
    // A sink failure degrades DELIVERY only — the verdict stands, the row is not blind.
    expect(tccGuardStatus(ok).verdictUnknown).toBeUndefined();
    const failed = { ...ok, error: 'boom' };
    const status = tccGuardStatus(failed);
    expect(status.enabled).toBe(true);
    expect(status.verdictUnknown).toBe(true);
    expect(status.verdictUnknownReason).toContain('boom');
    expect(tccGuardStatus(null)).toEqual({ enabled: true, lastTickAt: 0 });
  });
});

// ── Second-pass review findings (2026-10-15) ─────────────────────────────

/** True when the tmpdir's filesystem is case-insensitive (default APFS). */
function tmpIsCaseInsensitive(root: string): boolean {
  const probe = path.join(root, 'CaseProbe');
  fs.mkdirSync(probe, { recursive: true });
  return fs.existsSync(path.join(root, 'caseprobe'));
}

describe('case-insensitive filesystems (second-pass finding #1)', () => {
  it('a differently-cased ~/documents/... path is STILL a finding on a case-insensitive FS', () => {
    if (!tmpIsCaseInsensitive(home)) return; // case-sensitive FS: the spelling is a different directory by definition
    const lower = path.join(home, 'documents', 'projects', 'agent');
    const c = classifyTccProtectedPath(lower, darwin());
    expect(c.protected).toBe(true);
    expect(c.zone).toBe('Documents');
    expect(() => assertNotTccProtected(lower, 'the project directory', darwin())).toThrow(TccProtectedPathRefusal);
  });

  it('realpathOfLongestExistingPrefix returns the on-disk case, not the caller\'s', () => {
    if (!tmpIsCaseInsensitive(home)) return;
    const real = realpathOfLongestExistingPrefix(path.join(home, 'documents'));
    expect(path.basename(real)).toBe('Documents');
  });
});

describe('attention sink robustness (second-pass findings #2, #6, #7)', () => {
  const protectedAgent = () => {
    const projectDir = path.join(home, 'Documents', 'Projects', 'agent');
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    return { projectDir, stateDir };
  };

  it('a hung sink is bounded by emitTimeoutMs and the finding lands in the JSONL fallback (boot never stalls)', async () => {
    const { projectDir, stateDir } = protectedAgent();
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir, ...darwin(), emitTimeoutMs: 50,
      emitAttention: () => new Promise(() => { /* never resolves */ }),
    });
    expect(result.emitTimedOut).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.emitted).toBe(1);
    expect(summarizeTccDetection(result)).toContain('attention sink timed out');
    expect(fs.existsSync(path.join(stateDir, 'audit', 'tcc-protected-path.jsonl'))).toBe(true);
  });

  it('a throwing sink records the error AND still writes the JSONL fallback (nothing lost for this boot)', async () => {
    const { projectDir, stateDir } = protectedAgent();
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir, ...darwin(),
      emitAttention: async () => { throw new Error('telegram down'); },
    });
    expect(result.emitError).toBe('telegram down');
    expect(result.error).toBeUndefined();
    expect(result.emitted).toBe(1);
    const lines = fs.readFileSync(path.join(stateDir, 'audit', 'tcc-protected-path.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).category).toBe('tcc-protected-path');
  });

  it('an EMPTY finding set resolves the category via resolveAttention (the item closes itself after the move)', async () => {
    const projectDir = path.join(home, 'Projects', 'moved-agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const resolvedCategories: string[] = [];
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir: path.join(projectDir, '.instar'), ...darwin(),
      emitAttention: async () => { throw new Error('must not emit'); },
      resolveAttention: async (category) => { resolvedCategories.push(category); return 1; },
    });
    expect(resolvedCategories).toEqual(['tcc-protected-path']);
    expect(result.resolved).toBe(1);
  });

  it('a NON-empty finding set never calls resolveAttention', async () => {
    const { projectDir, stateDir } = protectedAgent();
    let resolveCalls = 0;
    const result = await runTccProtectedPathDetection({
      projectDir, stateDir, ...darwin(),
      emitAttention: async () => {},
      resolveAttention: async () => { resolveCalls++; return 0; },
    });
    expect(resolveCalls).toBe(0);
    expect(result.resolved).toBe(0);
  });
});
