/**
 * Wiring-integrity test for notify-on-stop Layer B (StopNotifier).
 *
 * Guards the exact failure mode from PR #334 (sentinels shipped as dead code
 * with a false "wired" claim): a component that exists but is never constructed
 * or never called. Asserts the full chain is connected —
 *   evaluate route → ctx.stopNotifier.maybeNotify → server.ts constructs it →
 *   AgentServer forwards it to the routes ctx.
 *
 * The decision logic itself is covered by StopNotifier.test.ts; the live
 * route-fires-notifier end-to-end is verified by test-as-self before merge.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('notify-on-stop Layer B — wiring integrity', () => {
  it('the evaluate route feeds each decision to ctx.stopNotifier.maybeNotify', () => {
    const src = read('src/server/routes.ts');
    expect(src).toMatch(/ctx\.stopNotifier\?\.maybeNotify\(\{/);
    // and passes the real decision + mode + attended-state
    const call = src.slice(src.indexOf('ctx.stopNotifier?.maybeNotify(')).slice(0, 220);
    expect(call).toContain('mode');
    expect(call).toContain('decision: r.decision');
    expect(call).toContain('autonomousActive');
  });

  it('the routes ctx declares a stopNotifier field', () => {
    expect(read('src/server/routes.ts')).toMatch(/stopNotifier:\s*import\([^)]*StopNotifier[^)]*\)\.StopNotifier\s*\|\s*null/);
  });

  it('server.ts constructs a StopNotifier and passes it into AgentServer', () => {
    const src = read('src/commands/server.ts');
    expect(src).toMatch(/new StopNotifier\(/);
    // stopNotifier is passed into the AgentServer construction (tolerant of
    // additional trailing fields appended after it, e.g. liveTestGate).
    expect(src).toMatch(/unjustifiedStopGate, stopGateDb, stopNotifier[,\s}]/);
  });

  it('AgentServer accepts stopNotifier and forwards it to the routes ctx', () => {
    const src = read('src/server/AgentServer.ts');
    expect(src).toMatch(/stopNotifier\?:/);
    expect(src).toMatch(/stopNotifier:\s*options\.stopNotifier\s*\?\?\s*null/);
  });

  it('the StopNotifier sink is a SentinelNotifier with escalation ON (coalesced single-topic reuse)', () => {
    const src = read('src/commands/server.ts');
    // The dedicated stop-notify sink is default-on (distinct from the
    // housekeeping sentinel notifier, which is default-off).
    const block = src.slice(src.indexOf('notify-on-stop Layer B'));
    expect(block).toMatch(/new SentinelNotifier\(/);
    expect(block).toMatch(/telegramEscalation: true/);
    expect(block).toMatch(/stopSink\.escalate\(/);
  });

  it('Layer B respects the config master gate (enabled !== false default-on)', () => {
    const src = read('src/commands/server.ts');
    const block = src.slice(src.indexOf('notify-on-stop Layer B'));
    expect(block).toMatch(/notifyOnStop/);
    expect(block).toMatch(/enabled !== false/);
  });
});
