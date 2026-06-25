/**
 * PermissionPromptAutoResolver — Tier-1 unit tests (spec:
 * docs/specs/framework-permission-prompt-robustness.md ## Tests "Tier 1").
 *
 * Covers the two pure detectors (Layer 2 `detectApprovalPrompt`, Layer 3
 * `detectPersistingMenu`) and the stateful driver's episode/persistence state
 * machines, bounded-state eviction, and audit/fingerprint privacy. All I/O is
 * injected so the logic is exercised with real fixtures and fake deps.
 *
 * Fixtures are the REAL Claude Code cd-redirection render form (Scrape/Parser
 * Fixture Realness standard): the `❯`-led option line + the lead-stripped prose.
 */

import { describe, it, expect } from 'vitest';
import {
  PermissionPromptAutoResolver,
  detectApprovalPrompt,
  detectPersistingMenu,
  toPaneTailLines,
  MAX_ATTEMPTS,
  LAYER3_PERSIST_TICKS,
  STATE_TTL_MS,
  type PaneTailLine,
  type ResolverAuditRow,
  type ResolverDefect,
  type PermissionPromptResolverDeps,
} from '../../src/monitoring/PermissionPromptAutoResolver.js';

// ─── Real render fixtures ────────────────────────────────────────────────────────

/** The exact Claude Code cd-redirection approval block, cursor on Yes. */
const CC_APPROVE_YES = [
  'Compound command contains cd with output redirection — manual approval required',
  'to prevent path resolution bypass.',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No',
  '  Esc to cancel',
].join('\n');

/** Same block, but the ❯ selector cursor is on the NON-approve option (No). */
const CC_CURSOR_ON_NO = [
  'Compound command contains cd with output redirection — manual approval required',
  'to prevent path resolution bypass.',
  'Do you want to proceed?',
  '  1. Yes',
  '❯ 2. No',
  '  Esc to cancel',
].join('\n');

const CC_YES = toPaneTailLines(CC_APPROVE_YES);
const CC_NO = toPaneTailLines(CC_CURSOR_ON_NO);

// ─── leadGlyphsOf is exercised via the PaneTailLine model in IdleErrorClassifier
//     test; here we assert the PaneTailLine split the detectors depend on. ─────────

describe('toPaneTailLines', () => {
  it('drops empties, lead-strips text, and separates the leading glyph run', () => {
    const lines = toPaneTailLines('  ❯ 1. Yes\n\n   \n  2. No\n');
    expect(lines).toEqual<PaneTailLine[]>([
      { text: '1. Yes', leadGlyphs: '  ❯ ' },
      { text: '2. No', leadGlyphs: '  ' },
    ]);
  });

  it('the ❯ idle cursor line strips to empty text with the glyph in leadGlyphs', () => {
    const [line] = toPaneTailLines('❯ ');
    expect(line).toEqual({ text: '', leadGlyphs: '❯ ' });
  });
});

// ─── Layer 2 — detectApprovalPrompt ──────────────────────────────────────────────

