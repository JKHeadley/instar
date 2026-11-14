/**
 * message-origin-all-platforms §2: the evidence ladder for app and Slack replies. The session is
 * the one the verified bind token names; a credential for another session is not accepted, and
 * nothing here ever refuses a reply.
 */
import { describe, it, expect } from 'vitest';
import { boundSessionName, resolveReplyOrigin, type ReplyOriginDeps } from '../../src/server/replyOrigin.js';
import type { TelegramOriginProducer } from '../../src/messaging/telegram-origin/types.js';

const TOKEN = `ior1_${'a'.repeat(43)}`;
const observed = (value: string) => ({ value, status: 'observed' as const, sourceEventRef: 'x', observedAt: 1, reason: null });
const producerFor = (sessionId: string): TelegramOriginProducer => ({
  agentId: 'echo', agentName: 'echo', originMachineId: 'identity-m', originMachineName: 'Mac Studio', sessionId, sessionIncarnation: 'i',
  turnId: null, producerKind: 'session', producerId: sessionId, harnessId: 'claude-code', harnessName: 'Claude Code',
  machine: observed('Mac Studio'), harness: observed('claude-code'), model: observed('claude-opus-5-5'),
});
function deps(over: Partial<ReplyOriginDeps> = {}): ReplyOriginDeps {
  const sessions: Record<string, { tmux: string; framework: string; model: string }> = {
    'sid-1': { tmux: 'echo-topic-1', framework: 'codex-cli', model: 'gpt-6-astra' },
    'sid-2': { tmux: 'echo-topic-2', framework: 'claude-code', model: 'claude-opus-5-5' },
  };
  return {
    machine: () => ({ id: 'store-m', name: 'Mac Studio' }),
    originService: () => ({ sessionProducer: async () => producerFor('sid-1') }),
    runningSessionByTmux: (t) => { const e = Object.entries(sessions).find(([, s]) => s.tmux === t); return e ? { id: e[0], framework: e[1].framework, model: e[1].model } : null; },
    tmuxForSessionId: (id) => sessions[id]?.tmux ?? null,
    now: () => 99,
    ...over,
  };
}

describe('resolveReplyOrigin', () => {
  it('rung 1: a credential for the bound session gives observed evidence, recorded under the store machine id', async () => {
    const e = await resolveReplyOrigin(deps(), { boundSession: 'echo-topic-1', originCredential: TOKEN });
    expect(e).toMatchObject({ producerKind: 'session', machineId: 'store-m', harness: { value: 'claude-code', status: 'observed' }, model: { status: 'observed' } });
  });
  it("a credential for ANOTHER session is not accepted: the bound session's launch record is used", async () => {
    const e = await resolveReplyOrigin(deps(), { boundSession: 'echo-topic-2', originCredential: TOKEN });
    expect(e.harness).toMatchObject({ value: 'claude-code', status: 'configured' }); // sid-2's launch record, not sid-1's credential
    expect(e.model).toMatchObject({ value: 'claude-opus-5-5', status: 'configured' });
  });
  it('a credential that does not verify falls to rung 2, never a refusal', async () => {
    const e = await resolveReplyOrigin(deps({ originService: () => ({ sessionProducer: async () => { throw new Error('session-not-live'); } }) }),
      { boundSession: 'echo-topic-1', originCredential: TOKEN });
    expect(e.harness).toMatchObject({ value: 'codex-cli', status: 'configured' });
  });
  it('a credential lookup that never answers is bounded and falls to rung 2', async () => {
    const e = await resolveReplyOrigin(deps({ originService: () => ({ sessionProducer: () => new Promise<never>(() => undefined) }) }),
      { boundSession: 'echo-topic-1', originCredential: TOKEN });
    expect(e.harness).toMatchObject({ value: 'codex-cli', status: 'configured' });
  });
  it('a throwing dependency never throws out of the ladder: rung 3', async () => {
    const e = await resolveReplyOrigin(deps({ originService: () => null, runningSessionByTmux: () => { throw new Error('state unreadable'); } }),
      { boundSession: 'echo-topic-1', originCredential: undefined });
    expect(e.producerKind).toBe('unknown');
  });
  it('no origin runtime (no Telegram): rung 2 from the launch record', async () => {
    const e = await resolveReplyOrigin(deps({ originService: () => null }), { boundSession: 'echo-topic-1', originCredential: undefined });
    expect(e).toMatchObject({ producerKind: 'session', harnessName: 'Codex', model: { value: 'gpt-6-astra', status: 'configured' } });
  });
  it('rung 3: no session evidence is recorded as unknown, honestly', async () => {
    const e = await resolveReplyOrigin(deps({ originService: () => null }), { boundSession: 'not-running', originCredential: 'garbage' });
    expect(e).toMatchObject({ producerKind: 'unknown', machine: { value: 'Mac Studio', status: 'observed' }, harness: { status: 'unknown', reason: 'no-session-evidence' } });
  });
  it('the legacy raw route (no bind token) accepts a verifying credential on its own, else unknown', async () => {
    expect((await resolveReplyOrigin(deps(), { boundSession: null, originCredential: TOKEN })).harness.status).toBe('observed');
    expect((await resolveReplyOrigin(deps(), { boundSession: null, originCredential: undefined })).producerKind).toBe('unknown');
  });
  it('a header naming a session is not evidence: only the bind verdict names it', () => {
    expect(boundSessionName('session:echo-topic-1')).toBe('echo-topic-1');
    expect(boundSessionName(undefined)).toBeNull();
    expect(boundSessionName('device:abc')).toBeNull();
  });
});
