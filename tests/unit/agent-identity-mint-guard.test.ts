// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * AC1 (a2a-single-agent-identity §1.1): a joined machine with no identity NEVER mints at
 * either mint site; a standalone first machine still mints; an unreadable registry refuses
 * at BOTH sites; the mint-site census fails the build on an unlisted site; the identity lock
 * serializes mutations and two stale-breakers cannot both win.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectJoinedMesh, describeMintRefusal } from '../../src/threadline/client/JoinedMeshDetector.js';
import { IdentityManager, IdentityNotProvisionedError } from '../../src/threadline/client/IdentityManager.js';
import { createUnifiedTrustSystem } from '../../src/threadline/UnifiedTrustWiring.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { acquireIdentityLock, withIdentityLock, isLockStale, IdentityLockedError, IDENTITY_LOCK_FILE } from '../../src/core/AgentIdentityLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', '..', 'src');

function stateDir(opts: { selfId?: string; registryIds?: string[]; registryRaw?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-guard-'));
  if (opts.selfId) {
    fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify({ machineId: opts.selfId, name: 'test' }));
  }
  if (opts.registryIds || opts.registryRaw !== undefined) {
    fs.mkdirSync(path.join(dir, 'machines'), { recursive: true });
    const machines: Record<string, unknown> = {};
    for (const id of opts.registryIds ?? []) machines[id] = { name: id, role: 'awake', status: 'active' };
    fs.writeFileSync(path.join(dir, 'machines', 'registry.json'), opts.registryRaw ?? JSON.stringify({ version: 1, machines }));
  }
  return dir;
}

const rm = (d: string) => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/agent-identity-mint-guard.test.ts' });

describe('§1.1 detectJoinedMesh — four readings, two directions', () => {
  it('no registry file → standalone first machine → mint', () => {
    const d = stateDir({ selfId: 'm_self' });
    const v = detectJoinedMesh(d);
    expect(v).toMatchObject({ joined: false, mintAllowed: true, reason: 'no-registry' });
    rm(d);
  });

  it('a registry naming any other row (any status) → refuse', () => {
    const d = stateDir({ selfId: 'm_self', registryIds: ['m_self', 'm_peer'] });
    fs.writeFileSync(path.join(d, 'machines', 'registry.json'), JSON.stringify({ version: 1, machines: { m_self: { status: 'active' }, m_peer: { status: 'revoked' } } }));
    const v = detectJoinedMesh(d);
    expect(v).toMatchObject({ joined: true, mintAllowed: false, peerMachineCount: 1 });
    rm(d);
  });

  it('rows but no own machine id → refuse (the parent minted here)', () => {
    const d = stateDir({ registryIds: ['m_other'] });
    const v = detectJoinedMesh(d);
    expect(v).toMatchObject({ joined: false, mintAllowed: false, reason: 'no-machine-id' });
    rm(d);
  });

  it('ENOENT and EACCES are no longer collapsed: a present-but-unreadable registry is `unreadable` → refuse', () => {
    const d = stateDir({ selfId: 'm_self' });
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const v = detectJoinedMesh(d, {
      readFile: (p) => {
        if (p.endsWith('registry.json')) throw eacces;
        return fs.readFileSync(p, 'utf-8');
      },
    });
    expect(v).toMatchObject({ joined: false, mintAllowed: false, reason: 'unreadable' });
    if (!v.joined && !v.mintAllowed) expect(v.detail).toMatch(/EACCES/);
    rm(d);
  });

  it('a corrupt registry is `unreadable` → refuse, and the refusal names the standalone lever', () => {
    const d = stateDir({ selfId: 'm_self', registryRaw: '{ not json' });
    const v = detectJoinedMesh(d);
    expect(v.mintAllowed).toBe(false);
    expect(describeMintRefusal(v)).toMatch(/instar identity init --standalone --i-understand-peers-must-repin/);
    rm(d);
  });
});