describe('detectApprovalPrompt', () => {
  it('fires on the real CC cd-redirection block (≥2 prose + ❯-on-Yes + bottom + not generating)', () => {
    const m = detectApprovalPrompt(CC_YES, 'claude-code', false);
    expect(m).not.toBeNull();
    expect(m!.approveKey).toBe('Enter');
    // ≥2 DISTINCT static pattern names, sorted — never tail text.
    expect(m!.matchedPatternNames).toEqual([
      'compound-cd-redirect',
      'do-you-want-to-proceed',
      'manual-approval',
      'path-resolution-bypass',
    ]);
    expect(m!.stableFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does NOT fire on only ONE distinct prose pattern (repeated across lines)', () => {
    const oneProse = toPaneTailLines(
      ['manual approval required', 'manual approval required', '❯ 1. Yes', '  2. No', '  Esc to cancel'].join('\n'),
    );
    expect(detectApprovalPrompt(oneProse, 'claude-code', false)).toBeNull();
  });

  it('does NOT fire when a live idle input box is rendered BELOW the menu (not the genuine bottom)', () => {
    const withInputBoxBelow = toPaneTailLines(CC_APPROVE_YES + '\n❯ ');
    expect(detectApprovalPrompt(withInputBoxBelow, 'claude-code', false)).toBeNull();
  });

  it('does NOT fire when the session is generating', () => {
    expect(detectApprovalPrompt(CC_YES, 'claude-code', true)).toBeNull();
  });

  it('does NOT fire (Layer 2 auto-answer) when the ❯ cursor is on a NON-approve option (No)', () => {
    expect(detectApprovalPrompt(CC_NO, 'claude-code', false)).toBeNull();
    // ...and that same fixture IS surfaced by Layer 3 (never silently stranded).
    expect(detectPersistingMenu(CC_NO, false)).not.toBeNull();
  });

  it('does NOT fire for an unregistered framework', () => {
    expect(detectApprovalPrompt(CC_YES, 'codex-cli', false)).toBeNull();
  });

  it('DOCUMENTED RESIDUAL: a ❯ 1. Yes block that IS the genuine bottom as displayed content matches', () => {
    // A text capture cannot perfectly distinguish TUI chrome from displayed content
    // (a transcript / doc rendering the same bytes at the genuine bottom). This is
    // the honest residual — the consequence is a single BENIGN Enter (an empty submit
    // an idle pane ignores), bounded by re-capture + MAX_ATTEMPTS + the Terminal
    // backstop. The detector does NOT pretend closure.
    const m = detectApprovalPrompt(CC_YES, 'claude-code', false);
    expect(m).not.toBeNull();
    expect(m!.approveKey).toBe('Enter');
  });

  it('the fingerprint is identical across captures differing only in non-signature lines', () => {
    const withNoise = toPaneTailLines(
      [
        'some earlier scrollback that is not part of the signature',
        CC_APPROVE_YES,
      ].join('\n'),
    );
    const a = detectApprovalPrompt(CC_YES, 'claude-code', false);
    const b = detectApprovalPrompt(withNoise, 'claude-code', false);
    expect(a!.stableFingerprint).toBe(b!.stableFingerprint);
  });
});

// ─── Layer 3 — detectPersistingMenu (prose-AGNOSTIC) ─────────────────────────────

describe('detectPersistingMenu', () => {
  it('fires prose-AGNOSTICALLY on a glyph-led numbered menu + affordance with NO registry prose (drift)', () => {
    const drifted = toPaneTailLines(
      [
        'Some brand-new host wording we do not recognize at all',
        '❯ 1. Approve',
        '  2. Reject',
        '  Esc to cancel',
      ].join('\n'),
    );
    // Layer 2 declines (no registry prose, label not an approve verb)...
    expect(detectApprovalPrompt(drifted, 'claude-code', false)).toBeNull();
    // ...Layer 3 catches the drift.
    const m = detectPersistingMenu(drifted, false);
    expect(m).not.toBeNull();
    expect(m!.optionLabels).toEqual(['1. Approve', '2. Reject']);
  });

  it('fires on a ❯-on-No menu (the case Layer 2 declines)', () => {
    const m = detectPersistingMenu(CC_NO, false);
    expect(m).not.toBeNull();
    expect(m!.optionLabels).toEqual(['1. Yes', '2. No']);
  });

  it('does NOT fire while generating', () => {
    expect(detectPersistingMenu(CC_NO, true)).toBeNull();
  });

  it('does NOT fire on a single glyph-led option with no affordance and <2 options', () => {
    const single = toPaneTailLines(['Some prompt', '❯ 1. Continue'].join('\n'));
    expect(detectPersistingMenu(single, false)).toBeNull();
  });

  it('does NOT fire when the only numbered lines are NOT glyph-led', () => {
    const noGlyph = toPaneTailLines(['Pick:', '  1. a', '  2. b', '  Esc to cancel'].join('\n'));
    expect(detectPersistingMenu(noGlyph, false)).toBeNull();
  });
});

// ─── Driver harness ──────────────────────────────────────────────────────────────

function harness() {
  const ctrl = {
    now: 1_000_000,
    generating: false,
    emergencyOff: false,
    recapture: (async (_s: string) => null) as (s: string) => Promise<PaneTailLine[] | null>,
    sendKeyReturns: true,
    sendKeyThrows: false,
  };
  const audits: ResolverAuditRow[] = [];
  const defects: ResolverDefect[] = [];
  const sendKeyCalls: Array<{ session: string; key: string }> = [];
  const deps: PermissionPromptResolverDeps = {
    sendKey: (session, key) => {
      sendKeyCalls.push({ session, key });
      if (ctrl.sendKeyThrows) throw new Error('send boom');
      return ctrl.sendKeyReturns;
    },
    reCaptureTail: (s) => ctrl.recapture(s),
    isGenerating: () => ctrl.generating,
    raiseDefect: (d) => defects.push(d),
    appendAudit: (r) => audits.push(r),
    now: () => ctrl.now,
    emergencyDisabled: () => ctrl.emergencyOff,
  };
  const resolver = new PermissionPromptAutoResolver(deps);
  return { resolver, ctrl, audits, defects, sendKeyCalls };
}

/** Confirm re-capture: the menu is still present on the race-guard re-capture. */
function confirmSame(tailStr: string) {
  return async () => toPaneTailLines(tailStr);
}

// ─── Layer-2 state machine ───────────────────────────────────────────────────────

describe('PermissionPromptAutoResolver — Layer 2 state machine', () => {
  it('emergencyDisabled() makes evaluate a strict no-op and reads disabled in guardStatus', async () => {
    const h = harness();
    h.ctrl.emergencyOff = true;
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.sendKeyCalls).toHaveLength(0);
    expect(h.resolver.guardStatus().enabled).toBe(false);
    h.ctrl.emergencyOff = false;
    expect(h.resolver.guardStatus().enabled).toBe(true);
  });

  it('answers with exactly one Enter on a confirmed live menu, audited "answered"', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.sendKeyCalls).toEqual([{ session: 'sess', key: 'Enter' }]);
    const last = h.audits.at(-1)!;
    expect(last.outcome).toBe('answered');
    expect(last.keySent).toBe('Enter');
    expect(last.matchedPatternNames).toContain('manual-approval');
  });

  it('re-capture mismatch → race-aborted, NO send (capture→send race closed)', async () => {
    const h = harness();
    h.ctrl.recapture = async () => toPaneTailLines('all clear, back to work\n');
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.sendKeyCalls).toHaveLength(0);
    expect(h.audits.some((a) => a.outcome === 'race-aborted')).toBe(true);
  });

  it('re-capture returning null → race-aborted, NO send', async () => {
    const h = harness();
    h.ctrl.recapture = async () => null;
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.sendKeyCalls).toHaveLength(0);
    expect(h.audits.some((a) => a.outcome === 'race-aborted')).toBe(true);
  });

  it('sendKey failure → send-failed, count not advanced (next tick retries)', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    h.ctrl.sendKeyReturns = false;
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.audits.some((a) => a.outcome === 'send-failed')).toBe(true);
    // count not advanced: a successful next send is still the FIRST → "answered".
    h.ctrl.sendKeyReturns = true;
    h.ctrl.now += 5000;
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.audits.at(-1)!.outcome).toBe('answered');
  });

  it('MAX_ATTEMPTS consecutive un-cleared sends → ONE Terminal defect, then stops sending', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    for (let i = 0; i < 6; i++) {
      await h.resolver.evaluate('sess', CC_YES);
      h.ctrl.now += 5000;
    }
    expect(h.sendKeyCalls).toHaveLength(MAX_ATTEMPTS); // 3 sends, then terminal
    const l2Defects = h.defects.filter((d) => d.layer === 'layer2');
    expect(l2Defects).toHaveLength(1);
    expect(l2Defects[0].matchedPatternNames).toContain('manual-approval');
    expect(h.audits.filter((a) => a.outcome === 'persisted-terminal')).toHaveLength(1);
  });

  it('episode reset-on-clear: a cleared tick evicts, so a later same-shape prompt starts FRESH (no pre-terminate)', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    // Prompt A → drive to Terminal.
    for (let i = 0; i < 6; i++) {
      await h.resolver.evaluate('sess', CC_YES);
      h.ctrl.now += 5000;
    }
    expect(h.defects.filter((d) => d.layer === 'layer2')).toHaveLength(1);
    const sendsAfterA = h.sendKeyCalls.length;
    // A cleared tick.
    await h.resolver.evaluate('sess', toPaneTailLines('back to work\n'));
    h.ctrl.now += 5000;
    // Prompt B (same shape) reappears → must be answered fresh, NOT pre-terminated.
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.sendKeyCalls.length).toBe(sendsAfterA + 1);
    expect(h.audits.at(-1)!.outcome).toBe('answered');
  });

  it('a prompt answered once then cleared audits "cleared"', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    await h.resolver.evaluate('sess', CC_YES); // answered (send #1)
    h.ctrl.now += 5000;
    await h.resolver.evaluate('sess', toPaneTailLines('working again\n')); // cleared → evict
    expect(h.audits.some((a) => a.outcome === 'cleared')).toBe(true);
  });

  it('no global per-session window cap: many DISTINCT cleared prompts never false-Terminal a busy session', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    for (let i = 0; i < 10; i++) {
      await h.resolver.evaluate('sess', CC_YES); // one send, answered
      h.ctrl.now += 5000;
      await h.resolver.evaluate('sess', toPaneTailLines('working\n')); // clears
      h.ctrl.now += 5000;
    }
    expect(h.defects).toHaveLength(0);
    expect(h.sendKeyCalls).toHaveLength(10);
  });

  it('audit privacy: a secret token in the tail prose never reaches the audit or the fingerprint', async () => {
    const SECRET = 'sk-leakcanary-CAFEBABE';
    const tail = toPaneTailLines(
      [
        `Compound command contains cd with output redirection — manual approval required (cmd: echo ${SECRET})`,
        'to prevent path resolution bypass.',
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. No',
        '  Esc to cancel',
      ].join('\n'),
    );
    const h = harness();
    h.ctrl.recapture = async () => tail;
    await h.resolver.evaluate('sess', tail);
    expect(h.audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.audits)).not.toContain(SECRET);
    for (const a of h.audits) expect(a.fingerprint).not.toContain(SECRET);
  });
});

