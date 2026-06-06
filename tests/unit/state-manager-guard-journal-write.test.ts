// safe-git-allow: test sandbox teardown only (tmpdir scratch dirs).
// safe-fs-allow: test sandbox teardown only (tmpdir scratch dirs).
/**
 * Tier-1 tests for StateManager.guardJournalWrite (COHERENCE-JOURNAL-SPEC §3.1).
 *
 * The contract under test:
 *  1. Journal-prefix writes are permitted on a READ-ONLY standby INDEPENDENT of
 *     `_sessionPoolActive` — the quiet-standby topology (pool inactive) is exactly
 *     where the EXO artifact-stranding incident happened, and reusing the
 *     pool-gated `sessionScoped` exception would have silently disabled the
 *     journal there.
 *  2. The permission is allowlisted to the canonicalized coherence-journal
 *     prefix; an escaping path throws EVEN when not read-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../../src/core/StateManager.js';

let tmpDir: string;
let sm: StateManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-journal-'));
  sm = new StateManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('StateManager.guardJournalWrite', () => {
  it('permits own-stream paths under the journal prefix in normal mode', () => {
    const p = path.join(tmpDir, 'state', 'coherence-journal', 'm_abc.topic-placement.jsonl');
    expect(() => sm.guardJournalWrite(p)).not.toThrow();
  });

  it('permits peer-replica appends under the peers/ subdir', () => {
    const p = path.join(tmpDir, 'state', 'coherence-journal', 'peers', 'm_def.session-lifecycle.jsonl');
    expect(() => sm.guardJournalWrite(p)).not.toThrow();
  });

  it('permits journal writes on a READ-ONLY standby with the session pool INACTIVE (the quiet-standby case)', () => {
    sm.setReadOnly(true);
    // Deliberately NOT calling setSessionPoolActive(true) — this is the
    // topology the dedicated entrypoint exists for.
    const p = path.join(tmpDir, 'state', 'coherence-journal', 'm_abc.autonomous-run.jsonl');
    expect(() => sm.guardJournalWrite(p)).not.toThrow();
    // Sanity: shared-state writes stay blocked on the same standby.
    expect(() => sm.set('some-key', { v: 1 })).toThrow(/read-only/);
  });

  it('permits meta/lock sidecars under the prefix', () => {
    sm.setReadOnly(true);
    expect(() =>
      sm.guardJournalWrite(path.join(tmpDir, 'state', 'coherence-journal', 'm_abc.meta.json')),
    ).not.toThrow();
    expect(() =>
      sm.guardJournalWrite(path.join(tmpDir, 'state', 'coherence-journal', 'm_abc.lock')),
    ).not.toThrow();
  });

  it('throws for a path escaping the prefix via ../ EVEN when not read-only', () => {
    const escape = path.join(tmpDir, 'state', 'coherence-journal', '..', 'sessions', 'oops.json');
    expect(() => sm.guardJournalWrite(escape)).toThrow(/escapes the coherence-journal prefix/);
  });

  it('throws for an absolute path outside the journal root', () => {
    expect(() => sm.guardJournalWrite('/tmp/evil.jsonl')).toThrow(
      /escapes the coherence-journal prefix/,
    );
  });

  it('throws for a sibling dir that merely shares the prefix string', () => {
    const sneaky = path.join(tmpDir, 'state', 'coherence-journal-evil', 'x.jsonl');
    expect(() => sm.guardJournalWrite(sneaky)).toThrow(/escapes the coherence-journal prefix/);
  });
});
