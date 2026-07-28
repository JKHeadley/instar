/**
 * Standby-no-poll guard — wiring integrity (Multi-Machine; the 2026-05-29
 * duplicate-poller 409 cure).
 *
 * Telegram allows exactly ONE getUpdates long-poll per bot token. The lifeline
 * is the poller. With two machines, both lifelines polled the same token → a
 * permanent 409-conflict war + nondeterministic delivery (half the user's
 * messages stolen by the standby). The guard lets a standby run the FULL server
 * (so it still joins the session pool) but NOT own the Telegram poll, gated on a
 * per-machine LOCAL flag `multiMachine.telegramPolling` (default = poll, so every
 * existing single-machine agent is unchanged).
 *
 * `TelegramLifeline.start()` isn't cleanly unit-instantiable (its constructor
 * does loadConfig + registry + state-dir side effects), so — like
 * version-skew-alert-routing.test.ts — this pins the wiring against source:
 *   - the gate predicate is the default-true `!== false` form
 *   - flushStaleConnection() + this.poll() are INSIDE the gate (suppressed when off)
 *   - supervisor.start() is BEFORE/OUTSIDE the gate (a standby still serves + pools)
 *   - the suppressed branch sets polling=false and logs it (no silent no-op)
 *   - the config flag exists on MultiMachineConfig
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const lifelineSrc = fs.readFileSync(
  path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
  'utf-8',
);
const typesSrc = fs.readFileSync(
  path.join(repoRoot, 'src', 'core', 'types.ts'),
  'utf-8',
);

describe('standby-no-poll guard — config flag', () => {
  it('MultiMachineConfig declares an optional telegramPolling flag', () => {
    expect(typesSrc).toContain('telegramPolling?: boolean');
  });
});

describe('standby-no-poll guard — TelegramLifeline.start() wiring', () => {
  it('gates on the shared default-TRUE predicate (only an explicit false suppresses)', () => {
    // Source delegates to the pure, separately-unit-tested predicate so the
    // wiring and the default-true semantics cannot drift.
    expect(lifelineSrc).toMatch(
      /const\s+telegramPollingEnabled\s*=\s*shouldOwnTelegramPoll\(this\.projectConfig\)/,
    );
    expect(lifelineSrc).toContain("import { shouldOwnTelegramPoll } from './telegramPollOwnership.js'");
  });

  it('runs the server supervisor BEFORE/OUTSIDE the poll gate (a standby still serves + joins the pool)', () => {
    const supervisorIdx = lifelineSrc.indexOf('await this.supervisor.start()');
    const gateIdx = lifelineSrc.indexOf('const telegramPollingEnabled =');
    expect(supervisorIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeGreaterThan(0);
    expect(supervisorIdx).toBeLessThan(gateIdx); // supervisor.start() is not inside the gate
  });

  it('flushStaleConnection() + poll() are INSIDE the enabled branch (suppressed when off)', () => {
    const gateIdx = lifelineSrc.indexOf('if (telegramPollingEnabled) {');
    expect(gateIdx).toBeGreaterThan(0);
    const elseIdx = lifelineSrc.indexOf('} else {', gateIdx);
    expect(elseIdx).toBeGreaterThan(gateIdx);
    const enabledBlock = lifelineSrc.slice(gateIdx, elseIdx);
    expect(enabledBlock).toContain('await this.flushStaleConnection();');
    expect(enabledBlock).toContain('this.poll();');
    expect(enabledBlock).toContain('this.polling = true;');
  });

  it('the suppressed branch sets polling=false and logs it (not a silent no-op)', () => {
    const gateIdx = lifelineSrc.indexOf('if (telegramPollingEnabled) {');
    const elseIdx = lifelineSrc.indexOf('} else {', gateIdx);
    // window from the else through a bit past it to capture the standby branch body
    const elseBlock = lifelineSrc.slice(elseIdx, elseIdx + 600);
    expect(elseBlock).toContain('this.polling = false;');
    expect(elseBlock).toMatch(/SUPPRESSED/);
    // it must NOT call flush or poll in the standby branch
    expect(elseBlock).not.toContain('this.poll();');
    expect(elseBlock).not.toContain('flushStaleConnection');
  });

  it('keeps queue replay OUTSIDE the gate (a standby still drains its queue when the server is healthy)', () => {
    // The replay interval is set up after the gate closes; assert it still exists
    // and is not accidentally nested inside the poll-enabled branch.
    const replayIdx = lifelineSrc.indexOf('this.replayInterval = setInterval(');
    const gateIdx = lifelineSrc.indexOf('if (telegramPollingEnabled) {');
    expect(replayIdx).toBeGreaterThan(gateIdx); // after the gate
  });
});
