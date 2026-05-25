/**
 * Shared test-only ThreadResumeMap.
 *
 * Phase 2a (CMT-497) made `ThreadResumeMap` a view over `ConversationStore`. In
 * tests there are no real Claude session JSONL files, so the production
 * `jsonlExists()` resume-guard would make `get()` return null. This subclass
 * overrides ONLY that guard and otherwise uses the real view logic.
 *
 * This lives in ONE place on purpose: the regression that turned main red
 * (PR #381 → fixed in #383) happened because this helper was duplicated across
 * the integration + e2e suites and one copy went stale during the refactor.
 * One shared copy means a future refactor updates it once, everywhere.
 */

import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';

export class TestThreadResumeMap extends ThreadResumeMap {
  protected jsonlExists(): boolean {
    return true;
  }
}
