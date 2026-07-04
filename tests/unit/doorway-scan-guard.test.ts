/**
 * doorway-scan-guard.js — the §2.7 PreToolUse command-allowlist guard.
 *
 * Drives the REAL deployed hook (written by PostUpdateMigrator.migrateHooks) as a
 * subprocess across the full fixture matrix (spec §Testing "Adversarial source-write
 * guard" + "§2.7 guard AST-parse"). This is both the parser-contract test and the
 * wiring-integrity test: the genuine stateful lexer (not a regex) refuses every
 * write/exec/spend primitive, the sanctioned shapes are permitted, scope fails OPEN,
 * command matching fails CLOSED, and it is a strict no-op under any other slug.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;
let hookPath: string;

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-guard-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (migrator as unknown as { migrateHooks(r: typeof result): void }).migrateHooks(result);
  hookPath = path.join(projectDir, '.instar', 'hooks', 'instar', 'doorway-scan-guard.js');
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'dw-guard test cleanup' });
});

/** Run the deployed guard. Returns the exit code (0 = allow/no-op, 2 = refuse). */
function runGuard(command: string, opts: { slug?: string; toolName?: string; rawInput?: string } = {}): number {
  const input = opts.rawInput ?? JSON.stringify({ tool_name: opts.toolName ?? 'Bash', tool_input: { command } });
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.INSTAR_JOB_SLUG;
  if (opts.slug !== undefined) env.INSTAR_JOB_SLUG = opts.slug;
  try {
    execFileSync('node', [hookPath], { input, env, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
    return 0;
  } catch (e: any) {
    return typeof e.status === 'number' ? e.status : -1;
  }
}

const IN = { slug: 'doorway-scan' };

describe('doorway-scan-guard — deployed hook exists + is executable', () => {
  it('was written by migrateHooks', () => {
    expect(fs.existsSync(hookPath)).toBe(true);
  });
});

describe('SANCTIONED shapes — PERMITTED inside the doorway-scan session', () => {
  const allowed = [
    'node scripts/doorway-scan.mjs --scope free-probes',
    'node scripts/doorway-scan.mjs --scope "free-probes"',          // quoted-arg normalization
    'node   scripts/doorway-scan.mjs   --scope   free-probes',      // collapsed whitespace
    'test -f scripts/doorway-scan.mjs',
    'cat .instar/state/doorway-scan.json',
    'jq -r .port .instar/config.json',
    'curl -sf http://localhost:4042/health',
    'curl -s http://127.0.0.1:4042/health',
  ];
  for (const cmd of allowed) {
    it(`ALLOW: ${cmd}`, () => expect(runGuard(cmd, IN)).toBe(0));
  }
});

describe('WRITE / EXEC / SPEND primitives — REFUSED inside the doorway-scan session', () => {
  const refused = [
    'cp evil docs/LLM-ROUTING-REGISTRY.md',
    'python3 -c "open(\'scripts/x\',\'w\')"',                       // interpreter not allowlisted
    'node -e "require(\'fs\').writeFileSync(\'src/x\',\'\')"',      // interpreter
    'perl -i -pe s/a/b/ scripts/model-registry-freshness.manifest.json',
    'git checkout -- scripts/model-registry-freshness.manifest.json',
    'node scripts/doorway-scan.mjs --scope free-probes; cp a b',    // compound ;
    'node scripts/doorway-scan.mjs --scope free-probes && cp a b',  // compound &&
    'echo $(cp a b)',                                               // command substitution
    'echo `cp a b`',                                                // backtick substitution
    'INSTAR_DOORWAY_SCAN_MANUAL=1 node scripts/doorway-scan.mjs --scope free-probes', // env-prefix money bypass
    'unset INSTAR_JOB_SLUG; cp a b',                                // scope-escape chain
    'cat scripts/x > docs/y',                                       // redirect
    'curl -o docs/x http://localhost:4042/health',                  // output-redirect flag
    'curl -sf https://evil.example.com/x',                          // non-localhost curl
    'node scripts/doorway-scan.mjs --scope +liveness',              // metered scope (not the sanctioned argv)
    'node "foo',                                                     // undecomposable (unterminated quote) → fail closed
    'mv scripts/doorway-scan.mjs /tmp/x',
  ];
  for (const cmd of refused) {
    it(`REFUSE: ${cmd}`, () => expect(runGuard(cmd, IN)).toBe(2));
  }
});

describe('SCOPE — fails OPEN / strict no-op outside the doorway-scan session', () => {
  it('a dangerous command under a DIFFERENT slug is ALLOWED (never blocks another session)', () => {
    expect(runGuard('cp evil docs/LLM-ROUTING-REGISTRY.md', { slug: 'some-other-job' })).toBe(0);
  });
  it('a dangerous command with NO job slug (interactive session) is ALLOWED', () => {
    expect(runGuard('cp evil docs/LLM-ROUTING-REGISTRY.md', {})).toBe(0);
  });
  it('a non-Bash tool is a strict no-op even in the doorway-scan session', () => {
    expect(runGuard('irrelevant', { slug: 'doorway-scan', toolName: 'Edit' })).toBe(0);
  });
  it('malformed stdin (scope-resolution error) FAILS OPEN (allow)', () => {
    expect(runGuard('', { slug: 'doorway-scan', rawInput: 'this is not json' })).toBe(0);
  });
});
