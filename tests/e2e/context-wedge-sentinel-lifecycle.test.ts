// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — writes only to its own tmp dir.

/**
 * E2E lifecycle test — ContextWedgeSentinel's production wiring.
 *
 * Two "feature is alive" gates (Testing Integrity Standard Tier 3):
 *
 *  1. JSONL audit on a real disk: assemble the EXACT components server.ts wires
 *     (SentinelNotifier + buildContextWedgeDeps + ContextWedgeSentinel + the
 *     sentinel→notifier event wiring) with the same log-sink shape
 *     (<stateDir>/../logs/sentinel-events.jsonl), drive a confirmed wedge, and
 *     read back the file the server would have written. Proves detection +
 *     audit actually reach disk, and that detect-only mode kills nothing.
 *
 *  2. WIRED source check: the sentinel only matters if server.ts actually
 *     constructs + starts it AND folds it into the SessionReaper recovery veto.
 *     A grep against server.ts catches the dead-code failure (the exact sin the
 *     trio committed in PR #334: shipped as orphan classes, never instantiated,
 *     release notes falsely claimed "wired into server startup").
 *
 * Spec: docs/specs/context-wedge-sentinel.md
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextWedgeSentinel } from '../../src/monitoring/ContextWedgeSentinel.js';
import {
  buildContextWedgeDeps,
  type SentinelSessionSurface,
} from '../../src/monitoring/sentinelWiring.js';
import { SentinelNotifier, type SentinelLogEntry } from '../../src/monitoring/SentinelNotifier.js';

const WEDGE_TAIL = [
  '  ⎿  API Error: 400 messages.9.content.20: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.',
  '✻ Cooked for 0s',
].join('\n');

interface Rig {
  sentinel: ContextWedgeSentinel;
  sentinelLogPath: string;
  respawns: () => number;
  cleanup: () => void;
}

/** Mirrors the production wiring in src/commands/server.ts (the trio block). */
function wireProduction(opts: {
  surface: SentinelSessionSurface;
  autoRecovery: { enabled: boolean; dryRun?: boolean };
  telegramEscalation?: boolean;
}): Rig {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-wedge-e2e-'));
  // logs live INSIDE the per-test stateDir, not as a sibling. The previous
  // `path.join(stateDir, '..', 'logs')` made cleanup's `path.dirname(logsDir)`
  // resolve to os.tmpdir() ITSELF — so cleanup() rm-rf'd the shared tmpdir base,
  // which intermittently broke the next test's mkdtemp with ENOENT.
  const logsDir = path.join(stateDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const sentinelLogPath = path.join(logsDir, 'sentinel-events.jsonl');

  const logSink = (entry: SentinelLogEntry): void => {
    try { fs.appendFileSync(sentinelLogPath, JSON.stringify(entry) + '\n'); } catch { /* best-effort */ }
  };
  const notifier = new SentinelNotifier(
    { log: logSink, sendConsolidated: async () => true },
    { telegramEscalation: opts.telegramEscalation ?? false, coalesceWindowMs: 50 },
  );

  let respawns = 0;
  const sentinel = new ContextWedgeSentinel(
    buildContextWedgeDeps({
      sessions: opts.surface,
      escalate: (name, text) => notifier.escalate('context-wedge', name, text),
      autoRecovery: opts.autoRecovery,
      freshRespawn: async () => { respawns++; return true; },
    }),
    // Tiny real-timer confirm window so the e2e is fast + deterministic
    // (the fake-timer timing path is exercised by the integration tier).
    { confirmWindowMs: 20, tickIntervalMs: 20_000 },
  );
  // Same event wiring server.ts installs.
  sentinel.on('detected', (e: { sessionName: string }) => notifier.record('detected', 'context-wedge', e.sessionName));
  sentinel.on('recovered', (e: { sessionName: string }) => notifier.record('recovered', 'context-wedge', e.sessionName, 'fresh respawn'));
  sentinel.on('dry-run', (e: { sessionName: string }) => notifier.record('dry-run', 'context-wedge', e.sessionName, 'would fresh-respawn'));
  sentinel.on('false-alarm', (e: { sessionName: string }) => notifier.record('false-alarm', 'context-wedge', e.sessionName));

  return {
    sentinel,
    sentinelLogPath,
    respawns: () => respawns,
    cleanup: () => { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

function readAudit(p: string): SentinelLogEntry[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const settle = () => new Promise<void>(r => setTimeout(r, 80));

describe('ContextWedgeSentinel E2E — production wiring writes the audit trail', () => {
  it('detect-only (default): a confirmed wedge writes context-wedge rows to the JSONL, kills nothing', async () => {
    const surface: SentinelSessionSurface = {
      captureOutput: () => WEDGE_TAIL,
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'echo-wedged' }],
    };
    const rig = wireProduction({ surface, autoRecovery: { enabled: false } });
    try {
      rig.sentinel.tick(); // scan via the self-driving path
      await settle();
      const audit = readAudit(rig.sentinelLogPath);
      const wedgeRows = audit.filter(e => e.sentinel === 'context-wedge');
      expect(wedgeRows.length).toBeGreaterThan(0);
      expect(wedgeRows.some(e => e.kind === 'detected')).toBe(true);
      expect(audit.some(e => e.kind === 'escalated' && e.sentinel === 'context-wedge')).toBe(true);
      expect(rig.respawns()).toBe(0); // detect-only never kills
    } finally {
      rig.cleanup();
    }
  });

  it('live: a confirmed wedge respawns and writes a recovered row', async () => {
    const surface: SentinelSessionSurface = {
      captureOutput: () => WEDGE_TAIL,
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'echo-wedged' }],
    };
    const rig = wireProduction({ surface, autoRecovery: { enabled: true, dryRun: false } });
    try {
      rig.sentinel.tick();
      await settle();
      expect(rig.respawns()).toBe(1);
      const audit = readAudit(rig.sentinelLogPath);
      expect(audit.some(e => e.kind === 'recovered' && e.sentinel === 'context-wedge')).toBe(true);
    } finally {
      rig.cleanup();
    }
  });
});

describe('ContextWedgeSentinel E2E — WIRED into server.ts (dead-code guard)', () => {
  const serverSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/commands/server.ts'),
    'utf-8',
  );

  it('server.ts constructs a ContextWedgeSentinel', () => {
    expect(serverSrc).toContain('new ContextWedgeSentinel(');
  });

  it('server.ts starts the sentinel scan loop', () => {
    expect(serverSrc).toMatch(/wedgeSentinel\.start\(\)/);
  });

  it('server.ts builds the deps via buildContextWedgeDeps', () => {
    expect(serverSrc).toContain('buildContextWedgeDeps(');
  });

  it('server.ts folds the wedge sentinel into the SessionReaper recovery veto', () => {
    expect(serverSrc).toContain('wedgeRecoveryActive');
  });

  it('server.ts wires the fresh-respawn recovery (no --resume into the corrupted transcript)', () => {
    expect(serverSrc).toMatch(/fresh:\s*true/);
  });
});

