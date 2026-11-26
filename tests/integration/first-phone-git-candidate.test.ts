import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { createFirstPhoneGitCandidateReader, FIRST_PHONE_CANDIDATE_PATH } from '../../src/core/FirstPhoneGitCandidateReader.js';
import { firstPhoneSlotDecisionPayload } from '../../src/core/FirstPhoneSlotDecision.js';
import { createOrderedWitnessObserver } from '../../src/core/OrderedWitnessObserver.js';
import { OrderedWitnessSnapshotStore } from '../../src/core/OrderedWitnessSnapshotStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import fixture from '../fixtures/first-phone/ordered-challenge-v2.json';

it('stages the exact canonical candidate from the pinned Git commit without accepting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'first-phone-git-candidate-'));
  const mirror = join(root, 'mirror');
  const scope = { agentId: 'echo', namespace: 'machine-key-history' } as const;
  const ref = 'refs/heads/authority';
  const { challengeKey, challengeDigest } = fixture.expected;
  const body = firstPhoneSlotDecisionPayload({
    prior: { slotKey: fixture.input.slotKey, generation: 0, keyDigest: null, reservedBy: null },
    operationId: 'fixture-cancel', requestDigest: 'a'.repeat(64),
    action: { kind: 'cancel', challengeKey, challengeDigest },
  });
  mkdirSync(mirror);
  const git = (args: string[]) => SafeGitExecutor.execSync(args, {
    cwd: mirror, operation: 'first-phone-git-candidate:fixture',
  }).trim();
  const store = OrderedWitnessSnapshotStore.open(join(root, 'witness.sqlite'));
  try {
    git(['init']);
    const file = join(mirror, FIRST_PHONE_CANDIDATE_PATH);
    mkdirSync(dirname(file), { recursive: true });
    const commitCandidate = (text: string) => {
      writeFileSync(file, text);
      git(['add', '--', FIRST_PHONE_CANDIDATE_PATH]);
      const tree = git(['write-tree']);
      return git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit-tree', tree, '-m', 'candidate']);
    };
    const commit = commitCandidate(body);
    const malformed = commitCandidate(body + '\n');
    const reader = createFirstPhoneGitCandidateReader(mirror);
    expect(reader('HEAD')).toBeNull();
    expect(reader('1'.repeat(40))).toBeNull();
    expect(reader(malformed)).toBeNull();
    expect(reader(commit)).toEqual({ operation: challengeKey, payload: Buffer.from(body) });

    git(['update-ref', ref, commit]);
    const observe = createOrderedWitnessObserver({
      enabled: true, target: { repository: mirror, ref, scope, audience: 'disposable' },
      store, readCandidateAtCommit: reader,
    });
    expect(observe(scope)).toBe('staged');
    expect(store.readOperation(scope, challengeKey)).toBeNull();
  } finally {
    store.close();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'first-phone-git-candidate:cleanup' });
  }
});
