// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * EVO-008 consumer proof against the REAL installed Claude CLI (opt-in: it spends a few
 * cheap model calls). Run on each machine before the fleet step:
 *
 *   INSTAR_LIVE_CLAUDE_CONFINEMENT=1 npx vitest run --config vitest.integration.config.ts tests/integration/job-tool-confinement-live.test.ts
 *
 * It builds the argv the way the job launch does (bypass flag, then the headless extra
 * flags, then applyClaudeToolConfinement), checks the whole contract, and runs it from a
 * directory whose .claude/settings.json allows everything and auto-approves every
 * permission request. Both sides of the boundary: a denied tool's side effect must not
 * happen, an allowed tool's must. It also reads the CLI's own start record to check that
 * every confinable name is a tool this CLI really honours.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyClaudeToolConfinement, assertClaudeConfinementContract, CONFINED_PROMPT_LEAD } from '../../src/core/SessionManager.js';
import { claudeHeadlessExtraFlags } from '../../src/core/frameworkSessionLaunch.js';
import { CLAUDE_CONFINABLE_TOOL_NAMES } from '../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const LIVE = process.env.INSTAR_LIVE_CLAUDE_CONFINEMENT === '1';
const CLAUDE = process.env.INSTAR_LIVE_CLAUDE_BIN ?? 'claude';

function confinedArgv(tools: string[], prompt: string, extra: string[] = []): string[] {
  const argv = [CLAUDE, '--dangerously-skip-permissions', '--model', 'haiku', ...extra, '-p', `${CONFINED_PROMPT_LEAD}\n${prompt}`];
  const flags = claudeHeadlessExtraFlags({ framework: 'claude-code', allowedTools: tools, disableProjectMcp: true });
  argv.splice(argv.indexOf('-p'), 0, ...flags);
  applyClaudeToolConfinement(argv, tools);
  assertClaudeConfinementContract(argv, tools);
  return argv;
}

function run(argv: string[], cwd: string): string {
  return execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf-8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!LIVE)('EVO-008 live: the confined job launch really refuses unlisted tools', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-live-confine-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'secret-content-42\n');
    fs.writeFileSync(path.join(dir, 'approve.sh'), '#!/bin/sh\necho \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\'\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'WebFetch'] },
      hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: path.join(dir, 'approve.sh') }] }] },
    }));
  });
  afterAll(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-tool-confinement-live.test.ts' });
  });

  it('Read-only: Read works, Bash and Write leave no trace (permissive settings + auto-approve hook present)', () => {
    const out = run(confinedArgv(['Read'], `Read ${dir}/readme.txt and quote it. Then use Bash to run: echo x > ${dir}/bash.txt . Then use Write to create ${dir}/write.txt . Report each result.`), dir);
    expect(out).toContain('secret-content-42');
    expect(fs.existsSync(path.join(dir, 'bash.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'write.txt'))).toBe(false);
  });

  it('Bash-only: the allowed tool works, Write does not', () => {
    run(confinedArgv(['Bash'], `Use Bash to run: echo allowed > ${dir}/allowed.txt . Then use Write to create ${dir}/write2.txt . Report each result.`), dir);
    expect(fs.existsSync(path.join(dir, 'allowed.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'write2.txt'))).toBe(false);
  });

  it('every confinable name is a tool this CLI honours (its own start record)', () => {
    const names = [...CLAUDE_CONFINABLE_TOOL_NAMES];
    const out = run(confinedArgv(names, 'Say ok.', ['--output-format', 'stream-json', '--verbose', '--max-turns', '1']), dir);
    const init = JSON.parse(out.split('\n').find((l) => l.includes('"subtype":"init"'))!) as { tools: string[] };
    const canonical = new Set(names.map((n) => (n === 'Agent' ? 'Task' : n)));
    expect(new Set(init.tools)).toEqual(canonical);
  });
});
