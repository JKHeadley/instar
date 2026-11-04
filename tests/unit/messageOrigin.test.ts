/**
 * message-origin-all-platforms §1/§4/§5: the shared evidence model, the phone row, the display
 * resolver and the Slack footer. Both sides of every rule.
 */
import { describe, it, expect } from 'vitest';
import {
  agentDisplaySetting, deviceOriginRow, effectiveDisplay, escapeSlackLabel, machineEvidence, originEvidenceFromLaunchRecord,
  originEvidenceFromProducer, originEvidenceWithoutSession, slackOriginFooter, validateDeviceOriginRow, validateMessageOriginEvidence,
  type MessageOriginEvidence,
} from '../../src/messaging/messageOrigin.js';
import type { TelegramOriginProducer } from '../../src/messaging/telegram-origin/types.js';

const ALL_ON = { enabled: true, machine: true, harness: true, model: true };
const observed = (value: string) => ({ value, status: 'observed' as const, sourceEventRef: 'transcript:/Users/x/.claude/session.jsonl#42', observedAt: 1, reason: null });

function producer(over: Partial<TelegramOriginProducer> = {}): TelegramOriginProducer {
  return {
    agentId: 'echo', agentName: 'echo', originMachineId: 'm_abc', originMachineName: 'Mac Studio', sessionId: 's1', sessionIncarnation: 'i1',
    turnId: null, producerKind: 'session', producerId: 's1', harnessId: 'claude-code', harnessName: 'Claude Code',
    machine: observed('Mac Studio'), harness: observed('claude-code'), model: observed('claude-opus-5-5'), ...over,
  };
}

describe('evidence from the Telegram producer (reused, not re-derived)', () => {
  it('maps a session producer and never copies a source ref that could name a transcript', () => {
    const e = originEvidenceFromProducer(producer(), 1000);
    expect(e).toMatchObject({ v: 1, producerKind: 'session', machineId: 'm_abc', harnessName: 'Claude Code', recordedAt: 1000 });
    expect(e.machine).toMatchObject({ value: 'Mac Studio', status: 'observed', sourceEventRef: 'machine-identity' });
    expect(e.model).toMatchObject({ value: 'claude-opus-5-5', status: 'observed', sourceEventRef: 'session-credential' });
    expect(JSON.stringify(e)).not.toContain('/Users/');
    expect(validateMessageOriginEvidence(e)).toEqual(e);
  });
  it('an id-shaped registry fallback is not a machine name', () => {
    expect(machineEvidence('Machine abcd1234', 1).status).toBe('unknown');
    expect(machineEvidence('Mac Studio', 1)).toMatchObject({ value: 'Mac Studio', status: 'observed' });
    expect(machineEvidence('', 1).reason).toBe('machine-name-unavailable');
  });
  it('a producer value that would not survive a read is recorded as unknown, not stored broken', () => {
    const e = originEvidenceFromProducer(producer({ harness: observed('Claude Code!!') }), 1);
    expect(e.harness.status).toBe('unknown');
    expect(validateMessageOriginEvidence(e)).not.toBeNull();
  });
});

describe('launch record and no-session evidence', () => {
  it('a concrete launch model is configured, never observed; the session id never enters the record', () => {
    const e = originEvidenceFromLaunchRecord({ machineId: 'm1', machineName: 'Laptop', sessionId: 'sess-secretish', framework: 'codex-cli', model: 'gpt-6-astra', at: 5 });
    expect(e.harness).toMatchObject({ value: 'codex-cli', status: 'configured', reason: 'session-launch-record' });
    expect(e.model).toMatchObject({ value: 'gpt-6-astra', status: 'configured' });
    expect(e.harnessName).toBe('Codex');
    expect(JSON.stringify(e)).not.toContain('sess-secretish');
  });
  it('a tier word is not a model, and a legacy record with no framework is unknown', () => {
    const e = originEvidenceFromLaunchRecord({ machineId: 'm1', machineName: null, sessionId: 's', framework: undefined, model: 'capable', at: 5 });
    expect(e.harness).toMatchObject({ status: 'unknown', reason: 'session-framework-unrecorded' });
    expect(e.model).toMatchObject({ status: 'unknown', reason: 'session-model-is-a-tier' });
    expect(e.machine.status).toBe('unknown');
  });
  it('rung 3 and automation say why they are unknown', () => {
    expect(originEvidenceWithoutSession({ machineId: null, machineName: 'Mini', at: 1, kind: 'unknown' }).model.reason).toBe('no-session-evidence');
    expect(originEvidenceWithoutSession({ machineId: null, machineName: 'Mini', at: 1, kind: 'server-automation' }))
      .toMatchObject({ producerKind: 'server-automation', harness: { status: 'unknown', reason: 'unbound-author-call' } });
  });
});

