// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Integration test for ContextWedgeSentinel wiring.
 *
 * Drives the real ContextWedgeSentinel through the real buildContextWedgeDeps
 * + a real SentinelNotifier against a fake SessionManager surface — the same
 * shape server.ts assembles in the silently-stopped block. Proves the delivery
 * contract across the three recovery policies:
 *   - detect-only (default): audit + (Telegram OFF) escalation-suppressed; no respawn.
 *   - dry-run: a 'dry-run' audit row, no respawn, no Telegram.
 *   - live: a fresh respawn happens and lands as a 'recovered' audit row.
 *   - telegram ON + detect-only: ONE coalesced escalation send.
 *
 * Spec: docs/specs/context-wedge-sentinel.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextWedgeSentinel } from '../../src/monitoring/ContextWedgeSentinel.js';
import {
  buildContextWedgeDeps,
  type SentinelSessionSurface,
} from '../../src/monitoring/sentinelWiring.js';
import { SentinelNotifier, type SentinelLogEntry } from '../../src/monitoring/SentinelNotifier.js';

const WEDGE_TAIL = [
  '  ⎿  API Error: 400 messages.9.content.20: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.',
  '✻ Cooked for 0s',
].join('\n');

function surfaceWith(output: string): SentinelSessionSurface {
  return {
    captureOutput: () => output,
    isSessionAlive: () => true,
    sendKey: () => true,
    listRunningSessions: () => [{ tmuxSession: 'echo-wedged' }],
  };
}

/** Mirror server.ts's sentinel→notifier event wiring so the integration test
 *  exercises the same audit-row production the server does. */
function wireEvents(sentinel: ContextWedgeSentinel, notifier: SentinelNotifier): void {
  sentinel.on('detected', (e: { sessionName: string }) => notifier.record('detected', 'context-wedge', e.sessionName));
  sentinel.on('recovered', (e: { sessionName: string }) => notifier.record('recovered', 'context-wedge', e.sessionName, 'fresh respawn'));
  sentinel.on('dry-run', (e: { sessionName: string }) => notifier.record('dry-run', 'context-wedge', e.sessionName, 'would fresh-respawn'));
  sentinel.on('false-alarm', (e: { sessionName: string }) => notifier.record('false-alarm', 'context-wedge', e.sessionName, 'signature scrolled out of tail'));
  sentinel.on('recovery-error', (e: { sessionName: string; err: unknown }) => notifier.record('recovery-error', 'context-wedge', e.sessionName, String(e.err)));
}

