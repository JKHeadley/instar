/**
 * Local-route trust — unit tier (docs/specs/a2a-local-route-trust.md, ACT-056).
 *
 * The decision logic against a REAL AgentTrustManager (no mocks of the
 * authority): both sides of every boundary — profile / no profile, registry vs
 * asserted vs name identity, each trust level against each operation — plus
 * the live mode resolver, the counters, the log line, and migration parity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import {
  INVALID_LOCAL_OPERATION,
  classifyLocalOperation,
  createLocalRouteTrustCounters,
  localRouteTrustLogLine,
  resolveLocalRouteTrust,
  resolveLocalRouteTrustMode,
  statedLocalTrustLevel,
} from '../../src/threadline/localRouteTrust.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const FP_A = 'a'.repeat(32);
const FP_B = 'b'.repeat(32);
const OP = 'threadline local-route-trust unit test';

describe('local-route trust — decision logic (real AgentTrustManager)', () => {
  let dir: string;
  let tm: AgentTrustManager;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lrt-unit-'));
    tm = new AgentTrustManager({ stateDir: dir });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

  const input = (o: Partial<Parameters<typeof resolveLocalRouteTrust>[1]> = {}) => ({
    registryFingerprint: null, assertedFingerprint: null, senderName: 'peer', body: 'hello', ...o,
  });

  it('a sender with no profile is untrusted and may not send a message', () => {
    const v = resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A }));
    expect(v).toMatchObject({ level: 'untrusted', operation: 'message', allowed: false, identitySource: 'none', fingerprint: FP_A });
  });

  it('a sender with no profile and no fingerprint at all is untrusted', () => {
    const v = resolveLocalRouteTrust(tm, input({ senderName: 'unknown' }));
    expect(v).toMatchObject({ level: 'untrusted', allowed: false, identitySource: 'none', fingerprint: null });
  });

  it('an untrusted sender may still probe (ping / health), exactly as on the relay', () => {
    expect(resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A, body: { type: 'ping' } })).allowed).toBe(true);
    expect(resolveLocalRouteTrust(tm, input({ body: { type: 'health' } })).allowed).toBe(true);
  });

  it('a registry fingerprint with a verified profile may send a message', () => {
    tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'test', 'peer');
    const v = resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A }));
    expect(v).toMatchObject({ level: 'verified', allowed: true, identitySource: 'registry', fingerprint: FP_A });
  });

  it('matches the relay gate for every level × operation', () => {
    const ops = ['ping', 'message', 'query', 'task-request', 'data-share', 'spawn', 'delegate', 'credential-share', 'made-up-op'];
    for (const level of ['verified', 'trusted', 'autonomous'] as const) {
      tm.setTrustLevelByFingerprint(FP_A, level, 'user-granted', 'test', 'peer');
      const relayAllowed = tm.getAllowedOperationsByFingerprint(FP_A);
      for (const op of ops) {
        const v = resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A, body: { type: op, content: 'x' } }));
        expect(v.level).toBe(level);
        expect(v.allowed, `${level}/${op}`).toBe(relayAllowed.includes(op));
      }
    }
    // The boundary itself: verified may not task-request, trusted may.
    tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'down', 'peer');
    expect(resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A, body: { type: 'task-request' } })).allowed).toBe(false);
  });

  it('a profile explicitly downgraded to untrusted is refused a message', () => {
    tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'up', 'peer');
    tm.setTrustLevelByFingerprint(FP_A, 'untrusted', 'user-granted', 'revoked', 'peer');
    expect(resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A }))).toMatchObject({ level: 'untrusted', allowed: false, identitySource: 'registry' });
  });

  it('the registry fingerprint wins over a body-asserted one', () => {
    tm.setTrustLevelByFingerprint(FP_B, 'autonomous', 'user-granted', 'test', 'other');
    // Registry says FP_A (no profile); the body claims FP_B (autonomous).
    const v = resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A, assertedFingerprint: FP_B, senderName: 'peer' }));
    expect(v).toMatchObject({ level: 'untrusted', allowed: false, fingerprint: FP_A });
  });

  it('the asserted fingerprint is consulted only when the registry resolves none', () => {
    tm.setTrustLevelByFingerprint(FP_B, 'trusted', 'user-granted', 'test', 'other');
    const v = resolveLocalRouteTrust(tm, input({ assertedFingerprint: FP_B }));
    expect(v).toMatchObject({ level: 'trusted', allowed: true, identitySource: 'asserted', fingerprint: FP_B });
  });

  it('a profile granted by NAME is honoured when no fingerprint profile exists', () => {
    tm.setTrustLevel('peer', 'verified', 'user-granted', 'by name');
    expect(resolveLocalRouteTrust(tm, input())).toMatchObject({ level: 'verified', allowed: true, identitySource: 'name', fingerprint: null });
    // …also when the registry resolves a fingerprint that has no profile of its own.
    expect(resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A }))).toMatchObject({ level: 'verified', allowed: true, identitySource: 'name' });
    // A name-keyed profile's explicit block is respected.
    tm.blockOperation('peer', 'message');
    expect(resolveLocalRouteTrust(tm, input()).allowed).toBe(false);
  });

  it('a profile that belongs to a fingerprint is never reached by its display name', () => {
    // A fingerprint-keyed profile for FP_B whose display name is "peer".
    tm.setTrustLevelByFingerprint(FP_B, 'autonomous', 'user-granted', 'test', 'peer');
    // The registry resolves this sender to FP_A — a different same-named agent.
    expect(resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A, senderName: 'peer' })))
      .toMatchObject({ level: 'untrusted', allowed: false, identitySource: 'none', fingerprint: FP_A });
    // Leaving the fingerprint out must not yield more than stating a wrong one.
    expect(resolveLocalRouteTrust(tm, input({ senderName: 'peer' })))
      .toMatchObject({ level: 'untrusted', allowed: false, identitySource: 'none', fingerprint: null });
    // Stating the right one is the only way to that profile.
    expect(resolveLocalRouteTrust(tm, input({ assertedFingerprint: FP_B, senderName: 'peer' })))
      .toMatchObject({ level: 'autonomous', allowed: true, identitySource: 'asserted' });
  });

  it('a sender named after an object built-in resolves to untrusted without throwing', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolveLocalRouteTrust(tm, input({ senderName: name }))).toMatchObject({ level: 'untrusted', allowed: false, identitySource: 'none' });
    }
  });

  it('writes nothing: resolving never creates a profile', () => {
    resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A }));
    resolveLocalRouteTrust(tm, input({ senderName: 'stranger' }));
    expect(tm.getProfileByFingerprint(FP_A)).toBeNull();
    expect(tm.getProfile('stranger')).toBeNull();
  });

  it('classifies the operation like the relay gate', () => {
    expect(classifyLocalOperation('plain text')).toBe('message');
    expect(classifyLocalOperation({ content: 'no type' })).toBe('message');
    expect(classifyLocalOperation({ type: 'query' })).toBe('query');
    // Present but unusable: the relay gate refuses it, so no level allows it here.
    expect(classifyLocalOperation({ type: '' })).toBe(INVALID_LOCAL_OPERATION);
    expect(classifyLocalOperation({ type: 7 })).toBe(INVALID_LOCAL_OPERATION);
    expect(classifyLocalOperation({ type: undefined })).toBe(INVALID_LOCAL_OPERATION);
    tm.setTrustLevelByFingerprint(FP_A, 'autonomous', 'user-granted', 'test', 'peer');
    expect(resolveLocalRouteTrust(tm, input({ registryFingerprint: FP_A, body: { type: 7 } })).allowed).toBe(false);
    expect(classifyLocalOperation(null)).toBe('message');
  });
});

describe('local-route trust — mode, counters, log line', () => {
  it('enabled omitted ⇒ the developmentAgent gate decides; dryRun defaults true', () => {
    expect(resolveLocalRouteTrustMode({}, { developmentAgent: true })).toEqual({ enabled: true, dryRun: true });
    expect(resolveLocalRouteTrustMode({}, { developmentAgent: false })).toEqual({ enabled: false, dryRun: true });
    expect(resolveLocalRouteTrustMode({}, {})).toEqual({ enabled: false, dryRun: true });
  });

  it('an explicit value wins; the live read wins over the config object', () => {
    expect(resolveLocalRouteTrustMode({}, { developmentAgent: true, threadline: { localRouteTrust: { enabled: false } } }).enabled).toBe(false);
    expect(resolveLocalRouteTrustMode({}, { threadline: { localRouteTrust: { enabled: true, dryRun: false } } })).toEqual({ enabled: true, dryRun: false });
    expect(resolveLocalRouteTrustMode({ enabled: false, dryRun: true }, { threadline: { localRouteTrust: { enabled: true, dryRun: false } } })).toEqual({ enabled: false, dryRun: true });
  });

  it('only an explicit false leaves dry-run', () => {
    expect(resolveLocalRouteTrustMode({ dryRun: 'no' as never }, { developmentAgent: true }).dryRun).toBe(true);
    expect(resolveLocalRouteTrustMode({ dryRun: false }, { developmentAgent: true }).dryRun).toBe(false);
  });

  it('the stated level can be lowered by a claimed identity, never raised above verified', () => {
    expect(statedLocalTrustLevel('untrusted')).toBe('untrusted');
    expect(statedLocalTrustLevel('verified')).toBe('verified');
    expect(statedLocalTrustLevel('trusted')).toBe('verified');
    expect(statedLocalTrustLevel('autonomous')).toBe('verified');
  });

  it('counters start at zero', () => {
    expect(createLocalRouteTrustCounters()).toEqual({ evaluated: 0, allowed: 0, wouldRefuse: 0, refused: 0, noTrustManager: 0, lookupErrors: 0 });
  });

  it('the log line carries no raw peer text', () => {
    const line = localRouteTrustLogLine('would-refuse', 'evil\nname\u001b[31m with spaces', {
      level: 'untrusted', operation: 'msg\ninjected', allowed: false, identitySource: 'none', fingerprint: FP_A,
    });
    expect(line).not.toMatch(/[\n\u001b ]name/);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain(`fp=${FP_A.slice(0, 12)} source=none trust=untrusted op=msg?injected`);
    expect(line.startsWith('[relay-agent-trust] would-refuse from=evil?name?[31m?with?spaces')).toBe(true);
    expect(localRouteTrustLogLine('refuse', '', { level: 'untrusted', operation: 'message', allowed: false, identitySource: 'none', fingerprint: null }))
      .toBe('[relay-agent-trust] refuse from=unknown fp=none source=none trust=untrusted op=message');
  });
});

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('local-route trust — migration parity', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lrt-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the CLAUDE.md section once and is idempotent', () => {
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n');
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added A2A local-route trust section');
    const after = fs.readFileSync(claudeMd, 'utf-8');
    expect(after).toContain('### A2A local-route trust');
    expect(after).toContain("{ error: 'insufficient-trust', refused: true }");
    expect(run().upgraded).not.toContain('CLAUDE.md: added A2A local-route trust section');
    expect(fs.readFileSync(claudeMd, 'utf-8').split('### A2A local-route trust').length - 1).toBe(1);
  });

  it('the template carries the same section for new agents', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('### A2A local-route trust');
    expect(md).toContain('a sender with no profile may only ping');
  });

  it('no config default is added; one DEV_GATED_FEATURES entry decides', () => {
    const d = getMigrationDefaults('standalone') as { threadline?: Record<string, unknown> };
    expect(d.threadline?.localRouteTrust).toBeUndefined();
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'threadline.localRouteTrust.enabled')).toHaveLength(1);
    const dev: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const fleet: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    expect(resolveLocalRouteTrustMode({}, dev as never)).toEqual({ enabled: true, dryRun: true });
    expect(resolveLocalRouteTrustMode({}, fleet as never).enabled).toBe(false);
  });
});
