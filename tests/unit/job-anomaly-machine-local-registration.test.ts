import { describe, it, expect } from 'vitest';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import { MACHINE_LOCAL_DIRECT_WRITE_FILES, invalidDirectWriteFiles } from '../../src/core/WriteDomainRegistry.js';

const PATHS = ['.instar/state/job-anomaly-episodes.json', '.instar/state/job-triage-state.json'];

describe('job-cost-reduction machine-local stores', () => {
  it.each(PATHS)('%s is excluded from git-sync', (p) => {
    const r = new FileClassifier({ projectDir: '/repo' }).classify(p);
    expect(r.strategy).toBe('exclude');
  });

  it('both are registered machine-local with a valid two-axis story and the hardware-bound justification', () => {
    for (const p of PATHS) {
      const e = MACHINE_LOCAL_DIRECT_WRITE_FILES.find(f => f.path === p);
      expect(e).toBeDefined();
      expect(e!.domain).toBe('machine-local');
      expect(e!.justification).toBe('hardware-bound-resource');
      expect(e!.story.fileLevel).toBe('git-sync-excluded');
    }
    expect(invalidDirectWriteFiles()).toEqual([]);
  });

  it('every registered direct-write file is also in the git-sync exclusions', () => {
    const c = new FileClassifier({ projectDir: '/repo' });
    for (const f of MACHINE_LOCAL_DIRECT_WRITE_FILES) expect(c.classify(f.path).strategy).toBe('exclude');
  });

  it('a story on a shared git-synced path without a file-level arm is reported invalid', () => {
    expect(invalidDirectWriteFiles([{ path: 'x', domain: 'machine-local', justification: 'hardware-bound-resource',
      story: { logical: 'pool-scope-read-merge', onSharedGitSyncedPath: true } }])).toHaveLength(1);
  });
});
