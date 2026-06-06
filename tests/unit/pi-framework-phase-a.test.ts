/**
 * Pi framework Phase A — unit tests (PI-HARNESS-INTEGRATION-SPEC §2-3).
 *
 * Covers the fourth-framework registration surfaces:
 *   - launch builders (interactive + headless argv shapes)
 *   - model pass-through resolution
 *   - framework prerequisite check (both sides of the boundary)
 *   - configured-framework resolution (config / env / enabledFrameworks)
 *   - the pi stuck-input marker heuristic, pinned against REAL pane captures
 *     from the P0.1 hands-on eval (pi 0.78.1 under tmux)
 *
 * The framework-agnosticism suite (tests/unit/framework-agnosticism.test.ts)
 * additionally enforces the injection-process pairing structurally — pi-cli
 * is covered there via SUPPORTED_FRAMEWORKS without changes.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveLaunch,
  buildHeadlessLaunch,
  resolveModelForFramework,
} from '../../src/core/frameworkSessionLaunch.js';
import {
  checkFrameworkPrerequisite,
  resolveConfiguredFramework,
} from '../../src/core/Config.js';
import { SUPPORTED_FRAMEWORKS } from '../../src/core/TopicFrameworksStore.js';
import { SessionManager } from '../../src/core/SessionManager.js';

const PI_BIN = '/opt/homebrew/bin/pi';

describe('pi-cli launch builders (spec §2.2-2.3)', () => {
  it('interactive: minimal launch is just the binary (pi is YOLO by design — no approval flag exists)', () => {
    const spec = buildInteractiveLaunch('pi-cli', { binaryPath: PI_BIN });
    expect(spec.argv).toEqual([PI_BIN]);
    expect(spec.envOverrides['CLAUDECODE']).toBe('');
  });

  it('interactive: pins --session-dir when piSessionDir is provided (durable transcripts)', () => {
    const spec = buildInteractiveLaunch('pi-cli', {
      binaryPath: PI_BIN,
      piSessionDir: '/agent/.instar/state/pi-sessions',
    });
    expect(spec.argv).toEqual([PI_BIN, '--session-dir', '/agent/.instar/state/pi-sessions']);
  });

  it('interactive: resume maps to --session-id (create-or-resume; deterministic)', () => {
    const spec = buildInteractiveLaunch('pi-cli', {
      binaryPath: PI_BIN,
      resumeSessionId: 'abc-123',
    });
    expect(spec.argv).toEqual([PI_BIN, '--session-id', 'abc-123']);
  });

  it('interactive: resumeSessionId wins over sessionId (mirrors the claude-code builder)', () => {
    const spec = buildInteractiveLaunch('pi-cli', {
      binaryPath: PI_BIN,
      resumeSessionId: 'resume-id',
      sessionId: 'fresh-id',
    });
    expect(spec.argv).toContain('resume-id');
    expect(spec.argv).not.toContain('fresh-id');
  });

  it('interactive: defaultModel passes through as --model (provider/id pattern)', () => {
    const spec = buildInteractiveLaunch('pi-cli', {
      binaryPath: PI_BIN,
      defaultModel: 'openai-codex/gpt-5.5',
    });
    expect(spec.argv).toEqual([PI_BIN, '--model', 'openai-codex/gpt-5.5']);
  });

  it('headless: canonical one-shot argv (eval-verified: -p --mode json --no-session --offline <prompt>)', () => {
    const spec = buildHeadlessLaunch('pi-cli', {
      binaryPath: PI_BIN,
      prompt: 'summarize this thread',
    });
    expect(spec.argv).toEqual([
      PI_BIN, '-p', '--mode', 'json', '--no-session', '--offline',
      'summarize this thread',
    ]);
    expect(spec.envOverrides['CLAUDECODE']).toBe('');
  });

  it('headless: a leading-dash prompt stays a single positional (cannot be re-parsed as a flag)', () => {
    const spec = buildHeadlessLaunch('pi-cli', {
      binaryPath: PI_BIN,
      prompt: '--not-a-flag really',
    });
    expect(spec.argv[spec.argv.length - 1]).toBe('--not-a-flag really');
  });

  it('model resolution: generic tiers pass through verbatim (provider-specific vocabulary lives in pi)', () => {
    expect(resolveModelForFramework('pi-cli', 'fast')).toBe('fast');
    expect(resolveModelForFramework('pi-cli', 'anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(resolveModelForFramework('pi-cli', undefined)).toBeUndefined();
  });
});

describe('pi-cli framework prerequisite + resolution (spec §2.1)', () => {
  it('prerequisite satisfied when the pi binary is detected', () => {
    const r = checkFrameworkPrerequisite({
      configuredFramework: 'pi-cli',
      claudePathDetected: null,
      codexPathDetected: null,
      piPathDetected: PI_BIN,
    });
    expect(r.satisfied).toBe(true);
  });

  it('prerequisite FAILS with an actionable install hint when pi is missing', () => {
    const r = checkFrameworkPrerequisite({
      configuredFramework: 'pi-cli',
      claudePathDetected: '/usr/local/bin/claude',
      codexPathDetected: null,
      piPathDetected: null,
    });
    expect(r.satisfied).toBe(false);
    expect(r.error).toContain('@earendil-works/pi-coding-agent');
  });

  it('resolveConfiguredFramework honors pi-cli from config, env (pi-cli|pi), and enabledFrameworks[0]', () => {
    expect(resolveConfiguredFramework('pi-cli', undefined)).toBe('pi-cli');
    expect(resolveConfiguredFramework(undefined, 'pi-cli')).toBe('pi-cli');
    expect(resolveConfiguredFramework(undefined, 'pi')).toBe('pi-cli');
    expect(resolveConfiguredFramework(undefined, undefined, ['pi-cli'])).toBe('pi-cli');
    // Unrelated values still default to claude-code (back-compat).
    expect(resolveConfiguredFramework(undefined, undefined, undefined)).toBe('claude-code');
  });

  it('pi-cli is registered in SUPPORTED_FRAMEWORKS (topic-framework store accepts it)', () => {
    expect(SUPPORTED_FRAMEWORKS).toContain('pi-cli');
  });
});

describe('pi stuck-input marker heuristic (spec §2.2; REAL pane captures, pi 0.78.1)', () => {
  // The method is pure (only reads pane + marker), so calling it unbound is safe
  // and avoids constructing a full SessionManager in a unit test.
  const isStuck = (pane: string, marker: string): boolean =>
    SessionManager.prototype.isMarkerStuckAtPrompt.call(undefined as never, pane, marker);

  const RULE = '─'.repeat(200);

  it('detects a marker stranded in pi input box (sandwiched between two rules) — REAL capture shape', () => {
    // Verbatim shape from the live tmux capture of an unsubmitted injection.
    const pane = [
      ' pi v0.78.1',
      ' escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more',
      '',
      RULE,
      'STUCK-MARKER-TEST do not submit this text',
      RULE,
      '/private/tmp/pi-eval/workspace',
      '0.0%/128k (auto)                    mock-model',
    ].join('\n');
    expect(isStuck(pane, 'STUCK-MARKER-TEST do not submit this te')).toBe(true);
  });

  it('does NOT flag the same text once submitted into the transcript (no rule sandwich) — REAL capture shape', () => {
    // Verbatim shape from the live capture AFTER submission: the message renders
    // in the transcript area, the input box (between the rules) is empty.
    const pane = [
      ' pi v0.78.1',
      ' Run the eval command.',
      ' $ echo HERMETIC-TOOL-EXEC-OK && pwd',
      ' HERMETIC-TOOL-EXEC-OK',
      ' Took 0.0s',
      ' EVAL-COMPLETE: tool ran and result received.',
      RULE,
      '',
      RULE,
      '/private/tmp/pi-eval/workspace',
      '↑250 ↓30 0.1%/128k (auto)           mock-model',
    ].join('\n');
    expect(isStuck(pane, 'Run the eval command.')).toBe(false);
  });

  it('detects a long input wrapped across two rows inside the box (rule within 2 lines both sides)', () => {
    const pane = [
      RULE,
      'WRAPPED-MARKER-LINE-ONE continues with a very long instruction that',
      'spills onto a second visible row in the input box',
      RULE,
      '/private/tmp/pi-eval/workspace',
    ].join('\n');
    expect(isStuck(pane, 'WRAPPED-MARKER-LINE-ONE continues with a')).toBe(true);
  });

  it('does not false-fire on transcript text adjacent to a single rule', () => {
    const pane = [
      ' some earlier output',
      ' THE-MARKER-TEXT appears in normal transcript output here',
      RULE,
      'input box is empty',
      RULE,
    ].join('\n');
    // marker line has a rule BELOW (within 2) but none above → not stuck.
    expect(isStuck(pane, 'THE-MARKER-TEXT appears in normal trans')).toBe(false);
  });

  it('existing framework prompt-char detection is unchanged (claude ❯ / codex › / gemini │ *)', () => {
    expect(isStuck('❯ MARKER-FOR-CLAUDE sitting at the prompt', 'MARKER-FOR-CLAUDE sitting at the prompt')).toBe(true);
    expect(isStuck('› MARKER-FOR-CODEX sitting at the prompt', 'MARKER-FOR-CODEX sitting at the prompt')).toBe(true);
    expect(isStuck('│ * MARKER-FOR-GEMINI in the input box', 'MARKER-FOR-GEMINI in the input box')).toBe(true);
  });
});
