import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { createTempProject, type TempProject } from '../helpers/setup.js';

let project: TempProject;
afterEach(() => { vi.restoreAllMocks(); project?.cleanup(); });
function manager(rollout: string | null = null, framework: 'codex-cli' | 'claude-code' = 'codex-cli') {
  project = createTempProject();
  const sm = new SessionManager({ tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/false', projectDir: project.dir,
    framework, maxSessions: 2, protectedSessions: [], completionPatterns: [] }, project.state, {
    stageBActivation: { configured: true, pendingActivation: false, active: true, artifactDigest: null, reason: 'candidate-canary' },
    codexRolloutPathForSession: () => rollout,
  });
  project.state.saveSession({ id: 'id', name: 'idle', tmuxSession: 'idle', status: 'running', framework,
    claudeSessionId: rollout ? 'native-id' : undefined, startedAt: new Date().toISOString(), model: 'test', maxDurationMinutes: 5 });
  // Native framework selection comes from tmux environment, not the saved record.
  vi.spyOn(sm as unknown as { getSessionFramework: () => 'codex-cli' | 'claude-code' }, 'getSessionFramework').mockReturnValue(framework);
  expect(sm.frameworkForSession('idle')).toBe(framework);
  const effect = vi.spyOn(sm as unknown as { performTmuxInjectionEffect: () => void }, 'performTmuxInjectionEffect').mockImplementation(() => {});
  return { sm, effect };
}

describe('Invocation-local Telegram refusal observation', () => {
  it('tags the actual ordinary missing-baseline branch before any durable prepare or physical effect', () => {
    const { sm, effect } = manager();
    expect(sm.injectTelegramMessageObserved('idle', 91, 'current message', undefined, undefined, undefined, 157))
      .toEqual({ injected: false, refusal: 'codex-baseline-unavailable-before-dispatch' });
    expect(sm.injectTelegramMessageObserved('idle', 91, 'current message', undefined, undefined, undefined, 157).injected).toBe(false);
    expect(effect).not.toHaveBeenCalled();
    expect(sm.inboundDeliveryStatus()).toMatchObject({ logicalRows: 0 });
  });

  it('allows a genuine later success after proven before-effect refusals, then deduplicates that success', () => {
    const { sm } = manager();
    expect(sm.injectTelegramMessageObserved('idle', 91, 'message', undefined, undefined, undefined, 157).injected).toBe(false);
    const inject = vi.spyOn(sm, 'injectMessage').mockReturnValue(true);
    expect(sm.injectTelegramMessageObserved('idle', 91, 'message', undefined, undefined, undefined, 157).injected).toBe(true);
    expect(sm.injectTelegramMessageObserved('idle', 91, 'message', undefined, undefined, undefined, 157).injected).toBe(true);
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('suppresses the same source after a real partial-effect error without ever claiming delivery', () => {
    const { sm, effect } = manager(null, 'claude-code');
    const partial = path.join(project.dir, 'partial-effect.txt');
    effect.mockImplementation(() => { fs.appendFileSync(partial, 'pasted\n'); throw new Error('fixture failed after partial paste'); });
    expect(sm.injectTelegramMessageObserved('idle', 91, 'partial effect', undefined, undefined, undefined, 158)).toEqual({ injected: false });
    expect(fs.readFileSync(partial, 'utf8')).toBe('pasted\n');
    expect(sm.injectTelegramMessageObserved('idle', 91, 'partial effect', undefined, undefined, undefined, 158)).toEqual({ injected: false });
    expect(fs.readFileSync(partial, 'utf8')).toBe('pasted\n');
  });

  it('does not infer a typed refusal from an unrelated false result', () => {
    const { sm } = manager();
    vi.spyOn(sm, 'injectMessage').mockReturnValue(false);
    expect(sm.injectTelegramMessageObserved('idle', 91, 'other refusal')).toEqual({ injected: false });
  });

  it('does not tag the later baseline-bind failure after prepare', () => {
    const { sm, effect } = manager();
    const rollout = path.join(project.dir, 'rollout.jsonl'); fs.writeFileSync(rollout, '{}\n');
    const internals = sm as unknown as { codexRolloutPathForSession: () => string; inboundDeliveries: { bindRolloutBaseline: () => boolean } };
    internals.codexRolloutPathForSession = () => rollout;
    const session = project.state.listSessions()[0]; project.state.saveSession({ ...session, claudeSessionId: 'native-id' });
    vi.spyOn(internals.inboundDeliveries, 'bindRolloutBaseline').mockReturnValue(false);
    expect(sm.injectTelegramMessageObserved('idle', 91, 'post-prepare refusal')).toEqual({ injected: false });
    expect(effect).not.toHaveBeenCalled();
    expect(sm.inboundDeliveryStatus()).toMatchObject({ logicalRows: 1 });
  });

  it('leaves the exact matching bootstrap exception untagged', () => {
    const { sm } = manager();
    const pending = (sm as unknown as { pendingInjects: { record: (entry: unknown) => void } }).pendingInjects;
    pending.record({ tmuxSession: 'idle', initialMessage: '[telegram:91 (name unresolved)] bootstrap', telegramTopicId: 91, freshPreRolloutBootstrap: true });
    // Refuse after prepare so this test proves the ordinary pre-prepare tag did not fire.
    vi.spyOn((sm as unknown as { inboundDeliveries: { hasOtherActiveDispatch: () => boolean } }).inboundDeliveries, 'hasOtherActiveDispatch').mockReturnValue(true);
    expect(sm.injectTelegramMessageObserved('idle', 91, 'bootstrap')).toEqual({ injected: true });
    expect(sm.inboundDeliveryStatus()).toMatchObject({ logicalRows: 1 });
  });

  it('keeps nested observations separate and restores context after a throw', () => {
    const { sm } = manager();
    const real = sm.injectTelegramMessage.bind(sm);
    vi.spyOn(sm, 'injectTelegramMessage').mockImplementation((session, ...args) => {
      if (session === 'outer') {
        expect(sm.injectTelegramMessageObserved('idle', 91, 'inner').refusal).toBe('codex-baseline-unavailable-before-dispatch');
        return false;
      }
      if (session === 'throw') throw new Error('fixture exception');
      return real(session, ...args);
    });
    expect(sm.injectTelegramMessageObserved('outer', 91, 'outer')).toEqual({ injected: false });
    expect(() => sm.injectTelegramMessageObserved('throw', 91, 'throw')).toThrow('fixture exception');
    expect(sm.injectTelegramMessageObserved('outer', 91, 'outer again')).toEqual({ injected: false });
  });
});
