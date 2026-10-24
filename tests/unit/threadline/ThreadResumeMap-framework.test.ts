// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * ThreadResumeMap.get() checks a thread's transcript in the layout of the
 * framework its bound session runs on (resolved by session name). A thread on
 * claude-code never enters the Codex archive discovery; a thread on codex-cli
 * still resolves its rollout; an unknown session tries every layout through
 * the bounded lookups. The same framework-blind path TopicResumeMap had.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ThreadResumeMap, type ThreadResumeEntry } from '../../../src/threadline/ThreadResumeMap.js';
import { resetRolloutLookupState, rolloutLookupStats } from '../../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { localPartitionOf, makeFakeHome, uuidV4Like, uuidV7At, writeRollout } from '../../helpers/codexArchiveFixture.js';

/** No tmux in unit tests: a dead session makes a transcript miss resolve to null. */
class DeadSessionThreadResumeMap extends ThreadResumeMap {
  protected sessionAlive(): boolean {
    return false;
  }
}

function archiveReads(): number {
  const s = rolloutLookupStats();
  return s.hintedPartitionReads + s.syncDirectoryReads + s.asyncEnumerations + s.asyncDirectoryReads;
}

function entry(uuid: string, sessionName: string): ThreadResumeEntry {
  const now = new Date().toISOString();
  return {
    uuid, sessionName, createdAt: now, savedAt: now, lastAccessedAt: now,
    remoteAgent: 'peer', subject: 'test', state: 'active', pinned: false, messageCount: 1,
  };
}

describe('ThreadResumeMap — framework-scoped transcript check', () => {
  let home: string;
  let priorHome: string | undefined;
  let stateDir: string;
  const frameworks: Record<string, string | undefined> = {
    'sess-claude': 'claude-code',
    'sess-codex': 'codex-cli',
    'sess-boom': 'explode',
  };

  function writeClaudeTranscript(uuid: string): void {
    const dir = path.join(home, '.claude', 'projects', '-some-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), '{"type":"user"}\n');
  }

  beforeEach(() => {
    home = makeFakeHome('thread-resume-fw-');
    priorHome = process.env.HOME;
    process.env.HOME = home;
    stateDir = path.join(home, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    resetRolloutLookupState();
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    resetRolloutLookupState();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadResumeMap-framework.test.ts:cleanup' });
  });

  function makeMap(): ThreadResumeMap {
    return new DeadSessionThreadResumeMap(stateDir, stateDir, undefined, undefined, {
      frameworkResolver: (name) => {
        if (frameworks[name] === 'explode') throw new Error('resolver failure');
        return frameworks[name];
      },
    });
  }

  it('a thread on claude-code with a missing transcript is null — and the Codex archive is never read', () => {
    const map = makeMap();
    const uuid = uuidV4Like(1);
    writeRollout(home, uuid, '2026/09/26'); // a Codex rollout under the same id must not count
    map.save('thread-claude', entry(uuid, 'sess-claude'));
    expect(map.get('thread-claude')).toBeNull();
    expect(archiveReads()).toBe(0);
  });

  it('a thread on claude-code with its transcript present resolves without touching Codex', () => {
    const map = makeMap();
    const uuid = uuidV4Like(2);
    writeClaudeTranscript(uuid);
    map.save('thread-claude-ok', entry(uuid, 'sess-claude'));
    expect(map.get('thread-claude-ok')?.uuid).toBe(uuid);
    expect(archiveReads()).toBe(0);
  });

  it('a thread on codex-cli still resolves its rollout (present → entry; absent → null)', () => {
    const map = makeMap();
    const when = new Date(2026, 9, 10, 9, 0, 0);
    const codexId = uuidV7At(when, 3);
    writeRollout(home, codexId, localPartitionOf(when));
    map.save('thread-codex', entry(codexId, 'sess-codex'));
    expect(map.get('thread-codex')?.uuid).toBe(codexId);
    expect(rolloutLookupStats().hintedPartitionReads).toBeGreaterThanOrEqual(1);

    map.save('thread-codex-gone', entry(uuidV7At(when, 4), 'sess-codex'));
    expect(map.get('thread-codex-gone')).toBeNull();
    // A Claude transcript under a codex id does not resume a codex thread.
    const claudeOnly = uuidV4Like(5);
    writeClaudeTranscript(claudeOnly);
    map.save('thread-codex-claude', entry(claudeOnly, 'sess-codex'));
    expect(map.get('thread-codex-claude')).toBeNull();
  });

  it('an unknown session (no resolver answer, or a throwing resolver) tries every layout through the bounded lookup', () => {
    const map = makeMap();
    const uuid = uuidV4Like(6);
    writeRollout(home, uuid, '2026/09/26');
    map.save('thread-unknown', entry(uuid, 'sess-unknown'));
    expect(map.get('thread-unknown')?.uuid).toBe(uuid);
    map.save('thread-boom', entry(uuid, 'sess-boom'));
    expect(map.get('thread-boom')?.uuid).toBe(uuid);
    expect(rolloutLookupStats().statCalls).toBeLessThanOrEqual(4);
  });

  it('a map built without a resolver behaves as before (every layout), and setFrameworkResolver installs one later', () => {
    const map = new DeadSessionThreadResumeMap(stateDir, stateDir);
    const uuid = uuidV4Like(7);
    writeRollout(home, uuid, '2026/09/26');
    map.save('t', entry(uuid, 'sess-claude'));
    expect(map.get('t')?.uuid).toBe(uuid);
    resetRolloutLookupState();
    map.setFrameworkResolver(() => 'claude-code');
    expect(map.get('t')).toBeNull();
    expect(archiveReads()).toBe(0);
  });
});
