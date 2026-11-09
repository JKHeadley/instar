/**
 * mcp-children-are-baseline — an MCP server a session launched from its
 * .mcp.json is resident noise, whatever its binary is called.
 *
 * REGRESSION (sagemind/Luna, 2026-10-22): every Luna conversation runs the
 * Google Workspace MCP as `…/uv/tools/workspace-mcp/bin/python3
 * …/.local/bin/workspace-mcp --tool-tier complete`. None of the baseline
 * patterns matched it (no "server" word, not playwright, not the threadline
 * entry), so computeHasActiveProcesses reported every one of her sessions as
 * doing work forever. The idle clock never started, the idle-zombie kill never
 * fired, and idle conversations piled up until the 20-session cap refused new
 * ones. The fix recognises the MCP server by the `mcp` token in its command,
 * which every MCP binary carries by convention.
 */

import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';
import {
  BASELINE_PROCESS_PATTERNS,
  MCP_STACK_ROOT_PATTERNS,
  isMcpLauncherShell,
  isToolShellCommand,
} from '../../src/core/baselineProcessPatterns.js';
import { drainProcessShape } from '../../src/core/standDownDrain.js';

const HEADER = '  PID  PPID COMMAND';
// Luna's pane: tmux runs claude directly, so the pane pid IS the claude process.
const CLAUDE = '83924  5021 /opt/homebrew/bin/claude --dangerously-skip-permissions --resume 2f1a --model claude-opus-5';
const THREADLINE = '85668 83924 node /Users/justin/.instar/agents/sagemind/.instar/shadow-install/node_modules/instar/dist/threadline/mcp-stdio-entry.js --state-dir /Users/justin/.instar/agents/sagemind/.instar --agent-name sagemind';
const WORKSPACE_MCP = '85669 83924 /Users/justin/.local/share/uv/tools/workspace-mcp/bin/python3 /Users/justin/.local/bin/workspace-mcp --tool-tier complete';
const PLAUD_MCP = '85670 83924 node /opt/homebrew/lib/node_modules/npm/bin/npx-cli.js -y @plaud-ai/mcp@latest';
const TOOL_SHELL = "85700 83924 /bin/zsh -c source /Users/justin/.claude-followme-sagemind-justin/shell-snapshots/snapshot-zsh-1792700000000-abc123.sh 2>/dev/null || true && eval 'vitest run tests/unit/mcp-stdio.test.ts'";
// A Codex pane: no snapshot token anywhere; a tool call is a plain `zsh -lc`.
const CODEX = '70298  5021 /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex resume 2f1a --model gpt-5.6-sol -c mcp_servers.threadline.command="node"';
const CODEX_THREADLINE = '72860 70298 node /Users/justin/.instar/agents/sagemind/.instar/shadow-install/node_modules/instar/dist/threadline/mcp-stdio-entry.js --state-dir /Users/justin/.instar/agents/sagemind/.instar --agent-name sagemind';
const CODEX_SHELL_MCP = "72900 70298 /bin/zsh -lc 'npx vitest run tests/unit/mcp-stdio.test.ts'";
const CODEX_SHELL_GREP = '72901 70298 /bin/zsh -lc grep -rn mcp src/';
const PYTHON_WORK = '85710 83924 python3 /Users/justin/Projects/train.py --epochs 3';

const ps = (...lines: string[]): string => [HEADER, ...lines].join('\n');
const hasActive = (panePid: string, out: string): boolean =>
  (SessionManager.prototype as unknown as { computeHasActiveProcesses(p: string, o: string): boolean })
    .computeHasActiveProcesses.call({}, panePid, out);

describe('baseline process patterns — MCP servers by the mcp token', () => {
  it("matches Luna's Google Workspace MCP command (no 'server' word anywhere in it)", () => {
    expect(BASELINE_PROCESS_PATTERNS.some((p) => p.test(WORKSPACE_MCP))).toBe(true);
    expect(MCP_STACK_ROOT_PATTERNS.some((p) => p.test(WORKSPACE_MCP))).toBe(true);
  });

  it('matches an npx-launched scoped MCP package (@plaud-ai/mcp@latest)', () => {
    expect(BASELINE_PROCESS_PATTERNS.some((p) => p.test(PLAUD_MCP))).toBe(true);
  });

  it('does not match ordinary work just because it is Python or node', () => {
    expect(BASELINE_PROCESS_PATTERNS.some((p) => p.test(PYTHON_WORK))).toBe(false);
  });
});

