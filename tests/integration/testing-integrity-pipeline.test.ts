// safe-git-allow: integration fixture uses a throwaway mkdtempSync git repository and removes only that directory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/lint-testing-integrity.mjs');
const baseChildEnvironment: NodeJS.ProcessEnv = { ...process.env };
delete baseChildEnvironment.GIT_DIR;
delete baseChildEnvironment.GIT_WORK_TREE;
delete baseChildEnvironment.GIT_INDEX_FILE;
delete baseChildEnvironment.GIT_OBJECT_DIRECTORY;
delete baseChildEnvironment.GIT_COMMON_DIR;
let childEnvironment: NodeJS.ProcessEnv;

function runGuard(root: string, args: string[] = []): { exitCode: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: childEnvironment,
      stdio: 'pipe',
    });
    return { exitCode: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      exitCode: failure.status ?? -1,
      output: `${String(failure.stdout ?? '')}${String(failure.stderr ?? '')}`,
    };
  }
}

describe('Testing Integrity blocking pipeline', () => {
  let repository: string;
  let protectedMain: string;

  beforeEach(() => {
    childEnvironment = { ...baseChildEnvironment };
    repository = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-integrity-pipeline-'));
    execFileSync('git', ['init', '-q'], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['config', 'user.name', 'Testing Integrity'], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['config', 'user.email', 'testing-integrity@invalid'], { cwd: repository, env: childEnvironment });
    const route = path.join(repository, 'src', 'server', 'base.ts');
    fs.mkdirSync(path.dirname(route), { recursive: true });
    fs.writeFileSync(route, "const router = Router();\nrouter.get('/base', (_req, res) => res.status(200).end());\n");
    const evidenceDirectory = path.join(repository, 'tests', 'e2e');
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(path.join(evidenceDirectory, '.keep'), 'Testing Integrity fixture: intentionally no evidence.\n');
    execFileSync('git', ['add', 'src/server/base.ts', 'tests/e2e/.keep'], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repository, env: childEnvironment });
    protectedMain = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, env: childEnvironment, encoding: 'utf8' }).trim();
    const realGit = execFileSync('which', ['git'], { cwd: repository, env: childEnvironment, encoding: 'utf8' }).trim();
    const mockBin = path.join(repository, '.test-bin');
    fs.mkdirSync(mockBin);
    const gitWrapper = path.join(mockBin, 'git');
    fs.writeFileSync(gitWrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'ls-remote') {
  if (args[2] !== 'https://github.com/JKHeadley/instar.git' || args[3] !== 'refs/heads/main') process.exit(91);
  process.stdout.write(process.env.TEST_PROTECTED_MAIN + '\\trefs/heads/main\\n');
  process.exit(0);
}
const run = spawnSync(process.env.TEST_REAL_GIT, args, { stdio: 'inherit', env: process.env });
process.exit(run.status ?? 92);
`);
    fs.chmodSync(gitWrapper, 0o755);
    childEnvironment = {
      ...childEnvironment,
      PATH: `${mockBin}${path.delimiter}${childEnvironment.PATH ?? ''}`,
      TEST_PROTECTED_MAIN: protectedMain,
      TEST_REAL_GIT: realGit,
    };
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(repository, {
      recursive: true,
      force: true,
      operation: 'tests/integration/testing-integrity-pipeline.test.ts:cleanup',
    });
  });

  it('passes a pristine non-empty derived route population', () => {
    const result = runGuard(repository);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('PASS — derived 1 HTTP routes; 0 changed obligation(s)');
  });

  it('blocks a nested planted route with no executed Tier-3 evidence', () => {
    const planted = path.join(repository, 'src', 'server', 'nested', 'planted.ts');
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, "const api = Router();\napi.post('/planted', (_req, res) => res.status(201).end());\n");

    expect(fs.readFileSync(planted, 'utf8')).toContain("api.post('/planted'");
    const result = runGuard(repository);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('POST /planted has no executed Tier-3 route evidence');
  });

  it('refuses a caller-selected base that already contains the planted route', () => {
    const planted = path.join(repository, 'src', 'server', 'nested', 'self-based.ts');
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, "const router = Router();\nrouter.get('/self-based', (_req, res) => res.status(200).end());\n");
    execFileSync('git', ['add', planted], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['commit', '-q', '-m', 'plant route in caller-selected head'], { cwd: repository, env: childEnvironment });

    const result = runGuard(repository, ['--base', 'HEAD']);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('does not accept caller-selected arguments');
  });

  it('ignores a locally forged tracking ref and uses the server-advertised main SHA', () => {
    const planted = path.join(repository, 'src', 'server', 'forged-base.ts');
    fs.writeFileSync(planted, "const router = Router();\nrouter.get('/forged-base', (_req, res) => res.status(200).end());\n");
    execFileSync('git', ['add', planted], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['commit', '-q', '-m', 'plant route'], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', 'HEAD'], { cwd: repository, env: childEnvironment });

    const result = runGuard(repository);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('GET /forged-base has no executed Tier-3 route evidence');
  });

  it('ignores a replacement object that maps protected main onto the planted tree', () => {
    const planted = path.join(repository, 'src', 'server', 'replacement-base.ts');
    fs.writeFileSync(planted, "const router = Router();\nrouter.get('/replacement-base', (_req, res) => res.status(200).end());\n");
    execFileSync('git', ['add', planted], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['commit', '-q', '-m', 'plant route'], { cwd: repository, env: childEnvironment });
    execFileSync('git', ['replace', protectedMain, 'HEAD'], { cwd: repository, env: childEnvironment });

    const result = runGuard(repository);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('GET /replacement-base has no executed Tier-3 route evidence');
  });

  it('refuses a lookalike-host remote argument instead of querying it', () => {
    const result = runGuard(repository, ['--protected-remote', 'https://evil.example/JKHeadley/instar.git']);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('does not accept caller-selected arguments');
  });
});
