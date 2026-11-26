/**
 * Relay unknown-sender trust — unit tier (docs/specs/a2a-relay-unknown-sender-trust.md, ACT-066).
 *
 * Decision logic against a REAL AgentTrustManager (no mocks of the authority):
 * both sides of every boundary — profile / no profile, each level × operation,
 * off / dry-run / enforcing, the first-contact profile default — plus the live
 * mode resolver, counters, the log line, and migration parity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentTrustManager, type AgentTrustLevel } from '../../src/threadline/AgentTrustManager.js';
import {
  INVALID_RELAY_OPERATION,
  classifyRelayPlaintextOperation,
  createRelayUnknownSenderTrustCounters,
  handleRelayUnknownSender,
  isRelayUnknownSenderTrustEnforcing,
  newFingerprintProfileLevel,
  relayUnknownSenderTrustCounters,
  relayUnknownSenderTrustLogLine,
  resetRelayUnknownSenderTrustCounters,
  resolveRelayUnknownSenderTrust,
  resolveRelayUnknownSenderTrustMode,
  type RelayUnknownSenderPassDecision,
  type RelayUnknownSenderTrustMode,
} from '../../src/threadline/relayUnknownSenderTrust.js';
import type { ReceivedMessage } from '../../src/threadline/client/ThreadlineClient.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const OP = 'threadline relay-unknown-sender-trust unit test';

const OFF: RelayUnknownSenderTrustMode = { enabled: false, dryRun: true };
const DRY: RelayUnknownSenderTrustMode = { enabled: true, dryRun: true };
const ENFORCE: RelayUnknownSenderTrustMode = { enabled: true, dryRun: false };

function received(from: string, type?: string): ReceivedMessage {
  return {
    from, fromName: from.slice(0, 8), threadId: 't-1', messageId: 'm-1',
    content: { content: 'hello', ...(type !== undefined ? { type } : {}) },
    timestamp: new Date().toISOString(), envelope: {} as never,
  };
}

describe('relay unknown-sender trust — decision logic (real AgentTrustManager)', () => {
  let dir: string;
  let tm: AgentTrustManager;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rust-unit-'));
    tm = new AgentTrustManager({ stateDir: dir });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

  it('classifies the plaintext wire types', () => {
    expect(classifyRelayPlaintextOperation(undefined)).toBe('message');
    expect(classifyRelayPlaintextOperation('chat')).toBe('message');
    expect(classifyRelayPlaintextOperation('ack')).toBe('ack');
    expect(classifyRelayPlaintextOperation('query')).toBe('query');
    expect(classifyRelayPlaintextOperation('')).toBe(INVALID_RELAY_OPERATION);
    expect(classifyRelayPlaintextOperation(7)).toBe(INVALID_RELAY_OPERATION);
  });

  it('a fingerprint with no profile is untrusted and may not send a message', () => {
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'chat')).toEqual({ level: 'untrusted', operation: 'message', allowed: false, hasProfile: false });
  });

  it('an untrusted sender\'s delivery acks pass; its probes do not (the consumer would route them to a session)', () => {
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'ack').allowed).toBe(true);
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'ping').allowed).toBe(false);
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'health').allowed).toBe(false);
    // A profiled sender's probe follows the table (passes as a probe).
    tm.setTrustLevelByFingerprint(FP_B, 'verified', 'user-granted', 'grant', 'peer');
    expect(resolveRelayUnknownSenderTrust(tm, FP_B, 'ping').allowed).toBe(true);
  });

  it('a verified profile may send a message; the held level is reported', () => {
    tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'test', 'peer');
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'chat')).toEqual({ level: 'verified', operation: 'message', allowed: true, hasProfile: true });
  });

  it('matches the relay gate table for every level × operation', () => {
    const ops = ['ping', 'message', 'query', 'task-request', 'data-share', 'spawn', 'delegate', 'made-up-op'];
    for (const level of ['verified', 'trusted', 'autonomous'] as const) {
      tm.setTrustLevelByFingerprint(FP_A, level, 'user-granted', 'test', 'peer');
      const gateAllowed = tm.getAllowedOperationsByFingerprint(FP_A);
      for (const op of ops) {
        const v = resolveRelayUnknownSenderTrust(tm, FP_A, op);
        expect(v.level).toBe(level);
        expect(v.allowed, `${level}/${op}`).toBe(gateAllowed.includes(op));
      }
    }
  });

  it('a first-contact profile still at setup-default counts as no profile; a grant makes it count', () => {
    tm.getOrCreateProfileByFingerprint(FP_A, undefined, { relayFirstContact: true });
    expect(tm.getProfileByFingerprint(FP_A)?.relayFirstContact).toBe(true);
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'chat')).toMatchObject({ level: 'untrusted', allowed: false, hasProfile: false });
    tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'test', 'peer');
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'chat')).toMatchObject({ level: 'verified', allowed: true, hasProfile: true });
  });

  it('credential-share is refused on this plaintext path at every level', () => {
    for (const level of ['verified', 'trusted', 'autonomous'] as const) {
      tm.setTrustLevelByFingerprint(FP_A, level, 'user-granted', 'test', 'peer');
      expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'credential-share').allowed).toBe(false);
    }
  });

  it('a profile explicitly downgraded to untrusted is refused a message', () => {
    tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'up', 'peer');
    tm.setTrustLevelByFingerprint(FP_A, 'untrusted', 'user-granted', 'revoked', 'peer');
    expect(resolveRelayUnknownSenderTrust(tm, FP_A, 'chat')).toMatchObject({ level: 'untrusted', allowed: false, hasProfile: true });
  });
});

describe('relay unknown-sender trust — handler across modes', () => {
  let dir: string;
  let mode: RelayUnknownSenderTrustMode;
  let tm: AgentTrustManager;
  let emitted: RelayUnknownSenderPassDecision[];
  let lines: string[];
  let counters: ReturnType<typeof createRelayUnknownSenderTrustCounters>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rust-handler-'));
    mode = OFF;
    counters = createRelayUnknownSenderTrustCounters();
    tm = new AgentTrustManager({
      stateDir: dir,
      newFingerprintProfileLevel: () => newFingerprintProfileLevel(mode),
      onFingerprintProfileCreated: (l) => { if (l === 'untrusted') counters.profilesCreatedUntrusted++; },
    });
    emitted = [];
    lines = [];
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

  const run = (from: string, type?: string) => handleRelayUnknownSender(
    { trustManager: tm, mode: () => mode, counters, emit: (d) => emitted.push(d), log: (l) => lines.push(l) },
    received(from, type),
    type,
  );

  it('off: today\'s behaviour — emitted verified, and a verified profile is created', () => {
    expect(run(FP_A, 'chat')).toBe('passed-legacy');
    expect(emitted).toEqual([expect.objectContaining({ reason: 'relay-authenticated', trustLevel: 'verified', fingerprint: FP_A })]);
    expect(tm.getProfileByFingerprint(FP_A)).toMatchObject({ level: 'verified', source: 'setup-default' });
    expect(counters.evaluated).toBe(0);
    expect(lines).toEqual([]);
  });

  it('dry-run: a stranger is delivered as today, logged and counted — and its repeat messages keep counting', () => {
    mode = DRY;
    expect(run(FP_A, 'chat')).toBe('would-refuse-delivered');
    expect(emitted[0]).toMatchObject({ trustLevel: 'verified', reason: 'relay-authenticated' });
    expect(counters).toMatchObject({ evaluated: 1, wouldRefuse: 1, allowed: 0, refused: 0, firstContactProfiles: 1 });
    expect(lines[0]).toMatch(/^\[relay-unknown-sender-trust\] would-refuse fp=aaaaaaaaaaaa profile=no trust=untrusted op=message$/);
    // The legacy path created a verified profile; under enforcement it would not
    // exist, so the second message is still a would-refuse.
    expect(tm.getProfileByFingerprint(FP_A)?.level).toBe('verified');
    expect(run(FP_A, 'chat')).toBe('would-refuse-delivered');
    expect(counters).toMatchObject({ evaluated: 2, wouldRefuse: 2, firstContactProfiles: 1 });
  });

  it('dry-run: first contact, then an operator grant — later messages count as allowed', () => {
    mode = DRY;
    expect(run(FP_A, 'chat')).toBe('would-refuse-delivered');
    tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'grant', 'peer');
    expect(run(FP_A, 'chat')).toBe('passed-dry-run');
    expect(counters).toMatchObject({ wouldRefuse: 1, allowed: 1 });
    mode = ENFORCE;
    expect(run(FP_A, 'chat')).toBe('passed');
  });

  it('dry-run: a granted sender counts as allowed', () => {
    mode = DRY;
    tm.setTrustLevelByFingerprint(FP_B, 'verified', 'user-granted', 'grant', 'peer');
    expect(run(FP_B, 'chat')).toBe('passed-dry-run');
    expect(counters).toMatchObject({ evaluated: 1, allowed: 1, wouldRefuse: 0, firstContactProfiles: 0 });
  });

  it('enforcing: a stranger\'s message is refused, emits nothing and writes no profile', () => {
    mode = ENFORCE;
    expect(run(FP_A, 'chat')).toBe('refused');
    expect(emitted).toEqual([]);
    expect(tm.getProfileByFingerprint(FP_A)).toBeNull();
    expect(counters).toMatchObject({ evaluated: 1, refused: 1, allowed: 0 });
    expect(lines[0]).toContain('[relay-unknown-sender-trust] refuse fp=aaaaaaaaaaaa');
  });

  it('enforcing: a stranger\'s ping is dropped; its ack passes at untrusted; neither writes a profile', () => {
    mode = ENFORCE;
    expect(run(FP_A, 'ping')).toBe('refused');
    expect(emitted).toEqual([]);
    expect(run(FP_A, 'ack')).toBe('passed');
    expect(emitted[0]).toMatchObject({ reason: 'relay-authenticated', trustLevel: 'untrusted' });
    expect(tm.getProfileByFingerprint(FP_A)).toBeNull();
  });

  it('enforcing: a granted sender\'s ping passes with reason probe', () => {
    mode = ENFORCE;
    tm.setTrustLevelByFingerprint(FP_B, 'verified', 'user-granted', 'grant', 'peer');
    expect(run(FP_B, 'ping')).toBe('passed');
    expect(emitted[0]).toMatchObject({ reason: 'probe', trustLevel: 'verified' });
  });

  it('enforcing: a granted sender passes at its HELD level and its interaction is recorded', () => {
    mode = ENFORCE;
    tm.setTrustLevelByFingerprint(FP_B, 'trusted', 'user-granted', 'grant', 'peer');
    expect(run(FP_B, 'chat')).toBe('passed');
    expect(emitted[0]).toMatchObject({ reason: 'relay-authenticated', trustLevel: 'trusted', fingerprint: FP_B });
    expect(tm.getProfileByFingerprint(FP_B)?.history.messagesReceived).toBe(1);
    expect(counters).toMatchObject({ allowed: 1, refused: 0 });
  });

  it('enforcing: a verified sender may not task-request (operation boundary)', () => {
    mode = ENFORCE;
    tm.setTrustLevelByFingerprint(FP_B, 'verified', 'user-granted', 'grant', 'peer');
    expect(run(FP_B, 'task-request')).toBe('refused');
    tm.setTrustLevelByFingerprint(FP_B, 'trusted', 'user-granted', 'grant', 'peer');
    expect(run(FP_B, 'task-request')).toBe('passed');
  });

  it('a throwing lookup: delivered as today in dry-run, refused when enforcing', () => {
    const broken = {
      getProfileByFingerprint: () => { throw new Error('boom'); },
      getAllowedOperationsByFingerprint: () => [],
      recordMessageReceivedByFingerprint: () => {},
      getOrCreateProfileByFingerprint: () => { throw new Error('boom'); },
    };
    const go = (m: RelayUnknownSenderTrustMode) => handleRelayUnknownSender(
      { trustManager: broken as never, mode: () => m, counters, emit: (d) => emitted.push(d), log: (l) => lines.push(l) },
      received(FP_A, 'chat'), 'chat',
    );
    expect(go(ENFORCE)).toBe('refused-lookup-error');
    expect(emitted).toEqual([]);
    expect(go(DRY)).toBe('passed-dry-run');
    expect(emitted).toEqual([expect.objectContaining({ trustLevel: 'verified', reason: 'relay-authenticated' })]);
    expect(counters.lookupErrors).toBe(2);
  });

  it('the first-contact mark is durable: after a restart the stranger is still a would-refuse, and enforcement grants it nothing on any path', () => {
    mode = DRY;
    run(FP_A, 'chat');
    expect(tm.getProfileByFingerprint(FP_A)).toMatchObject({ level: 'verified', source: 'setup-default', relayFirstContact: true });
    // No flush: the marker rides the profile's first, immediate write (crash-safe).
    // A new manager over the same directory (a restart).
    const tm2 = new AgentTrustManager({ stateDir: dir, newFingerprintProfileLevel: () => newFingerprintProfileLevel(mode) });
    expect(tm2.getProfileByFingerprint(FP_A)?.relayFirstContact).toBe(true);
    expect(handleRelayUnknownSender(
      { trustManager: tm2, mode: () => mode, counters, emit: () => {}, log: () => {} }, received(FP_A, 'chat'), 'chat',
    )).toBe('would-refuse-delivered');
    // Dry-run: the gate's reads are unchanged (today's verified).
    expect(tm2.getTrustLevelByFingerprint(FP_A)).toBe('verified');
    // Enforcing: the gate's reads treat it as ungranted too.
    mode = ENFORCE;
    expect(tm2.getTrustLevelByFingerprint(FP_A)).toBe('untrusted');
    expect(tm2.getAllowedOperationsByFingerprint(FP_A)).toEqual(['ping', 'health']);
    // An operator grant restores it everywhere.
    tm2.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'grant', 'peer');
    expect(tm2.getTrustLevelByFingerprint(FP_A)).toBe('verified');
  });
});

describe('relay unknown-sender trust — new fingerprint profile default', () => {
  let dir: string;
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

  const make = (level?: () => AgentTrustLevel) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rust-default-'));
    return new AgentTrustManager({ stateDir: dir, ...(level ? { newFingerprintProfileLevel: level } : {}) });
  };

  it('no reader: verified, as today', () => {
    expect(make().getOrCreateProfileByFingerprint(FP_A)).toMatchObject({ level: 'verified', allowedOperations: ['ping', 'health', 'message', 'query'] });
  });

  it('enforcing: untrusted, with the untrusted operation table', () => {
    expect(make(() => 'untrusted').getOrCreateProfileByFingerprint(FP_A)).toMatchObject({ level: 'untrusted', allowedOperations: ['ping', 'health'] });
  });

  it('the reader can only lower the default: any other answer or a throw keeps verified', () => {
    expect(make(() => 'autonomous').getOrCreateProfileByFingerprint(FP_A).level).toBe('verified');
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
    expect(make(() => { throw new Error('x'); }).getOrCreateProfileByFingerprint(FP_A).level).toBe('verified');
  });

  it('enforcing: an operator grant on a new fingerprint still lands (untrusted → verified, user-granted)', () => {
    const tm = make(() => 'untrusted');
    expect(tm.setTrustLevelByFingerprint(FP_A, 'verified', 'user-granted', 'grant', 'peer')).toBe(true);
    expect(tm.getTrustLevelByFingerprint(FP_A)).toBe('verified');
  });

  it('an existing profile is never changed by the default', () => {
    const tm = make(() => 'verified');
    tm.getOrCreateProfileByFingerprint(FP_A);
    const tm2 = new AgentTrustManager({ stateDir: dir, newFingerprintProfileLevel: () => 'untrusted' });
    expect(tm2.getOrCreateProfileByFingerprint(FP_A).level).toBe('verified');
  });
});

describe('relay unknown-sender trust — mode, counters, log line', () => {
  it('enabled omitted ⇒ the developmentAgent gate decides; dryRun defaults true', () => {
    expect(resolveRelayUnknownSenderTrustMode({}, { developmentAgent: true })).toEqual({ enabled: true, dryRun: true });
    expect(resolveRelayUnknownSenderTrustMode({}, { developmentAgent: false })).toEqual({ enabled: false, dryRun: true });
    expect(resolveRelayUnknownSenderTrustMode({}, {})).toEqual({ enabled: false, dryRun: true });
  });

  it('an explicit value wins; the live read wins over the config object', () => {
    expect(resolveRelayUnknownSenderTrustMode({}, { developmentAgent: true, threadline: { relayUnknownSenderTrust: { enabled: false } } }).enabled).toBe(false);
    expect(resolveRelayUnknownSenderTrustMode({ enabled: false, dryRun: true }, { threadline: { relayUnknownSenderTrust: { enabled: true, dryRun: false } } })).toEqual({ enabled: false, dryRun: true });
    expect(resolveRelayUnknownSenderTrustMode({ dryRun: 'no' as never }, { developmentAgent: true }).dryRun).toBe(true);
  });

  it('only on + dryRun:false enforces, and only then is the default lowered', () => {
    expect(isRelayUnknownSenderTrustEnforcing(ENFORCE)).toBe(true);
    expect(isRelayUnknownSenderTrustEnforcing(DRY)).toBe(false);
    expect(isRelayUnknownSenderTrustEnforcing({ enabled: false, dryRun: false })).toBe(false);
    expect(newFingerprintProfileLevel(ENFORCE)).toBe('untrusted');
    expect(newFingerprintProfileLevel(DRY)).toBe('verified');
    expect(newFingerprintProfileLevel(OFF)).toBe('verified');
  });

  it('counters start at zero; the process-wide set resets', () => {
    expect(createRelayUnknownSenderTrustCounters()).toEqual({
      evaluated: 0, allowed: 0, wouldRefuse: 0, refused: 0, firstContactProfiles: 0, lookupErrors: 0, profilesCreatedUntrusted: 0,
    });
    relayUnknownSenderTrustCounters.refused = 3;
    resetRelayUnknownSenderTrustCounters();
    expect(relayUnknownSenderTrustCounters.refused).toBe(0);
  });

  it('the log line carries no raw peer text', () => {
    const line = relayUnknownSenderTrustLogLine('refuse', 'evil\nfp\u001b', { level: 'untrusted', operation: 'op\ninj', allowed: false, hasProfile: false });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toBe('[relay-unknown-sender-trust] refuse fp=evil?fp? profile=no trust=untrusted op=op?inj');
  });
});

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('relay unknown-sender trust — migration parity', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rust-mig-'));
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
    expect(run().upgraded).toContain('CLAUDE.md: added A2A relay unknown-sender trust section');
    const after = fs.readFileSync(claudeMd, 'utf-8');
    expect(after).toContain('### A2A relay unknown-sender trust');
    expect(after).toContain('`[relay-unknown-sender-trust] would-refuse`');
    expect(run().upgraded).not.toContain('CLAUDE.md: added A2A relay unknown-sender trust section');
    expect(fs.readFileSync(claudeMd, 'utf-8').split('### A2A relay unknown-sender trust').length - 1).toBe(1);
  });

  it('the template carries the same section for new agents', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('### A2A relay unknown-sender trust');
    expect(md).toContain('a new fingerprint profile starts `untrusted` instead of `verified`');
  });

  it('no config default is added; one DEV_GATED_FEATURES entry decides', () => {
    const d = getMigrationDefaults('standalone') as { threadline?: Record<string, unknown> };
    expect(d.threadline?.relayUnknownSenderTrust).toBeUndefined();
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'threadline.relayUnknownSenderTrust.enabled')).toHaveLength(1);
    const dev: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const fleet: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    expect(resolveRelayUnknownSenderTrustMode({}, dev as never)).toEqual({ enabled: true, dryRun: true });
    expect(resolveRelayUnknownSenderTrustMode({}, fleet as never).enabled).toBe(false);
  });
});