describe('SessionManager.computeHasActiveProcesses — a conversation whose only children are MCP servers is idle', () => {
  it("REGRESSION: Luna's tree (claude → threadline MCP + workspace-mcp) is NOT active", () => {
    expect(hasActive('83924', ps(CLAUDE, THREADLINE, WORKSPACE_MCP))).toBe(false);
  });

  it('still idle with the npx-launched MCP alongside', () => {
    expect(hasActive('83924', ps(CLAUDE, THREADLINE, WORKSPACE_MCP, PLAUD_MCP))).toBe(false);
  });

  it("a tool shell whose command merely mentions 'mcp' is still work (the shell rule wins)", () => {
    expect(hasActive('83924', ps(CLAUDE, THREADLINE, WORKSPACE_MCP, TOOL_SHELL))).toBe(true);
  });

  it('a non-MCP child (a script the session launched) is still work', () => {
    expect(hasActive('83924', ps(CLAUDE, THREADLINE, WORKSPACE_MCP, PYTHON_WORK))).toBe(true);
  });
});

describe('a Codex tool shell is work even when its text mentions mcp (second-pass review finding)', () => {
  it("recognises both frameworks' tool shells and not the MCP servers", () => {
    expect(isToolShellCommand(TOOL_SHELL)).toBe(true);
    expect(isToolShellCommand(CODEX_SHELL_MCP)).toBe(true);
    expect(isToolShellCommand(CODEX_SHELL_GREP)).toBe(true);
    expect(isToolShellCommand(WORKSPACE_MCP)).toBe(false);
    expect(isToolShellCommand(THREADLINE)).toBe(false);
    expect(isToolShellCommand(PYTHON_WORK)).toBe(false);
  });

  it('computeHasActiveProcesses: a Codex pane running `vitest … mcp-stdio.test.ts` is active', () => {
    expect(hasActive('70298', ps(CODEX, CODEX_THREADLINE, CODEX_SHELL_MCP))).toBe(true);
    expect(hasActive('70298', ps(CODEX, CODEX_THREADLINE, CODEX_SHELL_GREP))).toBe(true);
  });

  it('computeHasActiveProcesses: a Codex pane with only its MCP child is idle', () => {
    expect(hasActive('70298', ps(CODEX, CODEX_THREADLINE))).toBe(false);
  });

  it('drainProcessShape: a tool shell mentioning mcp is work, never an MCP root', () => {
    // pane shell 100 → claude 200 → MCP servers + a tool shell whose text says mcp
    const rows = (...extra: string[]) => [
      '  200   100 /opt/homebrew/bin/claude --resume 2f1a --model claude-opus-5',
      THREADLINE.replace('85668 83924', '  300   200'),
      WORKSPACE_MCP.replace('85669 83924', '  301   200'),
      ...extra,
    ];
    expect(drainProcessShape('100', ps(...rows()))).toEqual({ working: false });
    expect(drainProcessShape('100', ps(...rows(TOOL_SHELL.replace('85700 83924', '  400   200'))))).toEqual({ working: true });
    expect(drainProcessShape('100', ps(...rows(CODEX_SHELL_GREP.replace('72901 70298', '  401   200'))))).toEqual({ working: true });
    // a vitest worker under that shell is work too (it would otherwise read as under an MCP root)
    expect(drainProcessShape('100', ps(...rows(
      CODEX_SHELL_MCP.replace('72900 70298', '  402   200'),
      '  403   402 node /x/node_modules/vitest/dist/worker.js',
    )))).toEqual({ working: true });
  });
});