describe('the validator (records read from disk or from another machine)', () => {
  const good: MessageOriginEvidence = originEvidenceFromProducer(producer(), 7);
  it('rejects extra keys, unknown statuses, a value with an unknown status, control characters and bad ids', () => {
    expect(validateMessageOriginEvidence({ ...good, extra: 1 })).toBeNull();
    expect(validateMessageOriginEvidence({ ...good, model: { ...good.model, status: 'guessed' } })).toBeNull();
    expect(validateMessageOriginEvidence({ ...good, model: { ...good.model, status: 'unknown' } })).toBeNull();
    expect(validateMessageOriginEvidence({ ...good, machine: { ...good.machine, value: 'Mac\nStudio' } })).toBeNull();
    expect(validateMessageOriginEvidence({ ...good, harness: { ...good.harness, value: 'Claude Code' } })).toBeNull();
    expect(validateMessageOriginEvidence({ ...good, v: 2 })).toBeNull();
    expect(validateMessageOriginEvidence(null)).toBeNull();
  });
  it('accepts the record it produced', () => { expect(validateMessageOriginEvidence(JSON.parse(JSON.stringify(good)))).toEqual(good); });
});

describe('the phone row (§4)', () => {
  const e = originEvidenceFromProducer(producer(), 1);
  it('a recorded origin: exact shape, friendly harness name, statuses passed through, no refs', () => {
    expect(deviceOriginRow(e, ALL_ON)).toEqual({
      recorded: true,
      machine: { value: 'Mac Studio', status: 'observed' },
      harness: { value: 'Claude Code', id: 'claude-code', status: 'observed' },
      model: { value: 'claude-opus-5-5', status: 'observed' },
      display: ALL_ON,
    });
  });
  it('false only for not-recorded; every other missing reason is null', () => {
    expect(deviceOriginRow(null, ALL_ON).recorded).toBe(false);
    for (const reason of ['other-machine', 'not-found', 'not-retained', 'lookup-timeout', 'ambiguous', 'unlinked'] as const) {
      const row = deviceOriginRow(null, ALL_ON, reason);
      expect(row).toMatchObject({ recorded: null, reason, machine: { value: null, status: 'unknown' }, model: { value: null, status: 'unknown' } });
    }
  });
  it("a peer's row is re-checked and given THIS machine's display bits", () => {
    const off = { enabled: false, machine: true, harness: true, model: true };
    const peer = deviceOriginRow(e, ALL_ON);
    expect(validateDeviceOriginRow(peer, off)).toEqual({ ...peer, display: off });
    expect(validateDeviceOriginRow({ ...peer, recorded: 'yes' }, off)).toBeNull();
    expect(validateDeviceOriginRow({ ...peer, recorded: null }, off)).toBeNull(); // null needs a known reason
    expect(validateDeviceOriginRow({ ...peer, machine: { value: 'x\u0007', status: 'observed' } }, off)).toBeNull();
  });
});

describe('the setting (§5)', () => {
  it('the single enabled Telegram entry holds it; otherwise the top-level setting does', () => {
    const tg = [{ type: 'telegram', enabled: true, config: { messageOrigin: { display: { model: false } } } }];
    expect(effectiveDisplay(agentDisplaySetting(tg, { display: { machine: false } }))).toEqual({ ...ALL_ON, model: false });
    expect(effectiveDisplay(agentDisplaySetting([{ type: 'slack', enabled: true }], { display: { machine: false } }))).toEqual({ ...ALL_ON, machine: false });
    const disabledTg = [{ type: 'telegram', enabled: false, config: { messageOrigin: { display: { model: false } } } }];
    expect(effectiveDisplay(agentDisplaySetting(disabledTg, { display: { enabled: false } }))).toEqual({ ...ALL_ON, enabled: false });
  });
  it('absent means on; a conversation override wins per bit; a malformed bit reads as on', () => {
    expect(effectiveDisplay(undefined)).toEqual(ALL_ON);
    expect(effectiveDisplay({ harness: false }, { harness: true, model: false })).toEqual({ ...ALL_ON, model: false });
    expect(effectiveDisplay({ machine: 'no' })).toEqual(ALL_ON);
  });
});

describe('the Slack footer (§5)', () => {
  const e = originEvidenceFromProducer(producer(), 1);
  it('one italic line, configured labelled, off when display is off', () => {
    expect(slackOriginFooter('echo', e, ALL_ON)).toBe('_echo · Mac Studio · Claude Code · claude-opus-5-5_');
    const launch = originEvidenceFromLaunchRecord({ machineId: 'm', machineName: 'Mini', sessionId: 's', framework: 'codex-cli', model: 'gpt-6-astra', at: 1 });
    expect(slackOriginFooter('echo', launch, ALL_ON)).toBe('_echo · Mini · Codex (configured) · gpt-6-astra (configured)_');
    expect(slackOriginFooter('echo', e, { ...ALL_ON, enabled: false })).toBe('');
    expect(slackOriginFooter('echo', e, { enabled: true, machine: false, harness: false, model: true })).toBe('_echo · claude-opus-5-5_');
  });
  it('a nickname can never become a mention or formatting', () => {
    expect(escapeSlackLabel('<!channel> *bold*')).not.toMatch(/<!channel>/);
    expect(escapeSlackLabel('<!channel>')).toBe('&lt;!channel&gt;');
    const evil = originEvidenceFromLaunchRecord({ machineId: 'm', machineName: '<!channel>', sessionId: 's', framework: 'claude-code', model: null, at: 1 });
    expect(slackOriginFooter('echo', evil, ALL_ON)).not.toContain('<!channel>');
  });
});
