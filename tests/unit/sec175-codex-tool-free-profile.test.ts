// safe-git-allow: test file — direct fs usage is fixture setup only.
/**
 * SEC-175: a Codex call marked noLocalTools (a prompt holding outside text)
 * must run tool-free, including web search, which Codex leaves on by default.
 * Asserts the real argv in both invocation modes, and that every built-in tool
 * the openai-codex adapter registers is closed by the profile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexCliIntelligenceProvider } from '../../src/core/CodexCliIntelligenceProvider.js';
import {
  CODEX_TOOL_FREE_CONFIG,
  CODEX_TOOL_FREE_COVERAGE,
  CODEX_TOOL_FREE_DISABLED_FEATURES,
  codexToolFreeArgs,
} from '../../src/core/codexToolFreeProfile.js';
import { createToolAccess } from '../../src/providers/adapters/openai-codex/capability/toolAccess.js';

let dir: string;
let prevEnv: string | undefined;

function fakeCodex(): string {
  const argv = path.join(dir, 'argv.txt');
  const p = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(
    p,
    `#!/bin/sh
: > "${argv}"
OUTFILE=""
PREV=""
for a in "$@"; do
  printf '%s\\n' "$a" >> "${argv}"
  if [ "$PREV" = "--output-last-message" ]; then OUTFILE="$a"; fi
  PREV="$a"
done
cat > /dev/null
if [ -n "$OUTFILE" ]; then printf '%s' 'OK' > "$OUTFILE"; else printf '%s' 'OK'; fi
exit 0
`,
    { mode: 0o755 },
  );
  return p;
}

function readArgv(): string[] {
  return fs.readFileSync(path.join(dir, 'argv.txt'), 'utf-8').split('\n').filter(Boolean);
}

/** True when `flag value` appears as an adjacent pair. */
function hasPair(argv: string[], flag: string, value: string): boolean {
  return argv.some((a, i) => a === flag && argv[i + 1] === value);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec175-codex-'));
  prevEnv = process.env.INSTAR_CODEX_EXEC_JSON;
  delete process.env.INSTAR_CODEX_EXEC_JSON;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.INSTAR_CODEX_EXEC_JSON;
  else process.env.INSTAR_CODEX_EXEC_JSON = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SEC-175 Codex tool-free profile', () => {
  for (const mode of ['exec-json', 'plain'] as const) {
    it(`a noLocalTools call turns web search and every other tool off (${mode} mode)`, async () => {
      if (mode === 'plain') process.env.INSTAR_CODEX_EXEC_JSON = '0';
      const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodex() });
      await provider.evaluate('outside text', { noLocalTools: true, attribution: { component: 'test' } });
      const argv = readArgv();
      expect(hasPair(argv, '-c', 'web_search="disabled"')).toBe(true);
      for (const f of CODEX_TOOL_FREE_DISABLED_FEATURES) expect(hasPair(argv, '--disable', f)).toBe(true);
      for (const c of CODEX_TOOL_FREE_CONFIG) expect(hasPair(argv, '-c', c)).toBe(true);
      expect(hasPair(argv, '--sandbox', 'read-only')).toBe(true);
    });

    it(`an ordinary call is unchanged (${mode} mode)`, async () => {
      if (mode === 'plain') process.env.INSTAR_CODEX_EXEC_JSON = '0';
      const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodex() });
      await provider.evaluate('plain call', { attribution: { component: 'test' } });
      const argv = readArgv();
      expect(argv).not.toContain('web_search="disabled"');
      expect(argv).not.toContain('--disable');
    });
  }

  it('every built-in tool the Codex adapter registers is closed by the profile', () => {
    const args = codexToolFreeArgs();
    const tools = createToolAccess().registeredTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const closedBy = CODEX_TOOL_FREE_COVERAGE[tool.name];
      expect(closedBy, `no tool-free rule for Codex tool "${tool.name}"`).toBeTruthy();
      if (closedBy === 'sandbox') continue; // refused by the read-only sandbox
      expect(args, `rule for "${tool.name}" is not in the argv`).toContain(closedBy);
    }
  });

  it('only long-standing feature names use --disable, because Codex refuses an unknown one', () => {
    // A newer switch belongs in CODEX_TOOL_FREE_CONFIG as -c features.<name>=false,
    // which an older Codex ignores instead of failing the call.
    expect([...CODEX_TOOL_FREE_DISABLED_FEATURES]).toEqual([
      'shell_tool',
      'unified_exec',
      'apps',
      'browser_use',
      'computer_use',
    ]);
  });
});
