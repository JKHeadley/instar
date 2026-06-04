/**
 * Unit tests — frameworkSessionLaunch.
 *
 * Verifies that the launch-arg builder produces the right argv and
 * env-overrides shape for each framework. Includes a regression-class
 * test against the v0.x Claude shape so a future builder change can't
 * silently break existing Claude-installed agents.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildInteractiveLaunch,
  buildHeadlessLaunch,
  resolveInteractiveFramework,
  resolveModelForFramework,
} from '../../src/core/frameworkSessionLaunch.js';
import { __resetCodexCapabilityCache } from '../../src/core/codexCapabilities.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Fake `codex` binary whose --help text we control, so the capability probe is deterministic. */
const _fakeCodexDirs: string[] = [];
function fakeCodexBinary(supportsHookTrustBypass: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-codex-'));
  _fakeCodexDirs.push(dir);
  const bin = path.join(dir, 'codex');
  const flagLine = supportsHookTrustBypass ? '  --dangerously-bypass-hook-trust  bypass\n' : '';
  fs.writeFileSync(bin, `#!/bin/bash\ncat <<'HELP'\nUsage: codex\n${flagLine}  -m, --model <M>\nHELP\n`, { mode: 0o755 });
  __resetCodexCapabilityCache();
  return bin;
}
afterAll(() => { for (const d of _fakeCodexDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/frameworkSessionLaunch.test.ts:cleanup' }); });

describe('frameworkSessionLaunch.buildInteractiveLaunch', () => {
  describe('claude-code', () => {
    it('produces the legacy v0.x argv shape (binary + --dangerously-skip-permissions)', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
      });
      expect(spec.argv).toEqual(['/usr/local/bin/claude', '--dangerously-skip-permissions']);
    });

    it('appends --resume <id> when a resumeSessionId is provided', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        resumeSessionId: 'abc-123',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/claude',
        '--dangerously-skip-permissions',
        '--resume',
        'abc-123',
      ]);
    });

    it('appends --session-id <id> when sessionId is set (warm-session A2A)', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        sessionId: 'warm-uuid-1',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/claude',
        '--dangerously-skip-permissions',
        '--session-id',
        'warm-uuid-1',
      ]);
    });

    it('--resume wins over --session-id when both are set (mutually exclusive)', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        resumeSessionId: 'resume-uuid',
        sessionId: 'warm-uuid-1',
      });
      // Reloading an existing transcript precludes setting a fresh id.
      expect(spec.argv).toContain('--resume');
      expect(spec.argv).not.toContain('--session-id');
    });

    it('emits CLAUDECODE= override so nested Claude detection stays off', () => {
      const spec = buildInteractiveLaunch('claude-code', { binaryPath: '/x/claude' });
      expect(spec.envOverrides).toEqual({ CLAUDECODE: '' });
    });

    it('does NOT push --model when no defaultModel is set (account default preserved)', () => {
      const spec = buildInteractiveLaunch('claude-code', { binaryPath: '/x/claude' });
      expect(spec.argv).not.toContain('--model');
    });

    it('pins --model from a generic tier (balanced → sonnet) when defaultModel is set', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        defaultModel: 'balanced',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/claude',
        '--dangerously-skip-permissions',
        '--model',
        'sonnet',
      ]);
    });

    it('passes a raw model id through verbatim to --model', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        defaultModel: 'claude-opus-4-8',
      });
      expect(spec.argv).toContain('--model');
      expect(spec.argv[spec.argv.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    });

    it('combines --resume and --model when both are provided', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        resumeSessionId: 'abc-123',
        defaultModel: 'capable',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/claude',
        '--dangerously-skip-permissions',
        '--resume',
        'abc-123',
        '--model',
        'opus',
      ]);
    });
  });

  describe('codex-cli', () => {
    it('passes --model gpt-5.5 + --dangerously-bypass-approvals-and-sandbox by default (parity with Claude\'s --dangerously-skip-permissions)', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
      });
      // The explicit `--model` flag avoids Codex CLI's own historical
      // default `gpt-5.2-codex` (retired from ChatGPT-subscription auth
      // 2026-04-14). The session default is gpt-5.5 as of 2026-05-23
      // (Justin's call) — newest generalist + Codex CLI's own default,
      // confirmed working on the subscription. See models.ts comment block.
      // The bypass flag is the single-flag parity for Claude's
      // `--dangerously-skip-permissions` — removes approval prompts AND
      // drops the sandbox (which would otherwise block the agent from
      // reaching localhost where instar's server lives).
      expect(spec.argv).toEqual([
        '/usr/local/bin/codex',
        '--model',
        'gpt-5.5',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
    });

    it('appends --dangerously-bypass-hook-trust when the codex binary supports it (>=0.133)', () => {
      const bin = fakeCodexBinary(true);
      const spec = buildInteractiveLaunch('codex-cli', { binaryPath: bin });
      expect(spec.argv).toContain('--dangerously-bypass-hook-trust');
      // It comes after the sandbox bypass, before any threadline -c overrides.
      expect(spec.argv.indexOf('--dangerously-bypass-hook-trust'))
        .toBeGreaterThan(spec.argv.indexOf('--dangerously-bypass-approvals-and-sandbox'));
    });

    it('omits --dangerously-bypass-hook-trust when the codex binary lacks it (<0.133) — would otherwise fail the launch', () => {
      const bin = fakeCodexBinary(false);
      const spec = buildInteractiveLaunch('codex-cli', { binaryPath: bin });
      expect(spec.argv).not.toContain('--dangerously-bypass-hook-trust');
    });

    it('honors a custom codexSandboxMode by switching to the flag-pair form (safer profile, no bypass)', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        codexSandboxMode: 'read-only',
      });
      expect(spec.argv).toContain('--sandbox');
      expect(spec.argv).toContain('read-only');
      expect(spec.argv).toContain('--ask-for-approval');
      expect(spec.argv).toContain('never');
      expect(spec.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('inserts `resume <id>` as a subcommand right after the binary path when resumeSessionId is set', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        resumeSessionId: 'sess-42',
      });
      // Codex's resume is a SUBCOMMAND (codex resume <id>), not a flag.
      // Must be the first arg after the binary; flags follow.
      expect(spec.argv[0]).toBe('/usr/local/bin/codex');
      expect(spec.argv[1]).toBe('resume');
      expect(spec.argv[2]).toBe('sess-42');
      expect(spec.argv).toContain('--model');
      // The flag-style --resume must NEVER appear — Codex doesn't accept it.
      expect(spec.argv).not.toContain('--resume');
    });

    it('does NOT insert `resume` when resumeSessionId is absent (fresh launch)', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
      });
      expect(spec.argv).not.toContain('resume');
      expect(spec.argv[1]).toBe('--model');
    });

    it('preserves sandbox + model flags when resuming', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        resumeSessionId: 'uuid-7',
        codexSandboxMode: 'workspace-write',
      });
      expect(spec.argv).toContain('resume');
      expect(spec.argv).toContain('uuid-7');
      expect(spec.argv).toContain('--sandbox');
      expect(spec.argv).toContain('workspace-write');
      expect(spec.argv).toContain('--model');
    });

    it('preserves --oss + --local-provider when resuming a local-model session', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        resumeSessionId: 'local-uuid',
        codexLocalProvider: 'ollama',
        defaultModel: 'llama3.2:latest',
      });
      expect(spec.argv).toContain('resume');
      expect(spec.argv).toContain('local-uuid');
      expect(spec.argv).toContain('--oss');
      expect(spec.argv).toContain('--local-provider');
      expect(spec.argv).toContain('ollama');
    });

    it('emits CLAUDECODE= override as defense-in-depth', () => {
      const spec = buildInteractiveLaunch('codex-cli', { binaryPath: '/x/codex' });
      expect(spec.envOverrides.CLAUDECODE).toBe('');
    });
  });
});

