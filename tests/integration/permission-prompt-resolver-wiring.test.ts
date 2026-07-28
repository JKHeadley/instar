/**
 * PermissionPromptAutoResolver — DI-seam integration test.
 *
 * Spec: docs/specs/framework-permission-prompt-robustness.md
 *
 * Drives the real resolver through its injected I/O surface (no SessionManager / no
 * tmux). Pins the load-bearing Layer-2 contract end-to-end:
 *   - a real Claude Code approval prompt at the genuine bottom of a non-generating
 *     pane → the resolver sends exactly ONE `Enter` and writes ONE audit row;
 *   - a generating pane → NO keystroke (never interrupt live work);
 *   - emergencyDisabled → NO keystroke (the operator off-switch is honored first).
 */

import { describe, it, expect } from 'vitest';
import {
  PermissionPromptAutoResolver,
  toPaneTailLines,
  type PermissionPromptResolverDeps,
  type ResolverAuditRow,
  type PaneTailLine,
} from '../../src/monitoring/PermissionPromptAutoResolver.js';

// The real Claude Code 2.1.176 Bash-classifier approval prompt that wedges sessions.
const THE_CC_PROMPT = [
  'Compound command contains cd with output redirection — manual approval required',
  'to prevent path resolution bypass.',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No',
  '  Esc to cancel',
].join('\n');

interface Harness {
  resolver: PermissionPromptAutoResolver;
  sends: Array<{ session: string; key: string }>;
  audits: ResolverAuditRow[];
  defects: unknown[];
}

function mkResolver(overrides: Partial<PermissionPromptResolverDeps> = {}): Harness {
  const sends: Array<{ session: string; key: string }> = [];
  const audits: ResolverAuditRow[] = [];
  const defects: unknown[] = [];
  const promptTail = toPaneTailLines(THE_CC_PROMPT);
  const deps: PermissionPromptResolverDeps = {
    sendKey: (session, key) => { sends.push({ session, key }); return true; },
    // Race-guard re-capture returns the SAME live prompt tail by default.
    reCaptureTail: async (_session): Promise<PaneTailLine[] | null> => promptTail,
    isGenerating: () => false,
    raiseDefect: (d) => { defects.push(d); },
    appendAudit: (row) => { audits.push(row); },
    now: () => Date.now(),
    emergencyDisabled: () => false,
    ...overrides,
  };
  return { resolver: new PermissionPromptAutoResolver(deps), sends, audits, defects };
}

describe('PermissionPromptAutoResolver — DI-seam integration', () => {
  it('a real approval prompt → sends exactly one Enter + writes one audit row', async () => {
    const { resolver, sends, audits } = mkResolver();
    await resolver.evaluate('sess', toPaneTailLines(THE_CC_PROMPT));

    expect(sends).toEqual([{ session: 'sess', key: 'Enter' }]);
    expect(audits).toHaveLength(1);
    const row = audits[0];
    expect(row.sessionName).toBe('sess');
    expect(row.framework).toBe('claude-code');
    expect(row.keySent).toBe('Enter');
    expect(row.outcome).toBe('answered');
    // Privacy: the audit carries ONLY the static registry pattern names (a fixed
    // allowlist) — never bytes captured from the live pane tail.
    const REGISTRY_NAMES = new Set([
      'manual-approval',
      'path-resolution-bypass',
      'compound-cd-redirect',
      'do-you-want-to-proceed',
    ]);
    expect(row.matchedPatternNames.length).toBeGreaterThanOrEqual(2);
    for (const name of row.matchedPatternNames) {
      expect(REGISTRY_NAMES.has(name)).toBe(true);
    }
  });

  it('a generating pane → NO keystroke (never interrupt live work)', async () => {
    const { resolver, sends, audits } = mkResolver({ isGenerating: () => true });
    await resolver.evaluate('sess', toPaneTailLines(THE_CC_PROMPT));

    expect(sends).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('emergencyDisabled → NO keystroke (operator off-switch honored first)', async () => {
    const { resolver, sends, audits } = mkResolver({ emergencyDisabled: () => true });
    await resolver.evaluate('sess', toPaneTailLines(THE_CC_PROMPT));

    expect(sends).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('guardStatus reports the floor ON when not emergency-disabled, OFF when it is', async () => {
    const on = mkResolver();
    expect(on.resolver.guardStatus().enabled).toBe(true);

    const off = mkResolver({ emergencyDisabled: () => true });
    expect(off.resolver.guardStatus().enabled).toBe(false);
  });
});
