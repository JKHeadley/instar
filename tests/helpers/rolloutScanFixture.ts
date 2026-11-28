import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

export function rolloutFixture(specCount = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-async-'));
  const canonical = path.join(root, 'canonical');
  const repo = path.join(root, 'consumer');
  fs.mkdirSync(canonical);
  const git = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: 'tests:rollout-async-fixture' }).trim();
  git(canonical, ['init', '-q', '-b', 'main']);
  git(canonical, ['config', 'user.name', 'Rollout Test Fixture']);
  git(canonical, ['config', 'user.email', 'fixture@instar.local']);
  git(canonical, ['config', 'commit.gpgsign', 'false']);
  const write = (cwd: string, name: string, content: string) => {
    const target = path.join(cwd, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const content = (title: string) => `---\napproved: true\nreview-convergence: fixture\n---\n# ${title}\n`;
  for (let i = 0; i < specCount; i++) write(canonical, `docs/specs/canonical-${i}.md`, content(`Canonical ${i}`));
  git(canonical, ['add', '-A']); git(canonical, ['commit', '-qm', 'fixture A']);
  const first = git(canonical, ['rev-parse', 'HEAD']);
  git(root, ['clone', '-q', canonical, repo]);
  write(canonical, 'docs/specs/canonical-new.md', content('Canonical new'));
  git(canonical, ['add', '-A']); git(canonical, ['commit', '-qm', 'fixture B']);
  const second = git(canonical, ['rev-parse', 'HEAD']);
  write(repo, 'docs/specs/local-only.md', content('Local only'));
  return { root, canonical, repo, first, second, git, write, content,
    close: () => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests:rollout-async-fixture-cleanup' }) };
}