// ── AUP-rejection family (signature 2, 2026-06-05 EXO incident) ──────────────

const AUP_ERROR_LINE =
  '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.';

const AUP_WEDGE_TAIL = [
  '❯ [telegram:19437 "🎯 EXO 3.0" from Justin] did you get my last 3 messages?',
  AUP_ERROR_LINE,
  '✻ Churned for 8s · 1 shell still running',
  '❯ [telegram:19437 "🎯 EXO 3.0" from Unknown] did you get my last 3 messages?',
  AUP_ERROR_LINE,
  '✻ Cogitated for 8s · 1 shell still running',
].join('\n');

describe('ContextWedgeSentinel E2E — AUP-rejection wedge through the production wiring', () => {
  it('live: a confirmed AUP loop respawns and the audit row carries the kind', async () => {
    const surface: SentinelSessionSurface = {
      captureOutput: () => AUP_WEDGE_TAIL,
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'echo-exo-3-0' }],
    };
    const rig = wireProduction({ surface, autoRecovery: { enabled: true, dryRun: false } });
    try {
      rig.sentinel.tick();
      await settle();
      expect(rig.respawns()).toBe(1);
      const audit = readAudit(rig.sentinelLogPath);
      const recovered = audit.find(e => e.kind === 'recovered' && e.sentinel === 'context-wedge');
      expect(recovered).toBeTruthy();
    } finally {
      rig.cleanup();
    }
  });

  it('a benign ONE-OFF AUP rejection never enters the wedge lifecycle (no audit rows, no kill)', async () => {
    const oneOff = [
      '❯ [telegram:42] some message',
      AUP_ERROR_LINE,
      '✻ Worked for 22s',
    ].join('\n');
    const surface: SentinelSessionSurface = {
      captureOutput: () => oneOff,
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'echo-fine' }],
    };
    const rig = wireProduction({ surface, autoRecovery: { enabled: true, dryRun: false } });
    try {
      rig.sentinel.tick();
      await settle();
      expect(rig.respawns()).toBe(0);
      const audit = readAudit(rig.sentinelLogPath);
      expect(audit.filter(e => e.sentinel === 'context-wedge')).toHaveLength(0);
    } finally {
      rig.cleanup();
    }
  });
});

describe('Fresh-respawn API lever — WIRED into routes.ts (dead-code guard)', () => {
  const routesSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/server/routes.ts'),
    'utf-8',
  );

  it('routes.ts validates the fresh param', () => {
    expect(routesSrc).toMatch(/"fresh" must be a boolean/);
  });

  it('routes.ts forwards fresh to refreshSession', () => {
    expect(routesSrc).toMatch(/refreshSession\(\{ sessionName, followUpPrompt, reason, fresh \}\)/);
  });
});