describe('frameworkSessionLaunch.resolveInteractiveFramework', () => {
  it('per-call wins over config and env', () => {
    expect(
      resolveInteractiveFramework({
        perCall: 'codex-cli',
        configFramework: 'claude-code',
        envFramework: 'claude-code',
      }),
    ).toBe('codex-cli');
  });

  it('config wins over env when per-call is unset', () => {
    expect(
      resolveInteractiveFramework({
        configFramework: 'codex-cli',
        envFramework: 'claude-code',
      }),
    ).toBe('codex-cli');
  });

  it('env wins when per-call and config are unset', () => {
    expect(
      resolveInteractiveFramework({
        envFramework: 'codex-cli',
      }),
    ).toBe('codex-cli');
  });

  it('defaults to claude-code when nothing is set', () => {
    expect(resolveInteractiveFramework({})).toBe('claude-code');
  });

  it('treats env null the same as unset', () => {
    expect(resolveInteractiveFramework({ envFramework: null })).toBe('claude-code');
  });
});

describe('frameworkSessionLaunch.buildHeadlessLaunch', () => {
  describe('claude-code', () => {
    it('builds --dangerously-skip-permissions + -p prompt', () => {
      const spec = buildHeadlessLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        prompt: 'hello world',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/claude',
        '--dangerously-skip-permissions',
        '-p',
        'hello world',
      ]);
      expect(spec.envOverrides).toEqual({ CLAUDECODE: '' });
    });

    it('includes --model when specified', () => {
      const spec = buildHeadlessLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        prompt: 'p',
        model: 'sonnet',
      });
      expect(spec.argv).toContain('--model');
      expect(spec.argv).toContain('sonnet');
      expect(spec.argv[spec.argv.length - 1]).toBe('p');
    });

    it('clears CLAUDECODE in env overrides (nested-detection guard)', () => {
      const spec = buildHeadlessLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        prompt: 'x',
      });
      expect(spec.envOverrides.CLAUDECODE).toBe('');
    });
  });

  describe('codex-cli', () => {
    it('defaults headless codex JOBS to the workspace-write sandbox (no bypass)', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'analyze this',
      });
      expect(spec.argv[0]).toBe('/usr/local/bin/codex');
      expect(spec.argv).toContain('exec');
      expect(spec.argv).toContain('--json');
      expect(spec.argv).toContain('--skip-git-repo-check');
      // Jobs keep the sandbox (they ingest external content + don't use MCP).
      expect(spec.argv).toContain('-s');
      expect(spec.argv).toContain('workspace-write');
      expect(spec.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(spec.argv).toContain('-m');
      expect(spec.argv).toContain('gpt-5.5');
      expect(spec.argv[spec.argv.length - 1]).toBe('analyze this');
    });

    it('appends --dangerously-bypass-hook-trust before the prompt when the codex binary supports it', () => {
      const bin = fakeCodexBinary(true);
      const spec = buildHeadlessLaunch('codex-cli', { binaryPath: bin, prompt: 'do the thing' });
      expect(spec.argv).toContain('--dangerously-bypass-hook-trust');
      // Prompt must remain the final positional arg (flag precedes it).
      expect(spec.argv[spec.argv.length - 1]).toBe('do the thing');
      expect(spec.argv.indexOf('--dangerously-bypass-hook-trust'))
        .toBeLessThan(spec.argv.length - 1);
    });

    it('omits --dangerously-bypass-hook-trust when the codex binary lacks it', () => {
      const bin = fakeCodexBinary(false);
      const spec = buildHeadlessLaunch('codex-cli', { binaryPath: bin, prompt: 'do the thing' });
      expect(spec.argv).not.toContain('--dangerously-bypass-hook-trust');
    });

    it('codexAllowMcpTools (reply workers) → full bypass so MCP calls are permitted', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'reply to peer',
        codexAllowMcpTools: true,
      });
      // Reply workers MUST call threadline_send; codex cancels MCP under any
      // sandbox, so the reply path uses full bypass. Jobs (above) do not.
      expect(spec.argv).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(spec.argv).not.toContain('workspace-write');
    });

    it('explicit codexSandboxMode wins over codexAllowMcpTools', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'p',
        codexSandboxMode: 'read-only',
        codexAllowMcpTools: true,
      });
      expect(spec.argv).toContain('-s');
      expect(spec.argv).toContain('read-only');
      expect(spec.argv).toContain('--ask-for-approval');
      expect(spec.argv).toContain('never');
      expect(spec.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(spec.argv).not.toContain('workspace-write');
    });

    it('honors model override', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'p',
        model: 'gpt-5.4-codex',
      });
      expect(spec.argv).toContain('gpt-5.4-codex');
      expect(spec.argv).not.toContain('gpt-5.3-codex');
    });

    it('prompt is the last positional arg', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'final-positional',
      });
      expect(spec.argv[spec.argv.length - 1]).toBe('final-positional');
    });

    it('clears CLAUDECODE for defense-in-depth', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'x',
      });
      expect(spec.envOverrides.CLAUDECODE).toBe('');
    });
  });

  it('throws for unknown framework', () => {
    expect(() =>
      buildHeadlessLaunch('made-up-framework' as never, {
        binaryPath: '/x',
        prompt: 'y',
      }),
    ).toThrowError(/No headless launch builder/);
  });
});