describe('a shell under an MCP root is its launcher, not work (Mama PC, Linux, 2026-11-04)', () => {
  // The real tree: on Linux `npm exec` starts the server through `sh -c playwright-mcp`.
  const PANE = '3554423';
  const LINUX = [
    HEADER,
    '3554423 694 /home/echo/.instar/state/claude-bin/2.1.310/claude --dangerously-skip-permissions --resume 0a37',
    '3554602 3554423 npm exec @playwright/mcp@latest',
    '3554603 3554423 node /home/echo/.instar/shadow-install/node_modules/instar/dist/threadline/mcp-stdio-entry.js --state-dir /home/echo',
    '3554672 3554602 sh -c playwright-mcp',
    '3554673 3554672 node /home/echo/.npm/_npx/9833c18b2d85bc59/node_modules/.bin/playwright-mcp',
  ];
  const active = (rows: string[]) => (SessionManager.prototype as unknown as { computeHasActiveProcesses(p: string, o: string): boolean })
    .computeHasActiveProcesses.call({}, PANE, rows.join('\n'));

  it('computeHasActiveProcesses: the Linux launcher shell is idle', () => {
    expect(active(LINUX)).toBe(false);
  });
  it('drainProcessShape: the Linux launcher shell is idle', () => {
    expect(drainProcessShape(PANE, LINUX.join('\n'))).toEqual({ working: false });
  });
  it('the same shell with no MCP root above it is still work', () => {
    const rows = [HEADER, LINUX[1], '3554672 3554423 sh -c playwright-mcp'];
    expect(active(rows)).toBe(true);
    expect(drainProcessShape(PANE, rows.join('\n'))).toEqual({ working: true });
  });
  it("the agent's own shell beside the MCP stack is still work", () => {
    const rows = [...LINUX, '3560000 3554423 /bin/bash -c source /home/echo/.claude/shell-snapshots/snapshot-bash-1.sh && eval vitest'];
    expect(active(rows)).toBe(true);
    expect(drainProcessShape(PANE, rows.join('\n'))).toEqual({ working: true });
  });
  it('a browser under the MCP stays as each check had it: active here, resident for the drain', () => {
    const rows = [...LINUX, '3554700 3554673 /opt/chrome/chrome --headless'];
    expect(active(rows)).toBe(true);
    expect(drainProcessShape(PANE, rows.join('\n'))).toEqual({ working: false });
  });
  it('second-pass review: a framework started with --mcp-config hides nothing below it', () => {
    const rows = [
      HEADER, '3554423 694 zsh',
      '3554500 3554423 claude --dangerously-skip-permissions --mcp-config /tmp/config.json',
      '3560000 3554500 /bin/bash -c source /home/echo/.claude/shell-snapshots/snapshot-bash-1.sh && eval while true; do :; done',
    ];
    expect(active(rows)).toBe(true);
    expect(drainProcessShape(PANE, rows.join('\n'))).toEqual({ working: true });
  });
  it('second-pass review: a command-running MCP keeps its shells as work', () => {
    const rows = [...LINUX, '3554800 3554673 sh -c while true; do :; done'];
    expect(active(rows)).toBe(true);
    expect(drainProcessShape(PANE, rows.join('\n'))).toEqual({ working: true });
  });
  it.each([
    ['sh -c playwright-mcp', 'npm exec @playwright/mcp@latest', true],
    ['/bin/sh -c playwright-mcp --headless', 'npm exec @playwright/mcp@latest', true],
    ['sh -c playwright-mcp', 'claude --mcp-config /tmp/c.json', false],
    ['sh -c playwright-mcp', undefined, false],
    ['sh -c playwright-mcp && rm -rf build', 'npm exec @playwright/mcp@latest', false],
    ['sh -c vitest run mcp.test.ts', 'npm exec @playwright/mcp@latest', false],
    ['zsh -lc playwright-mcp', 'npm exec @playwright/mcp@latest', false],
    ['sh -c mcp=1 read value', 'npm exec mcp=1 read value', false],
  ])('isMcpLauncherShell(%s, %s) is %s', (cmd, parent, want) => {
    expect(isMcpLauncherShell(cmd, parent)).toBe(want);
  });
});