describe('§1.1 BOTH mint sites refuse on joined AND on unreadable', () => {
  it('site 1 — IdentityManager.getOrCreate refuses on an unreadable registry and writes nothing', () => {
    const d = stateDir({ selfId: 'm_self', registryRaw: 'nope' });
    expect(() => new IdentityManager(d).getOrCreate()).toThrow(IdentityNotProvisionedError);
    expect(fs.existsSync(path.join(d, 'threadline', 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'identity.json'))).toBe(false);
    rm(d);
  });

  it('site 2 — createUnifiedTrustSystem refuses on a joined machine and writes NO canonical identity.json', () => {
    const d = stateDir({ selfId: 'm_self', registryIds: ['m_self', 'm_peer'] });
    const tm = new AgentTrustManager({ stateDir: d });
    expect(() => createUnifiedTrustSystem(tm, { stateDir: d })).toThrow(IdentityNotProvisionedError);
    expect(fs.existsSync(path.join(d, 'identity.json'))).toBe(false);
    rm(d);
  });

  it('site 2 — refuses on an unreadable registry too', () => {
    const d = stateDir({ selfId: 'm_self', registryRaw: '{"machines": 7}' });
    const tm = new AgentTrustManager({ stateDir: d });
    expect(() => createUnifiedTrustSystem(tm, { stateDir: d })).toThrow(IdentityNotProvisionedError);
    expect(fs.existsSync(path.join(d, 'identity.json'))).toBe(false);
    rm(d);
  });

  it('site 2 — a standalone first machine STILL mints (the guard is not a blanket ban)', () => {
    const d = stateDir({ selfId: 'm_self' });
    const tm = new AgentTrustManager({ stateDir: d });
    const sys = createUnifiedTrustSystem(tm, { stateDir: d });
    expect(fs.existsSync(path.join(d, 'identity.json'))).toBe(true);
    sys.shutdown();
    rm(d);
  });

  it('the refusal carries the verdict so the boot posture can name the reason and the lever', () => {
    const d = stateDir({ selfId: 'm_self', registryRaw: '[]' });
    try {
      new IdentityManager(d).getOrCreate();
      throw new Error('should refuse');
    } catch (err) {
      const e = err as IdentityNotProvisionedError;
      expect(e.code).toBe('identity-not-provisioned');
      expect(e.verdict?.mintAllowed).toBe(false);
      expect(e.message).toMatch(/unreadable/);
    }
    rm(d);
  });
});

// ── Mint-site census ───────────────────────────────────────────────────────

/** Code-owned allowlist BY FILE (spec §1.1): every call site of a minting primitive in src/. */
const CENSUS = {
  'generateIdentityKeyPair(': [
    'threadline/ThreadlineCrypto.ts', // the primitive's own body
    'threadline/client/IdentityManager.ts', // getOrCreate — guarded (checked below)
    'identity/IdentityManager.ts', // CanonicalIdentityManager.create — the primitive; its callers are guarded
    'identity/KeyRotation.ts', // rotates an EXISTING identity (not a mint)
    'threadline/relay/A2ABridge.ts', // non-agent key user (bridge identity)
    'threadline/relay/RegistryAuth.ts', // non-agent key user (relay registry)
    'commands/identity.ts', // `instar identity init --standalone` — the deliberate operator mint (§1.4)
  ],
  'identity.create(': [
    'threadline/UnifiedTrustWiring.ts', // guarded (checked below)
    'commands/identity.ts', // `instar identity init --standalone`
  ],
  '.getOrCreate(': [
    'threadline/client/IdentityManager.ts', // the guarded primitive itself (self-reference in docs/comments)
    'threadline/client/ThreadlineClient.ts',
    'threadline/HandshakeManager.ts',
    'threadline/mcp-stdio-entry.ts',
    'threadline/relay/A2ABridge.ts', // an unrelated rate-limiter map helper named getOrCreate
    'threadline/client/JoinedMeshDetector.ts', // doc comment only
  ],
} as const;

/** The two guarded sites must call `detectJoinedMesh(` in the same function body (≤80 lines above the mint). */
const GUARDED: Array<{ file: string; mint: RegExp }> = [
  { file: 'threadline/client/IdentityManager.ts', mint: /generateIdentityKeyPair\(/ },
  { file: 'threadline/UnifiedTrustWiring.ts', mint: /identity\.create\(/ },
];

function listTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listTs(p, out);
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Pure census over a {relPath: contents} map so an injected unlisted site is testable. */
export function censusViolations(files: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const [needle, allowed] of Object.entries(CENSUS)) {
    for (const [rel, text] of Object.entries(files)) {
      if (!text.includes(needle)) continue;
      if (!(allowed as readonly string[]).includes(rel)) violations.push(`${rel} calls ${needle} but is not in the mint-site allowlist`);
    }
  }
  for (const g of GUARDED) {
    const text = files[g.file];
    if (!text) continue;
    const lines = text.split('\n');
    const mintLine = lines.findIndex((l) => g.mint.test(l));
    if (mintLine < 0) continue;
    const window = lines.slice(Math.max(0, mintLine - 80), mintLine).join('\n');
    if (!window.includes('detectJoinedMesh(')) violations.push(`${g.file}: the mint at line ${mintLine + 1} is not guarded by detectJoinedMesh( in the same function body`);
  }
  return violations;
}

describe('§1.1 mint-site census — a new unlisted mint site fails the build', () => {
  const real = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of listTs(SRC)) out[path.relative(SRC, p)] = fs.readFileSync(p, 'utf-8');
    return out;
  };

  it('every call site of a minting primitive in src/ is on the allowlist, and both guarded sites call detectJoinedMesh', () => {
    expect(censusViolations(real())).toEqual([]);
  });

  it('an injected unlisted `generateIdentityKeyPair(` site is reported', () => {
    const files = real();
    files['monitoring/Rogue.ts'] = 'const kp = generateIdentityKeyPair();';
    expect(censusViolations(files)).toEqual(['monitoring/Rogue.ts calls generateIdentityKeyPair( but is not in the mint-site allowlist']);
  });

  it('a guarded site that loses its detectJoinedMesh call is reported', () => {
    const files = real();
    files['threadline/UnifiedTrustWiring.ts'] = files['threadline/UnifiedTrustWiring.ts'].replace(/detectJoinedMesh\(/g, 'noGuard(');
    expect(censusViolations(files).some((v) => v.startsWith('threadline/UnifiedTrustWiring.ts: the mint'))).toBe(true);
  });
});

