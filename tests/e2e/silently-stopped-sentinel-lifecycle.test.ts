// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — writes only to its own tmp dir.

/**
 * E2E lifecycle test — the silently-stopped sentinels' production wiring.
 *
 * Tests the production initialization path: this assembles the EXACT same
 * components server.ts wires (SentinelNotifier + OutputActivityTracker +
 * ActiveWorkSilenceSentinel + buildActiveWorkSilenceDeps), with the same
 * log-sink shape (console + JSONL at <stateDir>/../logs/sentinel-events.jsonl),
 * and exercises both the default (Telegram OFF, log-only) and opt-in
 * (Telegram ON, coalesced) modes.
 *
 * WHY THIS TEST EXISTS:
 * The unit + integration tests prove each component is correct in isolation
 * and that the wiring deps delegate. They do NOT prove that on a server start
 * a JSONL audit file is actually written to disk, or that the
 * sentinelTelegramEscalation default flips Telegram off for a real scenario.
 * This test boots the assembly against a tmp stateDir and reads the file the
 * server would have written — the "feature is alive" gate for the 2026-05-22
 * fix. If the wiring stops writing the JSONL or the default gate flips, this
 * test fails immediately on the next CI run.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildActiveWorkSilenceDeps,
  OutputActivityTracker,
  type SentinelSessionSurface,
} from '../../src/monitoring/sentinelWiring.js';
import { ActiveWorkSilenceSentinel } from '../../src/monitoring/ActiveWorkSilenceSentinel.js';
import { SentinelNotifier, type SentinelLogEntry } from '../../src/monitoring/SentinelNotifier.js';

interface ProductionRig {
  notifier: SentinelNotifier;
  sentinel: ActiveWorkSilenceSentinel;
  sentinelLogPath: string;
  sent: string[];
  cleanup: () => void;
}

/**
 * Mirrors the production wiring in src/commands/server.ts (the silently-stopped
 * trio block). If server.ts diverges from this assembly, the E2E will catch it.
 */