// ─── Bounded state (Layer 2) ─────────────────────────────────────────────────────

describe('PermissionPromptAutoResolver — bounded Layer-2 state', () => {
  it('sweep evicts an entry whose session is no longer running (session-exit)', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.resolver.stateSizes().episodes).toBe(1);
    h.resolver.sweep(new Set()); // 'sess' not running
    expect(h.resolver.stateSizes().episodes).toBe(0);
    // ...and the next sighting is a FRESH episode (answered, not retried).
    h.ctrl.now += 5000;
    await h.resolver.evaluate('sess', CC_YES);
    expect(h.audits.at(-1)!.outcome).toBe('answered');
  });

  it('sweep evicts a TTL-stale entry even while the session is still running', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    await h.resolver.evaluate('sess', CC_YES);
    h.ctrl.now += STATE_TTL_MS + 1;
    h.resolver.sweep(new Set(['sess']));
    expect(h.resolver.stateSizes().episodes).toBe(0);
  });

  it('the episode map does not grow across N ticks of churn', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    for (let i = 0; i < 25; i++) {
      const session = `sess-${i}`;
      h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
      await h.resolver.evaluate(session, CC_YES);
      h.resolver.sweep(new Set()); // every session immediately gone
    }
    expect(h.resolver.stateSizes().episodes).toBe(0);
  });
});

