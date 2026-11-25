import { describe, expect, it, vi } from 'vitest';
import { evaluateRecovery } from '../../scripts/verify-studio-context-recovery.mjs';

const codexCommand = 'bash /agent/.instar/hooks/instar/telegram-topic-context.sh';
const claudeCommand = 'bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh"';

function fixture() {
  const claude = {
    engine: 'claude-code', machine: 'studio', at: 1200, recoveryBlock: true,
    postCompact: true, postCompactAt: 1199, synthetic: false,
  };
  const codex = {
    engine: 'codex-cli', machine: 'studio', at: 1300, recoveryBlock: true,
    synthetic: false, sessionId: 'codex-session', boundaryUuid: 'codex-epoch',
    seededCarrier: 'packet:1234abcd',
  };
  const marker = {
    sessionId: codex.sessionId, engine: 'codex-cli', source: 'compact',
    delivery: 'next-prompt',
    epochs: [{ epoch: codex.boundaryUuid, carrier: codex.seededCarrier, seededAt: 1400 }],
  };
  const input = {
    expectedVersion: '1.3.2038', machine: 'studio', installedAt: 1000, now: 2000,
    health: { version: '1.3.2038' },
    sentinel: { heartbeatFresh: true, lastTickAt: 1500, canary: { recent: [claude, codex] } },
    claudeSettings: { hooks: { SessionStart: [{ matcher: 'compact', hooks: [
      { type: 'command', command: claudeCommand, timeout: 45 },
    ] }] } },
    codexSettings: { hooks: { UserPromptSubmit: [{ matcher: '', hooks: [
      { type: 'command', command: codexCommand, timeout: 15_000 },
    ] }] } },
    claudeScriptExecutable: true,
    codexScriptExecutable: true,
    codexHookCommands: [codexCommand],
    readMarker: vi.fn(() => marker),
  };
  return { claude, codex, marker, input };
}

describe('Studio recovery release evidence', () => {
  it('requires native evidence from both engines on the installed version', () => {
    const { input } = fixture();
    expect(evaluateRecovery(input)).toMatchObject({
      status: 'native-recovery-observed',
      observations: { claudeCode: true, codex: true },
    });
  });

  it('holds on a different running release or a heartbeat older than deployment', () => {
    const { input } = fixture();
    expect(evaluateRecovery({ ...input, health: { version: '1.3.2032' } }).status)
      .toBe('awaiting-evidence');
    input.sentinel.lastTickAt = 999;
    expect(evaluateRecovery(input).checks.freshSentinel).toBe(false);
    expect(input.readMarker).not.toHaveBeenCalled();
  });

  it('requires the executable registered hook at each repaired deadline', () => {
    const { input } = fixture();
    input.claudeSettings.hooks.SessionStart[0].hooks[0].timeout = 5;
    input.codexSettings.hooks.UserPromptSubmit[0].hooks[0].command = codexCommand.replace('/agent/', '/other/');
    expect(evaluateRecovery(input).checks).toMatchObject({ claudeHook: false, codexHook: false });
    expect(evaluateRecovery({ ...fixture().input, codexScriptExecutable: false }).checks.codexHook)
      .toBe(false);
  });

  it('rejects old, foreign, synthetic or truncated recovery observations', () => {
    for (const change of [
      { at: 999 }, { machine: 'laptop' }, { synthetic: true }, { recoveryTruncated: true },
      { postCompact: false }, { postCompactAt: 999 }, { at: 2001 },
    ]) {
      const { claude, input } = fixture();
      Object.assign(claude, change);
      expect(evaluateRecovery(input).observations.claudeCode).toBe(false);
    }
  });

  it('requires a fresh acknowledgment matching the Codex carrier and epoch', () => {
    for (const change of [
      { carrier: 'packet:ffffffff' }, { epoch: 'different-boundary' },
      { seededAt: 1299 }, { seededAt: 2001 },
    ]) {
      const { marker, input } = fixture();
      Object.assign(marker.epochs[0], change);
      expect(evaluateRecovery(input).observations.codex).toBe(false);
    }
    const { input } = fixture();
    expect(evaluateRecovery({ ...input, readMarker: () => null }).observations.codex).toBe(false);
  });

  it('does not look up a marker for an unsafe session identifier or superseded epoch', () => {
    const { codex, input } = fixture();
    codex.sessionId = '../other-session';
    expect(evaluateRecovery(input).observations.codex).toBe(false);
    Object.assign(codex, { sessionId: 'codex-session', superseded: true });
    expect(evaluateRecovery(input).observations.codex).toBe(false);
    expect(input.readMarker).not.toHaveBeenCalled();
  });
});
