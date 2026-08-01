import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertCompleteStageTransitionContext,
  createProductionStageTransitionContext,
} from '../../src/core/StageTransitionContext.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

describe('production StageTransition context', () => {
  let repo: string;

  function createContext(artifact: Record<string, unknown> = {}) {
    return createProductionStageTransitionContext(
      { targetRepoPath: repo, artifact },
      { resolveCanonicalMainSnapshot: () => 'HEAD' },
    );
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-context-'));
    fs.mkdirSync(path.join(repo, 'docs/specs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs/specs/on-main.md'), '# canonical\n');
    fs.symlinkSync('on-main.md', path.join(repo, 'docs/specs/link.md'));
    SafeGitExecutor.run(['init', '-q'], { cwd: repo, operation: 'tests/unit/StageTransitionContext.test.ts:init' });
    SafeGitExecutor.run(['config', 'user.name', 'Stage Context Test'], { cwd: repo, operation: 'tests/unit/StageTransitionContext.test.ts:name' });
    SafeGitExecutor.run(['config', 'user.email', 'stage-context@test.invalid'], { cwd: repo, operation: 'tests/unit/StageTransitionContext.test.ts:email' });
    SafeGitExecutor.run(['add', '-A'], { cwd: repo, operation: 'tests/unit/StageTransitionContext.test.ts:add' });
    SafeGitExecutor.run(['commit', '-q', '-m', 'canonical artifacts'], { cwd: repo, operation: 'tests/unit/StageTransitionContext.test.ts:commit' });
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'tests/unit/StageTransitionContext.test.ts:cleanup' });
  });

  it('reads a canonical blob even when the working checkout no longer has it', async () => {
    const ctx = createContext({ specPath: 'docs/specs/on-main.md' });
    SafeFsExecutor.safeUnlinkSync(path.join(repo, 'docs/specs/on-main.md'), { operation: 'tests/unit/StageTransitionContext.test.ts:stale-checkout' });
    await expect(ctx.readRepositoryArtifact?.('HEAD', 'docs/specs/on-main.md')).resolves.toBe('# canonical\n');
    fs.writeFileSync(path.join(repo, 'docs/specs/on-main.md'), '# canonical\n');
  });

  it('returns null only for an authoritatively absent ref path', async () => {
    const ctx = createContext();
    await expect(ctx.readRepositoryArtifact?.('HEAD', 'docs/specs/absent.md')).resolves.toBeNull();
  });

  it('rejects symlink blobs rather than treating them as regular evidence', async () => {
    const ctx = createContext();
    await expect(ctx.readRepositoryArtifact?.('HEAD', 'docs/specs/link.md')).rejects.toThrow(/not a regular file/);
  });

  it('assembles every production dependency and reports incomplete contexts loudly', () => {
    const ctx = createContext();
    expect(() => assertCompleteStageTransitionContext(ctx)).not.toThrow();
    expect(() => assertCompleteStageTransitionContext({ targetRepoPath: repo })).toThrow(/incomplete validator context/);
  });

  it('resolves one immutable canonical snapshot lazily and memoizes it for the request', () => {
    let resolutions = 0;
    const ctx = createProductionStageTransitionContext(
      { targetRepoPath: repo, artifact: {} },
      { resolveCanonicalMainSnapshot: () => {
        resolutions += 1;
        return '0123456789012345678901234567890123456789';
      } },
    );
    expect(resolutions).toBe(0);
    expect(ctx.resolveCanonicalMainRef?.()).toBe('0123456789012345678901234567890123456789');
    expect(ctx.resolveCanonicalMainRef?.()).toBe('0123456789012345678901234567890123456789');
    expect(resolutions).toBe(1);
  });
});
