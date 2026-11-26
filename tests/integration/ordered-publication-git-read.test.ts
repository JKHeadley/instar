import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createOrderedGitFloorReader } from '../../src/core/OrderedPublicationGitRead.js';
import { orderedFloorReadbackBytes } from '../../src/core/OrderedPublicationWitness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it('reads the pinned ref of a bare Git repository before verifying its witness', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ordered-git-floor-'));
  const scope = { agentId: 'echo', namespace: 'needs-you' } as const;
  const ref = 'refs/heads/authority';
  const git = (args: string[]) => SafeGitExecutor.execSync(args, {
    cwd: repository, operation: 'ordered-git-floor-test:prepare-bare-fixture',
  }).trim();
  try {
    git(['init', '--bare']);
    const tree = git(['write-tree']);
    const commit = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit-tree', tree, '-m', 'fixture']);
    // The similarly named branch must never stand in for a missing authority ref.
    git(['update-ref', 'refs/heads/other/authority', commit]);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const floor = { ...scope, epoch: 1, holder: 'studio', head: 'a'.repeat(64), position: 0,
      witnessGeneration: 1, witness: 'mini' };
    let requests = 0;
    const read = createOrderedGitFloorReader({ repository, ref, scope, audience: 'disposable' }, {
      pins: new Map([['mini', publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]]),
      currentWitness: () => ({ id: 'mini', generation: 1 }),
      readWitness(challenge) {
        requests++;
        expect(challenge.commit).toBe(commit);
        expect(challenge.destination).toBe(JSON.stringify(['disposable', ref]));
        return { floor, signature: sign(null, orderedFloorReadbackBytes(challenge, floor), privateKey) };
      },
    });
    expect(read(scope)).toBeNull();
    expect(requests).toBe(0);
    git(['update-ref', ref, commit]);
    expect(read({ ...scope, namespace: 'delete' })).toBeNull();
    expect(read(scope)).toEqual(floor);
    expect(requests).toBe(1);
  } finally {
    SafeFsExecutor.safeRmSync(repository, { recursive: true, force: true, operation: 'ordered-git-floor-test:cleanup' });
  }
});
