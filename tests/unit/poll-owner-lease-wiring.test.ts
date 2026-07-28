/**
 * Wiring-integrity test for the poll-ownership lease (Task 4 Part 1).
 * Guards the PR#334 dead-code failure mode: a structural fix that exists but
 * is never written by the lifeline or never checked by the server is the same
 * as not having it. Asserts the call sites are present in the canonical paths.
 *
 * The decision logic is covered by TelegramPollOwnerLease.test.ts;
 * end-to-end "server actually demotes on a real lease" is verified by
 * test-as-self before merge.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('poll-ownership lease — wiring integrity', () => {
  it('lifeline writes the lease after each successful poll tick', () => {
    const src = read('src/lifeline/TelegramLifeline.ts');
    // import + call after the successful-poll reset block
    expect(src).toMatch(/import \{ writeLease as writePollOwnerLease \} from '\.\/TelegramPollOwnerLease\.js'/);
    expect(src).toMatch(/writePollOwnerLease\(this\.projectConfig\.stateDir, this\.config\.token, process\.pid\)/);
    // it lives in the successful-poll branch (after backoff counter resets)
    const idx = src.indexOf('writePollOwnerLease(');
    const window = src.slice(Math.max(0, idx - 1500), idx + 100);
    expect(window).toContain('this.consecutive409s = 0');
  });

  it('server consults the lease BEFORE choosing send-only vs full-poll', () => {
    const src = read('src/commands/server.ts');
    expect(src).toMatch(/import \{ lifelineOwnsPoll as lifelineOwnsTelegramPoll \} from '\.\.\/lifeline\/TelegramPollOwnerLease\.js'/);
    expect(src).toMatch(/const lifelineOwnsPolling = telegramConfig && telegramBotToken\s*\?\s*lifelineOwnsTelegramPoll\(/);
    // send-only branch now also triggers on a live lease
    expect(src).toMatch(/if \(\(skipTelegram \|\| isStandbyTelegram \|\| lifelineOwnsPolling\) && telegramConfig\)/);
    // full-poll branch is now also gated on !lifelineOwnsPolling
    expect(src).toMatch(/if \(telegramConfig && !skipTelegram && !isStandbyTelegram && !lifelineOwnsPolling\)/);
  });

  it('the server NEVER writes the lease (only the lifeline does — single-writer)', () => {
    const src = read('src/commands/server.ts');
    expect(src).not.toMatch(/writeLease\s*\(/);
    expect(src).not.toMatch(/writePollOwnerLease/);
  });

  it('the lease lives under stateDir at a stable path', () => {
    const src = read('src/lifeline/TelegramPollOwnerLease.ts');
    expect(src).toMatch(/telegram-poll-owner\.json/);
  });
});
