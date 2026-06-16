/**
 * Unit tests for the existing-agent PreToolUse hook-parity fix (the
 * dark-guardrail migration gap, 2026-05-27).
 *
 * Spec: docs/specs/EXISTING-AGENT-PRETOOLUSE-HOOK-PARITY-SPEC.md
 *
 * Covers:
 *  - The anti-drift contract: the canonical Bash hook set is exactly the
 *    expected guardrails (a future accidental removal fails here).
 *  - ensureInstarBashPreToolUseHooks: adds-when-missing, idempotent no-op,
 *    hand-curated preservation, no-Bash-matcher creation, filename-robust
 *    presence detection.
 *  - init.ts consumes the shared constant (drift impossible by construction).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTAR_BASH_PRETOOLUSE_HOOKS,
  INSTAR_MCP_PRETOOLUSE_HOOKS,
  INSTAR_BASH_PRETOOLUSE_FILENAMES,
  instarHookFilename,
  ensureInstarBashPreToolUseHooks,
  type SettingsMatcherEntry,
} from '../../src/core/instarSettingsHooks.js';

const EXPECTED_BASH_FILENAMES = [
  'dangerous-command-guard.sh',
  'grounding-before-messaging.sh',
  'deferral-detector.js',
  'self-stop-guard.js',
  'external-communication-guard.js',
  'post-action-reflection.js',
  'pr-hand-lease-guard.js',
];

const cmd = (file: string, runner: 'bash' | 'node' = 'node') =>
  `${runner} \${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/${file}`;

describe('canonical instar PreToolUse hook sets (anti-drift contract)', () => {
  it('Bash set is exactly the expected guardrails, in canonical order', () => {
    expect(INSTAR_BASH_PRETOOLUSE_FILENAMES).toEqual(EXPECTED_BASH_FILENAMES);
  });

  it('every Bash entry has a resolvable instar hook filename', () => {
    for (const h of INSTAR_BASH_PRETOOLUSE_HOOKS) {
      expect(instarHookFilename(h.command)).not.toBeNull();
    }
  });

  it('MCP set is the external-operation-gate', () => {
    expect(INSTAR_MCP_PRETOOLUSE_HOOKS.map((h) => instarHookFilename(h.command)))
      .toEqual(['external-operation-gate.js']);
  });

  it('does NOT include slopcheck-guard (owned by its own ensure-block)', () => {
    expect(INSTAR_BASH_PRETOOLUSE_FILENAMES).not.toContain('slopcheck-guard.js');
  });

  it('entries carry no stray `filename` key (settings.json byte-stability)', () => {
    for (const h of INSTAR_BASH_PRETOOLUSE_HOOKS) {
      expect(Object.keys(h).sort()).toEqual(
        Object.keys(h).filter((k) => ['type', 'command', 'blocking', 'timeout'].includes(k)).sort(),
      );
    }
  });
});

describe('instarHookFilename', () => {
  it('extracts the script basename from a hook command', () => {
    expect(instarHookFilename(cmd('deferral-detector.js'))).toBe('deferral-detector.js');
    expect(instarHookFilename(cmd('grounding-before-messaging.sh', 'bash'))).toBe('grounding-before-messaging.sh');
  });
  it('works for an absolute path variant (robust to ${CLAUDE_PROJECT_DIR} expansion)', () => {
    expect(instarHookFilename('node /Users/x/.instar/hooks/instar/deferral-detector.js')).toBe('deferral-detector.js');
  });
  it('returns null for a non-instar command', () => {
    expect(instarHookFilename('node ./scripts/other.js')).toBeNull();
    expect(instarHookFilename('bash do-thing.sh')).toBeNull();
  });
});

describe('ensureInstarBashPreToolUseHooks', () => {
  it('adds all canonical hooks to an empty PreToolUse (creates the Bash matcher)', () => {
    const preToolUse: SettingsMatcherEntry[] = [];
    const added = ensureInstarBashPreToolUseHooks(preToolUse);
    expect(added).toEqual(EXPECTED_BASH_FILENAMES);
    const bash = preToolUse.find((e) => e.matcher === 'Bash');
    expect(bash).toBeDefined();
    expect(bash!.hooks!.map((h) => instarHookFilename(h.command!))).toEqual(EXPECTED_BASH_FILENAMES);
  });

  it('is idempotent — a second run is a no-op', () => {
    const preToolUse: SettingsMatcherEntry[] = [];
    ensureInstarBashPreToolUseHooks(preToolUse);
    const added2 = ensureInstarBashPreToolUseHooks(preToolUse);
    expect(added2).toEqual([]);
    const bash = preToolUse.find((e) => e.matcher === 'Bash')!;
    // no duplicates
    const names = bash.hooks!.map((h) => instarHookFilename(h.command!));
    expect(names).toEqual(EXPECTED_BASH_FILENAMES);
  });

  it('adds only the MISSING hooks, preserving an existing one', () => {
    const preToolUse: SettingsMatcherEntry[] = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('dangerous-command-guard.sh', 'bash') }] },
    ];
    const added = ensureInstarBashPreToolUseHooks(preToolUse);
    expect(added).not.toContain('dangerous-command-guard.sh');
    expect(added).toContain('deferral-detector.js');
    const bash = preToolUse.find((e) => e.matcher === 'Bash')!;
    // dangerous-command-guard appears exactly once (not duplicated)
    const dcg = bash.hooks!.filter((h) => instarHookFilename(h.command!) === 'dangerous-command-guard.sh');
    expect(dcg).toHaveLength(1);
  });

  it('preserves hand-curated custom hooks and their position; appends instar ones after', () => {
    const customA = { type: 'command', command: 'bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/custom/my-guard.sh' };
    const customB = { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/custom/other.js' };
    const preToolUse: SettingsMatcherEntry[] = [
      { matcher: 'Bash', hooks: [customA, customB] },
    ];
    ensureInstarBashPreToolUseHooks(preToolUse);
    const bash = preToolUse.find((e) => e.matcher === 'Bash')!;
    // custom hooks remain first, in original order
    expect(bash.hooks![0].command).toBe(customA.command);
    expect(bash.hooks![1].command).toBe(customB.command);
    // instar hooks appended after, in canonical order
    const tail = bash.hooks!.slice(2).map((h) => instarHookFilename(h.command!));
    expect(tail).toEqual(EXPECTED_BASH_FILENAMES);
  });

  it('does not duplicate a hook already present under an ABSOLUTE path', () => {
    const preToolUse: SettingsMatcherEntry[] = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /Users/x/.instar/hooks/instar/deferral-detector.js' }] },
    ];
    const added = ensureInstarBashPreToolUseHooks(preToolUse);
    expect(added).not.toContain('deferral-detector.js');
    const bash = preToolUse.find((e) => e.matcher === 'Bash')!;
    const dd = bash.hooks!.filter((h) => instarHookFilename(h.command!) === 'deferral-detector.js');
    expect(dd).toHaveLength(1);
  });

  it('pushes fresh copies — never mutates the shared canonical objects', () => {
    const preToolUse: SettingsMatcherEntry[] = [];
    ensureInstarBashPreToolUseHooks(preToolUse);
    const bash = preToolUse.find((e) => e.matcher === 'Bash')!;
    const pushed = bash.hooks!.find((h) => instarHookFilename(h.command!) === 'deferral-detector.js')!;
    const canonical = INSTAR_BASH_PRETOOLUSE_HOOKS.find((h) => instarHookFilename(h.command) === 'deferral-detector.js')!;
    expect(pushed).not.toBe(canonical); // different object reference
    expect(pushed).toEqual(canonical); // same content
  });

  it('leaves a pre-existing non-Bash matcher untouched', () => {
    const mcp = { matcher: 'mcp__.*', hooks: [{ type: 'command', command: cmd('external-operation-gate.js') }] };
    const preToolUse: SettingsMatcherEntry[] = [mcp];
    ensureInstarBashPreToolUseHooks(preToolUse);
    expect(preToolUse.find((e) => e.matcher === 'mcp__.*')).toBe(mcp);
    expect(mcp.hooks).toHaveLength(1);
  });
});

describe('init.ts consumes the shared constant (drift impossible by construction)', () => {
  it('imports INSTAR_BASH_PRETOOLUSE_HOOKS from instarSettingsHooks', () => {
    const initPath = path.resolve(fileURLToPath(import.meta.url), '../../../src/commands/init.ts');
    const src = fs.readFileSync(initPath, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*INSTAR_BASH_PRETOOLUSE_HOOKS[^}]*\}\s*from\s*'\.\.\/core\/instarSettingsHooks\.js'/);
    // and no longer hand-rolls an inline deferral-detector hook literal
    expect(src).not.toMatch(/const instarBashHooks = \[\s*\{/);
  });
});
