import { describe, it, expect } from 'vitest';
import {
  parseCodexHookTrust,
  codexHooksArmingStatus,
  expectedHookSlots,
} from '../../src/core/codexHookTrust.js';

// Mirrors the real ~/.codex/config.toml [hooks.state] shape observed on codey.
const HOOKS_PATH = '/Users/x/proj/.codex/hooks.json';
const SAMPLE = `
model = "gpt-5.5"

[projects."/Users/x/proj"]
trust_level = "trusted"

[hooks.state."${HOOKS_PATH}:pre_tool_use:0:0"]
trusted_hash = "sha256:aaa"

[hooks.state."${HOOKS_PATH}:stop:0:0"]
trusted_hash = "sha256:bbb"
enabled = false

[hooks.state."${HOOKS_PATH}:stop:0:1"]
trusted_hash = "sha256:ccc"

[hooks.state."/Users/OTHER/proj/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:zzz"
`;

describe('parseCodexHookTrust', () => {
  it('parses only entries for the given hooks.json path', () => {
    const e = parseCodexHookTrust(SAMPLE, HOOKS_PATH);
    expect(e.map((x) => x.slot).sort()).toEqual(['pre_tool_use:0:0', 'stop:0:0', 'stop:0:1']);
    // The other project's entry is excluded.
    expect(e.find((x) => x.key.includes('OTHER'))).toBeUndefined();
  });

  it('defaults enabled=true (Codex omits the field) and reads explicit enabled=false', () => {
    const e = parseCodexHookTrust(SAMPLE, HOOKS_PATH);
    expect(e.find((x) => x.slot === 'pre_tool_use:0:0')!.enabled).toBe(true);
    expect(e.find((x) => x.slot === 'stop:0:0')!.enabled).toBe(false); // disabled
    expect(e.find((x) => x.slot === 'stop:0:1')!.enabled).toBe(true);
  });

  it('captures trusted_hash', () => {
    const e = parseCodexHookTrust(SAMPLE, HOOKS_PATH);
    expect(e.find((x) => x.slot === 'pre_tool_use:0:0')!.trustedHash).toBe('sha256:aaa');
  });

  it('returns empty when the path has no entries', () => {
    expect(parseCodexHookTrust(SAMPLE, '/nope/.codex/hooks.json')).toEqual([]);
  });
});

describe('codexHooksArmingStatus', () => {
  it('flags untrusted (missing) and disabled (enabled=false) slots', () => {
    const status = codexHooksArmingStatus(SAMPLE, HOOKS_PATH, [
      'pre_tool_use:0:0', // trusted+enabled
      'stop:0:0',          // trusted but disabled
      'stop:0:1',          // trusted+enabled
      'stop:0:2',          // missing entirely
    ]);
    expect(status.untrusted).toEqual(['stop:0:2']);
    expect(status.disabled).toEqual(['stop:0:0']);
    expect(status.allArmed).toBe(false);
  });

  it('allArmed=true when every expected slot is trusted + enabled', () => {
    const status = codexHooksArmingStatus(SAMPLE, HOOKS_PATH, ['pre_tool_use:0:0', 'stop:0:1']);
    expect(status.allArmed).toBe(true);
    expect(status.untrusted).toEqual([]);
    expect(status.disabled).toEqual([]);
  });

  it('treats a fresh agent (no entries) as fully untrusted', () => {
    const status = codexHooksArmingStatus('', HOOKS_PATH, ['pre_tool_use:0:0', 'stop:0:0']);
    expect(status.untrusted).toEqual(['pre_tool_use:0:0', 'stop:0:0']);
    expect(status.allArmed).toBe(false);
  });
});

describe('expectedHookSlots', () => {
  it('derives <state_event>:<group>:<idx> slots from a hooks config', () => {
    const hooks = {
      PreToolUse: [{ hooks: [{}, {}, {}, {}] }], // 4 hooks
      Stop: [{ hooks: [{}, {}, {}] }],           // 3 hooks
      SessionStart: [{ hooks: [{}] }],
    };
    const slots = expectedHookSlots(hooks as any);
    expect(slots).toContain('pre_tool_use:0:0');
    expect(slots).toContain('pre_tool_use:0:3');
    expect(slots).toContain('stop:0:2');
    expect(slots).toContain('session_start:0:0');
    expect(slots).toHaveLength(8);
  });
});