// ─── Layer 3 — persistence + cross-layer no-double-raise ─────────────────────────

describe('PermissionPromptAutoResolver — Layer 3 persistence', () => {
  it('a Layer-2-declined menu (❯ on No) persisting raises exactly ONE Terminal defect at the threshold', async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      await h.resolver.evaluate('sess', CC_NO);
      h.ctrl.now += 5000;
    }
    expect(h.sendKeyCalls).toHaveLength(0); // Layer 2 never sends (cursor not on approve)
    const l3 = h.defects.filter((d) => d.layer === 'layer3');
    expect(l3).toHaveLength(1);
    expect(l3[0].dedupKey.startsWith('sess|')).toBe(true);
    expect(l3[0].menuStructureKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Layer-3 reset-on-clear: a cleared tick evicts, so a re-presented menu restarts its persistence count', async () => {
    const h = harness();
    // Persist just short of the threshold.
    for (let i = 0; i < LAYER3_PERSIST_TICKS - 1; i++) {
      await h.resolver.evaluate('sess', CC_NO);
      h.ctrl.now += 5000;
    }
    expect(h.defects).toHaveLength(0);
    // Clear → evict.
    await h.resolver.evaluate('sess', toPaneTailLines('working\n'));
    h.ctrl.now += 5000;
    expect(h.resolver.stateSizes().persistMenus).toBe(0);
    // Re-present once → count restarts, no defect yet.
    await h.resolver.evaluate('sess', CC_NO);
    expect(h.defects).toHaveLength(0);
  });

  it('no double-raise: a Layer-2-matched-but-unclearing prompt raises ONE defect total (Layer 3 never increments)', async () => {
    const h = harness();
    h.ctrl.recapture = confirmSame(CC_APPROVE_YES);
    for (let i = 0; i < 8; i++) {
      await h.resolver.evaluate('sess', CC_YES);
      h.ctrl.now += 5000;
    }
    expect(h.defects).toHaveLength(1);
    expect(h.defects[0].layer).toBe('layer2');
    expect(h.resolver.stateSizes().persistMenus).toBe(0);
  });

  it('Layer-3 bounded state: session-exit and TTL both evict the persistence map', async () => {
    const h = harness();
    await h.resolver.evaluate('sess', CC_NO);
    expect(h.resolver.stateSizes().persistMenus).toBe(1);
    h.resolver.sweep(new Set()); // session-exit
    expect(h.resolver.stateSizes().persistMenus).toBe(0);
    // TTL
    await h.resolver.evaluate('sess', CC_NO);
    h.ctrl.now += STATE_TTL_MS + 1;
    h.resolver.sweep(new Set(['sess']));
    expect(h.resolver.stateSizes().persistMenus).toBe(0);
  });

  it('Layer-3 audit privacy: a secret in a menu option label is never recoverable from the digest/defect', async () => {
    const SECRET = 'sk-supersecret-DEADBEEF';
    const tail = toPaneTailLines(
      ['Pick one:', `❯ 1. Use token ${SECRET}`, '  2. Cancel', '  Esc to cancel'].join('\n'),
    );
    const h = harness();
    for (let i = 0; i < LAYER3_PERSIST_TICKS + 1; i++) {
      await h.resolver.evaluate('sess', tail);
      h.ctrl.now += 5000;
    }
    const l3 = h.defects.find((d) => d.layer === 'layer3')!;
    expect(l3).toBeTruthy();
    expect(JSON.stringify(l3)).not.toContain(SECRET);
    expect(l3.menuStructureKey).not.toContain(SECRET);
    expect(JSON.stringify(h.audits)).not.toContain(SECRET);
  });
});

// ─── guardStatus liveness ────────────────────────────────────────────────────────

describe('PermissionPromptAutoResolver — guardStatus', () => {
  it('lastTickAt advances on both evaluate and sweep', async () => {
    const h = harness();
    expect(h.resolver.guardStatus().lastTickAt).toBe(0);
    await h.resolver.evaluate('sess', toPaneTailLines('idle\n'));
    expect(h.resolver.guardStatus().lastTickAt).toBe(h.ctrl.now);
    h.ctrl.now += 12345;
    h.resolver.sweep(new Set(['sess']));
    expect(h.resolver.guardStatus().lastTickAt).toBe(h.ctrl.now);
  });
});