describe('frameworkSessionLaunch.resolveModelForFramework', () => {
  describe('claude-code', () => {
    it('maps generic tiers to Claude CLI aliases', () => {
      expect(resolveModelForFramework('claude-code', 'fast')).toBe('haiku');
      expect(resolveModelForFramework('claude-code', 'balanced')).toBe('sonnet');
      expect(resolveModelForFramework('claude-code', 'capable')).toBe('opus');
    });
    it('passes Claude tier names through verbatim', () => {
      expect(resolveModelForFramework('claude-code', 'haiku')).toBe('haiku');
      expect(resolveModelForFramework('claude-code', 'sonnet')).toBe('sonnet');
      expect(resolveModelForFramework('claude-code', 'opus')).toBe('opus');
    });
    it('passes raw model ids through verbatim', () => {
      expect(resolveModelForFramework('claude-code', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    });
    it('returns undefined for undefined input', () => {
      expect(resolveModelForFramework('claude-code', undefined)).toBeUndefined();
    });
  });

  describe('codex-cli', () => {
    it('maps generic tiers to subscription-safe Codex model ids', () => {
      // light/medium/heavy mapping. NOTE: gpt-5.2 was retired from ChatGPT-account
      // Codex on 2026-06-03 (now 400s), so `fast`/`haiku` moved to gpt-5.4-mini —
      // the cheapest still-accepted model (== balanced). See models.ts.
      expect(resolveModelForFramework('codex-cli', 'fast')).toBe('gpt-5.4-mini');
      expect(resolveModelForFramework('codex-cli', 'balanced')).toBe('gpt-5.4-mini');
      expect(resolveModelForFramework('codex-cli', 'capable')).toBe('gpt-5.5');
    });
    it('maps legacy Claude tier names to Codex equivalents (cross-port back-compat)', () => {
      expect(resolveModelForFramework('codex-cli', 'haiku')).toBe('gpt-5.4-mini');
      expect(resolveModelForFramework('codex-cli', 'sonnet')).toBe('gpt-5.4-mini');
      expect(resolveModelForFramework('codex-cli', 'opus')).toBe('gpt-5.5');
    });
    it('passes raw Codex model ids through verbatim', () => {
      expect(resolveModelForFramework('codex-cli', 'gpt-5.4-codex')).toBe('gpt-5.4-codex');
    });
  });

  describe('gemini-cli', () => {
    it('keeps raw Gemini model ids inside the verified known-model set', () => {
      expect(resolveModelForFramework('gemini-cli', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
      expect(resolveModelForFramework('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
      expect(resolveModelForFramework('gemini-cli', 'gemini-2.0-flash')).toBe('gemini-2.5-flash');
    });
  });

  it('claude headless builder rewrites generic tier to haiku/sonnet/opus', () => {
    const fast = buildHeadlessLaunch('claude-code', { binaryPath: '/x/claude', prompt: 'p', model: 'fast' });
    expect(fast.argv).toContain('haiku');
    expect(fast.argv).not.toContain('fast');
  });

  it('codex headless builder rewrites generic tier to gpt-5.x', () => {
    const balanced = buildHeadlessLaunch('codex-cli', { binaryPath: '/x/codex', prompt: 'p', model: 'balanced' });
    expect(balanced.argv).toContain('gpt-5.4-mini'); // medium tier
    expect(balanced.argv).not.toContain('balanced');
  });
});

describe('frameworkSessionLaunch — Phase 6 local-provider (codex --oss)', () => {
  it('headless: emits --oss + --local-provider <p> when codexLocalProvider set', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'hello',
      model: 'llama3.2:latest',
      codexLocalProvider: 'ollama',
    });
    expect(spec.argv).toContain('--oss');
    expect(spec.argv).toContain('--local-provider');
    expect(spec.argv).toContain('ollama');
    expect(spec.argv).toContain('llama3.2:latest');
    // local-provider mode does NOT run the OpenAI tier resolver
    expect(spec.argv).not.toContain('gpt-5.3-codex');
  });

  it('headless: defaults to llama3.2:latest when model omitted and local provider set', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'p',
      codexLocalProvider: 'ollama',
    });
    expect(spec.argv).toContain('llama3.2:latest');
  });

  it('headless: lmstudio provider also accepted', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'p',
      model: 'qwen2.5-coder:7b',
      codexLocalProvider: 'lmstudio',
    });
    expect(spec.argv).toContain('lmstudio');
    expect(spec.argv).toContain('qwen2.5-coder:7b');
  });

  it('interactive: emits --oss + --local-provider on the interactive launch path', () => {
    const spec = buildInteractiveLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      codexLocalProvider: 'ollama',
      defaultModel: 'llama3.2:latest',
    });
    expect(spec.argv).toContain('--oss');
    expect(spec.argv).toContain('--local-provider');
    expect(spec.argv).toContain('ollama');
    expect(spec.argv).toContain('llama3.2:latest');
  });

  it('headless: claude-code framework ignores codexLocalProvider (Codex-only flag)', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/x/claude',
      prompt: 'p',
      // @ts-expect-error — codexLocalProvider isn't valid for claude-code
      codexLocalProvider: 'ollama',
    });
    expect(spec.argv).not.toContain('--oss');
    expect(spec.argv).not.toContain('--local-provider');
  });
});