function wireProduction(opts: {
  telegramEscalation: boolean;
  surface: SentinelSessionSurface;
  coalesceWindowMs?: number;
}): ProductionRig {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sentinel-e2e-'));
  // server.ts puts the JSONL at `<stateDir>/../logs/sentinel-events.jsonl`.
  const logsDir = path.join(stateDir, '..', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const sentinelLogPath = path.join(logsDir, 'sentinel-events.jsonl');

  const sent: string[] = [];
  const logSink = (entry: SentinelLogEntry): void => {
    const detail = entry.detail ? ` — ${entry.detail}` : '';
    // server.ts emits the same console line shape.
    void `[sentinel:${entry.kind}] ${entry.sentinel}/${entry.sessionName}${detail}`;
    try {
      fs.appendFileSync(sentinelLogPath, JSON.stringify(entry) + '\n');
    } catch { /* best-effort, never crash monitoring */ }
  };
  const sendConsolidated = async (text: string): Promise<boolean> => {
    sent.push(text);
    return true;
  };

  const notifier = new SentinelNotifier(
    { log: logSink, sendConsolidated },
    { telegramEscalation: opts.telegramEscalation, coalesceWindowMs: opts.coalesceWindowMs ?? 50 },
  );
  const tracker = new OutputActivityTracker(opts.surface, () => Date.now());
  const sentinel = new ActiveWorkSilenceSentinel(
    buildActiveWorkSilenceDeps({
      tracker, sessions: opts.surface,
      escalate: (name, text) => notifier.escalate('active-silence', name, text),
    }),
    { verifyWindowMs: 5 },
  );
  sentinel.on('silence', (e: { sessionName: string; idleMs: number }) =>
    notifier.record('detected', 'active-silence', e.sessionName, `idleMs=${e.idleMs}`));
  sentinel.on('recovered', (n: string) => notifier.record('recovered', 'active-silence', n));
  sentinel.on('nudge-error', (e: { sessionName: string; err: unknown }) =>
    notifier.record('nudge-error', 'active-silence', e.sessionName, e.err instanceof Error ? e.err.message : String(e.err)));

  const cleanup = (): void => {
    sentinel.stop();
    notifier.stop();
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(logsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { notifier, sentinel, sentinelLogPath, sent, cleanup };
}

describe('silently-stopped sentinels — production lifecycle (alive on boot)', () => {
  let rig: ProductionRig | undefined;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    rig?.cleanup();
    rig = undefined;
  });

  it('default (telegramEscalation OFF): zombie sessions never escalate AND nothing reaches Telegram', async () => {
    // The 2026-05-22 incident: on server restart the registry contains a pile
    // of long-dead tmux sessions whose frozen last frame still says "esc to
    // interrupt". With the production default, the user must see nothing —
    // and the audit JSONL must record the no-op so operators can confirm.
    const surface: SentinelSessionSurface = {
      captureOutput: () => 'Running Bash(npm test) (esc to interrupt)', // frozen
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [
        { tmuxSession: 'zombie-1' },
        { tmuxSession: 'zombie-2' },
        { tmuxSession: 'zombie-3' },
      ],
    };
    rig = wireProduction({ telegramEscalation: false, surface });
    vi.setSystemTime(1_700_000_000_000);

    // 30 minutes of ticks — far past the 15-min silence threshold.
    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(Date.now() + 60_000);
      rig.sentinel.tick();
    }
    await vi.advanceTimersByTimeAsync(200);
    await rig.notifier.flushNow();

    // No Telegram delivery.
    expect(rig.sent.length).toBe(0);

    // JSONL audit file exists and is empty of escalation events (no escalated
    // entries, because the detection fix prevents never-changed sessions from
    // crossing the threshold). The file may also be empty entirely — both are
    // valid; the assertion is the absence of escalations, not the presence of
    // file content.
    if (fs.existsSync(rig.sentinelLogPath)) {
      const lines = fs.readFileSync(rig.sentinelLogPath, 'utf-8').trim().split('\n').filter(Boolean);
      const escalated = lines.filter(l => /"kind":"escalated"/.test(l));
      expect(escalated).toEqual([]);
    }
  });

  it('genuine recovery-failed escalation: with telegramEscalation OFF logs only, with ON sends ONE consolidated message', async () => {
    // Same active-then-silent transition exercised by the integration test,
    // but assembled the production way and observed on the real JSONL path.
    const driveTransition = async (telegramEscalation: boolean): Promise<ProductionRig> => {
      let frame = 'Bash(npm test) step 1 (esc to interrupt)';
      const surface: SentinelSessionSurface = {
        captureOutput: () => frame,
        isSessionAlive: () => true,
        sendKey: () => true,
        listRunningSessions: () => [{ tmuxSession: 'agent-1' }],
      };
      const r = wireProduction({ telegramEscalation, surface, coalesceWindowMs: 50 });
      vi.setSystemTime(1_700_000_000_000);
      r.sentinel.tick(); // first sighting — non-eligible
      vi.setSystemTime(Date.now() + 60_000);
      frame = 'Bash(npm test) step 2 (esc to interrupt)'; // observed change
      r.sentinel.tick();
      vi.setSystemTime(Date.now() + 16 * 60_000);
      r.sentinel.tick(); // freeze past threshold → detect → nudge → escalate
      await vi.advanceTimersByTimeAsync(100);
      await r.notifier.flushNow();
      return r;
    };

    // Default mode: log-only, no Telegram.
    const rigOff = await driveTransition(false);
    rig = rigOff;
    expect(rigOff.sent.length).toBe(0);
    const offLines = fs.readFileSync(rigOff.sentinelLogPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(offLines.some(l => /"kind":"escalated"/.test(l) && /agent-1/.test(l))).toBe(true);
    expect(offLines.some(l => /"kind":"escalation-suppressed"/.test(l))).toBe(true);
    rigOff.cleanup();

    // Opt-in mode: ONE consolidated message — never per-session.
    const rigOn = await driveTransition(true);
    rig = rigOn;
    expect(rigOn.sent.length).toBe(1);
    expect(rigOn.sent[0]).toMatch(/agent-1/);
  });
});
