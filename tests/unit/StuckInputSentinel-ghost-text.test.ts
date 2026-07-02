// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * F2 ghost-text exclusion tests for StuckInputSentinel.
 *
 * Live finding F2 (2026-07-02, test-as-self run): Claude Code rendered a
 * model-generated prompt SUGGESTION ("ghost text") in a session's composer —
 * dim-styled (`ESC[0;2m`), never typed by anyone — and the sentinel classified
 * it as stuck real input and fired 4 Enter presses at it
 * (stuck-input-events.jsonl, outcome "fired"). Enter does not accept ghost
 * text today, so nothing executed — but that is one harness UX change away
 * from a watchdog auto-submitting a fabricated instruction.
 *
 * THE INVARIANT UNDER TEST: the sentinel never auto-submits text the user (or
 * an authorized injector) did not actually type. Before any keypress on the
 * generic `❯`-prompt path, the sentinel re-captures the pane WITH ANSI escapes
 * and refuses to act unless the text provably renders at normal intensity
 * ('real'). 'ghost' (entirely dim) and 'inconclusive' (capture failed / frames
 * raced / mixed styling) both fail toward NOT pressing keys.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StuckInputSentinel, classifyPromptTextPresentation } from '../../src/core/StuckInputSentinel.js';

const ESC = '\x1b';

// The exact text the live F2 event captured as "stuck input".
const GHOST_TEXT = 'tas channel-parity: now test the Slack topic';

/** Plain (no-ANSI) pane — what captureOutput sees. Ghost text and real input
 *  are byte-identical here; that indistinguishability IS the F2 bug. */