// ── The identity lock ─────────────────────────────────────────────────────

describe('§1.2 the identity lock', () => {
  it('serializes a concurrent install: the second holder waits, then refuses `identity-locked`', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'idlock-'));
    let t = 1_000_000;
    const now = () => t;
    const h = acquireIdentityLock(d, { now, pid: 11, processStartMs: 0, isPidAlive: () => true, processStartOf: () => 0, sleepMs: (ms) => { t += ms; } });
    expect(fs.existsSync(path.join(d, IDENTITY_LOCK_FILE))).toBe(true);
    expect(() => acquireIdentityLock(d, { now, pid: 22, processStartMs: 0, isPidAlive: () => true, processStartOf: () => 0, sleepMs: (ms) => { t += ms; }, waitMs: 2_000 })).toThrow(IdentityLockedError);
    h.release();
    expect(fs.existsSync(path.join(d, IDENTITY_LOCK_FILE))).toBe(false);
    rm(d);
  });

  it('a stale lock (dead pid, > 60 s) is broken by rename; only one breaker wins and holds', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'idlock-'));
    fs.writeFileSync(path.join(d, IDENTITY_LOCK_FILE), JSON.stringify({ pid: 999999, startedAt: new Date(0).toISOString(), at: new Date(0).toISOString() }));
    let t = 120_000;
    const now = () => t;
    const dead = () => false;
    const a = acquireIdentityLock(d, { now, pid: 1, processStartMs: 0, isPidAlive: dead, processStartOf: () => null, sleepMs: (ms) => { t += ms; } });
    // The second breaker finds a LIVE lock (ours) and must NOT break it.
    expect(() => acquireIdentityLock(d, { now, pid: 2, processStartMs: 0, isPidAlive: (pid) => pid === 1, processStartOf: () => 0, sleepMs: (ms) => { t += ms; }, waitMs: 1_000 })).toThrow(IdentityLockedError);
    const stamp = JSON.parse(fs.readFileSync(path.join(d, IDENTITY_LOCK_FILE), 'utf-8')) as { pid: number };
    expect(stamp.pid).toBe(1);
    a.release();
    rm(d);
  });

  it('the stale rule: pid+start-time pair, 60 s floor, 10-min ceiling', () => {
    const deps = { isPidAlive: (pid: number) => pid === 7, processStartOf: (pid: number) => (pid === 7 ? 5_000 : null), staleMs: 60_000, ceilingMs: 600_000 };
    const live = { pid: 7, startedAt: new Date(5_000).toISOString() };
    expect(isLockStale(live, 30_000, deps)).toBe(false); // too young to judge
    expect(isLockStale(live, 90_000, deps)).toBe(false); // alive, same start → held
    expect(isLockStale({ pid: 7, startedAt: new Date(999_000).toISOString() }, 90_000, deps)).toBe(true); // pid reused by another process
    expect(isLockStale({ pid: 8, startedAt: new Date(5_000).toISOString() }, 90_000, deps)).toBe(true); // dead pid
    expect(isLockStale(live, 600_000, deps)).toBe(true); // the ceiling, regardless
    expect(isLockStale({ pid: 7 }, 90_000, { ...deps, processStartOf: () => null }), 'cannot tell the start → not stale').toBe(false);
  });

  it('withIdentityLock always releases, even when fn throws', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'idlock-'));
    expect(() => withIdentityLock(d, () => { throw new Error('boom'); }, { pid: 3, processStartMs: 0, isPidAlive: () => true, processStartOf: () => 0 })).toThrow('boom');
    expect(fs.existsSync(path.join(d, IDENTITY_LOCK_FILE))).toBe(false);
    rm(d);
  });
});