describe('ContextWedgeSentinel — end-to-end through SentinelNotifier', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeRig(opts: { telegramEscalation?: boolean } = {}) {
    const log: SentinelLogEntry[] = [];
    const sent: string[] = [];
    const notifier = new SentinelNotifier(
      {
        log: (e) => log.push(e),
        sendConsolidated: async (text) => { sent.push(text); return true; },
      },
      { telegramEscalation: opts.telegramEscalation ?? false, coalesceWindowMs: 50 },
    );
    return { notifier, log, sent };
  }

  it('detect-only (default): confirmed wedge → audit + suppressed escalation, NO respawn, Telegram silent', async () => {
    const { notifier, log, sent } = makeRig({ telegramEscalation: false });
    let respawns = 0;
    const sentinel = new ContextWedgeSentinel(
      buildContextWedgeDeps({
        sessions: surfaceWith(WEDGE_TAIL),
        escalate: (name, text) => notifier.escalate('context-wedge', name, text),
        autoRecovery: { enabled: false },
        freshRespawn: async () => { respawns++; return true; },
      }),
      { confirmWindowMs: 45_000, tickIntervalMs: 20_000 },
    );
    wireEvents(sentinel, notifier);
    sentinel.scanSession('echo-wedged');
    await vi.advanceTimersByTimeAsync(46_000); // pass the confirm window
    const kinds = log.filter(e => e.sentinel === 'context-wedge').map(e => e.kind);
    expect(kinds).toContain('detected');
    expect(log.some(e => e.kind === 'escalated' && e.sentinel === 'context-wedge')).toBe(true);
    expect(log.some(e => e.kind === 'escalation-suppressed')).toBe(true);
    expect(sent).toHaveLength(0); // Telegram OFF by default
    expect(respawns).toBe(0); // detect-only never kills
  });

  it('dry-run: confirmed wedge → dry-run audit row, NO respawn, Telegram silent', async () => {
    const { notifier, log, sent } = makeRig({ telegramEscalation: true });
    let respawns = 0;
    const sentinel = new ContextWedgeSentinel(
      buildContextWedgeDeps({
        sessions: surfaceWith(WEDGE_TAIL),
        escalate: (name, text) => notifier.escalate('context-wedge', name, text),
        autoRecovery: { enabled: true, dryRun: true },
        freshRespawn: async () => { respawns++; return true; },
      }),
      { confirmWindowMs: 45_000 },
    );
    wireEvents(sentinel, notifier);
    sentinel.scanSession('echo-wedged');
    await vi.advanceTimersByTimeAsync(46_000);
    expect(log.some(e => e.kind === 'dry-run' && e.sentinel === 'context-wedge')).toBe(true);
    expect(respawns).toBe(0);
    expect(sent).toHaveLength(0); // dry-run is not an escalation
  });

  it('live: confirmed wedge → fresh respawn happens and lands as a recovered audit row', async () => {
    const { notifier, log } = makeRig({ telegramEscalation: false });
    let respawns = 0;
    const sentinel = new ContextWedgeSentinel(
      buildContextWedgeDeps({
        sessions: surfaceWith(WEDGE_TAIL),
        escalate: (name, text) => notifier.escalate('context-wedge', name, text),
        autoRecovery: { enabled: true, dryRun: false },
        freshRespawn: async () => { respawns++; return true; },
      }),
      { confirmWindowMs: 45_000 },
    );
    wireEvents(sentinel, notifier);
    sentinel.scanSession('echo-wedged');
    await vi.advanceTimersByTimeAsync(46_000);
    expect(respawns).toBe(1);
    expect(log.some(e => e.kind === 'recovered' && e.sentinel === 'context-wedge')).toBe(true);
    expect(log.some(e => e.kind === 'escalated')).toBe(false); // recovered, not escalated
  });

  it('telegram ON + detect-only: ONE coalesced escalation send to the system topic', async () => {
    const { notifier, sent } = makeRig({ telegramEscalation: true });
    const sentinel = new ContextWedgeSentinel(
      buildContextWedgeDeps({
        sessions: surfaceWith(WEDGE_TAIL),
        escalate: (name, text) => notifier.escalate('context-wedge', name, text),
        autoRecovery: { enabled: false },
        freshRespawn: async () => true,
      }),
      { confirmWindowMs: 45_000 },
    );
    wireEvents(sentinel, notifier);
    sentinel.scanSession('echo-wedged');
    await vi.advanceTimersByTimeAsync(46_000); // confirm
    await vi.advanceTimersByTimeAsync(100); // coalesce flush
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/restart/i);
  });

  it('false alarm: signature scrolls out of tail during confirm → no respawn, no escalation', async () => {
    const { notifier, log, sent } = makeRig({ telegramEscalation: true });
    let respawns = 0;
    let output = WEDGE_TAIL;
    const surface: SentinelSessionSurface = {
      captureOutput: () => output,
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'echo-transient' }],
    };
    const sentinel = new ContextWedgeSentinel(
      buildContextWedgeDeps({
        sessions: surface,
        escalate: (name, text) => notifier.escalate('context-wedge', name, text),
        autoRecovery: { enabled: true, dryRun: false },
        freshRespawn: async () => { respawns++; return true; },
      }),
      { confirmWindowMs: 45_000 },
    );
    wireEvents(sentinel, notifier);
    sentinel.scanSession('echo-transient');
    // Session progressed — error scrolled out before the confirm fires.
    output = 'normal prompt — back to work\n> ready for next';
    await vi.advanceTimersByTimeAsync(46_000);
    expect(respawns).toBe(0);
    expect(log.some(e => e.kind === 'false-alarm')).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