const PLAIN_STUCK_PANE = [
  '────────────────────────────────────────',
  `❯ ${GHOST_TEXT}`,
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

/** ANSI frame reproducing the live F2 capture: the suggestion rendered with
 *  the dim attribute (`ESC[0;2m`), the rest of the chrome normal. */
const GHOST_ANSI_PANE = [
  '────────────────────────────────────────',
  `❯ ${ESC}[0;2m${GHOST_TEXT}${ESC}[0m`,
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

/** ANSI frame of GENUINE stuck input: same text, normal intensity (with the
 *  prompt char itself colored, as Claude Code renders it). */
const REAL_ANSI_PANE = [
  '────────────────────────────────────────',
  `${ESC}[36m❯${ESC}[0m ${GHOST_TEXT}`,
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

type StubManager = {
  listRunningSessions: ReturnType<typeof vi.fn>;
  tmuxSessionExists: ReturnType<typeof vi.fn>;
  captureOutput: ReturnType<typeof vi.fn>;
  captureOutputAnsi: ReturnType<typeof vi.fn>;
  fireStuckInputRecovery: ReturnType<typeof vi.fn>;
  getStrandedDraftMarker: ReturnType<typeof vi.fn>;
  clearStrandedDraftMarker: ReturnType<typeof vi.fn>;
  strandedDraftMarkerSessions: ReturnType<typeof vi.fn>;
  isMarkerStuckAtPrompt: ReturnType<typeof vi.fn>;
};

function buildStubManager(
  panes: Record<string, string>,
  ansiPanes: Record<string, string | null | (() => string | null)>,
  markers: Record<string, { marker: string; framework: string }> = {},
): StubManager {
  const liveMarkers = new Map(Object.entries(markers).map(([k, v]) => [k, { ...v, injectedAt: 0 }]));
  return {
    listRunningSessions: vi.fn(() => Object.keys(panes).map(name => ({ tmuxSession: name }))),
    tmuxSessionExists: vi.fn((name: string) => name in panes),
    captureOutput: vi.fn((name: string) => panes[name]),
    captureOutputAnsi: vi.fn((name: string) => {
      const a = ansiPanes[name];
      return typeof a === 'function' ? a() : a;
    }),
    fireStuckInputRecovery: vi.fn(),
    getStrandedDraftMarker: vi.fn((name: string) => liveMarkers.get(name)),
    clearStrandedDraftMarker: vi.fn((name: string) => { liveMarkers.delete(name); }),
    strandedDraftMarkerSessions: vi.fn(() => [...liveMarkers.keys()]),
    isMarkerStuckAtPrompt: vi.fn((pane: string, marker: string) =>
      pane.split('\n').some(l => (l.includes('❯') || l.includes('›')) && l.includes(marker)),
    ),
  };
}

function buildSentinel(manager: StubManager, opts: Partial<ConstructorParameters<typeof StuckInputSentinel>[1]> = {}) {
  return new StuckInputSentinel(manager as any, {
    stateDir: os.tmpdir(),
    noPersist: true,
    minTicksBeforeFire: 2,
    maxAttempts: 4,
    ...opts,
  });
}

describe('classifyPromptTextPresentation — SGR dim decoding', () => {
  it("classifies the live F2 frame (ESC[0;2m suggestion) as 'ghost'", () => {
    expect(classifyPromptTextPresentation(GHOST_ANSI_PANE, GHOST_TEXT)).toBe('ghost');
  });

  it("classifies a bare ESC[2m dim run as 'ghost'", () => {
    const pane = `❯ ${ESC}[2m${GHOST_TEXT}${ESC}[0m`;
    expect(classifyPromptTextPresentation(pane, GHOST_TEXT)).toBe('ghost');
  });

  it("classifies a plain frame with no SGR codes as 'real' (nothing renders dim)", () => {
    expect(classifyPromptTextPresentation(PLAIN_STUCK_PANE, GHOST_TEXT)).toBe('real');
  });

  it("classifies normally-styled genuine input as 'real' even with colored chrome", () => {
    expect(classifyPromptTextPresentation(REAL_ANSI_PANE, GHOST_TEXT)).toBe('real');
  });

  it("classifies COLORED but normal-intensity text as 'real' (color is not the ghost tell)", () => {
    const pane = `❯ ${ESC}[36m${GHOST_TEXT}${ESC}[0m`;
    expect(classifyPromptTextPresentation(pane, GHOST_TEXT)).toBe('real');
  });

  it("never misreads a truecolor component '2' (38;2;r;g;b) as the dim attribute", () => {
    // A gray truecolor foreground — visually dim-ish, but NOT SGR 2. A naive
    // param scan would see the '2' color-space selector and false-classify
    // every truecolor UI as ghost, disabling genuine recovery.
    const pane = `❯ ${ESC}[38;2;150;150;150m${GHOST_TEXT}${ESC}[0m`;
    expect(classifyPromptTextPresentation(pane, GHOST_TEXT)).toBe('real');
  });

  it('handles the 256-color form (38;5;n) without misreading params', () => {
    const pane = `❯ ${ESC}[38;5;245m${GHOST_TEXT}${ESC}[0m`;
    expect(classifyPromptTextPresentation(pane, GHOST_TEXT)).toBe('real');
  });

  it("treats SGR 22 (normal intensity) as canceling dim — text after it is 'real'", () => {
    const pane = `❯ ${ESC}[2m${ESC}[22m${GHOST_TEXT}`;
    expect(classifyPromptTextPresentation(pane, GHOST_TEXT)).toBe('real');
  });

  it("returns 'inconclusive' on MIXED styling (part dim, part normal)", () => {
    const half = Math.floor(GHOST_TEXT.length / 2);
    const pane = `❯ ${ESC}[2m${GHOST_TEXT.slice(0, half)}${ESC}[22m${GHOST_TEXT.slice(half)}`;
    expect(classifyPromptTextPresentation(pane, GHOST_TEXT)).toBe('inconclusive');
  });

  it("returns 'inconclusive' when the ANSI frame's prompt text does not match (raced captures)", () => {
    expect(classifyPromptTextPresentation(GHOST_ANSI_PANE, 'a totally different message')).toBe('inconclusive');
  });

  it("returns 'inconclusive' when the ANSI frame has no readable prompt", () => {
    expect(classifyPromptTextPresentation('no prompt here at all', GHOST_TEXT)).toBe('inconclusive');
  });

  it('classifies wrapped-line ghost text (empty ❯, dim text on the next line)', () => {
    const pane = ['❯ ', `${ESC}[2mwrapped ghost suggestion${ESC}[0m`, '──────'].join('\n');
    expect(classifyPromptTextPresentation(pane, 'wrapped ghost suggestion')).toBe('ghost');
  });

  it('tracks dim state ACROSS lines when tmux does not re-emit attributes per line', () => {
    // Dim turned on at the end of the prompt line, wrapped text on the next
    // line with no attribute re-emission — the state must carry.
    const pane = [`❯ ${ESC}[2m`, 'wrapped ghost suggestion', '──────'].join('\n');
    expect(classifyPromptTextPresentation(pane, 'wrapped ghost suggestion')).toBe('ghost');
  });
});

describe('StuckInputSentinel — F2 ghost-text exclusion (the invariant)', () => {
  it('NEVER fires a keypress at ghost text, across arbitrarily many ticks', () => {
    const mgr = buildStubManager({ 'echo-A': PLAIN_STUCK_PANE }, { 'echo-A': GHOST_ANSI_PANE });
    const sentinel = buildSentinel(mgr);

    for (let i = 0; i < 10; i++) sentinel.tick();

    expect(mgr.fireStuckInputRecovery).not.toHaveBeenCalled();
    // The gate actually ran (this is not a detection miss):
    expect(mgr.captureOutputAnsi).toHaveBeenCalled();
    // Ghost is sticky — exhausted until the prompt text changes, so the gate
    // does not re-capture ANSI frames every tick forever.
    const rec = sentinel.getRecordForTest('echo-A');
    expect(rec?.exhausted).toBe(true);
    expect(rec?.attempts).toBe(0);
  });

  it('still recovers GENUINE stuck input (normal-intensity text) — the original mission', () => {
    const mgr = buildStubManager({ 'echo-A': PLAIN_STUCK_PANE }, { 'echo-A': REAL_ANSI_PANE });
    const sentinel = buildSentinel(mgr);

    sentinel.tick(); // observation
    sentinel.tick(); // fire attempt 0

    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(1);
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledWith('echo-A', 0);
  });

  it('fails toward NOT pressing when the ANSI capture returns null — and is NOT sticky', () => {
    const mgr = buildStubManager({ 'echo-A': PLAIN_STUCK_PANE }, { 'echo-A': null });
    const sentinel = buildSentinel(mgr);

    for (let i = 0; i < 5; i++) sentinel.tick();

    expect(mgr.fireStuckInputRecovery).not.toHaveBeenCalled();
    // Inconclusive is transient: the record is not exhausted, so a later
    // successful capture can still recover a genuinely stuck message.
    const rec = sentinel.getRecordForTest('echo-A');
    expect(rec?.exhausted).toBe(false);
    // Re-assessed on every fire-eligible tick (ticks 2..5 = 4 attempts).
    expect(mgr.captureOutputAnsi.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('fails toward NOT pressing when the ANSI capture THROWS', () => {
    const mgr = buildStubManager({ 'echo-A': PLAIN_STUCK_PANE }, {
      'echo-A': () => { throw new Error('tmux exploded'); },
    });
    const sentinel = buildSentinel(mgr);

    for (let i = 0; i < 5; i++) sentinel.tick();

    expect(mgr.fireStuckInputRecovery).not.toHaveBeenCalled();
  });

  it('self-heals: a transiently unreadable frame recovers once the capture works', () => {
    let ansi: string | null = null;
    const mgr = buildStubManager({ 'echo-A': PLAIN_STUCK_PANE }, { 'echo-A': () => ansi });
    const sentinel = buildSentinel(mgr);

    sentinel.tick(); // observation
    sentinel.tick(); // fire-eligible, but ANSI capture null → skip
    expect(mgr.fireStuckInputRecovery).not.toHaveBeenCalled();

    ansi = REAL_ANSI_PANE; // capture starts working; text provably real
    sentinel.tick();
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(1);
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledWith('echo-A', 0);
  });

  it('resets a sticky ghost record when the prompt text changes to genuinely typed input', () => {
    let plain = PLAIN_STUCK_PANE;
    let ansi = GHOST_ANSI_PANE;
    const mgr = buildStubManager({ 'echo-A': plain }, { 'echo-A': () => ansi });
    mgr.captureOutput = vi.fn(() => plain);
    const sentinel = buildSentinel(mgr);

    sentinel.tick();
    sentinel.tick();
    expect(mgr.fireStuckInputRecovery).not.toHaveBeenCalled();
    expect(sentinel.getRecordForTest('echo-A')?.exhausted).toBe(true);

    // The user actually types a message; it gets stuck for real.
    plain = PLAIN_STUCK_PANE.replace(GHOST_TEXT, 'a real typed message');
    ansi = REAL_ANSI_PANE.replace(GHOST_TEXT, 'a real typed message');
    sentinel.tick(); // new text → fresh record
    sentinel.tick(); // fire attempt 0
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(1);
  });

  it('does NOT gate the codex marker path (marker = text we ourselves injected)', () => {
    const CODEX_DRAFT = '[telegram:1052] continue running into version issues';
    const CODEX_MARKER = CODEX_DRAFT.slice(0, 40);
    const CODEX_PANE = [`› ${CODEX_DRAFT}`, '', '  gpt-5.5 medium'].join('\n');
    const mgr = buildStubManager(
      { 'codey-A': CODEX_PANE },
      {},
      { 'codey-A': { marker: CODEX_MARKER, framework: 'codex-cli' } },
    );
    const sentinel = buildSentinel(mgr);

    sentinel.tick();
    sentinel.tick();

    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(1);
    // The ghost gate never ran for the marker path.
    expect(mgr.captureOutputAnsi).not.toHaveBeenCalled();
  });

  it('logs exactly ONE ghost-text-skip observability event per stuck text', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ghost-evt-'));
    try {
      const mgr = buildStubManager({ 'echo-A': PLAIN_STUCK_PANE }, { 'echo-A': GHOST_ANSI_PANE });
      const sentinel = buildSentinel(mgr, { stateDir, noPersist: false });

      for (let i = 0; i < 6; i++) sentinel.tick();

      const log = fs.readFileSync(path.join(stateDir, 'stuck-input-events.jsonl'), 'utf-8')
        .trim().split('\n').map(l => JSON.parse(l));
      const ghostRows = log.filter(r => r.action === 'ghost-text-skip');
      expect(ghostRows).toHaveLength(1);
      expect(ghostRows[0].outcome).toBe('skipped');
      expect(ghostRows[0].session).toBe('echo-A');
      expect(ghostRows[0].promptText).toBe(GHOST_TEXT);
      // And no keypress rows at all.
      expect(log.filter(r => r.outcome === 'fired')).toHaveLength(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