describe('frameworkSessionLaunch — per-agent codex threadline MCP override', () => {
  const mcp = {
    command: 'node',
    args: [
      '/agents/echo/.instar/shadow-install/node_modules/instar/dist/threadline/mcp-stdio-entry.js',
      '--state-dir',
      '/agents/echo/.instar',
      '--agent-name',
      'echo',
    ],
  };

  it('headless codex emits -c mcp_servers.threadline overrides when set', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'reply to peer',
      codexThreadlineMcp: mcp,
    });
    const joined = spec.argv.join(' ');
    expect(spec.argv).toContain('-c');
    expect(joined).toContain('mcp_servers.threadline.command="node"');
    expect(joined).toContain('mcp_servers.threadline.args=');
    expect(joined).toContain('--agent-name');
    expect(joined).toContain('mcp_servers.threadline.kind="stdio"');
    // The -c overrides must precede the positional prompt.
    const lastCIdx = spec.argv.lastIndexOf('-c');
    expect(spec.argv[spec.argv.length - 1]).toBe('reply to peer');
    expect(lastCIdx).toBeLessThan(spec.argv.length - 1);
  });

  it('headless codex omits the override when not set', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'p',
    });
    expect(spec.argv.join(' ')).not.toContain('mcp_servers.threadline');
  });

  it('interactive codex emits the override when set', () => {
    const spec = buildInteractiveLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      codexThreadlineMcp: mcp,
    });
    expect(spec.argv.join(' ')).toContain('mcp_servers.threadline.command="node"');
  });

  it('claude-code ignores the codex threadline override', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      prompt: 'p',
      codexThreadlineMcp: mcp,
    });
    expect(spec.argv.join(' ')).not.toContain('mcp_servers.threadline');
  });

  it('override args are valid JSON (TOML-array compatible)', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'p',
      codexThreadlineMcp: mcp,
    });
    const argsFlag = spec.argv.find((a) => a.startsWith('mcp_servers.threadline.args='));
    expect(argsFlag).toBeDefined();
    const jsonPart = argsFlag!.slice('mcp_servers.threadline.args='.length);
    expect(() => JSON.parse(jsonPart)).not.toThrow();
    expect(JSON.parse(jsonPart)).toEqual(mcp.args);
  });
});
